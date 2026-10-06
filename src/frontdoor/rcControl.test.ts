import * as http from "node:http";
import * as https from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { CONTROL_PATH_PREFIX, createRcControlHandler, frontDoorRcControl, realRcControlTransport, type RcControlTransport } from "./rcControl";
import { generateCa, mintLeaf, LOOPBACK_LEAF_NAMES, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import type { RcPendingRequestSummary, RcSessionStatus, RcSessionSummary } from "./rcSessions";
import type { RcEventWriteResult } from "./rcWrites";

const TOKEN = "control-token-under-test";
/** The sequence number the scripted inject answers with, named so the literal never reads as a magic number. */
const SEQUENCE_NUM = 412;
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
/** A second tracked session with nothing pending, so an empty pending list is distinguishable from an untracked id. */
const QUIET_SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
const SESSIONS: readonly RcSessionSummary[] = [
  { id: SESSION_ID, createdAt: 1_000, lastSeenAt: 2_000 },
  { id: QUIET_SESSION_ID, createdAt: 1_100, lastSeenAt: 2_100 },
];
/** The request id the scripted pending entry carries, of the shape the protocol's own requests echo. */
const REQUEST_ID = "req_00000000-0000-4000-8000-00000000000a";
/** The minted request id the scripted control writes answer with, so a route's answer naming it proves the id travels from the operation to the caller. */
const MINTED_REQUEST_ID = "minted-00000000-0000-4000-8000-00000000000b";
const PENDING: readonly RcPendingRequestSummary[] = [{ sessionId: SESSION_ID, requestId: REQUEST_ID, type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: 1_500 }];
const STATUSES: readonly RcSessionStatus[] = [
  { id: SESSION_ID, createdAt: 1_000, lastSeenAt: 2_000, workerState: { value: "WORKER_STATUS_RUNNING", observedAt: 1_200 }, workerIdleSeconds: { value: 7, observedAt: 2_000 }, pending: [...PENDING] },
  { id: QUIET_SESSION_ID, createdAt: 1_100, lastSeenAt: 2_100, workerState: undefined, workerIdleSeconds: undefined, pending: [] },
];

/** The plain-HTTP transport the handler tests use: the handler is transport-agnostic, so a loopback HTTP server exercises it without any TLS setup. */
function plainTransport(port: number): RcControlTransport {
  return {
    request: async (options) =>
      await new Promise((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.body === undefined ? options.headers : { ...options.headers, "content-length": String(Buffer.byteLength(options.body, "utf8")) } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on("end", () => {
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        request.once("error", reject);
        request.end(options.body);
      }),
  };
}

/** Starts the handler on a loopback server and resolves with its port and a stop. */
async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ readonly port: number; readonly stop: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return {
    port: address.port,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      });
    },
  };
}

/** One write result the scripted handler deps answer with, whatever the operation's own parameters are. */
function writeAnswering(result: RcEventWriteResult): (sessionId: string) => Promise<RcEventWriteResult> {
  return async () => await Promise.resolve(result);
}

/** The full handler deps the scripted tests serve with, so every route has its dependency and each test overrides only what it exercises. */
function handlerDeps(overrides: Readonly<Partial<Parameters<typeof createRcControlHandler>[0]>> = {}): Parameters<typeof createRcControlHandler>[0] {
  return {
    expectedToken: TOKEN,
    list: () => SESSIONS,
    statusOf: (sessionId?: string) => STATUSES.filter((status) => sessionId === undefined || status.id === sessionId),
    pendingOf: (sessionId?: string) => PENDING.filter((pending) => sessionId === undefined || pending.sessionId === sessionId),
    inject: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    answer: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    interrupt: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    setModel: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    setPermissionMode: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    endSession: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    getUsage: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    getContextUsage: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    readFile: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    fileSuggestions: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    keepAlive: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }),
    mcpStatus: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    mcpReconnect: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    mcpAuthenticate: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    mcpOAuthCallbackUrl: writeAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID }),
    ...overrides,
  };
}

/** The error message a JSON answer carried, when it carried one. */
function errorTextOf(body: string): string {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string" ? parsed.error : body;
}

describe("the Remote Control control handler", () => {
  let running: { port: number; stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("lists the observed sessions for the generation's token, and refuses any other credential", async () => {
    const started = await serve(createRcControlHandler(handlerDeps()));
    running = started;
    const transport = plainTransport(started.port);
    const refused = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: "Bearer wrong" } });
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    const bare = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: {} });
    expect(bare.status).toBe(HTTP_STATUS.unauthorized);
    const allowed = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(allowed.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(allowed.body)).toEqual({ sessions: SESSIONS });
  });

  it("reports each session's status and pending control requests, and refuses a named session it has not observed rather than answering empty", async () => {
    const started = await serve(createRcControlHandler(handlerDeps()));
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const statuses = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/status`, headers });
    expect(statuses.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(statuses.body)).toEqual({ statuses: STATUSES });
    const oneSession = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/status?session=${SESSION_ID}`, headers });
    expect(JSON.parse(oneSession.body)).toEqual({ statuses: [STATUSES[0]] });
    const unknownSession = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/status?session=cse_00000000-0000-4000-8000-0000000000ff`, headers });
    expect(unknownSession.status).toBe(HTTP_STATUS.notFound);
    expect(errorTextOf(unknownSession.body)).toContain("has not observed Remote Control session");
    const pending = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/pending`, headers });
    expect(pending.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(pending.body)).toEqual({ pending: PENDING });
    const pendingOne = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/pending?session=${SESSION_ID}`, headers });
    expect(JSON.parse(pendingOne.body)).toEqual({ pending: PENDING });
    const pendingNone = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/pending?session=${QUIET_SESSION_ID}`, headers });
    // A tracked session with nothing pending is an empty list, not a refusal; the untracked id above is the refusal.
    expect(pendingNone.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(pendingNone.body)).toEqual({ pending: [] });
    const pendingUnknown = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/pending?session=cse_00000000-0000-4000-8000-0000000000ee`, headers });
    expect(pendingUnknown.status).toBe(HTTP_STATUS.notFound);
    const wrongMethod = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/pending`, headers, body: "{}" });
    expect(wrongMethod.status).toBe(HTTP_STATUS.methodNotAllowed);
  });

  it("carries an inject out and answers with the sequence numbers, or with the operation's verbose failure", async () => {
    const started = await serve(
      createRcControlHandler(handlerDeps({ inject: writeAnswering({ ok: false, message: "the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale" }) })),
    );
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const delivered = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: JSON.stringify({ session: SESSION_ID, text: "run the tests" }) });
    expect(delivered.status).toBe(HTTP_STATUS.badGateway);
    expect(JSON.parse(delivered.body)).toEqual({ error: "the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale" });
    const malformed = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: "{not json" });
    expect(malformed.status).toBe(HTTP_STATUS.badRequest);
    const empty = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: JSON.stringify({ session: SESSION_ID }) });
    expect(empty.status).toBe(HTTP_STATUS.badRequest);
    const unknownPath = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/elsewhere`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(unknownPath.status).toBe(HTTP_STATUS.notFound);
    const wrongMethod = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/sessions`, headers, body: "{}" });
    expect(wrongMethod.status).toBe(HTTP_STATUS.methodNotAllowed);
  });

  it("carries an answer out and answers with the sequence numbers, refusing a malformed body and an approval that carries text", async () => {
    const seen: { session: string; request: string; decision: { approve: boolean; message: string | undefined } }[] = [];
    const started = await serve(
      createRcControlHandler(
        handlerDeps({
          answer: async (session, request, decision) => {
            seen.push({ session, request, decision });
            return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
          },
        }),
      ),
    );
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const denied = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/answer`, headers, body: JSON.stringify({ session: SESSION_ID, request: REQUEST_ID, approve: false, text: "not today" }) });
    expect(denied.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(denied.body)).toEqual({ session: SESSION_ID, request: REQUEST_ID, sequenceNums: [SEQUENCE_NUM] });
    expect(seen).toEqual([{ session: SESSION_ID, request: REQUEST_ID, decision: { approve: false, message: "not today" } }]);
    const approved = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/answer`, headers, body: JSON.stringify({ session: SESSION_ID, request: REQUEST_ID, approve: true }) });
    expect(approved.status).toBe(HTTP_STATUS.ok);
    expect(seen[1]).toEqual({ session: SESSION_ID, request: REQUEST_ID, decision: { approve: true, message: undefined } });
    const approvalWithText = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/answer`, headers, body: JSON.stringify({ session: SESSION_ID, request: REQUEST_ID, approve: true, text: "go on" }) });
    expect(approvalWithText.status).toBe(HTTP_STATUS.badRequest);
    expect(errorTextOf(approvalWithText.body)).toContain("allow result has no message field");
    for (const malformed of ["{not json", JSON.stringify({ session: SESSION_ID, request: REQUEST_ID }), JSON.stringify({ session: SESSION_ID, request: REQUEST_ID, approve: "yes" }), JSON.stringify({ session: "", request: REQUEST_ID, approve: true })]) {
      const refused = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/answer`, headers, body: malformed });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
    }
    const failed = await serve(
      createRcControlHandler(handlerDeps({ answer: writeAnswering({ ok: false, message: "the front door has not observed control request req_missing pending on session cse_1: it was answered already" }) })),
    );
    running = failed;
    const verbose = await plainTransport(failed.port).request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/answer`, headers, body: JSON.stringify({ session: SESSION_ID, request: "req_missing", approve: true }) });
    expect(verbose.status).toBe(HTTP_STATUS.badGateway);
    expect(errorTextOf(verbose.body)).toContain("answered already");
  });

  it("passes the session and text it received to the inject operation", async () => {
    const seen: { session: string; text: string }[] = [];
    const started = await serve(
      createRcControlHandler(
        handlerDeps({
          inject: async (session, text) => {
            seen.push({ session, text });
            return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
          },
        }),
      ),
    );
    running = started;
    const answer = await plainTransport(started.port).request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ session: SESSION_ID, text: "run the tests" }) });
    expect(answer.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answer.body)).toEqual({ session: SESSION_ID, sequenceNums: [SEQUENCE_NUM] });
    expect(seen).toEqual([{ session: SESSION_ID, text: "run the tests" }]);
  });

  it("carries the three client-originated control requests out with each body's own fields, and refuses a malformed body and a mode the SDK's own type does not permit", async () => {
    const seen: { interrupt: string[]; setModel: [string, string][]; setPermissionMode: [string, string][] } = { interrupt: [], setModel: [], setPermissionMode: [] };
    const started = await serve(
      createRcControlHandler(
        handlerDeps({
          interrupt: async (session) => {
            seen.interrupt.push(session);
            return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
          },
          setModel: async (session, model) => {
            seen.setModel.push([session, model]);
            return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
          },
          setPermissionMode: async (session, mode) => {
            seen.setPermissionMode.push([session, mode]);
            return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
          },
        }),
      ),
    );
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const interrupted = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/interrupt`, headers, body: JSON.stringify({ session: SESSION_ID }) });
    expect(interrupted.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(interrupted.body)).toEqual({ session: SESSION_ID, sequenceNums: [SEQUENCE_NUM] });
    const modelSet = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/set-model`, headers, body: JSON.stringify({ session: SESSION_ID, model: "claude-opus-5-5" }) });
    expect(modelSet.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(modelSet.body)).toEqual({ session: SESSION_ID, sequenceNums: [SEQUENCE_NUM] });
    const modeSet = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/set-permission-mode`, headers, body: JSON.stringify({ session: SESSION_ID, mode: "plan" }) });
    expect(modeSet.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(modeSet.body)).toEqual({ session: SESSION_ID, sequenceNums: [SEQUENCE_NUM] });
    expect(seen).toEqual({ interrupt: [SESSION_ID], setModel: [[SESSION_ID, "claude-opus-5-5"]], setPermissionMode: [[SESSION_ID, "plan"]] });
    // Every malformed shape is refused before the operation runs: unreadable JSON, a missing or empty field, and a mode outside the SDK's own enum.
    for (const [path, body] of [
      [`${CONTROL_PATH_PREFIX}/interrupt`, "{not json"],
      [`${CONTROL_PATH_PREFIX}/interrupt`, JSON.stringify({})],
      [`${CONTROL_PATH_PREFIX}/interrupt`, JSON.stringify({ session: "" })],
      [`${CONTROL_PATH_PREFIX}/set-model`, JSON.stringify({ session: SESSION_ID })],
      [`${CONTROL_PATH_PREFIX}/set-model`, JSON.stringify({ session: SESSION_ID, model: "" })],
      [`${CONTROL_PATH_PREFIX}/set-permission-mode`, JSON.stringify({ session: SESSION_ID })],
      [`${CONTROL_PATH_PREFIX}/set-permission-mode`, JSON.stringify({ session: SESSION_ID, mode: "yolo" })],
      [`${CONTROL_PATH_PREFIX}/set-permission-mode`, JSON.stringify({ session: SESSION_ID, mode: "AcceptEdits" })],
    ] as const) {
      const refused = await transport.request({ method: "POST", path, headers, body });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
    }
    expect(seen).toEqual({ interrupt: [SESSION_ID], setModel: [[SESSION_ID, "claude-opus-5-5"]], setPermissionMode: [[SESSION_ID, "plan"]] });
    const wrongMethod = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/interrupt`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(wrongMethod.status).toBe(HTTP_STATUS.methodNotAllowed);
    const failed = await serve(createRcControlHandler(handlerDeps({ setPermissionMode: writeAnswering({ ok: false, message: "the front door has not observed Remote Control session cse_missing" }) })));
    running = failed;
    const verbose = await plainTransport(failed.port).request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/set-permission-mode`, headers, body: JSON.stringify({ session: SESSION_ID, mode: "plan" }) });
    expect(verbose.status).toBe(HTTP_STATUS.badGateway);
    expect(errorTextOf(verbose.body)).toContain("has not observed Remote Control session");
  });

  it("carries each verb of the wider control family out with its body's own fields, answering with the minted request id, and refuses each malformed shape before the operation runs", async () => {
    const seen: Record<string, readonly unknown[]> = {};
    const recording = (name: string) => async (...args: readonly unknown[]): Promise<RcEventWriteResult> => {
      seen[name] = args;
      return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    };
    const started = await serve(
      createRcControlHandler(
        handlerDeps({
          endSession: recording("endSession"),
          getUsage: recording("getUsage"),
          getContextUsage: recording("getContextUsage"),
          readFile: recording("readFile"),
          fileSuggestions: recording("fileSuggestions"),
          keepAlive: recording("keepAlive"),
          mcpStatus: recording("mcpStatus"),
          mcpReconnect: recording("mcpReconnect"),
          mcpAuthenticate: recording("mcpAuthenticate"),
          mcpOAuthCallbackUrl: recording("mcpOAuthCallbackUrl"),
        }),
      ),
    );
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const withRequest = { session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: [SEQUENCE_NUM] };
    const cases: readonly { readonly path: string; readonly body: unknown; readonly expectArgs: readonly unknown[] }[] = [
      { path: "end-session", body: { session: SESSION_ID, reason: "done for today" }, expectArgs: [SESSION_ID, "done for today"] },
      { path: "end-session", body: { session: SESSION_ID }, expectArgs: [SESSION_ID, undefined] },
      { path: "get-usage", body: { session: SESSION_ID, skipBehaviors: true }, expectArgs: [SESSION_ID, true] },
      { path: "get-usage", body: { session: SESSION_ID }, expectArgs: [SESSION_ID, undefined] },
      { path: "get-context-usage", body: { session: SESSION_ID, detail: "summary" }, expectArgs: [SESSION_ID, "summary"] },
      { path: "get-context-usage", body: { session: SESSION_ID }, expectArgs: [SESSION_ID, undefined] },
      { path: "read-file", body: { session: SESSION_ID, path: "src/index.ts", maxBytes: 4096, encoding: "base64" }, expectArgs: [SESSION_ID, "src/index.ts", { maxBytes: 4096, encoding: "base64" }] },
      { path: "read-file", body: { session: SESSION_ID, path: "src/index.ts" }, expectArgs: [SESSION_ID, "src/index.ts", undefined] },
      { path: "file-suggestions", body: { session: SESSION_ID, query: "src/front" }, expectArgs: [SESSION_ID, "src/front"] },
      { path: "file-suggestions", body: { session: SESSION_ID, query: "" }, expectArgs: [SESSION_ID, ""] },
      { path: "keep-alive", body: { session: SESSION_ID }, expectArgs: [SESSION_ID] },
      { path: "mcp-status", body: { session: SESSION_ID }, expectArgs: [SESSION_ID] },
      { path: "mcp-reconnect", body: { session: SESSION_ID, serverName: "github" }, expectArgs: [SESSION_ID, "github"] },
      { path: "mcp-authenticate", body: { session: SESSION_ID, serverName: "github", redirectUri: "https://example.com/cb" }, expectArgs: [SESSION_ID, "github", "https://example.com/cb"] },
      { path: "mcp-oauth-callback-url", body: { session: SESSION_ID, serverName: "github", callbackUrl: "https://example.com/cb?code=x" }, expectArgs: [SESSION_ID, "github", "https://example.com/cb?code=x"] },
    ];
    for (const testCase of cases) {
      const answered = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/${testCase.path}`, headers, body: JSON.stringify(testCase.body) });
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(JSON.parse(answered.body)).toEqual(withRequest);
    }
    expect(Object.keys(seen).sort()).toEqual(["endSession", "fileSuggestions", "getContextUsage", "getUsage", "keepAlive", "mcpAuthenticate", "mcpOAuthCallbackUrl", "mcpReconnect", "mcpStatus", "readFile"]);
    // Every malformed shape is refused before the operation runs: an empty reason, a non-boolean skipBehaviors, a detail outside the SDK's enum, an empty path, a non-positive or fractional maxBytes, an encoding outside the enum, and an empty server name or URI.
    for (const [path, body] of [
      [`${CONTROL_PATH_PREFIX}/end-session`, JSON.stringify({ session: SESSION_ID, reason: "" })],
      [`${CONTROL_PATH_PREFIX}/get-usage`, JSON.stringify({ session: SESSION_ID, skipBehaviors: "yes" })],
      [`${CONTROL_PATH_PREFIX}/get-context-usage`, JSON.stringify({ session: SESSION_ID, detail: "quick" })],
      [`${CONTROL_PATH_PREFIX}/read-file`, JSON.stringify({ session: SESSION_ID })],
      [`${CONTROL_PATH_PREFIX}/read-file`, JSON.stringify({ session: SESSION_ID, path: "" })],
      [`${CONTROL_PATH_PREFIX}/read-file`, JSON.stringify({ session: SESSION_ID, path: "src/index.ts", maxBytes: 0 })],
      [`${CONTROL_PATH_PREFIX}/read-file`, JSON.stringify({ session: SESSION_ID, path: "src/index.ts", maxBytes: 1.5 })],
      [`${CONTROL_PATH_PREFIX}/read-file`, JSON.stringify({ session: SESSION_ID, path: "src/index.ts", encoding: "hex" })],
      [`${CONTROL_PATH_PREFIX}/file-suggestions`, JSON.stringify({ session: SESSION_ID })],
      [`${CONTROL_PATH_PREFIX}/mcp-reconnect`, JSON.stringify({ session: SESSION_ID, serverName: "" })],
      [`${CONTROL_PATH_PREFIX}/mcp-authenticate`, JSON.stringify({ session: SESSION_ID, serverName: "github" })],
      [`${CONTROL_PATH_PREFIX}/mcp-oauth-callback-url`, JSON.stringify({ session: SESSION_ID, serverName: "github", callbackUrl: "" })],
    ] as const) {
      const refused = await transport.request({ method: "POST", path, headers, body });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
    }
    const wrongMethod = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/mcp-status`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(wrongMethod.status).toBe(HTTP_STATUS.methodNotAllowed);
    const failed = await serve(createRcControlHandler(handlerDeps({ mcpStatus: writeAnswering({ ok: false, message: "the front door has not observed Remote Control session cse_missing" }) })));
    running = failed;
    const verbose = await plainTransport(failed.port).request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/mcp-status`, headers, body: JSON.stringify({ session: SESSION_ID }) });
    expect(verbose.status).toBe(HTTP_STATUS.badGateway);
    expect(errorTextOf(verbose.body)).toContain("has not observed Remote Control session");
  });
});

describe("the control client", () => {
  let running: { port: number; stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("lists sessions, reads status and pending, and delivers writes through the transport, surfacing the door's verbose failure message", async () => {
    const started = await serve(createRcControlHandler(handlerDeps()));
    running = started;
    const control = frontDoorRcControl(plainTransport(started.port), TOKEN);
    expect(await control.listSessions()).toEqual(SESSIONS);
    expect(await control.statusOf()).toEqual(STATUSES);
    expect(await control.statusOf(SESSION_ID)).toEqual([STATUSES[0]]);
    expect(await control.pendingOf()).toEqual(PENDING);
    expect(await control.pendingOf(QUIET_SESSION_ID)).toEqual([]);
    expect(await control.sendPrompt(SESSION_ID, "run the tests")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    // The answer route's own answer names the request it answered, so the client surfaces the same id back.
    expect(await control.answerRequest(SESSION_ID, REQUEST_ID, { approve: false, message: "not today" })).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: REQUEST_ID });
    expect(await control.interruptSession(SESSION_ID)).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    expect(await control.setModel(SESSION_ID, "claude-opus-5-5")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    expect(await control.setPermissionMode(SESSION_ID, "dontAsk")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    // The wider family's scripted deps answer with the minted request id, so each client method surfaces it beside the sequence numbers; the keep-alive dep names none, and its result carries no request id, exactly as the payload's own contract says.
    expect(await control.endSession(SESSION_ID, "done for today")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.getUsage(SESSION_ID, true)).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.getContextUsage(SESSION_ID, "summary")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.readFile(SESSION_ID, "src/index.ts", { maxBytes: 4096, encoding: "base64" })).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.fileSuggestions(SESSION_ID, "src/front")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.keepAlive(SESSION_ID)).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    expect(await control.mcpStatus(SESSION_ID)).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.mcpReconnect(SESSION_ID, "github")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.mcpAuthenticate(SESSION_ID, "github", "https://example.com/cb")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await control.mcpOAuthCallbackUrl(SESSION_ID, "github", "https://example.com/cb?code=x")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    await expect(control.statusOf("cse_00000000-0000-4000-8000-0000000000ff")).rejects.toThrow("has not observed Remote Control session");
    await started.stop();
    const unreachable = await frontDoorRcControl(plainTransport(started.port), TOKEN).sendPrompt(SESSION_ID, "hello");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.message).toContain("could not reach the front door's control listener");
    }
    const unreachableAnswer = await frontDoorRcControl(plainTransport(started.port), TOKEN).answerRequest(SESSION_ID, REQUEST_ID, { approve: true, message: undefined });
    expect(unreachableAnswer.ok).toBe(false);
    if (!unreachableAnswer.ok) {
      expect(unreachableAnswer.message).toContain("could not reach the front door's control listener");
    }
    const unreachableInterrupt = await frontDoorRcControl(plainTransport(started.port), TOKEN).interruptSession(SESSION_ID);
    expect(unreachableInterrupt.ok).toBe(false);
    if (!unreachableInterrupt.ok) {
      expect(unreachableInterrupt.message).toContain("could not reach the front door's control listener");
    }
    await expect(frontDoorRcControl(plainTransport(started.port), TOKEN).statusOf()).rejects.toThrow("could not reach the front door's control listener");
  });
});

describe("the real control transport's TLS", () => {
  let ca: CaMaterial;
  let server: https.Server | undefined;

  beforeEach(() => {
    ca = generateCa(new Date());
  }, KEYGEN_TIMEOUT_MS);

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve(undefined);
        });
      });
    }
    server = undefined;
  });

  it("reaches a listener whose leaf chains to the given CA, and refuses one signed by any other", async () => {
    const otherCa = generateCa(new Date());
    const leaf = mintLeaf(ca, [...LOOPBACK_LEAF_NAMES], new Date());
    server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions: SESSIONS }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    const answer = await realRcControlTransport(address.port, ca.certPem).request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(answer.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answer.body)).toEqual({ sessions: SESSIONS });
    // A listener holding the port whose certificate chains elsewhere fails the handshake, which is the proof a squatter cannot answer as the door.
    await expect(realRcControlTransport(address.port, otherCa.certPem).request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: {} })).rejects.toThrow();
  }, KEYGEN_TIMEOUT_MS);
});
