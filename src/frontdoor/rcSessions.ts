import type { IncomingHttpHeaders } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import type { PassthroughObserver } from "./capture";
import type { RcCredentialStore } from "./rcCredentialStore";
import type { RcStreamEnvelope } from "./rcSchemas";
import type { FrontDoorRoute, RoutedResponse } from "./route";
import type { RcObservedCredential } from "./rcWrites";

/**
 * Remote Control session tracking: the record of the `cse_` sessions whose traffic crosses the door's terminated API-host session, and of the control requests awaiting an answer inside them. The client-half writes themselves (the prompt inject, the `control_response` answer, and every client-originated control request) live in `rcWrites.ts`, built on the observed credential this tracker holds.
 *
 * The tracker is observational: the door already terminates the API host's TLS, so it sees the CLI's own `POST /v1/code/sessions` (whose answer carries the new session's `cse_` id) and every recurring `/v1/code/sessions/...` call (heartbeat, presence), each carrying the session's Authorization bearer and the protocol headers a client-half replay needs. Per session the tracker retains the latest of each, because those calls recur and the freshest value is the live one. It also reads the request bodies of the exchanges whose payloads matter: the worker's event batches (whose `control_request` payloads, `can_use_tool` above all, are the approvals awaiting an answer), the worker heartbeats (whose bodies carry `idle_seconds`), the worker registration (whose body carries the worker state), and the client-half event writes (whose `control_response` payloads complete a pending request). Everything is held in this process's memory only: nothing here is written to a log, to the capture, or to disk, and the summary the control surface lists never includes the credential. The capture's existing redaction is untouched; a capture and this tracker observe the same exchanges through entirely separate paths.
 *
 * Every write replays the protocol's documented client half rather than splicing frames into any relayed stream: `POST /v1/code/sessions/{id}/events` with one payload event (a user message, a `control_response` answering an observed request by echoing its id, or a `control_request` a client originates), authenticated by the observed bearer and the observed protocol headers, sent from the door over its own interception-proof dials. Sequence numbers therefore come from the real service and the event is mirrored to every attached client, exactly as a message typed into claude.ai would be.
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

/** The client read stream's envelope source that names the worker (the CLI's half) as an event's emitter: the source a stream-borne `control_request` must carry to be a request the door can answer. */
const RC_STREAM_WORKER_SOURCE = "worker";

/**
 * How long a control request stays answerable once observed. The protocol's own permission round-trip is documented at roughly 10 to 14 seconds end to end, so the ceiling of that window is the exact bound after which the worker has already given up waiting: answering later would write a `control_response` nothing is waiting for. A request exactly at the bound is already too late, which is why expiry is `>=` and not `>`.
 */
export const RC_PENDING_DEADLINE_MS = 14_000;

/**
 * How much of one request body the tracker ever holds while parsing it. The protocol's own batch cap is 10 MiB, but that bound exists to admit bulk transcript events the tracker has no use for; what it reads out of a body (the control requests, the heartbeat's idle, the worker's state) is one control exchange's worth of JSON, the same notion of "a full exchange's body" the capture's per-exchange budget (`STREAM_LOG_CAP_BYTES`, 256 KiB) was sized for, so one budget serves both here. A body past it is skipped, never failed: the exchange flows on untouched and simply records nothing.
 */
export const RC_REQUEST_PARSE_CAP_BYTES = 262_144;

/**
 * How much of a control request's input the human-readable summary carries. A summary names the tool and sketches its input at a glance, and 300 characters is the log-detail budget this codebase already applies elsewhere (`UPSTREAM_LOG_DETAIL_CHARS`), so one budget serves both notions of "a one-line excerpt".
 */
export const RC_PENDING_SUMMARY_EXCERPT_CHARS = 300;

/** The exclusive ceiling of the 2xx success class, whose bounds are fixed hundreds (RFC 9110 section 15); named once so a range check never carries a bare literal. */
const SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** Whether a status is a 2xx success, stated once for this module family: the client-half writes module (`rcWrites.ts`) imports it, since a write answer and an observed exchange read the same success class. */
export function isSuccessful(status: number): boolean {
  return status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_MAX_EXCLUSIVE;
}

/** What the tracker retains about one observed session, in memory only. The credential fields feed the client-half write paths and nothing else: they never appear in a summary, a log or the capture. */
interface RcSessionRecord {
  readonly id: string;
  readonly createdAt: number;
  /** The instant of the last observed exchange for this session. */
  lastSeenAt: number;
  /** The most recent OAuth-kind Authorization header observed on this session's calls, replayed verbatim on the client-half writes. Worker calls carry the worker JWT instead; that credential authorises worker operations only, so it never becomes this value (and is retained nowhere, since no door write presents it). */
  oauthAuthorization: string | undefined;
  /** The most recent `anthropic-version` value observed on this session's calls. */
  anthropicVersion: string | undefined;
  /** The most recent `anthropic-client-platform` value observed on this session's calls. */
  anthropicClientPlatform: string | undefined;
  /** The session's control requests awaiting an answer, keyed by the id a `control_response` must echo. An entry lives exactly until it is answered or its deadline passes. */
  readonly pending: Map<string, RcPendingRequestRecord>;
  /** The worker state the latest worker registration named, with when that exchange was observed. */
  workerState: RcWorkerFact<string> | undefined;
  /** The idle the latest heartbeat carried, with when that exchange was observed. */
  workerIdleSeconds: RcWorkerFact<number> | undefined;
  /** The highest sequence number the door has seen for this session, from the client read stream's envelopes or from its own confirmed writes: the value a stream resume continues after. */
  sequenceNum: number | undefined;
}

/** One pending control request as the tracker holds it. */
interface RcPendingRequestRecord {
  readonly sessionId: string;
  readonly requestId: string;
  /** The request's subtype (`can_use_tool` and kin), or the payload discriminator when the subtype is absent. */
  readonly type: string;
  /** A short human-readable sketch: the tool name and a bounded excerpt of its input for `can_use_tool`. */
  readonly summary: string;
  readonly observedAt: number;
}

/** One pending control request as the control surface lists it: identification, type, summary and timing, never any credential. */
export interface RcPendingRequestSummary {
  readonly sessionId: string;
  /** The id a matching `control_response` must echo: the payload's `request_id`, the field the protocol's trust rule names. */
  readonly requestId: string;
  /** The request's subtype (`can_use_tool` and kin), or the payload discriminator when the subtype is absent. */
  readonly type: string;
  /** A short human-readable sketch: the tool name and a bounded excerpt of its input for `can_use_tool`. */
  readonly summary: string;
  /** When the request was observed, in epoch milliseconds from the injected clock. */
  readonly observedAt: number;
}

/** One observed fact about the worker, with the instant of the exchange that carried it. */
export interface RcWorkerFact<T> {
  readonly value: T;
  readonly observedAt: number;
}

/** One observed session as the status surface reports it: the list summary plus what the worker's own exchanges carried and the requests awaiting an answer, never the credential. */
export interface RcSessionStatus extends RcSessionSummary {
  /** The worker state the latest worker registration (`PUT /{id}/worker`) named, when one was observed. */
  readonly workerState: RcWorkerFact<string> | undefined;
  /** The idle the latest heartbeat carried, when one was observed. */
  readonly workerIdleSeconds: RcWorkerFact<number> | undefined;
  /** The session's control requests awaiting an answer, oldest-observed first. */
  readonly pending: readonly RcPendingRequestSummary[];
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

/** What one observed exchange drives, in arrival order: the request body chunks and their end (present only for the exchanges whose request payloads the tracker reads), then the response's head, each body chunk, and the end exactly once. */
export interface RcExchangeObserver {
  /** Feeds one request body chunk, when this exchange's request body carries something the tracker reads; absent otherwise, so an adapter never attaches a body listener for the exchanges that do not. */
  readonly onRequestChunk?: (chunk: Uint8Array) => void;
  /** The request body ended: the buffered body is parsed here, and its facts filed once the response is known to be a success. */
  readonly onRequestEnd?: () => void;
  readonly onResponse: (status: number, headers: Readonly<IncomingHttpHeaders>) => void;
  readonly onBodyChunk: (chunk: Uint8Array) => void;
  readonly onEnd: () => void;
}

/** Everything the tracker needs, injected so its decisions and lifecycle run against fakes in unit tests. */
export interface RcSessionTrackerDeps {
  readonly now: () => number;
  /** How long an entry may sit unobserved before it is expired; production passes `RC_IDLE_EXPIRY_MS`, tests pass small values so a deadline is reached in milliseconds. */
  readonly idleMs: number;
  /**
   * Where the observed client credential outlives this process. The worker's recurring calls carry the worker JWT, so a door generation that starts after a session's create observes nothing that states the OAuth bearer until some client-half call crosses; the store is what lets that generation still attach (and write). Absent, the credential is in memory only, exactly as it was before the store existed.
   */
  readonly credentialStore?: RcCredentialStore;
}

/** The live record of observed Remote Control sessions. */
export interface RcSessionTracker {
  /** Feeds one request/response exchange in: returns the observer its request and response drive when the request belongs to the Remote Control surface, or undefined when it does not, in which case nothing is retained and neither side needs observing. */
  readonly observeExchange: (request: RcObservedRequest) => RcExchangeObserver | undefined;
  /** Every live entry, idle ones expired first, sorted oldest-created first. */
  readonly list: () => readonly RcSessionSummary[];
  /** Every live entry as the status surface reports it, with the same sweeping and order as `list`, filtered to one session when named. */
  readonly statusOf: (sessionId?: string) => readonly RcSessionStatus[];
  /** Every control request awaiting an answer, deadline-expired ones dropped first, oldest-observed first, filtered to one session when named. */
  readonly pendingOf: (sessionId?: string) => readonly RcPendingRequestSummary[];
  /** The observed credential and protocol headers for one session, the client-half writes' accessor: present only while the session is tracked, and never surfaced anywhere a summary, log or capture goes. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Advances the session's sequence cursor to the highest number named, which every confirmed client-half write calls with the numbers the real service assigned its events. */
  readonly noteSequenceNums: (sessionId: string, sequenceNums: readonly number[]) => void;
  /** The session's sequence cursor: the highest number the door has seen, from the client read stream's envelopes or from its own confirmed writes; undefined while neither has been seen. */
  readonly sequenceNumOf: (sessionId: string) => number | undefined;
  /**
   * Files one client read stream envelope: advances the session's sequence cursor, and treats the payload exactly as an observed event-batch body's would be treated, which is how an approval reaches the pending list from the stream (the live finding behind the client attachment: the CLI routes `control_request`s only toward attached clients, so the stream, not the worker's own writes, is where a `can_use_tool` the door must answer becomes visible). A `control_request` whose envelope names the worker as its source births a pending entry; a `control_response` retires the request it answers, whoever answered it.
   */
  readonly fileStreamEvent: (sessionId: string, event: RcStreamEnvelope) => void;
  /** Retires one pending control request as answered: what a successful answer write calls, so the request stops being listed the moment it is answered. */
  readonly completePending: (sessionId: string, requestId: string) => void;
  /** Stops the idle sweep timer. The entries themselves are unreachable the moment the door drops them. */
  readonly close: () => void;
}

/** One header's single value, or undefined when absent or an unusable repeat. */
function singleHeader(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The Authorization prefix the client half presents: the claude.ai OAuth bearer, an opaque `sk-ant-oat` token. The protocol's other credential, the worker JWT a bridge registration mints, authorises worker calls only, so a header carrying it is never the injection credential (observed live: an inject replaying a heartbeat's JWT was answered 401). */
const OAUTH_AUTHORIZATION_PREFIX = "Bearer sk-ant-oat";

/** The OAuth-kind Authorization value a request carried, or undefined when the header is absent or presents the worker JWT instead. */
function oauthAuthorizationOf(headers: Readonly<IncomingHttpHeaders>): string | undefined {
  const value = singleHeader(headers, "authorization");
  return value?.startsWith(OAUTH_AUTHORIZATION_PREFIX) === true ? value : undefined;
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

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline (see `providersStore.ts` for its twin). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses JSON, yielding undefined for anything that is not one JSON object: a body the tracker cannot read is a body it knows nothing about, never a failure. */
function parseJsonObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A record's string field when it is a non-empty string, else undefined: the shape every id and name extraction narrows to. */
function nonEmptyString(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record === undefined ? undefined : record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A record's number field when it is a finite number, else undefined. */
function finiteNumber(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record === undefined ? undefined : record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One excerpt kept to the summary budget, marked when it was cut. */
function excerpt(text: string): string {
  return text.length <= RC_PENDING_SUMMARY_EXCERPT_CHARS ? text : `${text.slice(0, RC_PENDING_SUMMARY_EXCERPT_CHARS)}...`;
}

/**
 * The payload events of one event-batch body (the `events` array both the worker's and the client's event writes carry), as records; a body naming none yields an empty list, since an event write without events carries nothing to read.
 */
function payloadEventsOf(body: string): readonly Record<string, unknown>[] {
  const parsed = parseJsonObject(body);
  const events = parsed === undefined ? undefined : parsed.events;
  if (!Array.isArray(events)) {
    return [];
  }
  const payloads: Record<string, unknown>[] = [];
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    const payload = event.payload;
    if (!isRecord(payload)) {
      continue;
    }
    payloads.push(payload);
  }
  return payloads;
}

/**
 * One `control_request` payload as the tracker records it, or undefined when it names no id a `control_response` could echo. The id is the payload's `request_id`, the field the protocol's trust rule names; a top-level `uuid` is accepted as a fallback because the payload family also carries one, and a request with neither cannot be answered.
 */
function pendingOfControlRequestPayload(payload: Record<string, unknown>): { readonly requestId: string; readonly type: string; readonly summary: string } | undefined {
  if (payload.type !== "control_request") {
    return undefined;
  }
  const requestId = nonEmptyString(payload, "request_id") ?? nonEmptyString(payload, "uuid");
  if (requestId === undefined) {
    return undefined;
  }
  const request = isRecord(payload.request) ? payload.request : undefined;
  const subtype = nonEmptyString(request, "subtype");
  const type = subtype ?? "control_request";
  // `can_use_tool` is the approval the surface exists to answer, so its summary names the tool and sketches the input; every other subtype is recorded by type with a bounded sketch of whatever it carried.
  let summary = "";
  if (subtype === "can_use_tool") {
    const toolName = nonEmptyString(request, "tool_name") ?? "unknown tool";
    const input = request === undefined ? undefined : request.input;
    summary = input === undefined ? toolName : `${toolName} ${excerpt(JSON.stringify(input))}`;
  } else if (request !== undefined) {
    summary = excerpt(JSON.stringify(request));
  }
  return { requestId, type, summary };
}

/**
 * The request ids one `control_response` payload answers: the `request_id` inside the SDK response envelope, with the payload's own `request_id` and `uuid` as fallbacks for the same reason the request side takes them.
 */
function answeredRequestIdsOfControlResponsePayload(payload: Record<string, unknown>): readonly string[] {
  if (payload.type !== "control_response") {
    return [];
  }
  const response = isRecord(payload.response) ? payload.response : undefined;
  const id = nonEmptyString(response, "request_id") ?? nonEmptyString(payload, "request_id") ?? nonEmptyString(payload, "uuid");
  return id === undefined ? [] : [id];
}

/** What one parsed request body yielded, filed only once the exchange's own response is known to be a success. */
interface RcRequestBodyFacts {
  /** Control requests awaiting an answer, from a worker event batch. */
  readonly controlRequests: readonly Omit<RcPendingRequestRecord, "sessionId" | "observedAt">[];
  /** Request ids a client-half event write answered, which retire their pending entries. */
  readonly answeredRequestIds: readonly string[];
  /** The idle a heartbeat carried. */
  readonly idleSeconds: number | undefined;
  /** The state a worker registration named. */
  readonly workerStatus: string | undefined;
}

/** The kinds of request body the tracker reads, one per exchange shape; each names the fields its parser reads. */
type RcRequestBodyKind = "worker-events" | "client-events" | "heartbeat" | "worker-registration";

/** Reads one bounded request body of the given kind into the facts the tracker files. */
function parseRcRequestBody(kind: RcRequestBodyKind, body: string): RcRequestBodyFacts {
  if (kind === "heartbeat") {
    return { controlRequests: [], answeredRequestIds: [], idleSeconds: finiteNumber(parseJsonObject(body), "idle_seconds"), workerStatus: undefined };
  }
  if (kind === "worker-registration") {
    // The field the CLI's own worker state update sends is `worker_status` (its `UpdateSessionWorkerState` call, verified in the 2.1.88 source dump and the 2.1.289 bundle's strings), so that is the field the tracker reads.
    return { controlRequests: [], answeredRequestIds: [], idleSeconds: undefined, workerStatus: nonEmptyString(parseJsonObject(body), "worker_status") };
  }
  const controlRequests: Omit<RcPendingRequestRecord, "sessionId" | "observedAt">[] = [];
  const answeredRequestIds: string[] = [];
  for (const payload of payloadEventsOf(body)) {
    const pending = pendingOfControlRequestPayload(payload);
    if (pending !== undefined) {
      controlRequests.push({ requestId: pending.requestId, type: pending.type, summary: pending.summary });
      continue;
    }
    answeredRequestIds.push(...answeredRequestIdsOfControlResponsePayload(payload));
  }
  return { controlRequests, answeredRequestIds, idleSeconds: undefined, workerStatus: undefined };
}

/** Creates the tracker. One per door process; everything it holds dies with it. */
export function createRcSessionTracker(deps: RcSessionTrackerDeps): RcSessionTracker {
  const entries = new Map<string, RcSessionRecord>();
  const expire = (id: string): void => {
    entries.delete(id);
  };
  const expirePendings = (entry: RcSessionRecord, now: number): void => {
    for (const [requestId, pending] of entry.pending) {
      if (now - pending.observedAt >= RC_PENDING_DEADLINE_MS) {
        entry.pending.delete(requestId);
      }
    }
  };
  const sweep = (): void => {
    for (const [id, entry] of entries) {
      if (deps.now() - entry.lastSeenAt >= deps.idleMs) {
        expire(id);
        continue;
      }
      expirePendings(entry, deps.now());
    }
  };
  // The sweep only bounds memory between reads: every read accessor sweeps first, so what it returns is always exact however long the timer waits.
  const timer = setInterval(sweep, deps.idleMs);
  timer.unref();

  const birth = (id: string, facts: Readonly<{ oauthAuthorization: string | undefined; anthropicVersion: string | undefined; anthropicClientPlatform: string | undefined }>): RcSessionRecord => {
    const record: RcSessionRecord = { id, createdAt: deps.now(), lastSeenAt: deps.now(), ...facts, pending: new Map(), workerState: undefined, workerIdleSeconds: undefined, sequenceNum: undefined };
    entries.set(id, record);
    return record;
  };

  /** Persists the entry's client credential whenever it holds an OAuth bearer, so the credential survives this process; the worker-JWT-only moments of a session's life simply leave whatever was last persisted in place. */
  const persistCredential = (entry: RcSessionRecord): void => {
    if (entry.oauthAuthorization !== undefined) {
      deps.credentialStore?.write(entry.id, { authorization: entry.oauthAuthorization, anthropicVersion: entry.anthropicVersion, anthropicClientPlatform: entry.anthropicClientPlatform });
    }
  };

  const observeExchange = (request: RcObservedRequest): RcExchangeObserver | undefined => {
    const method = (request.method ?? "").toUpperCase();
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!path.startsWith(RC_SESSIONS_PATH_PREFIX)) {
      return undefined;
    }
    const tail = path.slice(RC_SESSIONS_PATH_PREFIX.length);
    const facts = {
      oauthAuthorization: oauthAuthorizationOf(request.headers),
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
          persistCredential(birth(id, facts));
        },
      };
    }
    const rest = tail.slice(1);
    const [id] = rest.split("/");
    if (id?.startsWith(RC_SESSION_ID_PREFIX) !== true) {
      return undefined;
    }
    // Every recurring session call refreshes the entry: the protocol headers and the OAuth-kind bearer are latest-wins because the freshest observed value is the live one. A worker call's JWT is not an OAuth credential, so it refreshes the entry's liveness without touching the injection credential (a worker JWT replayed on the client half is answered 401).
    const entry = entries.get(id) ?? birth(id, facts);
    entry.lastSeenAt = deps.now();
    entry.oauthAuthorization = facts.oauthAuthorization ?? entry.oauthAuthorization;
    entry.anthropicVersion = facts.anthropicVersion ?? entry.anthropicVersion;
    entry.anthropicClientPlatform = facts.anthropicClientPlatform ?? entry.anthropicClientPlatform;
    persistCredential(entry);

    // The one request-body shape each of these exchanges reads; every other recurring call's request body carries nothing the tracker retains.
    const bodyKind: RcRequestBodyKind | undefined =
      method === "POST" && rest === `${id}/worker/events`
        ? "worker-events"
        : method === "POST" && rest === `${id}/events`
          ? "client-events"
          : method === "POST" && rest === `${id}/worker/heartbeat`
            ? "heartbeat"
            : method === "PUT" && rest === `${id}/worker`
              ? "worker-registration"
              : undefined;

    // Request-body facts file only once the exchange's own response is known to be a success, whatever order the request end and the response head arrive in: a refused or aborted exchange delivered nothing, so it must record nothing.
    let chunks: Buffer[] = [];
    let buffered = 0;
    let oversized = false;
    let requestEnded = false;
    let accepted: boolean | undefined;
    let filed = false;
    const file = (): void => {
      if (filed || accepted !== true || !requestEnded || bodyKind === undefined) {
        return;
      }
      filed = true;
      const factsOfBody = oversized ? undefined : parseRcRequestBody(bodyKind, Buffer.concat(chunks).toString("utf8"));
      chunks = [];
      const entryNow = entries.get(id);
      if (entryNow === undefined || factsOfBody === undefined) {
        return;
      }
      const now = deps.now();
      for (const controlRequest of factsOfBody.controlRequests) {
        entryNow.pending.set(controlRequest.requestId, { sessionId: id, ...controlRequest, observedAt: now });
      }
      for (const requestId of factsOfBody.answeredRequestIds) {
        entryNow.pending.delete(requestId);
      }
      if (factsOfBody.idleSeconds !== undefined) {
        entryNow.workerIdleSeconds = { value: factsOfBody.idleSeconds, observedAt: now };
      }
      if (factsOfBody.workerStatus !== undefined) {
        entryNow.workerState = { value: factsOfBody.workerStatus, observedAt: now };
      }
    };

    const archiving = method === "POST" && rest === `${id}/archive`;
    return {
      ...(bodyKind === undefined
        ? {}
        : {
            onRequestChunk: (chunk: Uint8Array) => {
              if (oversized) {
                return;
              }
              chunks.push(Buffer.from(chunk));
              buffered += chunk.length;
              if (buffered > RC_REQUEST_PARSE_CAP_BYTES) {
                // Past the parse cap the body is skipped, not failed: the exchange flows on untouched and records nothing from it.
                oversized = true;
                chunks = [];
              }
            },
            onRequestEnd: () => {
              requestEnded = true;
              file();
            },
          }),
      onResponse: (status, headers) => {
        // A conflict header closes the session whatever the status says, and an accepted archive ends it by design; either way the entry describes something that is no longer live, and its persisted credential must not outlive it.
        if (singleHeader(headers, CONFLICT_REASON_HEADER) !== undefined || (archiving && isSuccessful(status))) {
          deps.credentialStore?.remove(id);
          expire(id);
          return;
        }
        accepted = isSuccessful(status);
        file();
      },
      onBodyChunk: () => {
        // A recurring call's response body carries nothing the tracker retains.
      },
      onEnd: () => {
        // Filing happened at the request; the end only matters for the create.
      },
    };
  };

  const summaryOf = ({ id, createdAt, lastSeenAt }: RcSessionRecord): RcSessionSummary => ({ id, createdAt, lastSeenAt });
  const pendingSummaryOf = ({ sessionId, requestId, type, summary, observedAt }: RcPendingRequestRecord): RcPendingRequestSummary => ({ sessionId, requestId, type, summary, observedAt });
  const sortedEntries = (): readonly RcSessionRecord[] => [...entries.values()].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1));
  const pendingSorted = (entry: RcSessionRecord): readonly RcPendingRequestSummary[] => [...entry.pending.values()].sort((left, right) => left.observedAt - right.observedAt || (left.requestId < right.requestId ? -1 : 1)).map(pendingSummaryOf);

  return {
    observeExchange,
    list: () => {
      sweep();
      return sortedEntries().map(summaryOf);
    },
    statusOf: (sessionId) => {
      sweep();
      return sortedEntries()
        .filter((entry) => sessionId === undefined || entry.id === sessionId)
        .map((entry) => ({ ...summaryOf(entry), workerState: entry.workerState, workerIdleSeconds: entry.workerIdleSeconds, pending: pendingSorted(entry) }));
    },
    pendingOf: (sessionId) => {
      sweep();
      return sortedEntries()
        .filter((entry) => sessionId === undefined || entry.id === sessionId)
        .flatMap((entry) => pendingSorted(entry));
    },
    credentialOf: (sessionId) => {
      const entry = entries.get(sessionId);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.oauthAuthorization === undefined && deps.credentialStore !== undefined) {
        // This generation never observed the session's client-half credential itself (it started after the create, and only worker calls have crossed since): the last generation's persisted copy is the freshest statement there is, and it is adopted once, as any later OAuth-bearing observation overwrites it the usual way.
        const persisted = deps.credentialStore.read(sessionId);
        if (persisted?.authorization !== undefined) {
          entry.oauthAuthorization = persisted.authorization;
          entry.anthropicVersion = entry.anthropicVersion ?? persisted.anthropicVersion;
          entry.anthropicClientPlatform = entry.anthropicClientPlatform ?? persisted.anthropicClientPlatform;
        }
      }
      return { authorization: entry.oauthAuthorization, anthropicVersion: entry.anthropicVersion, anthropicClientPlatform: entry.anthropicClientPlatform };
    },
    noteSequenceNums: (sessionId, sequenceNums) => {
      const entry = entries.get(sessionId);
      if (entry === undefined) {
        return;
      }
      for (const sequenceNum of sequenceNums) {
        entry.sequenceNum = entry.sequenceNum === undefined || sequenceNum > entry.sequenceNum ? sequenceNum : entry.sequenceNum;
      }
    },
    sequenceNumOf: (sessionId) => entries.get(sessionId)?.sequenceNum,
    fileStreamEvent: (sessionId, event) => {
      const entry = entries.get(sessionId);
      if (entry === undefined) {
        return;
      }
      entry.sequenceNum = entry.sequenceNum === undefined || event.sequence_num > entry.sequenceNum ? event.sequence_num : entry.sequenceNum;
      if (!isRecord(event.payload)) {
        return;
      }
      const pending = pendingOfControlRequestPayload(event.payload);
      if (pending !== undefined) {
        // Only the worker emits control requests (the ground truth of the client half: the stream's `control_request` envelopes name the worker as their source), so a request from anyone else is not birthed.
        if (event.source === RC_STREAM_WORKER_SOURCE) {
          entry.pending.set(pending.requestId, { sessionId, ...pending, observedAt: deps.now() });
        }
        return;
      }
      for (const requestId of answeredRequestIdsOfControlResponsePayload(event.payload)) {
        entry.pending.delete(requestId);
      }
    },
    completePending: (sessionId, requestId) => {
      entries.get(sessionId)?.pending.delete(requestId);
    },
    close: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Wraps one route so the tracker sees every exchange the route serves: the request's facts are handed over first, and when they are Remote Control facts the request's body chunks and the response the route writes are teed to the tracker's observer while flowing on unchanged. Used on the door's route resolution, so the bare `/v1/` pass-through an OAuth session's Remote Control calls ride is where observation happens.
 *
 * `onExchangeSettled`, when given, is called once the exchange's response has ended and the observer has filed whatever it filed: it is where the door re-pokes the client stream attachment, so a session becomes attached the moment its create's own response completes rather than at whatever exchange happens to follow.
 */
export function observingRoutedRoute(route: FrontDoorRoute, tracker: RcSessionTracker, hooks?: { readonly onExchangeSettled?: () => void }): FrontDoorRoute {
  return {
    ...route,
    serve: async (request, response) => {
      const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.headers });
      if (observed?.onRequestChunk !== undefined) {
        // Additive listeners, the same pattern the connect test world's recording uses: the pipe the route attaches keeps sole control of flow control, and the observer simply sees the same chunk deliveries the upstream does. Attaching these switches the body to flowing mode, which is safe here because the observer only asks for request bodies on the Remote Control subpaths, and those always ride the bare `/v1/` pass-through route, which pipes the body onward synchronously inside its serve.
        request.body.on("data", (chunk: Buffer) => {
          observed.onRequestChunk?.(chunk);
        });
        request.body.on("end", () => {
          observed.onRequestEnd?.();
        });
      }
      await route.serve(request, observed === undefined ? response : teeRoutedResponse(response, observed, hooks?.onExchangeSettled));
    },
  };
}

/**
 * The response half of `observingRoutedRoute`: every call forwards to the wrapped response untouched, with the tracker's observer driven alongside. A route that ends mid-body because its client went away calls neither `end` nor `destroy`, so `onEnd` never runs and an unfinished create is simply never filed; the observer is then unreachable, and nothing is retained.
 */
function teeRoutedResponse(response: RoutedResponse, observer: RcExchangeObserver, onSettled?: () => void): RoutedResponse {
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
      onSettled?.();
    },
    destroy: () => {
      response.destroy();
      observer.onEnd();
      onSettled?.();
    },
  };
}

/** Adapts the tracker's exchange observer to the passthrough forwarding's observer shape, so the connect test world (which forwards rather than routes) observes through the same tracker. */
export function rcObserverAsPassthrough(observer: RcExchangeObserver): PassthroughObserver {
  return {
    onRequestChunk: (chunk) => {
      observer.onRequestChunk?.(chunk);
    },
    ...(observer.onRequestEnd === undefined
      ? {}
      : {
          onRequestEnd: () => {
            observer.onRequestEnd?.();
          },
        }),
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
