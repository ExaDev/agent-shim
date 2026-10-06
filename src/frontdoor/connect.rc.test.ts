import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
// Named for the module, not `path`: this file's request helpers take a `path` parameter, which an import of the same name would shadow.
import nodePath from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { realFarmFs } from "../realPorts";
import { CONNECT_INTERCEPT_HOST, LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS, RC_TEST_SEQUENCE_NUM, RC_TEST_SESSION_ID, HTTP_OK, SETTLE_MS, TEST_CAPABILITY, connectRedirected, connectThroughProxy, makeTlsWorld, requestOn, settle } from "./connectTestWorld";
import { createRcApiNodeHandler, frontDoorRcApiClient } from "./rcApi";
import { createRcControlHandler, frontDoorRcControl, realRcControlTransport, type RcControlTransport } from "./rcControl";
import { createRcCredentialStore } from "./rcCredentialStore";
import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import { answerRcControlRequest, authenticateRcSessionMcpServer, endRcSession, getRcSessionContextUsage, getRcSessionMcpStatus, getRcSessionUsage, injectRcUserMessage, interruptRcSession, readRcSessionFile, reconnectRcSessionMcpServer, sendRcKeepAlive, setRcSessionModel, setRcSessionPermissionMode, submitRcSessionMcpOAuthCallbackUrl, suggestRcSessionFiles, type RcAnswerDecision, type RcContextUsageDetail, type RcEventDial, type RcEventWriteResult, type RcPermissionMode, type RcReadFileOptions } from "./rcWrites";
import { RC_STREAM_BACKOFF_MS, createRcEventFanout, createRcStreamHub, type RcStreamHub } from "./rcStream";
import type { RcStreamEvent } from "./rcSchemas";
import { createFrontDoorServer } from "./server";

/** The bearers the fake CLI presents, one per credential kind: the OAuth bearer the create carries (the client half's credential, the one an injected write must replay), and the worker JWT its recurring worker calls carry (a different kind that must never displace it, observed live as a 401 when replayed on the client half). */
const CREATE_BEARER = "Bearer sk-ant-oat";
const HEARTBEAT_BEARER = "Bearer eyJhbGciOiJFUzI1NiJ9.e2e.worker.jwt";
/** The protocol headers the fake CLI sends on every Remote Control call, which the injected write must replay. */
const VERSION = "2023-06-01";
const PLATFORM = "desktop_app";
/** The token the control handler and its client share in these tests, standing in for the door's per-generation file-backed token. */
const CONTROL_TOKEN = "e2e-control-token";
/** The id the scripted can_use_tool control request carries, which the answered control_response must echo. */
const RC_TEST_REQUEST_ID = "req_00000000-0000-4000-8000-00000000000a";
/** The idle the scripted heartbeat carries, so the status assertion names the protocol's own number rather than a bare literal. */
const RC_TEST_IDLE_SECONDS = 7;
/** The model id and permission mode the scripted set-model and set-permission-mode writes carry, of the shapes the SDK's own fields take. */
const RC_TEST_MODEL_ID = "claude-opus-5-5";
const RC_TEST_PERMISSION_MODE = "plan" as const satisfies RcPermissionMode;
/** How many client-half event writes the three control request operations produce: one per operation, in the order the test drives them. */
const CONTROL_REQUEST_WRITE_COUNT = 3;
/** The sequence number the scripted stream event carries, higher than the write path's fixed answer so the resume assertions name the cursor's own maximum rather than a number both paths could have produced. */
const STREAM_SEQUENCE_NUM = 12;
/** The event the generation-two stream delivers, one past the cursor that generation persisted: a resumed stream continues after its cursor, so the number it carries is the next one. */
const STREAM_RESUMED_SEQUENCE_NUM = 13;
/**
 * How long the attachment e2e may wait for a condition the door's detached loop produces (a dial landing, a pending birth). Loopback TLS handshakes and the loop itself run in milliseconds; the bound exists only so an overloaded machine fails visibly instead of hanging the suite, and is generous against the keygen-heavy world these tests run in.
 */
const E2E_WAIT_BUDGET_MS = 5_000;

/** Waits until the condition holds, polling at the world's own settle cadence, failing loudly at the budget rather than hanging. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + E2E_WAIT_BUDGET_MS;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("the door did not reach the awaited state within the test's wait budget");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
  }
}

/** The first event's payload of one event-write body, narrowed field by field from its parsed JSON rather than reached into as `any`. */
function firstPayloadOf(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("events" in parsed) || !Array.isArray(parsed.events)) {
    return undefined;
  }
  const events: readonly unknown[] = parsed.events;
  const first = events[0];
  if (typeof first !== "object" || first === null || !("payload" in first)) {
    return undefined;
  }
  return first.payload;
}

/** Sends one content-length framed POST on the TLS session, the way the CLI's own HTTP stack would. */
async function postOn(secure: Parameters<typeof requestOn>[0], path: string, bearer: string, body: string): Promise<ReturnType<typeof requestOn>> {
  return await requestOn(
    secure,
    `POST ${path} HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nAuthorization: ${bearer}\r\nanthropic-version: ${VERSION}\r\nanthropic-client-platform: ${PLATFORM}\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`,
  );
}

/**
 * The three client-originated control request operations as the control route wires them: the tracker's observed credential and the door's real dial code redirected at the stand-in API host, with the given request-id mint.
 */
function controlRequestOperations(tracker: RcSessionTracker, dial: RcEventDial, newUuid: () => string) {
  const deps = { credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid };
  return {
    interrupt: async (sessionId: string) => await interruptRcSession(deps, sessionId),
    setModel: async (sessionId: string, model: string) => await setRcSessionModel(deps, sessionId, model),
    setPermissionMode: async (sessionId: string, mode: RcPermissionMode) => await setRcSessionPermissionMode(deps, sessionId, mode),
    endSession: async (sessionId: string, reason: string | undefined) => await endRcSession(deps, sessionId, reason),
    getUsage: async (sessionId: string, skipBehaviors: boolean | undefined) => await getRcSessionUsage(deps, sessionId, skipBehaviors),
    getContextUsage: async (sessionId: string, detail: RcContextUsageDetail | undefined) => await getRcSessionContextUsage(deps, sessionId, detail),
    readFile: async (sessionId: string, path: string, options: RcReadFileOptions | undefined) => await readRcSessionFile(deps, sessionId, path, options),
    fileSuggestions: async (sessionId: string, query: string) => await suggestRcSessionFiles(deps, sessionId, query),
    keepAlive: async (sessionId: string) => await sendRcKeepAlive(deps, sessionId),
    mcpStatus: async (sessionId: string) => await getRcSessionMcpStatus(deps, sessionId),
    mcpReconnect: async (sessionId: string, serverName: string) => await reconnectRcSessionMcpServer(deps, sessionId, serverName),
    mcpAuthenticate: async (sessionId: string, serverName: string, redirectUri: string) => await authenticateRcSessionMcpServer(deps, sessionId, serverName, redirectUri),
    mcpOAuthCallbackUrl: async (sessionId: string, serverName: string, callbackUrl: string) => await submitRcSessionMcpOAuthCallbackUrl(deps, sessionId, serverName, callbackUrl),
  };
}

/** The PUT sibling, for the worker registration the protocol documents as PUT-not-POST. */
async function putOn(secure: Parameters<typeof requestOn>[0], path: string, bearer: string, body: string): Promise<ReturnType<typeof requestOn>> {
  return await requestOn(
    secure,
    `PUT ${path} HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nAuthorization: ${bearer}\r\nanthropic-version: ${VERSION}\r\nanthropic-client-platform: ${PLATFORM}\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`,
  );
}

/** The plain-HTTP control transport these tests speak, the handler being transport-agnostic. */
const loopbackTransport = (port: number): RcControlTransport => ({
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
});

describe("Remote Control observation and injection over the connect surface", () => {
  let ca: CaMaterial;
  let upstreamCa: CaMaterial;
  let tracker: RcSessionTracker;

  beforeAll(() => {
    ca = generateCa(new Date());
    upstreamCa = generateCa(new Date());
    tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
  }, KEYGEN_TIMEOUT_MS);

  it(
    "records the session and bearer the door observed from the CLI's own calls, and injects through the door's dial so the API host receives the client-half write",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { rc: { tracker } });
      const { connectPort, rcDial, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        // The CLI creates its Remote Control session through the door: the create is a routed /v1/ path, answered by the stand-in for the real API.
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));
        expect(JSON.parse(create.body)).toEqual({ session: { id: RC_TEST_SESSION_ID } });
        // The observation rides the same forwarding the capture does, so its end can trail the parsed response by a tick.
        await settle();
        expect(world.routedRequests.map((seen) => seen.url)).toEqual(["/v1/code/sessions"]);
        expect(world.routedRequests[0]?.headers.authorization).toBe(CREATE_BEARER);
        expect(tracker.list().map((session) => session.id)).toEqual([RC_TEST_SESSION_ID]);
        expect(tracker.credentialOf(RC_TEST_SESSION_ID)).toEqual({ authorization: CREATE_BEARER, anthropicVersion: VERSION, anthropicClientPlatform: PLATFORM });

        // The worker's recurring call carries the worker JWT: it refreshes the entry's liveness without displacing the OAuth bearer the write must replay.
        const heartbeat = await postOn(secure, `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker/heartbeat`, HEARTBEAT_BEARER, JSON.stringify({ session_id: RC_TEST_SESSION_ID }));
        expect(heartbeat.statusLine).toContain(String(HTTP_OK));
        await settle();
        expect(tracker.credentialOf(RC_TEST_SESSION_ID)?.authorization).toBe(CREATE_BEARER);

        // The inject operation, driven the way the door's control route drives it: the tracker's observed credential, and the door's real dial code redirected at the stand-in API host.
        const delivered = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: rcDial, newUuid: () => "uuid-e2e" }, RC_TEST_SESSION_ID, "run the tests");
        expect(delivered).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM] });

        // The API host received the documented client-half write: the session's events endpoint, the observed bearer, and the user-message payload in its event envelope.
        const write = world.upstreamRequests.find((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/events`);
        expect(write).toBeDefined();
        expect(write?.method).toBe("POST");
        expect(write?.headers.authorization).toBe(CREATE_BEARER);
        expect(write?.headers["anthropic-version"]).toBe(VERSION);
        expect(write?.headers["anthropic-client-platform"]).toBe(PLATFORM);
        expect(write?.headers.host).toBe(CONNECT_INTERCEPT_HOST);
        expect(JSON.parse(write?.body ?? "{}")).toEqual({
          events: [
            {
              payload: {
                type: "user",
                uuid: "uuid-e2e",
                session_id: RC_TEST_SESSION_ID,
                parent_tool_use_id: null,
                message: { role: "user", content: "run the tests" },
              },
            },
          ],
        });
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "exposes the observed session and the inject operation over the control surface",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { rc: { tracker } });
      const { connectPort, rcDial, close } = await world.start();
      const server = http.createServer(
        createRcControlHandler({
          expectedToken: CONTROL_TOKEN,
          list: tracker.list,
          statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
          pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
          inject: async (sessionId, text) => await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: rcDial, newUuid: () => "uuid-e2e-control" }, sessionId, text),
          answer: async (sessionId, requestId, decision) => await answerRcControlRequest({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision),
          ...controlRequestOperations(tracker, rcDial, () => "uuid-e2e-control"),
        }),
      );
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));
        await settle();
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            resolve(undefined);
          });
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("expected a bound TCP server");
        }
        const client = frontDoorRcControl(loopbackTransport(address.port), CONTROL_TOKEN);

        const sessions = await client.listSessions();
        expect(sessions.map((session) => session.id)).toEqual([RC_TEST_SESSION_ID]);
        expect(sessions[0]?.createdAt).toBeGreaterThan(0);
        expect(sessions[0]?.lastSeenAt).toBeGreaterThanOrEqual(sessions[0]?.createdAt ?? 0);

        const delivered = await client.sendPrompt(RC_TEST_SESSION_ID, "run the tests again");
        expect(delivered).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM] });
        expect(world.upstreamRequests.filter((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/events`).length).toBe(1);
        const refused = await client.sendPrompt("cse_00000000-0000-4000-8000-0000000000ff", "anyone there");
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
          expect(refused.message).toContain("has not observed");
        }
        secure.destroy();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve(undefined);
          });
        });
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "observes a pending can_use_tool from the CLI's own worker event write, lists and answers it over the control surface, and the API host receives the control_response with the observed bearer and echoed id",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { rc: { tracker } });
      const { connectPort, rcDial, close } = await world.start();
      const answer = async (sessionId: string, requestId: string, decision: RcAnswerDecision): Promise<RcEventWriteResult> =>
        await answerRcControlRequest({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision);
      const server = http.createServer(
        createRcControlHandler({
          expectedToken: CONTROL_TOKEN,
          list: tracker.list,
          statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
          pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
          inject: async (sessionId, text) => await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: rcDial, newUuid: () => "uuid-e2e-answer" }, sessionId, text),
          answer,
          ...controlRequestOperations(tracker, rcDial, () => "uuid-e2e-answer"),
        }),
      );
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));
        await settle();

        // The CLI registers its worker and heartbeats, then posts the event batch carrying the approval request, exactly the writes the door observes on a real session.
        const register = await putOn(secure, `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker`, HEARTBEAT_BEARER, JSON.stringify({ worker_status: "WORKER_STATUS_RUNNING", worker_epoch: 1 }));
        expect(register.statusLine).toContain(String(HTTP_OK));
        const heartbeat = await postOn(secure, `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker/heartbeat`, HEARTBEAT_BEARER, JSON.stringify({ session_id: RC_TEST_SESSION_ID, worker_epoch: 1, supports_heartbeat_probe: true, current_interval_seconds: 20, idle_seconds: RC_TEST_IDLE_SECONDS }));
        expect(heartbeat.statusLine).toContain(String(HTTP_OK));
        const workerEvents = await postOn(
          secure,
          `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker/events`,
          HEARTBEAT_BEARER,
          JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "control_request", request_id: RC_TEST_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } } }] }),
        );
        expect(workerEvents.statusLine).toContain(String(HTTP_OK));
        // The observation rides the same forwarding the capture does, so its end can trail the parsed response by a tick.
        await settle();

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            resolve(undefined);
          });
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("expected a bound TCP server");
        }
        const client = frontDoorRcControl(loopbackTransport(address.port), CONTROL_TOKEN);

        // The status the door already observes: the worker's own registration and heartbeat, and the request awaiting an answer.
        const statuses = await client.statusOf(RC_TEST_SESSION_ID);
        expect(statuses.map((status) => status.id)).toEqual([RC_TEST_SESSION_ID]);
        expect(statuses[0]?.workerState?.value).toBe("WORKER_STATUS_RUNNING");
        expect(statuses[0]?.workerIdleSeconds?.value).toBe(RC_TEST_IDLE_SECONDS);
        expect(statuses[0]?.pending.map((pending) => pending.requestId)).toEqual([RC_TEST_REQUEST_ID]);

        const pending = await client.pendingOf();
        expect(pending).toEqual([
          { sessionId: RC_TEST_SESSION_ID, requestId: RC_TEST_REQUEST_ID, type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: expect.any(Number) as unknown },
        ]);

        // The answer, driven the way the door's control route drives it: the tracker's observed credential, and the door's real dial code redirected at the stand-in API host. The client surfaces the answered request id back, the same id the route's answer names.
        const approved = await client.answerRequest(RC_TEST_SESSION_ID, RC_TEST_REQUEST_ID, { approve: true, message: undefined });
        expect(approved).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM], requestId: RC_TEST_REQUEST_ID });
        expect(await client.pendingOf(RC_TEST_SESSION_ID)).toEqual([]);
        const answeredAgain = await client.answerRequest(RC_TEST_SESSION_ID, RC_TEST_REQUEST_ID, { approve: true, message: undefined });
        expect(answeredAgain.ok).toBe(false);
        if (!answeredAgain.ok) {
          expect(answeredAgain.message).toContain("not observed control request");
        }

        // The API host received the documented client-half write: the session's events endpoint, the observed bearer, and the control_response echoing the request's id.
        const write = world.upstreamRequests.find((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/events`);
        expect(write).toBeDefined();
        expect(write?.method).toBe("POST");
        expect(write?.headers.authorization).toBe(CREATE_BEARER);
        expect(write?.headers["anthropic-version"]).toBe(VERSION);
        expect(write?.headers["anthropic-client-platform"]).toBe(PLATFORM);
        expect(write?.headers.host).toBe(CONNECT_INTERCEPT_HOST);
        expect(JSON.parse(write?.body ?? "{}")).toEqual({
          events: [
            {
              payload: {
                type: "control_response",
                response: { subtype: "success", request_id: RC_TEST_REQUEST_ID, response: { behavior: "allow" } },
              },
            },
          ],
        });
        secure.destroy();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve(undefined);
          });
        });
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "sends the client half's own control requests (interrupt, set_model, set_permission_mode) over the control surface, and the API host receives each write with the observed bearer and the SDK's request envelope",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { rc: { tracker } });
      const { connectPort, rcDial, close } = await world.start();
      // Each operation mints its own request id, the id the worker's response echoes, so the three asserted envelopes name three distinct minted values.
      let minted = 0;
      const server = http.createServer(
        createRcControlHandler({
          expectedToken: CONTROL_TOKEN,
          list: tracker.list,
          statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
          pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
          inject: async (sessionId, text) => await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: rcDial, newUuid: () => "uuid-e2e-control" }, sessionId, text),
          answer: async (sessionId, requestId, decision) => await answerRcControlRequest({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision),
          ...controlRequestOperations(tracker, rcDial, () => `uuid-e2e-control-request-${String(++minted)}`),
        }),
      );
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));
        await settle();

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            resolve(undefined);
          });
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("expected a bound TCP server");
        }
        const client = frontDoorRcControl(loopbackTransport(address.port), CONTROL_TOKEN);

        // Each write is driven the way the door's control route drives it: the tracker's observed credential, and the door's real dial code redirected at the stand-in API host. Each result names the request id its own write minted, in minting order.
        expect(await client.interruptSession(RC_TEST_SESSION_ID)).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM], requestId: "uuid-e2e-control-request-1" });
        expect(await client.setModel(RC_TEST_SESSION_ID, RC_TEST_MODEL_ID)).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM], requestId: "uuid-e2e-control-request-2" });
        expect(await client.setPermissionMode(RC_TEST_SESSION_ID, RC_TEST_PERMISSION_MODE)).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM], requestId: "uuid-e2e-control-request-3" });

        // The API host received each documented client-half write: the session's events endpoint, the observed bearer, and the SDK's control_request envelope for its subtype.
        const writes = world.upstreamRequests.filter((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/events`);
        expect(writes).toHaveLength(CONTROL_REQUEST_WRITE_COUNT);
        for (const write of writes) {
          expect(write.method).toBe("POST");
          expect(write.headers.authorization).toBe(CREATE_BEARER);
          expect(write.headers["anthropic-version"]).toBe(VERSION);
          expect(write.headers["anthropic-client-platform"]).toBe(PLATFORM);
          expect(write.headers.host).toBe(CONNECT_INTERCEPT_HOST);
        }
        expect(writes.map((write) => firstPayloadOf(write.body))).toEqual([
          { type: "control_request", request_id: "uuid-e2e-control-request-1", request: { subtype: "interrupt" } },
          { type: "control_request", request_id: "uuid-e2e-control-request-2", request: { subtype: "set_model", model: RC_TEST_MODEL_ID } },
          { type: "control_request", request_id: "uuid-e2e-control-request-3", request: { subtype: "set_permission_mode", mode: RC_TEST_PERMISSION_MODE } },
        ]);
        secure.destroy();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve(undefined);
          });
        });
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "attaches the client read stream with presence, surfaces and answers a stream-borne approval, streams the events to a typed subscriber, and resumes after a drop with the documented pair",
    async () => {
      // The hub is built after the world starts (its dial needs the stand-in's port) but before any exchange crosses the surface, so the settle hook the world fires finds it from the first create on.
      let hub: RcStreamHub | undefined;
      const world = makeTlsWorld(ca, upstreamCa, { rc: { tracker, onExchangeSettled: () => hub?.reconcile() } });
      const { connectPort, rcDial, rcStreamDial, close } = await world.start();
      const fanout = createRcEventFanout();
      const rcInject = async (sessionId: string, text: string) =>
        await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: rcDial, newUuid: () => "uuid-e2e-stream" }, sessionId, text);
      const rcAnswer = async (sessionId: string, requestId: string, decision: RcAnswerDecision): Promise<RcEventWriteResult> =>
        await answerRcControlRequest({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision);
      const controlDeps = {
        expectedToken: CONTROL_TOKEN,
        list: tracker.list,
        statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
        pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
        inject: rcInject,
        answer: rcAnswer,
        ...controlRequestOperations(tracker, rcDial, () => "uuid-e2e-stream"),
      };
      // The real listener shape: the same server builder the door uses, with both pre-pipeline surfaces mounted, over TLS signed by the world's CA. The typed API's handle is wrapped only to record that the subscription request landed, because the fan-out holds no replay: an event published before a subscriber's request arrives is simply not seen by that subscriber.
      const apiSurface = createRcApiNodeHandler({ ...controlDeps, fanout });
      const apiRequests: string[] = [];
      // No routed path exists in this test, so a request that reaches the pipeline completes without one; the log goes nowhere, as the server tests' own stand-in listener does.
      const server = createFrontDoorServer(
        async () => {
          await Promise.resolve();
        },
        () => undefined,
        mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
        createRcControlHandler(controlDeps),
        [{ ...apiSurface, handle: async (request, response) => { apiRequests.push(request.url ?? ""); return await apiSurface.handle(request, response); } }],
      );
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        hub = createRcStreamHub({
          now: () => Date.now(),
          credentialOf: tracker.credentialOf,
          trackedSessions: () => tracker.list().map((session) => session.id),
          fileStreamEvent: tracker.fileStreamEvent,
          sequenceNumOf: tracker.sequenceNumOf,
          dial: rcStreamDial,
          fanout,
          newClientId: () => "e2e-door-client",
          backoffMs: RC_STREAM_BACKOFF_MS,
          sleep: async (ms) => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            });
          },
        });
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));

        // The create's own settled exchange pokes the attachment: the door announced one stable client id and opened the stream, with the observed OAuth bearer and no resume (nothing has been seen yet).
        await until(() => world.rcStreamRequests.length === 1);
        const presence = world.upstreamRequests.find((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/client/presence`);
        expect(presence).toBeDefined();
        expect(presence?.method).toBe("POST");
        expect(presence?.headers.authorization).toBe(CREATE_BEARER);
        expect(presence?.headers["anthropic-version"]).toBe(VERSION);
        expect(JSON.parse(presence?.body ?? "{}")).toEqual({ client_id: "e2e-door-client", clear: false });
        const firstStream = world.rcStreamRequests[0];
        expect(firstStream?.method).toBe("GET");
        expect(firstStream?.headers.authorization).toBe(CREATE_BEARER);
        expect(firstStream?.headers.accept).toBe("text/event-stream");
        expect(firstStream?.url).not.toContain("from_sequence_num");

        // A typed subscriber over the door's real TLS, the same client the watch verb uses.
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            resolve(undefined);
          });
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("expected a bound TCP server");
        }
        const api = frontDoorRcApiClient(address.port, ca.certPem, CONTROL_TOKEN);
        // A caller without this generation's control token is refused by the typed API exactly as the bespoke routes refuse it.
        const wrongToken = frontDoorRcApiClient(address.port, ca.certPem, "not-the-control-token");
        await expect(wrongToken.rc.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        const received: RcStreamEvent[] = [];
        const stopWatching = new AbortController();
        const watching = (async () => {
          for await (const event of await api.rc.subscribe({ session: RC_TEST_SESSION_ID }, { signal: stopWatching.signal })) {
            received.push(event);
          }
        })();
        await until(() => apiRequests.some((url) => url.includes("/rc/subscribe")));

        // A control_request arrives on the stream (source worker, the live finding's shape): it births a pending entry exactly as an observed worker-event body would, and the subscriber sees the event.
        world.writeRcSse(
          `event: client_event\nid: ${String(STREAM_SEQUENCE_NUM)}\ndata: ${JSON.stringify({
            event_id: "ev-stream-1",
            event_type: "control_request",
            sequence_num: STREAM_SEQUENCE_NUM,
            source: "worker",
            payload: { type: "control_request", request_id: RC_TEST_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } },
            created_at: "2026-10-05T12:00:00Z",
          })}\n\n`,
        );
        await until(() => tracker.pendingOf(RC_TEST_SESSION_ID).length === 1);
        // The control client over the same TLS the CLI's own verbs use, since this server is the door's real listener shape rather than a plain-HTTP stand-in.
        const client = frontDoorRcControl(realRcControlTransport(address.port, ca.certPem), CONTROL_TOKEN);
        const pending = await client.pendingOf(RC_TEST_SESSION_ID);
        expect(pending.map((entry) => entry.requestId)).toEqual([RC_TEST_REQUEST_ID]);
        expect(pending[0]?.type).toBe("can_use_tool");
        expect(tracker.sequenceNumOf(RC_TEST_SESSION_ID)).toBe(STREAM_SEQUENCE_NUM);
        await until(() => received.length === 1);
        expect(received[0]?.session).toBe(RC_TEST_SESSION_ID);
        expect(received[0]?.envelope).toEqual({
          event_id: "ev-stream-1",
          event_type: "control_request",
          sequence_num: STREAM_SEQUENCE_NUM,
          source: "worker",
          payload: { type: "control_request", request_id: RC_TEST_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } },
          created_at: "2026-10-05T12:00:00Z",
        });

        // The answer responds through the write path that is already live-proven, and the door's own confirmed delivery advances the same cursor the resume continues from (without ever lowering it past the stream's own events).
        const approved = await client.answerRequest(RC_TEST_SESSION_ID, RC_TEST_REQUEST_ID, { approve: true, message: undefined });
        expect(approved).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM], requestId: RC_TEST_REQUEST_ID });
        expect(await client.pendingOf(RC_TEST_SESSION_ID)).toEqual([]);
        const write = world.upstreamRequests.find((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/events`);
        expect(write?.headers.authorization).toBe(CREATE_BEARER);
        expect(JSON.parse(write?.body ?? "{}")).toEqual({
          events: [{ payload: { type: "control_response", response: { subtype: "success", request_id: RC_TEST_REQUEST_ID, response: { behavior: "allow" } } } }],
        });

        // A drop reconnects with the documented resume pair together: the query parameter and the Last-Event-ID header, naming the highest sequence number the door has seen.
        world.endRcSse();
        await until(() => world.rcStreamRequests.length === 2);
        const resumed = world.rcStreamRequests[1];
        expect(resumed?.url.endsWith(`/v1/code/sessions/${RC_TEST_SESSION_ID}/events/stream?from_sequence_num=${String(STREAM_SEQUENCE_NUM)}`)).toBe(true);
        expect(resumed?.headers["last-event-id"]).toBe(String(STREAM_SEQUENCE_NUM));
        expect(resumed?.headers.authorization).toBe(CREATE_BEARER);

        stopWatching.abort();
        await watching.catch(() => {
          // Leaving the subscription aborts its request; the iterator ending on that abort is the expected shape, not a failure to surface.
        });
        secure.destroy();
      } finally {
        hub?.close();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve(undefined);
          });
          server.closeAllConnections();
        });
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "reattaches over the transparent surface on a door generation that starts after the session's create, reading the persisted credential its worker-only traffic cannot restate and resuming its stream from the persisted sequence cursor",
    async () => {
      // The door's own credential directory, outliving either generation exactly as the front-door directory does: generation one observes the create's OAuth bearer and persists it; generation two starts with empty in-memory tracker state and only the worker's recurring traffic crossing it, which is the live shape of a door that restarted mid-session (the rig's silent hub).
      const credentialsDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rc-credentials-"));
      const store = createRcCredentialStore(realFarmFs, credentialsDir);
      try {
        const trackerOne = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
        let hubOne: RcStreamHub | undefined;
        const generationOne = makeTlsWorld(ca, upstreamCa, {
          transparent: { port: 0, capability: TEST_CAPABILITY },
          rc: { tracker: trackerOne, onExchangeSettled: () => hubOne?.reconcile() },
        });
        const first = await generationOne.start();
        try {
          // The create arrives the way the rig's redirected traffic does: no proxy handshake, no capability header, straight into the transparent surface.
          const secure = await connectRedirected(first.transparentPort ?? 0, CONNECT_INTERCEPT_HOST, ca.certPem);
          hubOne = createRcStreamHub({
            now: () => Date.now(),
            credentialOf: trackerOne.credentialOf,
            trackedSessions: () => trackerOne.list().map((session) => session.id),
            fileStreamEvent: trackerOne.fileStreamEvent,
            sequenceNumOf: trackerOne.sequenceNumOf,
            storedSequenceNumOf: store.readCursor,
            saveSequenceNum: store.writeCursor,
            dial: first.rcStreamDial,
            fanout: createRcEventFanout(),
            newClientId: () => "e2e-generation-one",
            backoffMs: RC_STREAM_BACKOFF_MS,
            sleep: async (ms) => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, ms);
              });
            },
          });
          const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
          expect(create.statusLine).toContain(String(HTTP_OK));
          // The create's own settled exchange pokes the attachment, and the generation that saw the OAuth bearer attaches.
          await until(() => generationOne.rcStreamRequests.length === 1);
          expect(store.read(RC_TEST_SESSION_ID)?.authorization).toBe(CREATE_BEARER);
          expect(store.readCursor(RC_TEST_SESSION_ID)).toBeUndefined();

          // One event crosses the held stream, and then the stream ends the way the real host ends one: the drop is the attachment boundary where the cursor it reached is persisted, beside the credential the same file already held.
          generationOne.writeRcSse(
            `event: client_event\nid: ${String(STREAM_SEQUENCE_NUM)}\ndata: ${JSON.stringify({
              event_id: "ev-first-generation",
              event_type: "user",
              sequence_num: STREAM_SEQUENCE_NUM,
              source: "worker",
              payload: { type: "user" },
              created_at: "2026-10-05T12:00:00Z",
            })}\n\n`,
          );
          await until(() => trackerOne.sequenceNumOf(RC_TEST_SESSION_ID) === STREAM_SEQUENCE_NUM);
          generationOne.endRcSse();
          await until(() => generationOne.rcStreamRequests.length === 2);
          expect(store.readCursor(RC_TEST_SESSION_ID)).toBe(STREAM_SEQUENCE_NUM);
          expect(store.read(RC_TEST_SESSION_ID)?.authorization).toBe(CREATE_BEARER);
          secure.destroy();
        } finally {
          hubOne?.close();
          await first.close();
          await generationOne.stop();
        }

        // Generation two: a fresh tracker over the same store, a fresh surface, and a session that already exists. Only the worker's recurring calls cross it, and they carry the worker JWT, so the persisted credential is the only statement of the OAuth bearer this generation can ever see.
        const trackerTwo = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
        let hubTwo: RcStreamHub | undefined;
        const generationTwo = makeTlsWorld(ca, upstreamCa, {
          transparent: { port: 0, capability: TEST_CAPABILITY },
          rc: { tracker: trackerTwo, onExchangeSettled: () => hubTwo?.reconcile() },
        });
        const second = await generationTwo.start();
        try {
          const secure = await connectRedirected(second.transparentPort ?? 0, CONNECT_INTERCEPT_HOST, ca.certPem);
          hubTwo = createRcStreamHub({
            now: () => Date.now(),
            credentialOf: trackerTwo.credentialOf,
            trackedSessions: () => trackerTwo.list().map((session) => session.id),
            fileStreamEvent: trackerTwo.fileStreamEvent,
            sequenceNumOf: trackerTwo.sequenceNumOf,
            storedSequenceNumOf: store.readCursor,
            saveSequenceNum: store.writeCursor,
            dial: second.rcStreamDial,
            fanout: createRcEventFanout(),
            newClientId: () => "e2e-generation-two",
            backoffMs: RC_STREAM_BACKOFF_MS,
            sleep: async (ms) => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, ms);
              });
            },
          });
          const heartbeat = await postOn(secure, `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker/heartbeat`, HEARTBEAT_BEARER, JSON.stringify({ session_id: RC_TEST_SESSION_ID }));
          expect(heartbeat.statusLine).toContain(String(HTTP_OK));
          // The heartbeat's settled exchange pokes the attachment, and the persisted credential is what the announcement and the stream replay: without it this generation never attaches at all, which is the defect the live rig exposed.
          await until(() => generationTwo.rcStreamRequests.length === 1);
          const presence = generationTwo.upstreamRequests.find((seen) => seen.url === `/v1/code/sessions/${RC_TEST_SESSION_ID}/client/presence`);
          expect(presence?.headers.authorization).toBe(CREATE_BEARER);
          expect(JSON.parse(presence?.body ?? "{}")).toEqual({ client_id: "e2e-generation-two", clear: false });
          const stream = generationTwo.rcStreamRequests[0];
          expect(stream?.headers.authorization).toBe(CREATE_BEARER);
          // The persisted cursor is what the reattachment resumes from: this generation's memory holds no number (it never saw the traffic that produced it), so without the store it would name no cursor and re-read the stream from its head.
          expect(stream?.url.endsWith(`/v1/code/sessions/${RC_TEST_SESSION_ID}/events/stream?from_sequence_num=${String(STREAM_SEQUENCE_NUM)}`)).toBe(true);
          expect(stream?.headers["last-event-id"]).toBe(String(STREAM_SEQUENCE_NUM));

          // The reattached stream is a live one: a control_request written to it becomes a pending request the door can answer, exactly as the rig's approval does.
          generationTwo.writeRcSse(
            `event: client_event\nid: ${String(STREAM_RESUMED_SEQUENCE_NUM)}\ndata: ${JSON.stringify({
              event_id: "ev-restart-1",
              event_type: "control_request",
              sequence_num: STREAM_RESUMED_SEQUENCE_NUM,
              source: "worker",
              payload: { type: "control_request", request_id: RC_TEST_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } },
              created_at: "2026-10-05T12:00:00Z",
            })}\n\n`,
          );
          await until(() => trackerTwo.pendingOf(RC_TEST_SESSION_ID).length === 1);
          secure.destroy();
        } finally {
          hubTwo?.close();
          await second.close();
          await generationTwo.stop();
        }
      } finally {
        fs.rmSync(credentialsDir, { recursive: true, force: true });
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
