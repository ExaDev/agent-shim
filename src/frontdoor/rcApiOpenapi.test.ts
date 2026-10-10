import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CheckReport } from "../checkReport";
import type { DoctorReport } from "../doctorReport";
import { LIFECYCLE_AND_CODEX_TEST_DEPS } from "./lifecycleCodexTestDeps";
import { createDoorApiNodeHandler } from "./controlApi";
import { createDoorEventHub, rcFanoutOnDoorHub } from "./eventHub";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS, type RcSessionTracker } from "./rcSessions";
import type { RcStreamEvent } from "./rcSchemas";
import { createRcEventFanout } from "./rcStream";
import type { FrontDoorStatus } from "./status";
import { buildLayoutPaths } from "../paths";

/** The token the mounted door accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "unit-openapi-token";
/** One tracked session every status-shaped read names, observed the way the door's own tracker observes one. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";

/** How long the SSE case may wait for the event it publishes to cross the wire. Loopback and the bridge run in milliseconds; the bound exists only so an overloaded machine fails visibly instead of hanging the suite. */
const WAIT_BUDGET_MS = 5_000;
/** The sequence number every fake write below answers with, one named stand-in for the values the real operations echo back. */
const WRITE_SEQUENCE_NUM = 7;
/** The sequence-number array those writes answer with, built from the named stand-in so no bare number rides an array literal. */
const WRITE_SEQUENCE_NUMS = [WRITE_SEQUENCE_NUM] as const;

/** The settle cadence before the SSE test publishes, generous against a loopback hop's real sub-millisecond cost. */
const SETTLE_MS = 50;

/** The exact REST surface the document must describe: every procedure annotated, and nothing beyond it (an unannotated procedure would leak its router-segment path into this set, so equality proves both halves at once). Every path sits under the mount's one `/rest` namespace, which no RPC procedure path begins with, and the writes are flat verb paths carrying the session in the body, mirroring the CLI's own verbs, because the door's one input shape (the same Zod schema over RPC and REST) must stay one object. */
const EXPECTED_REST_PATHS = [
  "/rest/check",
  "/rest/codex/logout",
  "/rest/codex/status",
  "/rest/config/identity/add",
  "/rest/config/identity/remove",
  "/rest/config/identity/set",
  "/rest/config/identity/use",
  "/rest/config/pool/add",
  "/rest/config/pool/remove",
  "/rest/config/pool/set",
  "/rest/config/pool/use",
  "/rest/config/profile/add",
  "/rest/config/profile/remove",
  "/rest/config/profile/set",
  "/rest/config/profile/use",
  "/rest/config/provider/add",
  "/rest/config/provider/remove",
  "/rest/config/provider/set",
  "/rest/config/rule/add",
  "/rest/config/rule/remove",
  "/rest/config/rule/set",
  "/rest/doctor",
  "/rest/events",
  "/rest/frontdoor/restart",
  "/rest/frontdoor/sessions",
  "/rest/frontdoor/status",
  "/rest/launch/resolve",
  "/rest/pool/pick",
  "/rest/rc/answer",
  "/rest/rc/end-session",
  "/rest/rc/events",
  "/rest/rc/file-suggestions",
  "/rest/rc/get-context-usage",
  "/rest/rc/get-usage",
  "/rest/rc/interrupt",
  "/rest/rc/keep-alive",
  "/rest/rc/mcp-authenticate",
  "/rest/rc/mcp-oauth-callback-url",
  "/rest/rc/mcp-reconnect",
  "/rest/rc/mcp-status",
  "/rest/rc/pending",
  "/rest/rc/read-file",
  "/rest/rc/send",
  "/rest/rc/sessions",
  "/rest/rc/set-model",
  "/rest/rc/set-permission-mode",
  "/rest/rc/status",
  "/rest/rc/teleport",
  "/rest/update/check",
  "/rest/usage/live",
  "/rest/usage/snapshots",
  "/rest/usage/windows",
].sort();

/** The stand-in status the frontdoor reads answer, the same shape `frontdoor status` reports. */
const FRONTDOOR_STATUS: FrontDoorStatus = {
  state: { supervisorPid: 10, port: 4100, lastPort: 4100 },
  supervisorAlive: true,
  sessions: [],
  headroomSocket: undefined,
  logPath: "/home/testuser/.agent-shim/logs/frontdoor.log",
  logExists: false,
};

/** Reads one SSE frame's data payload from a byte stream, resolving on the first `data:` line, so the stream test asserts the protocol's own wire shape rather than a client library's view of it. */
async function firstSseData(body: Readonly<ReadableStream<Uint8Array>>): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("the SSE read timed out within the test's wait budget"));
        }, WAIT_BUDGET_MS);
      }),
    ]);
    if (done) {
      throw new Error("the SSE stream ended before any data frame arrived");
    }
    buffer += decoder.decode(value, { stream: true });
    const frame = /^data: (.*)$/m.exec(buffer);
    if (frame !== null) {
      void reader.cancel();
      return JSON.parse(frame[1] ?? "") as unknown;
    }
  }
}

/** Seeds one observed session in a tracker the way the door's own adapters do: the session-create exchange, whose answer carries the `cse_` id. */
function seedSession(tracker: RcSessionTracker, id: string): void {
  const observed = tracker.observeExchange({ method: "POST", url: "/v1/code/sessions", headers: { authorization: "Bearer sk-ant-oat2" } });
  observed?.onResponse(HTTP_STATUS.ok, {});
  observed?.onBodyChunk(Buffer.from(JSON.stringify({ session: { id } }), "utf8"));
  observed?.onEnd();
}

describe("the door's typed API served as REST with an OpenAPI document", () => {
  let base: string;
  let close: () => Promise<void>;
  /** The configuration tree the mount's `config.*` routes write, a throwaway layout so no test touches a real home. */
  let configRoot: string;
  /** The fan-out the subscribe route reads, wrapped on a door hub exactly as the door wires it, so the SSE test publishes the way the held stream does. */
  const doorEvents = createDoorEventHub();
  const fanout = rcFanoutOnDoorHub(createRcEventFanout(), doorEvents);

  beforeAll(async () => {
    configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agent-shim-openapi-config-"));
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    seedSession(tracker, SESSION_ID);
    const surface = createDoorApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      paths: buildLayoutPaths(configRoot),
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS }),
      answer: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      interrupt: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      setModel: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      setPermissionMode: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      endSession: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      getUsage: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      getContextUsage: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      readFile: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      fileSuggestions: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      keepAlive: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS }),
      mcpStatus: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpReconnect: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpAuthenticate: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpOAuthCallbackUrl: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      teleport: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS }),
      fanout,
      usageSnapshots: () => [],
      usageSnapshotOf: () => undefined,
      liveRateLimits: () => [],
      latestRateLimit: () => undefined,
      now: () => 0,
      frontDoorStatus: () => FRONTDOOR_STATUS,
      checkReport: (): CheckReport => {
        throw new Error("no REST test drives check.run");
      },
      doctorReport: (): DoctorReport => {
        throw new Error("no REST test drives doctor.run");
      },
      poolPick: (): never => {
        throw new Error("no REST test drives pool.pick");
      },
      poolNames: () => [],
      ...LIFECYCLE_AND_CODEX_TEST_DEPS,
      resolveLaunch: () => {
        throw new Error("this test resolves no launch");
      },
      events: doorEvents,
    });
    // The listener shape the door's own listener takes: it owns the not-matched 404, the mount owns everything under the prefix.
    const server = http.createServer((request, response) => {
      if (!(request.url ?? "/").startsWith("/__agent-shim/orpc")) {
        response.statusCode = HTTP_STATUS.notFound;
        response.end("outside the mount");
        return;
      }
      const answered = surface.handle(request, response);
      // The door's listener logs a rejection and answers the not-matched 404 itself; this stand-in does the same.
      answered.then(
        (result) => {
          if (!result.matched) {
            response.statusCode = HTTP_STATUS.notFound;
            response.end("no match");
          }
        },
        (error: unknown) => {
          console.error(error);
        },
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    base = `http://127.0.0.1:${String(address.port)}/__agent-shim/orpc`;
    close = async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    };
  });

  afterAll(async () => {
    await close();
    fs.rmSync(configRoot, { recursive: true, force: true });
  });

  /** One plain HTTP call, the shape a non-TypeScript consumer makes: no client library, no envelope. `token: null` sends none (a default parameter would swallow an explicit `undefined`, so absence is spelled `null`). */
  async function call(method: string, path: string, body?: unknown, token: string | null = CONTROL_TOKEN): Promise<{ readonly status: number; readonly type: string | null; readonly text: string }> {
    const answered = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    });
    return { status: answered.status, type: answered.headers.get("content-type"), text: await answered.text() };
  }

  it("lists sessions over REST with the control token", async () => {
    const listed = await call("GET", "/rest/rc/sessions");
    expect(listed.status).toBe(HTTP_STATUS.ok);
    expect(listed.type).toContain("application/json");
    expect(JSON.parse(listed.text)).toMatchObject({ sessions: [{ id: SESSION_ID }] });
  });

  it("refuses a REST call without the control token, in the same error shape the RPC protocol answers with", async () => {
    const refused = await call("GET", "/rest/rc/sessions", undefined, null);
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    expect(JSON.parse(refused.text)).toMatchObject({ code: "UNAUTHORIZED" });
    const wrong = await call("GET", "/rest/rc/sessions", undefined, "not-the-token");
    expect(wrong.status).toBe(HTTP_STATUS.unauthorized);
  });

  it("refuses a REST call whose body fails the shared schema, naming the field", async () => {
    const refused = await call("POST", "/rest/rc/send", { session: SESSION_ID });
    expect(refused.status).toBe(HTTP_STATUS.badRequest);
    expect(refused.text).toContain("text");
  });

  it("delivers a write over REST and answers with the operation's own shape", async () => {
    const sent = await call("POST", "/rest/rc/send", { session: SESSION_ID, text: "hello" });
    expect(sent.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(sent.text)).toEqual({ session: SESSION_ID, sequenceNums: WRITE_SEQUENCE_NUMS });
  });

  it("decodes query parameters and keeps the named-session refusal rule", async () => {
    const named = await call("GET", `/rest/rc/status?session=${SESSION_ID}`);
    expect(named.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(named.text)).toMatchObject({ statuses: [{ id: SESSION_ID }] });
    const unknown = await call("GET", "/rest/rc/status?session=cse_00000000-0000-4000-8000-0000000000ff");
    expect(unknown.status).toBe(HTTP_STATUS.notFound);
    expect(unknown.text).toContain("has not observed Remote Control session");
  });

  it("serves the configuration writes over REST, behind the control token, in the verbs' own result shape", async () => {
    const refused = await call("POST", "/rest/config/identity/add", { name: "work" }, null);
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    expect(fs.existsSync(nodePath.join(configRoot, "identities", "work"))).toBe(false);

    const created = await call("POST", "/rest/config/identity/add", { name: "work" });
    expect(created.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(created.text)).toEqual({ action: "created", kind: "identity", name: "work", value: { name: "work", allowAmbientCredential: false } });

    const duplicate = await call("POST", "/rest/config/identity/add", { name: "work" });
    expect(duplicate.status).toBe(HTTP_STATUS.conflict);
    expect(JSON.parse(duplicate.text)).toMatchObject({ code: "CONFLICT" });

    const unconfirmed = await call("POST", "/rest/config/identity/remove", { name: "work", confirm: false });
    expect(unconfirmed.status).toBe(HTTP_STATUS.badRequest);
    expect(JSON.parse(unconfirmed.text)).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a command credential source over REST and leaves the identity without a credential", async () => {
    await call("POST", "/rest/config/identity/add", { name: "scripted" });
    const refused = await call("POST", "/rest/config/identity/set", { name: "scripted", credential: { sources: [{ command: ["sh", "-c", "echo token"] }] } });
    expect(refused.status).toBe(HTTP_STATUS.badRequest);
    const shown = await call("POST", "/rest/config/identity/set", { name: "scripted", allowAmbientCredential: false });
    expect(JSON.parse(shown.text)).toMatchObject({ value: { name: "scripted", allowAmbientCredential: false } });
    expect(JSON.parse(shown.text)).not.toHaveProperty("value.credential");
  });

  it("serves the OpenAPI document under the same token, describing exactly the annotated surface", async () => {
    const refused = await call("GET", "/openapi.json", undefined, null);
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    const doc = await call("GET", "/openapi.json");
    expect(doc.status).toBe(HTTP_STATUS.ok);
    const parsed = JSON.parse(doc.text) as { info: { title: string; version: string }; paths: Record<string, { get?: { responses?: Record<string, { content?: Record<string, unknown> } | undefined> } | undefined }> };
    expect(parsed.info.title).toBe("agent-shim front door API");
    expect(parsed.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(parsed.paths).sort()).toEqual(EXPECTED_REST_PATHS);
    // The SSE routes describe their wire shape, so a consumer knows what the stream is before dialling it.
    const streamResponses = parsed.paths["/rest/rc/events"]?.get?.responses;
    expect(Object.keys(streamResponses?.["200"]?.content ?? {})).toContain("text/event-stream");
  });

  it("carries every operation's Zod schemas and their constraints in the document", async () => {
    const doc = await call("GET", "/openapi.json");
    interface Operation { requestBody?: { content?: Record<string, { schema?: unknown }> }; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
    const parsed = JSON.parse(doc.text) as { paths: Record<string, Record<string, Operation>> };
    // An empty schema or `anyOf: [{}, {not: {}}]` is what a document generated without schemas carries; every JSON response must describe a real shape instead.
    const isUnconstrained = (schema: unknown): boolean => typeof schema !== "object" || schema === null || !("type" in schema || "properties" in schema || "$ref" in schema || "items" in schema || "enum" in schema || "const" in schema);
    const operations = Object.values(parsed.paths).flatMap((byMethod) => Object.values(byMethod));
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      const ok = operation.responses?.["200"]?.content;
      const json = ok?.["application/json"];
      if (json !== undefined) {
        expect(isUnconstrained(json.schema)).toBe(false);
      }
    }
    const send = parsed.paths["/rest/rc/send"]?.post?.requestBody?.content?.["application/json"]?.schema;
    expect(send).toMatchObject({ type: "object", properties: { session: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } } });
    const resolve = parsed.paths["/rest/launch/resolve"]?.post?.requestBody?.content?.["application/json"]?.schema;
    expect(resolve).toMatchObject({ type: "object", properties: { path: { type: "string", minLength: 1 }, argv: { type: "array" }, env: { type: "object" } }, required: ["path"] });
  });

  it("still serves the RPC protocol beside the REST routes, on the procedure paths the typed clients use", async () => {
    // The web client's own call shape: a POST of the oRPC JSON envelope on the procedure's path. The REST annotation of `/rc/sessions` (GET) must not capture it.
    const answered = await fetch(`${base}/rc/list`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_TOKEN}` }, body: JSON.stringify({ json: {} }) });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(await answered.text())).toMatchObject({ json: { sessions: [{ id: SESSION_ID }] } });
  });

  it("lets a method with no annotated route fall through to the 404 the listener owns", async () => {
    // `/rest/rc/sessions` is annotated GET-only, so a POST names no REST route; `/rest` is no procedure's path either, so the RPC handler declines it too and the mount reports no match.
    const fallen = await call("POST", "/rest/rc/sessions", {});
    expect(fallen.status).toBe(HTTP_STATUS.notFound);
  });

  it("streams the SSE route over plain HTTP, one event as one data frame", async () => {
    const answered = await fetch(`${base}/rest/rc/events?session=${SESSION_ID}`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    expect(answered.headers.get("content-type")).toContain("text/event-stream");
    if (answered.body === null) {
      throw new Error("expected a streaming body");
    }
    const frame = firstSseData(answered.body);
    // The subscription is live only once its request has landed, so the publish waits a beat for the door to have served it.
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    const event: RcStreamEvent = { session: SESSION_ID, envelope: { event_type: "message", sequence_num: 1, source: "worker", payload: { message: "rest" } } };
    fanout.publish(event);
    const delivered = (await frame) as { session: string; envelope: { sequence_num: number; payload: { message: string } } };
    expect(delivered.session).toBe(SESSION_ID);
    expect(delivered.envelope.sequence_num).toBe(1);
    expect(delivered.envelope.payload.message).toBe("rest");
  });
});
