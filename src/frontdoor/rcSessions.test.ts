import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createFakeFarmFs } from "../test-helpers";

import { createRcCredentialStore } from "./rcCredentialStore";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import {
  RC_IDLE_EXPIRY_MS,
  RC_PENDING_PER_SESSION_MAX,
  RC_REQUEST_ID_MAX_CHARS,
  RC_RETIRED_TOMBSTONES_MAX,
  RC_PENDING_SUMMARY_EXCERPT_CHARS,
  RC_REQUEST_PARSE_CAP_BYTES,
  createRcSessionTracker,
  observingRoutedRoute,
  type RcSessionTracker,
} from "./rcSessions";

/** A made-up session id of the protocol's shape, and the recurring paths that name it. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const HEARTBEAT_PATH = `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`;
/** The heartbeats' fixed cadence, from the captured heartbeat body the idle bound is derived against. */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
/** Stream sequence numbers past the first two, named so the order of events in a test reads as such. */
const THIRD_EVENT = 3;
const FOURTH_EVENT = 4;
/** The status the API closes a superseded worker with, named so the literal never reads as a magic number. */
const HTTP_CONFLICT = 409;

/** One exchange driven through the tracker the way the door's adapters drive it: request facts, the request body's chunks and end, then the response head, body and end. */
function exchange(tracker: RcSessionTracker, request: { method: string; url: string; authorization?: string; headers?: Record<string, string>; requestBody?: string; identity?: string }): { readonly respond: (status: number, body?: string, headers?: Record<string, string>) => void } {
  const observed = tracker.observeExchange({
    method: request.method,
    url: request.url,
    headers: { ...(request.authorization === undefined ? {} : { authorization: request.authorization }), ...(request.headers ?? {}) },
    ...(request.identity === undefined ? {} : { identity: request.identity }),
  });
  return {
    respond: (status, body = "", headers = {}) => {
      if (request.requestBody !== undefined && observed?.onRequestChunk !== undefined) {
        // Two chunks, so a parser that decoded each chunk separately would have to survive a split code point; the tracker buffers whole buffers instead.
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
  const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS });
  return { tracker, advance: (ms) => {
      now += ms;
    } };
}

describe("the Remote Control session tracker", () => {
  it("records a session from its create exchange, with the bearer and protocol headers that create carried", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
    expect(tracker.credentialOf(SESSION_ID)).toEqual({ authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });
  });

  it("ignores a create whose answer names no cse_ session id, and one whose status is not a success", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: "not-a-cse-id" } }));
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.unauthorized, JSON.stringify({ error: "no" }));
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer a" }).respond(HTTP_STATUS.ok, "not json at all");
    expect(tracker.list()).toEqual([]);
  });

  it("refreshes the retained OAuth bearer latest-wins among OAuth-kind calls, and never lets a worker JWT displace it", () => {
    const { tracker, advance } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    advance(HEARTBEAT_INTERVAL_MS);
    // The worker's recurring calls carry the worker JWT, a different credential kind that authorises worker operations only: the exchange refreshes the entry's liveness without touching the injection credential (a JWT replayed on the client half is answered 401, observed live).
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat");
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/client/presence`, authorization: "Bearer sk-ant-oat2" }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat2");
    expect(tracker.list()[0]?.lastSeenAt).toBe(CLOCK_START_MS + 2 * HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat2");
  });

  it("never takes the client platform from a client event write, so the door's own person's-app write does not become what every later write replays", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-client-platform": "claude_code_cli" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    // The self-hosted route's write rides the door's own surface and comes back through the observed route like any client's write.
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/events`, authorization: "Bearer sk-ant-oat", headers: { "anthropic-client-platform": "web_claude_ai" }, requestBody: JSON.stringify({ events: [] }) }).respond(HTTP_STATUS.ok, JSON.stringify({ results: [] }));
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/teleport-events`, authorization: "Bearer sk-ant-oat", headers: { "anthropic-client-platform": "web_claude_ai" } }).respond(HTTP_STATUS.ok, JSON.stringify({ results: [] }));
    expect(tracker.credentialOf(SESSION_ID)?.anthropicClientPlatform).toBe("claude_code_cli");
    // Any other call of the session's own still refreshes it, latest-wins.
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/client/presence`, authorization: "Bearer sk-ant-oat", headers: { "anthropic-client-platform": "claude_code_vscode" } }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.anthropicClientPlatform).toBe("claude_code_vscode");
  });

  it("births a session from a client event write without the platform that write named, in memory and in the store", () => {
    const real = createRcCredentialStore(createFakeFarmFs(), "/state/frontdoor/rc-credentials");
    const persistedPlatforms: (string | undefined)[] = [];
    const store = { ...real, write: (sessionId: string, credential: Parameters<typeof real.write>[1]) => {
      persistedPlatforms.push(credential.anthropicClientPlatform);
      real.write(sessionId, credential);
    } };
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
    // The first accepted call this door sees for the session is the door's own person's-app write.
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/events`, authorization: "Bearer sk-ant-oat", headers: { "anthropic-client-platform": "web_claude_ai" }, requestBody: JSON.stringify({ events: [] }) }).respond(HTTP_STATUS.ok, JSON.stringify({ results: [] }));
    expect(tracker.list().map((entry) => entry.id)).toEqual([SESSION_ID]);
    expect(tracker.credentialOf(SESSION_ID)?.anthropicClientPlatform).toBeUndefined();
    expect(persistedPlatforms.length).toBeGreaterThan(0);
    expect(persistedPlatforms).not.toContain("web_claude_ai");
  });

  it("tracks a session it never saw created from its recurring calls alone", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer sk-ant-oat" }).respond(HTTP_STATUS.ok);
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
  });

  it("reads the persisted credential back on a generation that never saw the create, whose every observation since carried only the worker JWT", () => {
    // One store shared by two tracker generations, exactly as the door's front-door directory is shared by two door processes: the live shape behind a door that restarts mid-session.
    const store = createRcCredentialStore(createFakeFarmFs(), "/state/frontdoor/rc-credentials");
    const first = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
    exchange(first, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(store.read(SESSION_ID)).toEqual({ authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });

    // The next generation: the create crossed the last one, and only the worker's recurring calls state anything now. Without the store this generation could never attach or write (the live defect behind the rig's silent hub), so its credential answer is the persisted copy.
    const second = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
    exchange(second, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    expect(second.list().map((session) => session.id)).toEqual([SESSION_ID]);
    expect(second.credentialOf(SESSION_ID)).toEqual({ authorization: "Bearer sk-ant-oat", anthropicVersion: "2023-06-01", anthropicClientPlatform: "desktop_app" });

    // A later OAuth-bearing observation overwrites the persisted copy the usual latest-wins way, and the next generation reads that one.
    exchange(second, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/client/presence`, authorization: "Bearer sk-ant-oat2" }).respond(HTTP_STATUS.ok);
    expect(store.read(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat2");
    const third = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
    exchange(third, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    expect(third.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat2");
  });

  it("forgets the persisted credential when the session closes, and keeps it through the idle sweep", () => {
    const store = createRcCredentialStore(createFakeFarmFs(), "/state/frontdoor/rc-credentials");
    let now = CLOCK_START_MS;
    const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS, credentialStore: store });
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    // The idle sweep drops the entry (a quiet session is not a closed one), and a returning heartbeat re-births it with the persisted credential intact.
    now += RC_IDLE_EXPIRY_MS + 1;
    expect(tracker.list()).toEqual([]);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat");
    // An accepted archive closes the session by design: the persisted credential must not outlive it.
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/archive`, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    expect(store.read(SESSION_ID)).toBeUndefined();
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

describe("the Remote Control pending-request lifecycle", () => {
  const WORKER_EVENTS_PATH = `/v1/code/sessions/${SESSION_ID}/worker/events`;
  const CLIENT_EVENTS_PATH = `/v1/code/sessions/${SESSION_ID}/events`;
  /** The id the protocol's trust rule names and a matching control_response must echo. */
  const REQUEST_ID = "req_00000000-0000-4000-8000-00000000000a";
  const OTHER_REQUEST_ID = "req_00000000-0000-4000-8000-00000000000b";
  /** How far past the summary budget the long input runs; any positive margin exercises the cut marker. */
  const LONG_INPUT_MARGIN_CHARS = 200;
  /** An input past the summary budget, so the cut marker is exercised. */
  const LONG_INPUT_CHARS = RC_PENDING_SUMMARY_EXCERPT_CHARS + LONG_INPUT_MARGIN_CHARS;

  /** One worker event batch carrying the given payloads, the documented `{worker_epoch, events}` write shape. */
  const workerEventsBody = (...payloads: readonly unknown[]): string => JSON.stringify({ worker_epoch: 1, events: payloads.map((payload) => ({ payload })) });

  it("records a can_use_tool control request from a worker event write, with its id, type, and a summary naming the tool and a bounded excerpt of the input", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } }),
    }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf()).toEqual([{ sessionId: SESSION_ID, requestId: REQUEST_ID, type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: CLOCK_START_MS }]);
    expect(tracker.pendingOf(SESSION_ID)).toEqual(tracker.pendingOf());
    expect(tracker.pendingOf("cse_00000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it("bounds the summary's input excerpt, records other control_request subtypes by their type, and skips payloads no response could echo", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody(
        { type: "control_request", request_id: OTHER_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Write", input: { content: "x".repeat(LONG_INPUT_CHARS) } } },
        { type: "control_request", request_id: REQUEST_ID, request: { subtype: "set_model", model: "claude-opus-5-5" } },
        { type: "control_request", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } },
        { type: "assistant", message: {} },
      ),
    }).respond(HTTP_STATUS.ok);
    const pending = tracker.pendingOf();
    // Both requests were observed in one batch, so the same instant leaves the id order to break the tie.
    expect(pending.map((request) => request.requestId)).toEqual([REQUEST_ID, OTHER_REQUEST_ID]);
    // The excerpt is the codebase's one-line detail budget: the summary budget's characters of input, marked as cut when it was cut.
    const write = pending.find((request) => request.requestId === OTHER_REQUEST_ID);
    expect(write?.type).toBe("can_use_tool");
    expect(write?.summary.startsWith('Write {"content":"xxxx')).toBe(true);
    expect(write?.summary.length).toBeLessThanOrEqual(`Write `.length + RC_PENDING_SUMMARY_EXCERPT_CHARS + "...".length);
    expect(write?.summary.endsWith("...")).toBe(true);
    const setModel = pending.find((request) => request.requestId === REQUEST_ID);
    expect(setModel?.type).toBe("set_model");
    expect(setModel?.summary).toBe('{"subtype":"set_model","model":"claude-opus-5-5"}');
  });

  it("completes a pending request when the matching control_response is observed on the session's client-half write, and leaves others pending", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody(
        { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } },
        { type: "control_request", request_id: OTHER_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "WebFetch", input: {} } },
      ),
    }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: CLIENT_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: JSON.stringify({ session_id: SESSION_ID, events: [{ payload: { type: "control_response", response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "deny", message: "not today" } } } }] }),
    }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
  });

  it("holds a pending request for as long as its session stays live, since the worker waits on it until it is answered or withdrawn", () => {
    const { tracker, advance } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } }),
    }).respond(HTTP_STATUS.ok);
    // Several heartbeat intervals pass with the session's heartbeats arriving: the worker sets no deadline, so the request stays pending until something retires it.
    const heartbeatLater = (): void => {
      advance(HEARTBEAT_INTERVAL_MS);
      exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    };
    heartbeatLater();
    heartbeatLater();
    heartbeatLater();
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
    // The worker's own idle registration is what retires it, with the session still tracked.
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${SESSION_ID}/worker`, authorization: "Bearer b", requestBody: JSON.stringify({ worker_status: "idle", worker_epoch: 1 }) }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf()).toEqual([]);
    expect(tracker.list().map((session) => session.id)).toEqual([SESSION_ID]);
  });

  it("retires a pending request when the worker withdraws it with a control_cancel_request, from the client read stream or from a worker event write", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody(
        { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } },
        { type: "control_request", request_id: OTHER_REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Write", input: {} } },
      ),
    }).respond(HTTP_STATUS.ok);
    // The worker withdraws a request it resolved itself (answered or dismissed in its own terminal) with this payload, observed live on the stream right after its own control_response.
    tracker.fileStreamEvent(SESSION_ID, { event_id: "e1", sequence_num: 1, event_type: "control_cancel_request", source: "worker", payload: { type: "control_cancel_request", request_id: REQUEST_ID }, created_at: "2026-01-01T00:00:00Z" });
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
    exchange(tracker, { method: "POST", url: WORKER_EVENTS_PATH, authorization: "Bearer b", requestBody: workerEventsBody({ type: "control_cancel_request", request_id: OTHER_REQUEST_ID }) }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf()).toEqual([]);
  });

  it("ignores a control_cancel_request on the stream from anyone but the worker, since only the worker's own withdrawal ends its wait", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    tracker.fileStreamEvent(SESSION_ID, { event_id: "e1", sequence_num: 1, event_type: "control_request", source: "worker", payload: { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }, created_at: "2026-01-01T00:00:00Z" });
    tracker.fileStreamEvent(SESSION_ID, { event_id: "e2", sequence_num: 2, event_type: "control_cancel_request", source: "client", payload: { type: "control_cancel_request", request_id: REQUEST_ID }, created_at: "2026-01-01T00:00:00Z" });
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
  });

  describe("retirement by worker registration", () => {
    const workerPath = `/v1/code/sessions/${SESSION_ID}/worker`;
    const register = (tracker: RcSessionTracker, body: Record<string, unknown>, status: number = HTTP_STATUS.ok): void => {
      exchange(tracker, { method: "PUT", url: workerPath, authorization: "Bearer b", requestBody: JSON.stringify(body) }).respond(status);
    };
    const ask = (tracker: RcSessionTracker, requestId: string, sequence: number): void => {
      tracker.fileStreamEvent(SESSION_ID, { event_id: `e${String(sequence)}`, sequence_num: sequence, event_type: "control_request", source: "worker", payload: { type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }, created_at: "2026-01-01T00:00:00Z" });
    };
    const answered = (tracker: RcSessionTracker, requestId: string, sequence: number): void => {
      tracker.fileStreamEvent(SESSION_ID, { event_id: `e${String(sequence)}`, sequence_num: sequence, event_type: "control_response", source: "client", payload: { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow" } } }, created_at: "2026-01-01T00:00:00Z" });
    };

    it("keeps a request still waiting when the worker reports running after another was answered", () => {
      const { tracker, advance } = trackerWithClock();
      register(tracker, { worker_status: "requires_action", worker_epoch: 1 });
      ask(tracker, REQUEST_ID, 1);
      ask(tracker, OTHER_REQUEST_ID, 2);
      answered(tracker, REQUEST_ID, THIRD_EVENT);
      advance(1);
      register(tracker, { worker_status: "running", worker_epoch: 1 });
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
    });

    it("keeps a request when a delayed running registration lands after it was observed", () => {
      const { tracker, advance } = trackerWithClock();
      register(tracker, { worker_status: "running", worker_epoch: 1 });
      advance(1);
      ask(tracker, REQUEST_ID, 1);
      advance(1);
      register(tracker, { worker_status: "running", worker_epoch: 1 });
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
    });

    it("retires on idle only the requests observed before that registration began, and never on a refused registration", () => {
      const { tracker, advance } = trackerWithClock();
      register(tracker, { worker_status: "requires_action", worker_epoch: 1 });
      ask(tracker, REQUEST_ID, 1);
      advance(1);
      register(tracker, { worker_status: "idle", worker_epoch: 1 }, HTTP_CONFLICT);
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
      advance(1);
      const idle = exchange(tracker, { method: "PUT", url: workerPath, authorization: "Bearer b", requestBody: JSON.stringify({ worker_status: "idle", worker_epoch: 1 }) });
      advance(1);
      ask(tracker, OTHER_REQUEST_ID, 2);
      idle.respond(HTTP_STATUS.ok);
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
    });

    it("tells a request filed in the same clock millisecond apart by observation order: one filed before the idle registration began retires, one filed while it was in flight survives", () => {
      // The clock never moves in this case, so only the order of observations can tell the two requests apart.
      const { tracker } = trackerWithClock();
      register(tracker, { worker_status: "requires_action", worker_epoch: 1 });
      ask(tracker, REQUEST_ID, 1);
      const idle = exchange(tracker, { method: "PUT", url: workerPath, authorization: "Bearer b", requestBody: JSON.stringify({ worker_status: "idle", worker_epoch: 1 }) });
      ask(tracker, OTHER_REQUEST_ID, 2);
      idle.respond(HTTP_STATUS.ok);
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
    });

    it("retires every earlier request when a registration names a new worker epoch", () => {
      const { tracker, advance } = trackerWithClock();
      register(tracker, { worker_status: "requires_action", worker_epoch: 1 });
      ask(tracker, REQUEST_ID, 1);
      advance(1);
      register(tracker, { worker_status: "requires_action", worker_epoch: 2 });
      expect(tracker.pendingOf()).toEqual([]);
    });
  });

  describe("bounds and tombstones", () => {
    const ask = (tracker: RcSessionTracker, requestId: string, sequence: number, input: unknown = {}): void => {
      tracker.fileStreamEvent(SESSION_ID, { event_id: `e${String(sequence)}`, sequence_num: sequence, event_type: "control_request", source: "worker", payload: { type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input } }, created_at: "2026-01-01T00:00:00Z" });
    };
    const heartbeat = (tracker: RcSessionTracker): void => {
      exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    };

    it("does not list a retired request again when a late duplicate of it arrives, and keeps the first observed instant on a re-observation", () => {
      const { tracker, advance } = trackerWithClock();
      heartbeat(tracker);
      ask(tracker, REQUEST_ID, 1);
      advance(1);
      ask(tracker, OTHER_REQUEST_ID, 2);
      advance(1);
      ask(tracker, REQUEST_ID, THIRD_EVENT);
      expect(tracker.pendingOf().map((request) => [request.requestId, request.observedAt])).toEqual([
        [REQUEST_ID, CLOCK_START_MS],
        [OTHER_REQUEST_ID, CLOCK_START_MS + 1],
      ]);
      tracker.completePending(SESSION_ID, REQUEST_ID);
      ask(tracker, REQUEST_ID, FOURTH_EVENT);
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([OTHER_REQUEST_ID]);
    });

    it("counts requests past the per-session cap and requests whose id the protocol would not mint as dropped, instead of storing them", () => {
      const { tracker } = trackerWithClock();
      heartbeat(tracker);
      for (let index = 0; index < RC_PENDING_PER_SESSION_MAX + 1; index += 1) {
        ask(tracker, `req-${String(index)}`, index);
      }
      ask(tracker, "x".repeat(RC_REQUEST_ID_MAX_CHARS + 1), RC_PENDING_PER_SESSION_MAX + 1);
      expect(tracker.pendingOf()).toHaveLength(RC_PENDING_PER_SESSION_MAX);
      expect(tracker.statusOf()[0]?.pendingDropped).toBe(2);
      // A stream replay of the dropped request is the same request, so it is not counted again.
      ask(tracker, `req-${String(RC_PENDING_PER_SESSION_MAX)}`, RC_PENDING_PER_SESSION_MAX + 2);
      expect(tracker.statusOf()[0]?.pendingDropped).toBe(2);
      // The worker's own event write carries the same request on the other channel, and is not counted again either.
      exchange(tracker, {
        method: "POST",
        url: `/v1/code/sessions/${SESSION_ID}/worker/events`,
        authorization: "Bearer b",
        requestBody: JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "control_request", request_id: `req-${String(RC_PENDING_PER_SESSION_MAX)}`, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} } } }] }),
      }).respond(HTTP_STATUS.ok);
      expect(tracker.statusOf()[0]?.pendingDropped).toBe(2);
    });

    it("marks a request past the parse cap as oversized, holding its summary only", () => {
      const { tracker } = trackerWithClock();
      heartbeat(tracker);
      // Every question field is within its own bound; what passes the cap is a field the door does not list (an option's preview), so the cap itself is what marks it.
      ask(tracker, REQUEST_ID, 1, { questions: [{ question: "Q?", options: [{ label: "A", preview: "x".repeat(RC_REQUEST_PARSE_CAP_BYTES) }] }] });
      const [pending] = tracker.pendingOf();
      expect(pending?.oversized).toBe(true);
      expect(pending?.unanswerable).toContain("parse cap");
      expect(pending?.questions).toBeUndefined();
      expect(tracker.pendingToolInputOf(SESSION_ID, REQUEST_ID)).toBeUndefined();
    });

    it("forgets the oldest retired id once RC_RETIRED_TOMBSTONES_MAX are remembered, so only that id can be born again", () => {
      const { tracker } = trackerWithClock();
      heartbeat(tracker);
      const retireOne = (requestId: string, sequence: number): void => {
        ask(tracker, requestId, sequence);
        tracker.completePending(SESSION_ID, requestId);
      };
      for (let index = 0; index <= RC_RETIRED_TOMBSTONES_MAX; index += 1) {
        retireOne(`req-${String(index)}`, index);
      }
      // One past the bound has been retired: the first is forgotten and comes back on a replay, the second is still remembered.
      ask(tracker, "req-0", RC_RETIRED_TOMBSTONES_MAX + 1);
      ask(tracker, "req-1", RC_RETIRED_TOMBSTONES_MAX + 2);
      expect(tracker.pendingOf().map((request) => request.requestId)).toEqual(["req-0"]);
    });

    it("lets one answer at a time claim a pending request", () => {
      const { tracker } = trackerWithClock();
      heartbeat(tracker);
      ask(tracker, REQUEST_ID, 1);
      const release = tracker.claimPending(SESSION_ID, REQUEST_ID);
      expect(release).toBeDefined();
      expect(tracker.claimPending(SESSION_ID, REQUEST_ID)).toBeUndefined();
      release?.();
      expect(tracker.claimPending(SESSION_ID, REQUEST_ID)).toBeDefined();
      expect(tracker.claimPending(SESSION_ID, OTHER_REQUEST_ID)).toBeUndefined();
    });
  });

  it("records nothing from a request body past the parse cap, and the exchange still succeeds", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    const padding = "x".repeat(RC_REQUEST_PARSE_CAP_BYTES);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: padding } } }),
    }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf()).toEqual([]);
    expect(tracker.list().map((session) => session.id)).toEqual([SESSION_ID]);
  });

  it("files no pending request when the worker event write is refused, whatever order the refusal and the request end arrive in", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }),
    }).respond(HTTP_CONFLICT);
    expect(tracker.pendingOf()).toEqual([]);
  });

  it("drops a session's pending requests with it when the session archives", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }),
    }).respond(HTTP_STATUS.ok);
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/archive`, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    expect(tracker.pendingOf()).toEqual([]);
    expect(tracker.statusOf()).toEqual([]);
  });
});

describe("the Remote Control session status", () => {
  const WORKER_PATH = `/v1/code/sessions/${SESSION_ID}/worker`;

  it("reports the worker state from the latest registration and the idle from the latest heartbeat, each with its instant", () => {
    const { tracker, advance } = trackerWithClock();
    // The registration body carries the field the CLI's own worker state update sends (`worker_status`, per the 2.1.88 source dump and the 2.1.289 bundle's strings).
    exchange(tracker, { method: "PUT", url: WORKER_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ worker_status: "WORKER_STATUS_RUNNING", worker_epoch: 1 }) }).respond(HTTP_STATUS.ok);
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ session_id: SESSION_ID, worker_epoch: 1, supports_heartbeat_probe: true, current_interval_seconds: 20, idle_seconds: 7 }) }).respond(HTTP_STATUS.ok);
    const status = tracker.statusOf()[0];
    expect(status?.id).toBe(SESSION_ID);
    expect(status?.workerState).toEqual({ value: "WORKER_STATUS_RUNNING", observedAt: CLOCK_START_MS });
    expect(status?.workerIdleSeconds).toEqual({ value: 7, observedAt: CLOCK_START_MS + HEARTBEAT_INTERVAL_MS });
    expect(status?.pending).toEqual([]);
    advance(HEARTBEAT_INTERVAL_MS);
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ idle_seconds: 27 }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.workerIdleSeconds).toEqual({ value: 27, observedAt: CLOCK_START_MS + 2 * HEARTBEAT_INTERVAL_MS });
    expect(tracker.statusOf()[0]?.workerState).toEqual({ value: "WORKER_STATUS_RUNNING", observedAt: CLOCK_START_MS });
    expect(tracker.statusOf("cse_00000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it("reports the model the worker registration's metadata named, the latest one winning, and no model key before one is seen", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "PUT", url: WORKER_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ worker_status: "idle", worker_epoch: 1, external_metadata: { task_summary: null } }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]).not.toHaveProperty("model");
    exchange(tracker, { method: "PUT", url: WORKER_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ worker_epoch: 1, external_metadata: { model: "claude-opus-4" } }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.model).toBe("claude-opus-4");
    exchange(tracker, { method: "PUT", url: WORKER_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ worker_epoch: 1, external_metadata: { model: null } }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.model).toBe("claude-opus-4");
    exchange(tracker, { method: "PUT", url: WORKER_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ worker_epoch: 1, external_metadata: { model: "claude-sonnet-4" } }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.model).toBe("claude-sonnet-4");
  });

  it("reads the model and working directory the session's init event stated, whether the worker wrote it or the client stream carried it", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer b" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    tracker.fileStreamEvent(SESSION_ID, { event_id: "e", sequence_num: 1, event_type: "system", source: "worker", payload: { type: "system", subtype: "init", model: "claude-opus-4", cwd: "/repo" }, created_at: "2026-01-01T00:00:00Z" });
    expect(tracker.statusOf()[0]).toMatchObject({ model: "claude-opus-4", cwd: "/repo" });
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${SESSION_ID}/worker/events`, authorization: "Bearer b", requestBody: JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "system", subtype: "init", model: "claude-haiku-4" } }] }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]).toMatchObject({ model: "claude-haiku-4", cwd: "/repo" });
  });

  it("reports the identity the session's own requests named, the latest one winning, and none when no request named one", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer b" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(tracker.statusOf()[0]).not.toHaveProperty("identity");
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b", identity: "work", requestBody: JSON.stringify({ idle_seconds: 1 }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.identity).toBe("work");
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b", requestBody: JSON.stringify({ idle_seconds: 2 }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.identity).toBe("work");
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b", identity: "personal", requestBody: JSON.stringify({ idle_seconds: 3 }) }).respond(HTTP_STATUS.ok);
    expect(tracker.statusOf()[0]?.identity).toBe("personal");
  });

  it("takes the identity from the create exchange that births the session", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer b", identity: "work" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(tracker.statusOf()[0]?.identity).toBe("work");
  });

  it("carries the launching identity from a routed request through the observing wrapper", async () => {
    const { tracker } = trackerWithClock();
    const route: FrontDoorRoute = {
      name: "stand-in",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request: RoutedRequest, response: RoutedResponse) => {
        response.start(HTTP_STATUS.ok, {});
        await response.write(JSON.stringify({ session: { id: SESSION_ID } }));
        response.end();
      },
    };
    const request: RoutedRequest = {
      method: "POST",
      url: "/v1/code/sessions",
      headers: { authorization: "Bearer sk-ant-oat" },
      body: new IncomingMessage(new Socket()),
      signal: new AbortController().signal,
      session: { identity: "work", sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
    };
    const response: RoutedResponse = { headersSent: false, start: () => undefined, flush: () => undefined, write: async () => { await Promise.resolve(); }, end: () => undefined, destroy: () => undefined };
    await observingRoutedRoute(route, tracker).serve(request, response);
    expect(tracker.statusOf()[0]?.identity).toBe("work");
  });

  it("reports no worker facts for a session observed only through its create", () => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer b" }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    expect(tracker.statusOf()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS, workerState: undefined, workerIdleSeconds: undefined, pending: [] }]);
  });
});

describe("the RoutedResponse tee the door's resolver applies", () => {
  it("feeds a served route's request body to the tracker through additive listeners, so a worker event write through the wrapper births its pending request without taking the body from the route", async () => {
    const { tracker } = trackerWithClock();
    const ended: boolean[] = [];
    /** A stand-in response recording what the route did, so the body listeners are proven not to change it. */
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
      write: async () => {
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
        // The pipe-only shape the bare /v1/ pass-through route applies: the body is consumed by piping it onward, never read whole. The await keeps this the route interface's own async shape while the body is left to the pipe.
        await Promise.resolve();
        response.start(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end();
      },
    };
    const body = new IncomingMessage(new Socket());
    const request: RoutedRequest = {
      method: "POST",
      url: `/v1/code/sessions/${SESSION_ID}/worker/events`,
      headers: { authorization: "Bearer sk-ant-oat" },
      // A real IncomingMessage over an unconnected socket, fed by hand: the additive listeners must see exactly these bytes, and the route's own flow must be unchanged.
      body,
      signal: new AbortController().signal,
      session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
    };
    const served = observingRoutedRoute(route, tracker).serve(request, recordingResponse);
    body.push(JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "control_request", request_id: "req-tee-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } } }] }));
    body.push(null);
    await served;
    // The listeners the wrapper attached deliver on later ticks than the response the stand-in route ended synchronously, exactly as a piped body would.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(ended).toEqual([true]);
    expect(tracker.pendingOf().map((pending) => pending.requestId)).toEqual(["req-tee-1"]);
    expect(tracker.pendingOf()[0]?.summary).toBe('Bash {"command":"pnpm test"}');
  });

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
      headers: { authorization: "Bearer sk-ant-oat" },
      // A real IncomingMessage over an unconnected socket: the stand-in route never reads the body, and constructing the genuine type keeps the request honest.
      body: new IncomingMessage(new Socket()),
      signal: new AbortController().signal,
      session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
    };
    await observingRoutedRoute(route, tracker).serve(request, recordingResponse);
    expect(writes).toEqual([Buffer.from(JSON.stringify({ session: { id: SESSION_ID } }), "utf8")]);
    expect(ended).toEqual([true]);
    expect(tracker.list()).toEqual([{ id: SESSION_ID, createdAt: CLOCK_START_MS, lastSeenAt: CLOCK_START_MS }]);
    expect(tracker.credentialOf(SESSION_ID)?.authorization).toBe("Bearer sk-ant-oat");
  });

  describe("live agent tasks", () => {
    const WORKER_EVENTS_PATH = `/v1/code/sessions/${SESSION_ID}/worker/events`;
    const started = { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_1", task_type: "local_agent", description: "look" };

    it("reads task events out of a successful worker event batch", () => {
      const { tracker } = trackerWithClock();
      exchange(tracker, { method: "POST", url: HEARTBEAT_PATH }).respond(HTTP_STATUS.ok);
      exchange(tracker, { method: "POST", url: WORKER_EVENTS_PATH, requestBody: JSON.stringify({ events: [{ payload: started }] }) }).respond(HTTP_STATUS.ok);
      expect(tracker.liveTasksOf(SESSION_ID)).toEqual([expect.objectContaining({ taskId: "a1", sessionId: SESSION_ID, toolUseId: "toolu_1", status: "running" })]);
    });

    it("reads them from the client read stream too, and the same event twice is one task", () => {
      const { tracker } = trackerWithClock();
      exchange(tracker, { method: "POST", url: HEARTBEAT_PATH }).respond(HTTP_STATUS.ok);
      exchange(tracker, { method: "POST", url: WORKER_EVENTS_PATH, requestBody: JSON.stringify({ events: [{ payload: started }] }) }).respond(HTTP_STATUS.ok);
      tracker.fileStreamEvent(SESSION_ID, { event_id: "e", sequence_num: 1, event_type: "system", source: "worker", payload: { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "completed" } }, created_at: "2026-01-01T00:00:00Z" });
      tracker.fileStreamEvent(SESSION_ID, { event_id: "e2", sequence_num: 2, event_type: "system", source: "worker", payload: started, created_at: "2026-01-01T00:00:00Z" });
      expect(tracker.liveTasksOf()).toHaveLength(1);
    });

    it("files nothing from a refused batch and drops the tasks with the idle session", () => {
      const { tracker, advance } = trackerWithClock();
      exchange(tracker, { method: "POST", url: HEARTBEAT_PATH }).respond(HTTP_STATUS.ok);
      exchange(tracker, { method: "POST", url: WORKER_EVENTS_PATH, requestBody: JSON.stringify({ events: [{ payload: started }] }) }).respond(HTTP_STATUS.unauthorized);
      expect(tracker.liveTasksOf()).toEqual([]);
      exchange(tracker, { method: "POST", url: WORKER_EVENTS_PATH, requestBody: JSON.stringify({ events: [{ payload: started }] }) }).respond(HTTP_STATUS.ok);
      advance(RC_IDLE_EXPIRY_MS);
      expect(tracker.liveTasksOf()).toEqual([]);
    });
  });
});
