import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createFakeFarmFs } from "../test-helpers";

import { createRcCredentialStore } from "./rcCredentialStore";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import {
  RC_IDLE_EXPIRY_MS,
  RC_PENDING_DEADLINE_MS,
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

  it("expires a pending request once the protocol's permission deadline has passed, and holds one inside it", () => {
    const { tracker, advance } = trackerWithClock();
    exchange(tracker, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer b" }).respond(HTTP_STATUS.ok);
    exchange(tracker, {
      method: "POST",
      url: WORKER_EVENTS_PATH,
      authorization: "Bearer b",
      requestBody: workerEventsBody({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } }),
    }).respond(HTTP_STATUS.ok);
    // The deadline is far inside the session's own idle bound, so it is the request that expires, not the entry.
    advance(RC_PENDING_DEADLINE_MS - 1);
    expect(tracker.pendingOf().map((request) => request.requestId)).toEqual([REQUEST_ID]);
    advance(1);
    expect(tracker.pendingOf()).toEqual([]);
    expect(tracker.list().map((session) => session.id)).toEqual([SESSION_ID]);
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
});
