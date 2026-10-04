import * as http from "node:http";

import { beforeAll, describe, expect, it } from "vitest";

import { CONNECT_INTERCEPT_HOST, generateCa, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS, RC_TEST_SEQUENCE_NUM, RC_TEST_SESSION_ID, HTTP_OK, connectThroughProxy, makeTlsWorld, requestOn, settle } from "./connectTestWorld";
import { createRcControlHandler, frontDoorRcControl, type RcControlTransport } from "./rcControl";
import { RC_IDLE_EXPIRY_MS, answerRcControlRequest, createRcSessionTracker, injectRcUserMessage, type RcAnswerDecision, type RcEventWriteResult, type RcSessionTracker } from "./rcSessions";

/** The bearers the fake CLI presents, one per credential kind: the OAuth bearer the create carries (the client half's credential, the one an injected write must replay), and the worker JWT its recurring worker calls carry (a different kind that must never displace it, observed live as a 401 when replayed on the client half). */
const CREATE_BEARER = "Bearer sk-ant-REDACTED";
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

/** Sends one content-length framed POST on the TLS session, the way the CLI's own HTTP stack would. */
async function postOn(secure: Parameters<typeof requestOn>[0], path: string, bearer: string, body: string): Promise<ReturnType<typeof requestOn>> {
  return await requestOn(
    secure,
    `POST ${path} HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nAuthorization: ${bearer}\r\nanthropic-version: ${VERSION}\r\nanthropic-client-platform: ${PLATFORM}\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`,
  );
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
        const delivered = await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial: rcDial, newUuid: () => "uuid-e2e" }, RC_TEST_SESSION_ID, "run the tests");
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
          inject: async (sessionId, text) => await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial: rcDial, newUuid: () => "uuid-e2e-control" }, sessionId, text),
          answer: async (sessionId, requestId, decision) => await answerRcControlRequest({ credentialOf: tracker.credentialOf, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision),
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
        await answerRcControlRequest({ credentialOf: tracker.credentialOf, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial: rcDial }, sessionId, requestId, decision);
      const server = http.createServer(
        createRcControlHandler({
          expectedToken: CONTROL_TOKEN,
          list: tracker.list,
          statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
          pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
          inject: async (sessionId, text) => await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial: rcDial, newUuid: () => "uuid-e2e-answer" }, sessionId, text),
          answer,
        }),
      );
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const create = await postOn(secure, "/v1/code/sessions", CREATE_BEARER, JSON.stringify({ bridge: {} }));
        expect(create.statusLine).toContain(String(HTTP_OK));
        await settle();

        // The CLI registers its worker and heartbeats, then posts the event batch carrying the approval request, exactly the writes the door observes on a real session.
        const register = await putOn(secure, `/v1/code/sessions/${RC_TEST_SESSION_ID}/worker`, HEARTBEAT_BEARER, JSON.stringify({ status: "WORKER_STATUS_RUNNING" }));
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

        // The answer, driven the way the door's control route drives it: the tracker's observed credential, and the door's real dial code redirected at the stand-in API host.
        const approved = await client.answerRequest(RC_TEST_SESSION_ID, RC_TEST_REQUEST_ID, { approve: true, message: undefined });
        expect(approved).toEqual({ ok: true, sequenceNums: [RC_TEST_SEQUENCE_NUM] });
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
});
