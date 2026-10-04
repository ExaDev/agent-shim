import type { IncomingHttpHeaders } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import type { PassthroughObserver } from "./capture";
import type { FrontDoorRoute, RoutedResponse } from "./route";

/**
 * Remote Control session tracking and prompt injection: the front door's record of the `cse_` sessions whose traffic crosses its terminated API-host session, and the client-half write that delivers a prompt to one of them.
 *
 * The tracker is observational: the door already terminates the API host's TLS, so it sees the CLI's own `POST /v1/code/sessions` (whose answer carries the new session's `cse_` id) and every recurring `/v1/code/sessions/...` call (heartbeat, presence), each carrying the session's Authorization bearer and the protocol headers a client-half replay needs. Per session the tracker retains the latest of each, because those calls recur and the freshest value is the live one. Everything is held in this process's memory only: nothing here is written to a log, to the capture, or to disk, and the summary the control surface lists never includes the credential. The capture's existing redaction is untouched; a capture and this tracker observe the same exchanges through entirely separate paths.
 *
 * Injection replays the protocol's documented client half rather than splicing frames into any relayed stream: `POST /v1/code/sessions/{id}/events` with one user-message payload event, authenticated by the observed bearer and the observed protocol headers, sent from the door over its own interception-proof dials. Sequence numbers therefore come from the real service and the event is mirrored to every attached client, exactly as a message typed into claude.ai would be.
 */

/** Every Remote Control exchange on the API host sits under this path prefix. */
export const RC_SESSIONS_PATH_PREFIX = "/v1/code/sessions";

/** The id prefix the protocol's own clients validate before using a session id, so the tracker applies the same test before recording one. */
const RC_SESSION_ID_PREFIX = "cse_";

/**
 * How long an entry survives without any observed exchange for its session. Derived from the protocol's own liveness, not chosen: the worker heartbeats every 20 s (the `current_interval_seconds` our own captured heartbeat body carries), so a live session produces observable traffic at least that often, and the transport's documented liveness bound is the 45 s stream timeout, which outlasts two missed heartbeat intervals (40 s) precisely so a momentarily quiet session is not dropped. An entry idle past 45 s therefore names a session the protocol itself has given up on, which makes 45 s the exact bound where retaining it stops describing anything live.
 */
export const RC_IDLE_EXPIRY_MS = 45_000;

/**
 * How much of a session-create response body the tracker ever holds. A create answer is one small JSON object naming the session, and 8 KiB is already the head-and-excerpt budget this surface applies elsewhere (`MAX_CONNECT_HEAD_BYTES`, `CHUNK_LOG_CAP_BYTES`), so one budget serves every notion of "a small diagnostic-sized answer" here; a body past it is not a create answer and is never parsed.
 */
const RC_CREATE_RESPONSE_CAP_BYTES = 8192;

/** The response header the API uses to close a worker's session out from under it: any observed value means this session is no longer the live one. */
const CONFLICT_REASON_HEADER = "x-ccr-conflict-reason";

/** The exclusive ceiling of the 2xx success class, whose bounds are fixed hundreds (RFC 9110 section 15); named once so a range check never carries a bare literal. */
const SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** Whether a status is a 2xx success. */
function isSuccessful(status: number): boolean {
  return status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_MAX_EXCLUSIVE;
}

/** What the tracker retains about one observed session, in memory only. The credential fields feed the inject path and nothing else: they never appear in a summary, a log or the capture. */
interface RcSessionRecord {
  readonly id: string;
  readonly createdAt: number;
  /** The instant of the last observed exchange for this session. */
  lastSeenAt: number;
  /** The most recent Authorization header value observed on this session's calls, replayed verbatim on injection. */
  authorization: string | undefined;
  /** The most recent `anthropic-version` value observed on this session's calls. */
  anthropicVersion: string | undefined;
  /** The most recent `anthropic-client-platform` value observed on this session's calls. */
  anthropicClientPlatform: string | undefined;
}

/** One observed session as the control surface lists it: the identification and timing only, never the credential. */
export interface RcSessionSummary {
  readonly id: string;
  /** When the session's create exchange completed, in epoch milliseconds from the injected clock. */
  readonly createdAt: number;
  /** When traffic for this session was last observed, in epoch milliseconds from the injected clock. */
  readonly lastSeenAt: number;
}

/** The request facts one observed exchange arrives with. */
export interface RcObservedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
}

/** What one observed exchange's response drives, in arrival order: the head, each body chunk, then the end exactly once. */
export interface RcExchangeObserver {
  readonly onResponse: (status: number, headers: Readonly<IncomingHttpHeaders>) => void;
  readonly onBodyChunk: (chunk: Uint8Array) => void;
  readonly onEnd: () => void;
}

/** Everything the tracker needs, injected so its decisions and lifecycle run against fakes in unit tests. */
export interface RcSessionTrackerDeps {
  readonly now: () => number;
  /** How long an entry may sit unobserved before it is expired; production passes `RC_IDLE_EXPIRY_MS`, tests pass small values so a deadline is reached in milliseconds. */
  readonly idleMs: number;
}

/** The live record of observed Remote Control sessions. */
export interface RcSessionTracker {
  /** Feeds one request/response exchange in: returns the observer its response drives when the request belongs to the Remote Control surface, or undefined when it does not, in which case nothing is retained and the response needs no observing. */
  readonly observeExchange: (request: RcObservedRequest) => RcExchangeObserver | undefined;
  /** Every live entry, idle ones expired first, sorted oldest-created first. */
  readonly list: () => readonly RcSessionSummary[];
  /** The observed credential and protocol headers for one session, the inject path's accessor: present only while the session is tracked, and never surfaced anywhere a summary, log or capture goes. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Stops the idle sweep timer. The entries themselves are unreachable the moment the door drops them. */
  readonly close: () => void;
}

/** One header's single value, or undefined when absent or an unusable repeat. */
function singleHeader(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Whether a create response body names a session id: parses as JSON, navigates to `session.id`, and accepts only a `cse_`-prefixed string, the same prefix the real client validates. */
function sessionCreateId(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("session" in parsed)) {
    return undefined;
  }
  const session = parsed.session;
  if (typeof session !== "object" || session === null || !("id" in session)) {
    return undefined;
  }
  const id = session.id;
  return typeof id === "string" && id.startsWith(RC_SESSION_ID_PREFIX) ? id : undefined;
}

/** Creates the tracker. One per door process; everything it holds dies with it. */
export function createRcSessionTracker(deps: RcSessionTrackerDeps): RcSessionTracker {
  const entries = new Map<string, RcSessionRecord>();
  const expire = (id: string): void => {
    entries.delete(id);
  };
  const sweep = (): void => {
    for (const [id, entry] of entries) {
      if (deps.now() - entry.lastSeenAt >= deps.idleMs) {
        expire(id);
      }
    }
  };
  // The sweep only bounds memory between listings: `list` sweeps on read, so what it returns is always exact however long the timer waits.
  const timer = setInterval(sweep, deps.idleMs);
  timer.unref();

  const observeExchange = (request: RcObservedRequest): RcExchangeObserver | undefined => {
    const method = (request.method ?? "").toUpperCase();
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!path.startsWith(RC_SESSIONS_PATH_PREFIX)) {
      return undefined;
    }
    const tail = path.slice(RC_SESSIONS_PATH_PREFIX.length);
    const facts = {
      authorization: singleHeader(request.headers, "authorization"),
      anthropicVersion: singleHeader(request.headers, "anthropic-version"),
      anthropicClientPlatform: singleHeader(request.headers, "anthropic-client-platform"),
    };
    if (tail === "") {
      // The bare path is the create (POST) and the list (GET); only the create births an entry, and its id arrives in the response, so the request's facts travel with the observer and are filed when the id is known.
      if (method !== "POST") {
        return undefined;
      }
      let accepted = false;
      let buffered = 0;
      let body = "";
      return {
        onResponse: (status) => {
          accepted = isSuccessful(status);
        },
        onBodyChunk: (chunk) => {
          if (!accepted || buffered >= RC_CREATE_RESPONSE_CAP_BYTES) {
            return;
          }
          const text = Buffer.from(chunk).toString("utf8");
          body = body + text.slice(0, RC_CREATE_RESPONSE_CAP_BYTES - buffered);
          buffered = body.length;
        },
        onEnd: () => {
          if (!accepted) {
            return;
          }
          const id = sessionCreateId(body);
          if (id === undefined) {
            return;
          }
          entries.set(id, { id, createdAt: deps.now(), lastSeenAt: deps.now(), ...facts });
        },
      };
    }
    const rest = tail.slice(1);
    const [id] = rest.split("/");
    if (id?.startsWith(RC_SESSION_ID_PREFIX) !== true) {
      return undefined;
    }
    // Every recurring session call refreshes the entry: the bearer and protocol headers are latest-wins because the freshest observed value is the live one (heartbeats and presence recur on the session's own credential).
    const entry = entries.get(id);
    if (entry === undefined) {
      // A session the door never saw created (it started before this door generation) still becomes observable from its recurring calls, since the id is in the path and the credential on the request.
      entries.set(id, { id, createdAt: deps.now(), lastSeenAt: deps.now(), ...facts });
    } else {
      entry.lastSeenAt = deps.now();
      entry.authorization = facts.authorization ?? entry.authorization;
      entry.anthropicVersion = facts.anthropicVersion ?? entry.anthropicVersion;
      entry.anthropicClientPlatform = facts.anthropicClientPlatform ?? entry.anthropicClientPlatform;
    }
    const archiving = method === "POST" && rest === `${id}/archive`;
    return {
      onResponse: (status, headers) => {
        // A conflict header closes the session whatever the status says, and an accepted archive ends it by design; either way the entry describes something that is no longer live.
        if (singleHeader(headers, CONFLICT_REASON_HEADER) !== undefined || (archiving && isSuccessful(status))) {
          expire(id);
        }
      },
      onBodyChunk: () => {
        // A recurring call's response body carries nothing the tracker retains.
      },
      onEnd: () => {
        // Filing happened at the request; the end only matters for the create.
      },
    };
  };

  return {
    observeExchange,
    list: () => {
      sweep();
      return [...entries.values()].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1)).map(({ id, createdAt, lastSeenAt }) => ({ id, createdAt, lastSeenAt }));
    },
    credentialOf: (sessionId) => {
      const entry = entries.get(sessionId);
      return entry === undefined ? undefined : { authorization: entry.authorization, anthropicVersion: entry.anthropicVersion, anthropicClientPlatform: entry.anthropicClientPlatform };
    },
    close: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Wraps one route so the tracker sees every exchange the route serves: the request's facts are handed over first, and when they are Remote Control facts the response the route writes is teed to the tracker's observer while flowing on unchanged. Used on the door's route resolution, so the bare `/v1/` pass-through an OAuth session's Remote Control calls ride is where observation happens.
 */
export function observingRoutedRoute(route: FrontDoorRoute, tracker: RcSessionTracker): FrontDoorRoute {
  return {
    ...route,
    serve: async (request, response) => {
      const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.headers });
      await route.serve(request, observed === undefined ? response : teeRoutedResponse(response, observed));
    },
  };
}

/**
 * The response half of `observingRoutedRoute`: every call forwards to the wrapped response untouched, with the tracker's observer driven alongside. A route that ends mid-body because its client went away calls neither `end` nor `destroy`, so `onEnd` never runs and an unfinished create is simply never filed; the observer is then unreachable, and nothing is retained.
 */
function teeRoutedResponse(response: RoutedResponse, observer: RcExchangeObserver): RoutedResponse {
  return {
    get headersSent(): boolean {
      return response.headersSent;
    },
    start: (status, headers) => {
      observer.onResponse(status, headers);
      response.start(status, headers);
    },
    flush: () => {
      response.flush();
    },
    write: async (chunk) => {
      observer.onBodyChunk(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      await response.write(chunk);
    },
    end: () => {
      response.end();
      observer.onEnd();
    },
    destroy: () => {
      response.destroy();
      observer.onEnd();
    },
  };
}

/** Adapts the tracker's exchange observer to the passthrough forwarding's observer shape, so the connect test world (which forwards rather than routes) observes through the same tracker. */
export function rcObserverAsPassthrough(observer: RcExchangeObserver): PassthroughObserver {
  return {
    // The request body carries nothing the tracker reads: the credential and the session id are in the request's headers and path, already handed over with the request.
    onRequestChunk: () => {
      return;
    },
    onResponse: (status, headers) => {
      observer.onResponse(status, headers);
    },
    onResponseChunk: (chunk) => {
      observer.onBodyChunk(chunk);
    },
    onEnd: () => {
      observer.onEnd();
    },
  };
}

/**
 * Builds the user-message payload event for one injected prompt: the Agent SDK stream-json `user` message shape (`type`, `uuid`, `session_id`, `parent_tool_use_id`, `message` with a `user` role), the same envelope a claude.ai client sends as a turn. The content is the plain string form, which is the shape validated end to end against the real API by the third-party client survey that settled this protocol.
 */
export function buildRcUserMessagePayload(uuid: string, sessionId: string, text: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

/** Wraps payload event(s) in the write body the endpoint takes: `{"events": [{"payload": {...}}]}`. */
export function buildRcEventWriteBody(payload: Record<string, unknown>): Record<string, unknown> {
  return { events: [{ payload }] };
}

/** The headers injection sends: the observed credential and protocol values, replayed verbatim, never invented. */
export interface RcInjectHeaders {
  readonly authorization: string | undefined;
  readonly anthropicVersion: string | undefined;
  readonly anthropicClientPlatform: string | undefined;
}

/** One answer from the API host the inject path dials: the status and the whole body. This dial only ever reads small JSON answers, never a stream, so the body needs no cap of its own. */
export interface RcDialAnswer {
  readonly status: number;
  readonly body: string;
}

/** The one network effect injection performs, injected so the pure logic runs against fakes: POST the write body to the session's events endpoint. Production dials the real API host over the door's interception-proof agent; tests redirect to a local stand-in. */
export interface RcEventDial {
  readonly writeEvents: (sessionId: string, headers: Readonly<Record<string, string>>, body: string) => Promise<RcDialAnswer>;
}

/** What one injection attempt produced: the sequence numbers the real service assigned, or a verbose failure message ready to show a user. */
export type RcInjectResult = { readonly ok: true; readonly sequenceNums: readonly number[] } | { readonly ok: false; readonly message: string };

/** Reads `results[].sequence_num` out of an accepted write answer: the numbers the real service assigned to the events, which every attached client's stream resumes from. */
function sequenceNumsOf(body: string): readonly number[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) {
    return undefined;
  }
  const sequenceNums: number[] = [];
  const results: readonly unknown[] = parsed.results;
  for (const result of results) {
    if (typeof result !== "object" || result === null || !("sequence_num" in result)) {
      return undefined;
    }
    const sequenceNum: unknown = result.sequence_num;
    if (typeof sequenceNum !== "number") {
      return undefined;
    }
    sequenceNums.push(sequenceNum);
  }
  // An accepted write that assigned no sequence number at all confirms no delivery, so it is a failure to surface rather than an empty success.
  return sequenceNums.length === 0 ? undefined : sequenceNums;
}

/** Maps one dial answer to the inject result: an accepted write yields its sequence numbers; anything else yields a verbose message, with the 401 case naming the stale observed bearer as the cause. */
export function rcInjectResultFromAnswer(answer: RcDialAnswer): RcInjectResult {
  if (!isSuccessful(answer.status)) {
    if (answer.status === HTTP_STATUS.unauthorized) {
      return { ok: false, message: `the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale after the door last saw the session's traffic. The session's own client refreshes it on its next call, which the door will observe, so retry once Remote Control has been active again. API answer: ${answer.body}` };
    }
    return { ok: false, message: `the API answered HTTP ${String(answer.status)} to the injected event: ${answer.body}` };
  }
  const sequenceNums = sequenceNumsOf(answer.body);
  if (sequenceNums === undefined) {
    return { ok: false, message: `the API accepted the injected event but its answer named no results[].sequence_num, so delivery cannot be confirmed: ${answer.body}` };
  }
  return { ok: true, sequenceNums };
}

/** The credential and protocol headers the tracker holds for one session, the inject path's accessor: present only while the session is tracked, and never surfaced anywhere a summary, log or capture goes. */
export type RcObservedCredential = RcInjectHeaders;

/** Everything one injection needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcInjectDeps {
  /** Reads the observed credential for a session: the tracker's accessor, in production. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** The dial to the real API host. */
  readonly dial: RcEventDial;
  /** Mints the payload event's uuid: a v4 UUID or better in production. */
  readonly newUuid: () => string;
}

/**
 * Injects one user-message prompt into an observed session: the documented client-half write, `POST /v1/code/sessions/{id}/events`, authenticated by the observed bearer and carrying the observed protocol headers. The result is the sequence numbers the real service assigned, or a verbose failure. A dial that cannot reach the API host is reported rather than thrown, so a caller with no exception handling still shows the user exactly what failed.
 */
export async function injectRcUserMessage(deps: RcInjectDeps, sessionId: string, text: string): Promise<RcInjectResult> {
  const credential = deps.credentialOf(sessionId);
  if (credential === undefined) {
    return { ok: false, message: `the front door has not observed Remote Control session ${sessionId}: it may never have passed through this door, or it ended or expired (an entry lives only a bounded idle period past its last observed traffic)` };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Replayed only when observed, never invented: these values are what the real client was seen sending on this session's own calls.
  if (credential.authorization !== undefined) {
    headers.authorization = credential.authorization;
  }
  if (credential.anthropicVersion !== undefined) {
    headers["anthropic-version"] = credential.anthropicVersion;
  }
  if (credential.anthropicClientPlatform !== undefined) {
    headers["anthropic-client-platform"] = credential.anthropicClientPlatform;
  }
  const body = JSON.stringify(buildRcEventWriteBody(buildRcUserMessagePayload(deps.newUuid(), sessionId, text)));
  let answer: RcDialAnswer;
  try {
    answer = await deps.dial.writeEvents(sessionId, headers, body);
  } catch (error) {
    return { ok: false, message: `the door could not reach the API host to inject into session ${sessionId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return rcInjectResultFromAnswer(answer);
}
