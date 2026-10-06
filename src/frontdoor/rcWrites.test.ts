import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import {
  RC_CONTEXT_USAGE_DETAILS,
  RC_PERMISSION_MODES,
  RC_READ_FILE_ENCODINGS,
  answerRcControlRequest,
  authenticateRcSessionMcpServer,
  buildRcControlRequestPayload,
  buildRcControlResponsePayload,
  buildRcEndSessionPayload,
  buildRcEventWriteBody,
  buildRcFileSuggestionsPayload,
  buildRcGetContextUsagePayload,
  buildRcGetUsagePayload,
  buildRcInterruptPayload,
  buildRcKeepAlivePayload,
  buildRcMcpAuthenticatePayload,
  buildRcMcpOAuthCallbackUrlPayload,
  buildRcMcpReconnectPayload,
  buildRcMcpStatusPayload,
  buildRcReadFilePayload,
  buildRcSetModelPayload,
  buildRcSetPermissionModePayload,
  buildRcUserMessagePayload,
  endRcSession,
  getRcSessionContextUsage,
  getRcSessionMcpStatus,
  getRcSessionUsage,
  injectRcUserMessage,
  interruptRcSession,
  isRcContextUsageDetail,
  isRcPermissionMode,
  isRcReadFileEncoding,
  rcEventWriteResultFromAnswer,
  readRcSessionFile,
  reconnectRcSessionMcpServer,
  sendRcKeepAlive,
  setRcSessionModel,
  setRcSessionPermissionMode,
  submitRcSessionMcpOAuthCallbackUrl,
  suggestRcSessionFiles,
  type RcEventDial,
} from "./rcWrites";

/**
 * The client-half write tests: every payload builder's exact shape (the SDK's own fields, quoted subtype by subtype), every operation's guard behaviour over an injected dial, and the shared delivery engine's refusals. The tracker scaffolding mirrors `rcSessions.test.ts`'s (a fake clock and an exchange driver), stated locally so each file's tests read beside their own fixtures.
 */

/** A made-up session id of the protocol's shape, and the recurring path that names it. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const HEARTBEAT_PATH = `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`;
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
/** The sequence numbers the scripted dials answer with, named so the literals never read as magic numbers. */
const FIRST_SEQUENCE_NUM = 411;
const SECOND_SEQUENCE_NUM = 412;
/** The number the real API returned as a JSON string in the observed live write answer. */
const LIVE_STRING_SEQUENCE_NUM = 6;
/** The status the API closes a superseded worker with, named so the literal never reads as a magic number. */
const HTTP_CONFLICT = 409;

/** One exchange driven through the tracker the way the door's adapters drive it: request facts, the request body's chunks and end, then the response head, body and end. */
function exchange(tracker: RcSessionTracker, request: { method: string; url: string; authorization?: string; headers?: Record<string, string>; requestBody?: string }): { readonly respond: (status: number, body?: string, headers?: Record<string, string>) => void } {
  const observed = tracker.observeExchange({
    method: request.method,
    url: request.url,
    headers: { ...(request.authorization === undefined ? {} : { authorization: request.authorization }), ...(request.headers ?? {}) },
  });
  return {
    respond: (status, body = "", headers = {}) => {
      if (request.requestBody !== undefined && observed?.onRequestChunk !== undefined) {
        const half = Math.floor(request.requestBody.length / 2);
        observed.onRequestChunk(Buffer.from(request.requestBody.slice(0, half), "utf8"));
        observed.onRequestChunk(Buffer.from(request.requestBody.slice(half), "utf8"));
        observed.onRequestEnd?.();
      }
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
  const tracker = createRcSessionTracker({ now: () => now, idleMs: 45_000 });
  return { tracker, advance: (ms) => {
      now += ms;
    } };
}

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
    expect(rcEventWriteResultFromAnswer({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: FIRST_SEQUENCE_NUM }, { sequence_num: SECOND_SEQUENCE_NUM }] }) })).toEqual({ ok: true, sequenceNums: [FIRST_SEQUENCE_NUM, SECOND_SEQUENCE_NUM] });
  });

  it("reads a sequence number the real API returned as a JSON string, the shape observed live", () => {
    expect(rcEventWriteResultFromAnswer({ status: HTTP_STATUS.ok, body: '{"results":[{"duplicate":false,"event_id":"cb3d099c-1725-4820-a5a2-f857ecb6a26b","sequence_num":"6"}]}' })).toEqual({ ok: true, sequenceNums: [LIVE_STRING_SEQUENCE_NUM] });
  });

  it("names the stale observed bearer as the cause when the API answers 401", () => {
    const result = rcEventWriteResultFromAnswer({ status: HTTP_STATUS.unauthorized, body: '{"error":"authentication_error"}' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("401");
      expect(result.message).toContain("bearer went stale");
      expect(result.message).toContain('{"error":"authentication_error"}');
    }
  });

  it("surfaces a non-401 API failure and an accepted answer with no sequence numbers, both verbosely", () => {
    const refused = rcEventWriteResultFromAnswer({ status: HTTP_CONFLICT, body: "conflicted" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("409");
      expect(refused.message).toContain("conflicted");
    }
    const malformed = rcEventWriteResultFromAnswer({ status: HTTP_STATUS.ok, body: '{"results":[]}' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.message).toContain("sequence_num");
    }
  });
});

describe("injectRcUserMessage over an injected dial", () => {
  it("posts the user-message write with the observed bearer and protocol headers, returning the sequence numbers", async () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "web_claude_ai" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    const dialled: { sessionId: string; headers: Record<string, string>; body: string }[] = [];
    const dial: RcEventDial = {
      writeEvents: async (sessionId, headers, body) => {
        dialled.push({ sessionId, headers: { ...headers }, body });
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: SECOND_SEQUENCE_NUM }] }) });
      },
    };
    const result = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => "uuid-2" }, SESSION_ID, "run the tests");
    expect(result).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM] });
    expect(dialled).toEqual([
      {
        sessionId: SESSION_ID,
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat", "anthropic-version": "2023-06-01", "anthropic-client-platform": "web_claude_ai" },
        body: JSON.stringify(buildRcEventWriteBody(buildRcUserMessagePayload("uuid-2", SESSION_ID, "run the tests"))),
      },
    ]);
  });

  it("refuses a write verbosely when only worker calls were observed, since the worker JWT does not authorise the client half", async () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    const dial: RcEventDial = {
      writeEvents: async () => {
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
    };
    const result = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => "uuid-4" }, SESSION_ID, "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("no claude.ai OAuth bearer has been observed");
      expect(result.message).toContain("worker JWT");
    }
  });

  it("refuses an unobserved session and reports an unreachable API host, both verbosely and without throwing", async () => {
    const { tracker } = trackerWithClock();
    const dial: RcEventDial = {
      writeEvents: async () => {
        return await Promise.reject(new Error("ECONNREFUSED"));
      },
    };
    const unknown = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => "uuid-3" }, SESSION_ID, "hello");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.message).toContain(SESSION_ID);
      expect(unknown.message).toContain("has not observed");
    }
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    const unreachable = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => "uuid-3" }, SESSION_ID, "hello");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.message).toContain("could not reach the API host");
      expect(unreachable.message).toContain("ECONNREFUSED");
    }
  });
});

describe("the control_response payload and answerRcControlRequest over an injected dial", () => {
  const REQUEST_ID = "req_00000000-0000-4000-8000-00000000000a";
  /** A tracker holding one observed session with one pending can_use_tool, the state every answer runs against. */
  const trackerWithPending = (): { readonly tracker: RcSessionTracker } => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    exchange(tracker, {
      method: "POST",
      url: `/v1/code/sessions/${SESSION_ID}/worker/events`,
      authorization: "Bearer sk-ant-oat",
      requestBody: JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } } }] }),
    }).respond(HTTP_STATUS.ok);
    return { tracker };
  };
  /** A dial that records what it was handed and answers with the documented per-event sequence numbers. */
  const dialRecording = (): { readonly dial: RcEventDial; readonly dialled: readonly { sessionId: string; headers: Record<string, string>; body: string }[] } => {
    const dialled: { sessionId: string; headers: Record<string, string>; body: string }[] = [];
    return {
      dialled,
      dial: {
        writeEvents: async (sessionId, headers, body) => {
          dialled.push({ sessionId, headers: { ...headers }, body });
          return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: SECOND_SEQUENCE_NUM }] }) });
        },
      },
    };
  };

  it("builds the SDK's control_response envelope, echoing the request id and carrying the permission result", () => {
    expect(buildRcControlResponsePayload(REQUEST_ID, { approve: true, message: undefined })).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "allow" } },
    });
    expect(buildRcControlResponsePayload(REQUEST_ID, { approve: false, message: "not today" })).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "deny", message: "not today" } },
    });
    expect(buildRcControlResponsePayload(REQUEST_ID, { approve: false, message: undefined })).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "deny", message: "" } },
    });
  });

  it("answers with the observed bearer and protocol headers, and retires the request once the write is confirmed", async () => {
    const { tracker } = trackerWithPending();
    const { dial, dialled } = dialRecording();
    const result = await answerRcControlRequest({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, dial }, SESSION_ID, REQUEST_ID, { approve: true, message: undefined });
    expect(result).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM] });
    expect(dialled).toEqual([
      {
        sessionId: SESSION_ID,
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat", "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" },
        body: JSON.stringify(buildRcEventWriteBody(buildRcControlResponsePayload(REQUEST_ID, { approve: true, message: undefined }))),
      },
    ]);
    expect(tracker.pendingOf()).toEqual([]);
  });

  it("refuses an unobserved session, an unknown request, and a dial failure, each verbosely and without throwing", async () => {
    const { tracker } = trackerWithPending();
    const { dial } = dialRecording();
    const deps = { credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, pendingOf: (id: string) => tracker.pendingOf(id), completePending: tracker.completePending, dial };
    const unknownSession = await answerRcControlRequest(deps, "cse_00000000-0000-4000-8000-0000000000ff", REQUEST_ID, { approve: true, message: undefined });
    expect(unknownSession.ok).toBe(false);
    if (!unknownSession.ok) {
      expect(unknownSession.message).toContain("has not observed Remote Control session");
    }
    const unknownRequest = await answerRcControlRequest(deps, SESSION_ID, "req_00000000-0000-4000-8000-0000000000ee", { approve: false, message: "no" });
    expect(unknownRequest.ok).toBe(false);
    if (!unknownRequest.ok) {
      expect(unknownRequest.message).toContain("not observed control request");
      expect(unknownRequest.message).toContain("pending");
    }
    const refusingDial: RcEventDial = { writeEvents: async () => await Promise.reject(new Error("ECONNREFUSED")) };
    const unreachable = await answerRcControlRequest({ ...deps, dial: refusingDial }, SESSION_ID, REQUEST_ID, { approve: true, message: undefined });
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.message).toContain("could not reach the API host");
      expect(unreachable.message).toContain("ECONNREFUSED");
    }
    // A failed write leaves the request pending: only a confirmed delivery retires it.
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
  });
});

describe("the control_request payloads and the three client-originated operations over an injected dial", () => {
  /** The id the operation mints, so the asserted envelope names exactly what the dial received. */
  const MINTED_REQUEST_ID = "minted-uuid-1";
  /** A model id of the shape the SDK's own field takes. */
  const MODEL_ID = "claude-opus-5-5";
  /** A mode from the SDK's own enum. */
  const MODE = "acceptEdits";

  /** A tracker holding one observed session created with the OAuth bearer the writes must replay. */
  const trackerWithSession = (): { readonly tracker: RcSessionTracker } => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    return { tracker };
  };
  /** A dial that records what it was handed and answers with the documented per-event sequence numbers. */
  const dialRecording = (): { readonly dial: RcEventDial; readonly dialled: readonly { sessionId: string; headers: Record<string, string>; body: string }[] } => {
    const dialled: { sessionId: string; headers: Record<string, string>; body: string }[] = [];
    return {
      dialled,
      dial: {
        writeEvents: async (sessionId, headers, body) => {
          dialled.push({ sessionId, headers: { ...headers }, body });
          return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: SECOND_SEQUENCE_NUM }] }) });
        },
      },
    };
  };
  /** The deps every one of the three operations runs with in these tests. */
  const depsOf = (tracker: RcSessionTracker, dial: RcEventDial) => ({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => MINTED_REQUEST_ID });
  /** The headers every client-half write sends with this tracker's observed credential. */
  const EXPECTED_HEADERS = { "content-type": "application/json", authorization: "Bearer sk-ant-oat", "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" };

  it("builds the SDK's control_request envelope for each subtype, with the fields its own type declares", () => {
    expect(buildRcInterruptPayload(MINTED_REQUEST_ID)).toEqual({ type: "control_request", request_id: MINTED_REQUEST_ID, request: { subtype: "interrupt" } });
    expect(buildRcSetModelPayload(MINTED_REQUEST_ID, MODEL_ID)).toEqual({ type: "control_request", request_id: MINTED_REQUEST_ID, request: { subtype: "set_model", model: MODEL_ID } });
    expect(buildRcSetPermissionModePayload(MINTED_REQUEST_ID, MODE)).toEqual({ type: "control_request", request_id: MINTED_REQUEST_ID, request: { subtype: "set_permission_mode", mode: MODE } });
  });

  it("narrows the permission mode to exactly the strings the SDK's own type permits", () => {
    for (const mode of RC_PERMISSION_MODES) {
      expect(isRcPermissionMode(mode)).toBe(true);
    }
    for (const refused of ["", "AcceptEdits", "accept_edits", "yolo", "default plan", null, undefined]) {
      expect(isRcPermissionMode(refused)).toBe(false);
    }
  });

  it("sends each control request with the observed bearer and protocol headers inside the event write body, returning the sequence numbers and the minted request id", async () => {
    const { tracker } = trackerWithSession();
    const { dial, dialled } = dialRecording();
    const deps = depsOf(tracker, dial);
    expect(await interruptRcSession(deps, SESSION_ID)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await setRcSessionModel(deps, SESSION_ID, MODEL_ID)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(await setRcSessionPermissionMode(deps, SESSION_ID, "plan")).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_REQUEST_ID });
    expect(dialled).toEqual([
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcInterruptPayload(MINTED_REQUEST_ID))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcSetModelPayload(MINTED_REQUEST_ID, MODEL_ID))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcSetPermissionModePayload(MINTED_REQUEST_ID, "plan"))) },
    ]);
  });

  it("refuses an unobserved session verbosely, and never dials", async () => {
    const { tracker } = trackerWithClock();
    const { dial, dialled } = dialRecording();
    const deps = depsOf(tracker, dial);
    for (const refused of [
      await interruptRcSession(deps, SESSION_ID),
      await setRcSessionModel(deps, SESSION_ID, MODEL_ID),
      await setRcSessionPermissionMode(deps, SESSION_ID, MODE),
    ]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toContain("has not observed Remote Control session");
        expect(refused.message).toContain(SESSION_ID);
      }
    }
    expect(dialled).toEqual([]);
  });

  it("refuses each write verbosely when only worker calls were observed, since the worker JWT does not authorise the client half", async () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    const { dial } = dialRecording();
    const deps = depsOf(tracker, dial);
    for (const refused of [
      await interruptRcSession(deps, SESSION_ID),
      await setRcSessionModel(deps, SESSION_ID, MODEL_ID),
      await setRcSessionPermissionMode(deps, SESSION_ID, MODE),
    ]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toContain("no claude.ai OAuth bearer has been observed");
        expect(refused.message).toContain("worker JWT");
      }
    }
  });

  it("refuses an empty model id without dialling, since the SDK's field gives its empty-free forms their own meaning", async () => {
    const { tracker } = trackerWithSession();
    const { dial, dialled } = dialRecording();
    const refused = await setRcSessionModel(depsOf(tracker, dial), SESSION_ID, "");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("non-empty model id");
    }
    expect(dialled).toEqual([]);
  });

  it("reports an unreachable API host verbosely and without throwing", async () => {
    const { tracker } = trackerWithSession();
    const refusingDial: RcEventDial = { writeEvents: async () => await Promise.reject(new Error("ECONNREFUSED")) };
    const deps = depsOf(tracker, refusingDial);
    for (const refused of [
      await interruptRcSession(deps, SESSION_ID),
      await setRcSessionModel(deps, SESSION_ID, MODEL_ID),
      await setRcSessionPermissionMode(deps, SESSION_ID, MODE),
    ]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toContain("could not reach the API host");
        expect(refused.message).toContain("ECONNREFUSED");
      }
    }
  });
});


describe("the wider client-half verb family: the SDK's remaining control subtypes and the keep-alive payload", () => {
  /** The id every operation in this family mints, so the asserted envelopes and results name exactly what the dial received. */
  const MINTED_ID = "minted-family-uuid";
  /** Inputs of the shapes each subtype's own fields declare. */
  const REASON = "done for today";
  const DETAIL = "summary" as const;
  const FILE_PATH = "src/frontdoor/rcSessions.ts";
  const QUERY = "src/frontdoor/rc";
  const SERVER_NAME = "github";
  const REDIRECT_URI = "https://example.com/oauth/callback";
  const CALLBACK_URL = "https://example.com/oauth/callback?code=x";

  /** A tracker holding one observed session created with the OAuth bearer the writes must replay. */
  const trackerWithSession = (): { readonly tracker: RcSessionTracker } => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    return { tracker };
  };
  /** A dial that records what it was handed and answers with the documented per-event sequence numbers. */
  const dialRecording = (): { readonly dial: RcEventDial; readonly dialled: readonly { sessionId: string; headers: Record<string, string>; body: string }[] } => {
    const dialled: { sessionId: string; headers: Record<string, string>; body: string }[] = [];
    return {
      dialled,
      dial: {
        writeEvents: async (sessionId, headers, body) => {
          dialled.push({ sessionId, headers: { ...headers }, body });
          return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: SECOND_SEQUENCE_NUM }] }) });
        },
      },
    };
  };
  const depsOf = (tracker: RcSessionTracker, dial: RcEventDial) => ({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial, newUuid: () => MINTED_ID });
  const EXPECTED_HEADERS = { "content-type": "application/json", authorization: "Bearer sk-ant-oat", "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" };

  it("builds each subtype's request with exactly the fields the SDK's own type or the CLI bundle declares, inside the one shared envelope", () => {
    expect(buildRcControlRequestPayload(MINTED_ID, { subtype: "mcp_status" })).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "mcp_status" } });
    expect(buildRcEndSessionPayload(MINTED_ID, undefined)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "end_session" } });
    expect(buildRcEndSessionPayload(MINTED_ID, REASON)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "end_session", reason: REASON } });
    expect(buildRcGetUsagePayload(MINTED_ID, undefined)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "get_usage" } });
    expect(buildRcGetUsagePayload(MINTED_ID, true)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "get_usage", skip_behaviors: true } });
    expect(buildRcGetUsagePayload(MINTED_ID, false)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "get_usage" } });
    expect(buildRcGetContextUsagePayload(MINTED_ID, undefined)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "get_context_usage" } });
    expect(buildRcGetContextUsagePayload(MINTED_ID, DETAIL)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "get_context_usage", detail: DETAIL } });
    expect(buildRcReadFilePayload(MINTED_ID, FILE_PATH, undefined)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "read_file", path: FILE_PATH } });
    expect(buildRcReadFilePayload(MINTED_ID, FILE_PATH, { maxBytes: 4096, encoding: "base64" })).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "read_file", path: FILE_PATH, max_bytes: 4096, encoding: "base64" } });
    expect(buildRcFileSuggestionsPayload(MINTED_ID, QUERY)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "file_suggestions", query: QUERY } });
    expect(buildRcFileSuggestionsPayload(MINTED_ID, "")).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "file_suggestions", query: "" } });
    expect(buildRcMcpStatusPayload(MINTED_ID)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "mcp_status" } });
    expect(buildRcMcpReconnectPayload(MINTED_ID, SERVER_NAME)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "mcp_reconnect", serverName: SERVER_NAME } });
    expect(buildRcMcpAuthenticatePayload(MINTED_ID, SERVER_NAME, REDIRECT_URI)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "mcp_authenticate", serverName: SERVER_NAME, redirectUri: REDIRECT_URI } });
    expect(buildRcMcpOAuthCallbackUrlPayload(MINTED_ID, SERVER_NAME, CALLBACK_URL)).toEqual({ type: "control_request", request_id: MINTED_ID, request: { subtype: "mcp_oauth_callback_url", serverName: SERVER_NAME, callbackUrl: CALLBACK_URL } });
  });

  it("builds the keep-alive payload on its own, with no request envelope, the SDK's own top-level shape for it", () => {
    expect(buildRcKeepAlivePayload()).toEqual({ type: "keep_alive" });
  });

  it("narrows the context-usage detail and the read-file encoding to exactly the strings the SDK's own types permit", () => {
    for (const detail of RC_CONTEXT_USAGE_DETAILS) {
      expect(isRcContextUsageDetail(detail)).toBe(true);
    }
    for (const refused of ["", "FULL", "quick", "full ", null, undefined]) {
      expect(isRcContextUsageDetail(refused)).toBe(false);
    }
    for (const encoding of RC_READ_FILE_ENCODINGS) {
      expect(isRcReadFileEncoding(encoding)).toBe(true);
    }
    for (const refused of ["", "UTF-8", "hex", "utf8", null, undefined]) {
      expect(isRcReadFileEncoding(refused)).toBe(false);
    }
  });

  it("sends each verb's control request with the observed bearer and protocol headers, surfacing the minted request id beside the sequence numbers", async () => {
    const { tracker } = trackerWithSession();
    const { dial, dialled } = dialRecording();
    const deps = depsOf(tracker, dial);
    expect(await endRcSession(deps, SESSION_ID, REASON)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await getRcSessionUsage(deps, SESSION_ID, true)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await getRcSessionContextUsage(deps, SESSION_ID, DETAIL)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await readRcSessionFile(deps, SESSION_ID, FILE_PATH, { maxBytes: 4096 })).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await suggestRcSessionFiles(deps, SESSION_ID, QUERY)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await getRcSessionMcpStatus(deps, SESSION_ID)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await reconnectRcSessionMcpServer(deps, SESSION_ID, SERVER_NAME)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await authenticateRcSessionMcpServer(deps, SESSION_ID, SERVER_NAME, REDIRECT_URI)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(await submitRcSessionMcpOAuthCallbackUrl(deps, SESSION_ID, SERVER_NAME, CALLBACK_URL)).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM], requestId: MINTED_ID });
    expect(dialled).toEqual([
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcEndSessionPayload(MINTED_ID, REASON))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcGetUsagePayload(MINTED_ID, true))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcGetContextUsagePayload(MINTED_ID, DETAIL))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcReadFilePayload(MINTED_ID, FILE_PATH, { maxBytes: 4096 }))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcFileSuggestionsPayload(MINTED_ID, QUERY))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcMcpStatusPayload(MINTED_ID))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcMcpReconnectPayload(MINTED_ID, SERVER_NAME))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcMcpAuthenticatePayload(MINTED_ID, SERVER_NAME, REDIRECT_URI))) },
      { sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcMcpOAuthCallbackUrlPayload(MINTED_ID, SERVER_NAME, CALLBACK_URL))) },
    ]);
  });

  it("sends the keep-alive as the bare payload the SDK declares, and its result carries no request id because nothing answers it", async () => {
    const { tracker } = trackerWithSession();
    const { dial, dialled } = dialRecording();
    const result = await sendRcKeepAlive(depsOf(tracker, dial), SESSION_ID);
    expect(result).toEqual({ ok: true, sequenceNums: [SECOND_SEQUENCE_NUM] });
    expect(dialled).toEqual([{ sessionId: SESSION_ID, headers: EXPECTED_HEADERS, body: JSON.stringify(buildRcEventWriteBody(buildRcKeepAlivePayload())) }]);
  });

  it("refuses an unobserved session verbosely whatever the verb, and never dials", async () => {
    const { tracker } = trackerWithClock();
    const { dial, dialled } = dialRecording();
    const deps = depsOf(tracker, dial);
    const refused = [
      await endRcSession(deps, SESSION_ID, undefined),
      await getRcSessionUsage(deps, SESSION_ID, undefined),
      await getRcSessionContextUsage(deps, SESSION_ID, undefined),
      await readRcSessionFile(deps, SESSION_ID, FILE_PATH, undefined),
      await suggestRcSessionFiles(deps, SESSION_ID, QUERY),
      await sendRcKeepAlive(deps, SESSION_ID),
      await getRcSessionMcpStatus(deps, SESSION_ID),
      await reconnectRcSessionMcpServer(deps, SESSION_ID, SERVER_NAME),
      await authenticateRcSessionMcpServer(deps, SESSION_ID, SERVER_NAME, REDIRECT_URI),
      await submitRcSessionMcpOAuthCallbackUrl(deps, SESSION_ID, SERVER_NAME, CALLBACK_URL),
    ];
    for (const result of refused) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("has not observed Remote Control session");
        expect(result.message).toContain(SESSION_ID);
      }
    }
    expect(dialled).toEqual([]);
  });

  it("refuses each write verbosely when only worker calls were observed, since the worker JWT does not authorise the client half", async () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    const { dial } = dialRecording();
    const deps = depsOf(tracker, dial);
    for (const result of [
      await endRcSession(deps, SESSION_ID, undefined),
      await getRcSessionUsage(deps, SESSION_ID, undefined),
      await sendRcKeepAlive(deps, SESSION_ID),
      await getRcSessionMcpStatus(deps, SESSION_ID),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("no claude.ai OAuth bearer has been observed");
        expect(result.message).toContain("worker JWT");
      }
    }
  });

  it("refuses each verb's empty-free fields without dialling, since the receiver reads the omitted form as its own default", async () => {
    const { tracker } = trackerWithSession();
    const { dial, dialled } = dialRecording();
    const deps = depsOf(tracker, dial);
    for (const refused of [
      await endRcSession(deps, SESSION_ID, ""),
      await readRcSessionFile(deps, SESSION_ID, "", undefined),
      await readRcSessionFile(deps, SESSION_ID, FILE_PATH, { maxBytes: 0 }),
      await readRcSessionFile(deps, SESSION_ID, FILE_PATH, { maxBytes: -1 }),
      await readRcSessionFile(deps, SESSION_ID, FILE_PATH, { maxBytes: 1.5 }),
      await reconnectRcSessionMcpServer(deps, SESSION_ID, ""),
      await authenticateRcSessionMcpServer(deps, SESSION_ID, "", REDIRECT_URI),
      await authenticateRcSessionMcpServer(deps, SESSION_ID, SERVER_NAME, ""),
      await submitRcSessionMcpOAuthCallbackUrl(deps, SESSION_ID, SERVER_NAME, ""),
    ]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message.length).toBeGreaterThan(0);
      }
    }
    expect(dialled).toEqual([]);
  });

  it("reports an unreachable API host verbosely and without throwing, whatever the verb", async () => {
    const { tracker } = trackerWithSession();
    const refusingDial: RcEventDial = { writeEvents: async () => await Promise.reject(new Error("ECONNREFUSED")) };
    const deps = depsOf(tracker, refusingDial);
    for (const result of [
      await endRcSession(deps, SESSION_ID, undefined),
      await getRcSessionUsage(deps, SESSION_ID, undefined),
      await readRcSessionFile(deps, SESSION_ID, FILE_PATH, undefined),
      await sendRcKeepAlive(deps, SESSION_ID),
      await getRcSessionMcpStatus(deps, SESSION_ID),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("could not reach the API host");
        expect(result.message).toContain("ECONNREFUSED");
      }
    }
  });
});
