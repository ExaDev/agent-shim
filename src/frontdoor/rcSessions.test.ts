import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import {
  RC_IDLE_EXPIRY_MS,
  buildRcEventWriteBody,
  buildRcUserMessagePayload,
  createRcSessionTracker,
  injectRcUserMessage,
  observingRoutedRoute,
  rcInjectResultFromAnswer,
  type RcEventDial,
  type RcSessionTracker,
} from "./rcSessions";

/** A made-up session id of the protocol's shape, and the recurring paths that name it. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const HEARTBEAT_PATH = `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`;
/** The heartbeats' fixed cadence, from the captured heartbeat body the idle bound is derived against. */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
/** The status the API closes a superseded worker with, named so the literal never reads as a magic number. */
const HTTP_CONFLICT = 409;
/** The sequence numbers the scripted dials answer with, named for the same reason. */
const FIRST_SEQUENCE_NUM = 411;
const SECOND_SEQUENCE_NUM = 412;

/** One exchange driven through the tracker the way the door's adapters drive it: request facts, then the response head, body and end. */
function exchange(tracker: RcSessionTracker, request: { method: string; url: string; authorization?: string; headers?: Record<string, string> }): { readonly respond: (status: number, body?: string, headers?: Record<string, string>) => void } {
  const observed = tracker.observeExchange({
    method: request.method,
    url: request.url,
    headers: { ...(request.authorization === undefined ? {} : { authorization: request.authorization }), ...(request.headers ?? {}) },
  });
  return {
    respond: (status, body = "", headers = {}) => {
      observed?.onResponse(status, headers);
      if (body !== "") {
        observed?.onBodyChunk(Buffer.from(body, "utf8"));
      }
      observed?.onEnd();
    },
  };
}

/** A tracker over a mutable fake clock, so the idle bound is reached by moving time rather than waiting. */
function trackerWithClock(startAt = CLOCK_START_MS): { readonly tracker: RcSessionTracker; readonly advance: (ms: number) => void } {
  let now = startAt;
  const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS });
  return { tracker, advance: (ms) => {
      now += ms;
    } };
}

describe("the Remote Control session tracker", () => {
  it("records a session from its create exchange, with the bearer and protocol headers that create carried", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-REDACTED", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
    expect(tracker.credentialOf(SESSION_ID)).toEqual({ authorization: "Bearer sk-ant-REDACTED", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });
  });

  it("ignores a create whose answer names no cse_ session id, and one whose status is not a success", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: "not-a-cse-id" } }));
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.unauthorized, JSON.stringify({ error: "no" }));
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.ok, "not json at all");
    expect(tracker.list()).toEqual([]);
  });

  it("refreshes the retained bearer latest-wins on the session's recurring calls, and does not lose it when a call carries none", () => {
    const { tracker, advance } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-REDACTED" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer sk-ant-REDACTED" }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-REDACTED");
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/client/presence`, authorization: "Bearer sk-ant-REDACTED" }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-REDACTED");
    expect(tracker.list()[0]?.lastSeenAt).toBe(CLOCK_START_MS + 2 * HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-REDACTED");
  });

  it("tracks a session it never saw created from its recurring calls alone", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer sk-ant-REDACTED" }).respond(HTTP_STATUS.ok);
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
  });

  it("expires an archived session on an accepted archive, and keeps it when the archive is refused", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/archive`, authorization: "Bearer b" }).respond(HTTP_STATUS.internalServerError);
    expect(tracker.list().map((session) => session.id)).toEqual([SESSION_ID]);
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/archive`, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    expect(tracker.list()).toEqual([]);
  });

  it("expires a session the API closes with a worker-conflict header, whatever the status", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${SESSION_ID}/worker`, authorization: "Bearer b" }).respond(HTTP_CONFLICT, "", { "x-ccr-conflict-reason": "superseded_by_worker" });
    expect(tracker.list()).toEqual([]);
  });

  it("expires an entry once it has been idle past the bound derived from the protocol's liveness, keeping one whose heartbeats are still inside it", () => {
    const { tracker, advance } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    advance(RC_IDLE_EXPIRY_MS - 1);
    expect(tracker.list().map((session) => session.id)).toEqual([SESSION_ID]);
    advance(1);
    expect(tracker.list()).toEqual([]);
  });

  it("observes nothing outside the Remote Control paths, and nothing on the session list read", () => {
    const { tracker } = trackerWithClock();
    expect(tracker.observeExchange({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer b" } })).toBeUndefined();
    expect(tracker.observeExchange({ method: "GET", url: "/v1/code/sessions", headers: { authorization: "Bearer b" } })).toBeUndefined();
    expect(tracker.observeExchange({ method: "POST", url: "/v1/code/sessions/search", headers: { authorization: "Bearer b" } })).toBeUndefined();
    expect(tracker.list()).toEqual([]);
  });
});

describe("the injected event's payload and answer parsing", () => {
  it("builds the Agent SDK user-message payload inside the documented write body", () => {
    const payload = buildRcUserMessagePayload("uuid-1", SESSION_ID, "run the tests");
    expect(payload).toEqual({
      type: "user",
      uuid: "uuid-1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: "run the tests" },
    });
    expect(buildRcEventWriteBody(payload)).toEqual({ events: [{ payload }] });
  });

  it("reads the sequence numbers out of an accepted write answer", () => {
    expect(rcInjectResultFromAnswer({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: FIRST_SEQUENCE_NUM }, { sequence_num: SECOND_SEQUENCE_NUM }] }) })).toEqual({ ok: true, sequenceNums: [FIRST_SEQUENCE_NUM, SECOND_SEQUENCE_NUM] });
  });

  it("names the stale observed bearer as the cause when the API answers 401", () => {
    const result = rcInjectResultFromAnswer({ status: HTTP_STATUS.unauthorized, body: '{"error":"authentication_error"}' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("401");
      expect(result.message).toContain("bearer went stale");
      expect(result.message).toContain('{"error":"authentication_error"}');
    }
  });

  it("surfaces a non-401 API failure and an accepted answer with no sequence numbers, both verbosely", () => {
    const refused = rcInjectResultFromAnswer({ status: HTTP_CONFLICT, body: "conflicted" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("409");
      expect(refused.message).toContain("conflicted");
    }
    const malformed = rcInjectResultFromAnswer({ status: HTTP_STATUS.ok, body: '{"results":[]}' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.message).toContain("sequence_num");
    }
  });
});

describe("injectRcUserMessage over an injected dial", () => {
  it("posts the user-message write with the observed bearer and protocol headers, returning the sequence numbers", async () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-REDACTED", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "web_claude_ai" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    const dialled: { sessionId: string; headers: Record<string, string>; body: string }[] = [];
    const dial: RcEventDial = {
      writeEvents: async (sessionId, headers, body) => {
        dialled.push({ sessionId, headers: { ...headers }, body });
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: SECOND_SEQUENCE_NUM }] }) });
      },
    };
    const result = await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial, newUuid: () => "uuid-2" }, SESSION_ID, "run the tests");
    expect(result).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM] });
    expect(dialled).toEqual([
      {
        sessionId: SESSION_ID,
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-REDACTED", "anthropic-version": "2023-06-01", "anthropic-client-platform": "web_claude_ai" },
        body: JSON.stringify(buildRcEventWriteBody(buildRcUserMessagePayload("uuid-2", SESSION_ID, "run the tests"))),
      },
    ]);
  });

  it("refuses an unobserved session and reports an unreachable API host, both verbosely and without throwing", async () => {
    const { tracker } = trackerWithClock();
    const dial: RcEventDial = {
      writeEvents: async () => {
        return await Promise.reject(new Error("ECONNREFUSED"));
      },
    };
    const unknown = await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial, newUuid: () => "uuid-3" }, SESSION_ID, "hello");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.message).toContain(SESSION_ID);
      expect(unknown.message).toContain("has not observed");
    }
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    const unreachable = await injectRcUserMessage({ credentialOf: tracker.credentialOf, dial, newUuid: () => "uuid-3" }, SESSION_ID, "hello");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.message).toContain("could not reach the API host");
      expect(unreachable.message).toContain("ECONNREFUSED");
    }
  });
});

describe("the RoutedResponse tee the door's resolver applies", () => {
  it("tees a served route's response into the tracker while the route's own flow is unchanged", async () => {
    const { tracker } = trackerWithClock();
    const writes: (string | Uint8Array)[] = [];
    const ended: boolean[] = [];
    /** A stand-in response recording what the route did, so the tee is proven not to change it. */
    const recordingResponse: RoutedResponse = {
      get headersSent() {
        return false;
      },
      start: () => {
        return;
      },
      flush: () => {
        return;
      },
      write: async (chunk) => {
        writes.push(chunk);
        await Promise.resolve();
      },
      end: () => {
        ended.push(true);
      },
      destroy: () => {
        ended.push(false);
      },
    };
    const route: FrontDoorRoute = {
      name: "stand-in",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request: RoutedRequest, response: RoutedResponse) => {
        response.start(HTTP_STATUS.ok, { "content-type": "application/json" });
        await response.write(Buffer.from(JSON.stringify({ session: { id: SESSION_ID } }), "utf8"));
        response.end();
      },
    };
    const request: RoutedRequest = {
      method: "POST",
      url: "/v1/code/sessions",
      headers: { authorization: "Bearer sk-ant-REDACTED" },
      // A real IncomingMessage over an unconnected socket: the stand-in route never reads the body, and constructing the genuine type keeps the request honest.
      body: new IncomingMessage(new Socket()),
      signal: new AbortController().signal,
      session: { identity: undefined, sessionId: undefined, headroom: false, projectId: undefined },
    };
    await observingRoutedRoute(route, tracker).serve(request, recordingResponse);
    expect(writes).toEqual([Buffer.from(JSON.stringify({ session: { id: SESSION_ID } }), "utf8")]);
    expect(ended).toEqual([true]);
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-REDACTED");
  });
});
