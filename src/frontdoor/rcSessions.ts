import type { IncomingHttpHeaders } from "node:http";

import { applyAgentTaskEvent, type LiveTask, type LiveTaskBook } from "../agents/liveTasks";
import { HTTP_STATUS } from "../codex/http";
import type { PassthroughObserver } from "./capture";
import type { RcCredentialStore } from "./rcCredentialStore";
import type { RcPendingRetireReason, RcSessionEndReason, RcSessionTransition } from "./rcEventLog";
import { rcQuestionsOfToolRequest, type RcPendingQuestion } from "./rcQuestions";
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

/** The pathname of a request URL, whatever query follows it. */
function pathnameOf(url: string | undefined): string {
  return new URL(url ?? "/", "http://127.0.0.1").pathname;
}

/**
 * Whether the tracker looks at an exchange for this URL: the session create and list (the bare prefix) and every call under a session. The one test both the tracker's own observation and the door's routing share, so a request is never observed by one and kept from the other's view.
 */
export function isRcSessionExchange(url: string | undefined): boolean {
  const path = pathnameOf(url);
  return path === RC_SESSIONS_PATH_PREFIX || path.startsWith(`${RC_SESSIONS_PATH_PREFIX}/`);
}

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

/** The range of UTF-16 code units that open a surrogate pair, from the Unicode standard. */
const HIGH_SURROGATE_FIRST = 0xd8_00;
const HIGH_SURROGATE_LAST = 0xdb_ff;

/** The worker state a registration names once the turn has ended with nothing waiting: the only state that speaks for every request the worker had asked before it (`running` does not, since a worker with several parallel requests reports `running` between answering one and the next). */
const RC_WORKER_IDLE = "idle";

/**
 * How many control requests one session may hold pending. The worker asks one approval or question at a time per agent, so the live count is bounded by the session's parallel subagents; 64 is far above any parallelism the CLI runs, so reaching it means a stream is replaying requests the door never saw retired, and further ones are counted as dropped rather than grown without bound.
 */
export const RC_PENDING_PER_SESSION_MAX = 64;

/**
 * The longest request id the tracker keys a pending entry by. The protocol mints UUIDs (36 characters); an id past 128 is not one the CLI produced, so the request is counted as dropped rather than stored, since cutting the id would make the echoed answer name a different request.
 */
export const RC_REQUEST_ID_MAX_CHARS = 128;

/**
 * How many retired request ids one session remembers. A retired id is kept so a late duplicate of its `control_request` (a stream replay after the door's own answer) is not re-listed; the window is the pending cap twice over, enough to cover every request that could have been waiting at once plus the same again in flight, and the oldest tombstone is forgotten first.
 */
export const RC_RETIRED_TOMBSTONES_MAX = 2 * RC_PENDING_PER_SESSION_MAX;

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
  /** The session's control requests awaiting an answer, keyed by the id a `control_response` must echo. An entry lives exactly as long as the worker waits on it: until a `control_response` answers it, the worker withdraws it with a `control_cancel_request`, an accepted registration names `idle` or a new worker epoch, or the session itself expires. The worker sets no deadline of its own, so time alone never retires an entry. */
  readonly pending: Map<string, RcPendingRequestRecord>;
  /** The ids of the control requests that stopped awaiting an answer (and of requests the door counted as dropped), in the order they were remembered, oldest first, bounded by `RC_RETIRED_TOMBSTONES_MAX`. The same request crosses the door on the worker's event write and again on the client read stream, and a stream replay can repeat it later still; remembering the id is what stops a later copy from birthing a request already answered, since no deadline bounds when that copy can arrive. */
  readonly retired: Set<string>;
  /** The worker state the latest worker registration named, with when that exchange was observed. */
  workerState: RcWorkerFact<string> | undefined;
  /** The idle the latest heartbeat carried, with when that exchange was observed. */
  workerIdleSeconds: RcWorkerFact<number> | undefined;
  /** The identity id the session's most recent request was attributed to: the launcher-injected identity header when the request carried one, else the identity the admitting launch recorded. A Remote Control worker or bridge call carries none of the launcher's custom headers (observed against the self-hosted surface with CLI versions 2.1.289 and 2.1.319), so for those the launch's recorded identity, found through the capability the tunnel supplies, is the source. */
  identity: string | undefined;
  /** The model the session last stated: the worker registration's metadata or the session's init event, whichever came later. */
  model: string | undefined;
  /** The working directory the session's init event stated. */
  cwd: string | undefined;
  /** The highest sequence number the door has seen for this session, from the client read stream's envelopes or from its own confirmed writes: the value a stream resume continues after. */
  sequenceNum: number | undefined;
  /** The background tasks and subagents the session's events described, by `task_id`. Memory only, like everything here; the transcripts on disk are the authoritative record. */
  liveTasks: LiveTaskBook;
  /** The worker epoch the latest accepted registration named; a registration naming another epoch is a new worker, which waits on nothing the old one asked. */
  workerEpoch: number | undefined;
  /** How many control requests were not stored because the session already held `RC_PENDING_PER_SESSION_MAX` or their id was past `RC_REQUEST_ID_MAX_CHARS`. */
  droppedPending: number;
  /** Request ids an answer is being written for right now, claimed by `claimPending` and released when the write settles. */
  readonly answering: Set<string>;
}

/** One pending control request as the tracker holds it. */
interface RcPendingRequestRecord {
  readonly sessionId: string;
  readonly requestId: string;
  /** The request's subtype (`can_use_tool` and kin), or the payload discriminator when the subtype is absent. */
  readonly type: string;
  /** A short human-readable sketch: the tool name and a bounded excerpt of its input for `can_use_tool`. */
  readonly summary: string;
  /** Whether the request's payload was past `RC_REQUEST_PARSE_CAP_BYTES`, so only its summary is held: a question this large is listed without its questions and cannot be answered here. */
  readonly oversized: boolean;
  /** Why a question request cannot be answered through the door (malformed, past a bound, a repeated question or label, or past the parse cap), so the answer path refuses it rather than approving it without answers; absent for an answerable question and for every other request. */
  readonly unanswerable: string | undefined;
  /** The questions a `can_use_tool` request for the question dialog puts to the user, parsed from its input; absent for every other request. */
  readonly questions: readonly RcPendingQuestion[] | undefined;
  /** The `can_use_tool` request's input exactly as the worker sent it, which an answer to a question carries back with its answers added; absent for every other request. Memory only, never listed. */
  readonly toolInput: Record<string, unknown> | undefined;
  readonly observedAt: number;
  /** Where the request was filed in the tracker's own observation order, which a worker registration is compared against: two observations in one clock millisecond still have distinct, ordered sequence numbers. Never listed. */
  readonly observedSequence: number;
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
  /** The questions the agent put to the user, in the order it asked them, when the request is the question dialog (a `can_use_tool` request for `AskUserQuestion`); absent for every other request. An answer chooses among exactly these options. */
  readonly questions?: readonly RcPendingQuestion[];
  /** Present and true when the request's payload was past the door's parse cap: only its summary is held, so a question listed this way shows no questions and cannot be answered through the door. */
  readonly oversized?: true;
  /** Present when the request is the question dialog but the door cannot answer it (why, in words): answer it in the session instead. */
  readonly unanswerable?: string;
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
  /** The identity (login) the session runs as, when the door saw it on the session's own requests or the session's own registry named it. Absent when neither knows. */
  readonly identity?: string;
  /** The model the session last stated, when the door saw one. */
  readonly model?: string;
  /** The session's name as the Claude Code session registry holds it (see `rcSessionRegistry.ts`); the tracker never sets it. */
  readonly name?: string;
  /** The session process's id from the registry; the tracker never sets it. */
  readonly pid?: number;
  /** The session's working directory, from its init event or else the registry. */
  readonly cwd?: string;
  /** How many control requests the door did not list because the session already held `RC_PENDING_PER_SESSION_MAX` or their id was not one the protocol mints; present only when some were. */
  readonly pendingDropped?: number;
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
  /** The identity the launcher injected on this request, when the door's identity step read one; the headers above no longer carry it. */
  readonly identity?: string;
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
  /** Where each transition a supervisor acts on is handed as the tracker files the fact behind it (a session appearing or ending, its worker state changing, a pending request born or retired): the door's session event log (`rcEventLog.ts`). Absent, the tracker records the same facts and tells no one. */
  readonly onTransition?: (transition: RcSessionTransition) => void;
  /** Told when the tracker closes, so whatever its transitions feed stops waiting for more: the door's session event log ends its followers here. */
  readonly onClose?: () => void;
}

/** The live record of observed Remote Control sessions. */
export interface RcSessionTracker {
  /** Feeds one request/response exchange in: returns the observer its request and response drive when the request belongs to the Remote Control surface, or undefined when it does not, in which case nothing is retained and neither side needs observing. */
  readonly observeExchange: (request: RcObservedRequest) => RcExchangeObserver | undefined;
  /** Every live entry, idle ones expired first, sorted oldest-created first. */
  readonly list: () => readonly RcSessionSummary[];
  /** Every live entry as the status surface reports it, with the same sweeping and order as `list`, filtered to one session when named. */
  readonly statusOf: (sessionId?: string) => readonly RcSessionStatus[];
  /** Every control request awaiting an answer, idle sessions expired first, oldest-observed first, filtered to one session when named. */
  readonly pendingOf: (sessionId?: string) => readonly RcPendingRequestSummary[];
  /** The observed credential and protocol headers for one session, the client-half writes' accessor: present only while the session is tracked, and never surfaced anywhere a summary, log or capture goes. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Advances the session's sequence cursor to the highest number named, which every confirmed client-half write calls with the numbers the real service assigned its events. */
  readonly noteSequenceNums: (sessionId: string, sequenceNums: readonly number[]) => void;
  /** The session's sequence cursor: the highest number the door has seen, from the client read stream's envelopes or from its own confirmed writes; undefined while neither has been seen. */
  readonly sequenceNumOf: (sessionId: string) => number | undefined;
  /**
   * Files one client read stream envelope: advances the session's sequence cursor, and treats the payload exactly as an observed event-batch body's would be treated, which is how an approval reaches the pending list from the stream (the live finding behind the client attachment: the CLI routes `control_request`s only toward attached clients, so the stream, not the worker's own writes, is where a `can_use_tool` the door must answer becomes visible). A `control_request` whose envelope names the worker as its source births a pending entry; a `control_response` retires the request it answers, whoever answered it; and a `control_cancel_request` from the worker retires the request it withdraws.
   */
  readonly fileStreamEvent: (sessionId: string, event: RcStreamEnvelope) => void;
  /** The live background tasks and subagents the observed events described, for one session or every tracked one, each carrying the session that reported it and when it was last observed. */
  readonly liveTasksOf: (sessionId?: string) => readonly LiveTask[];
  /** Retires one pending control request as answered: what a successful answer write calls, so the request stops being listed the moment it is answered. */
  readonly completePending: (sessionId: string, requestId: string) => void;
  /** Claims one pending request for an answer in flight, so two answers written at once cannot both reach the worker: returns the release to call once the write has settled, or undefined when the request is not pending or another answer already holds it. */
  readonly claimPending: (sessionId: string, requestId: string) => (() => void) | undefined;
  /** The input a pending question request carried, exactly as the worker sent it: the answer path's accessor, since an answer to a question carries that input back with its answers added. Undefined when the request is not pending or is not a question. Never surfaced in a listing. */
  readonly pendingToolInputOf: (sessionId: string, requestId: string) => Record<string, unknown> | undefined;
  /** Stops the idle sweep timer and tells the transition sink's owner (`onClose`) that no more transitions follow. The entries themselves are unreachable the moment the door drops them. */
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

/** One excerpt kept to the summary budget, cut on a code point boundary and marked when it was cut; the stream event sketch uses the same budget. */
export function rcExcerpt(text: string): string {
  if (text.length <= RC_PENDING_SUMMARY_EXCERPT_CHARS) {
    return text;
  }
  // Cut on a code point boundary: a cut between the halves of a surrogate pair would leave a lone surrogate, which is not valid UTF-8 once serialised.
  const cut = text.slice(0, RC_PENDING_SUMMARY_EXCERPT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return `${isHighSurrogate(last) ? cut.slice(0, -1) : cut}...`;
}

/** Whether one UTF-16 code unit is the first half of a surrogate pair. */
function isHighSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST;
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
function pendingOfControlRequestPayload(payload: Record<string, unknown>): Omit<RcPendingRequestRecord, "sessionId" | "observedAt" | "observedSequence"> | undefined {
  const parsed = fullPendingOfControlRequestPayload(payload);
  // A request body is already bounded by the parse cap, but a stream envelope is not: a question whose serialised payload is past the cap in UTF-8 bytes keeps its summary (itself an excerpt) and drops the input an answer would carry back. Only a question holds its input, so any other request is held as it is: its summary is already an excerpt, and approving or denying it carries none of its input.
  const isQuestion = parsed !== undefined && (parsed.questions !== undefined || parsed.unanswerable !== undefined);
  if (parsed === undefined || !isQuestion || Buffer.byteLength(JSON.stringify(payload), "utf8") <= RC_REQUEST_PARSE_CAP_BYTES) {
    return parsed;
  }
  return { ...parsed, questions: undefined, toolInput: undefined, oversized: true, unanswerable: parsed.unanswerable ?? (parsed.questions === undefined ? undefined : `the request is past the door's parse cap of ${String(RC_REQUEST_PARSE_CAP_BYTES)} bytes`) };
}

/** The pending record of one `control_request` payload, every field held whole. */
function fullPendingOfControlRequestPayload(payload: Record<string, unknown>): Omit<RcPendingRequestRecord, "sessionId" | "observedAt" | "observedSequence"> | undefined {
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
  let questions: readonly RcPendingQuestion[] | undefined;
  let unanswerable: string | undefined;
  let toolInput: Record<string, unknown> | undefined;
  if (subtype === "can_use_tool") {
    const toolName = nonEmptyString(request, "tool_name");
    const input = request === undefined ? undefined : request.input;
    summary = input === undefined ? (toolName ?? "unknown tool") : `${toolName ?? "unknown tool"} ${rcExcerpt(JSON.stringify(input))}`;
    // The question dialog rides this same subtype, its tool name telling it apart from an approval; its input is kept whole because the answer carries it back.
    const parsedQuestions = rcQuestionsOfToolRequest(toolName, input);
    if (parsedQuestions !== undefined && "questions" in parsedQuestions) {
      questions = parsedQuestions.questions;
      toolInput = isRecord(input) ? input : undefined;
    } else if (parsedQuestions !== undefined) {
      unanswerable = parsedQuestions.unanswerable;
    }
  } else if (request !== undefined) {
    summary = rcExcerpt(JSON.stringify(request));
  }
  return { requestId, type, summary, questions, unanswerable, toolInput, oversized: false };
}

/** The request id one worker `control_cancel_request` payload withdraws: the worker's own retraction of a request it resolved itself (answered or dismissed in its terminal), sent right after its own `control_response`. Only `request_id` names it: the payload's `uuid` is the cancel event's own id (observed on 2.1.319), not the request's, so the fallback the response parser keeps would name nothing pending here. */
function withdrawnRequestIdsOfControlCancelPayload(payload: Record<string, unknown>): readonly string[] {
  if (payload.type !== "control_cancel_request") {
    return [];
  }
  const id = nonEmptyString(payload, "request_id");
  return id === undefined ? [] : [id];
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

/** The facts a `system` `init` payload states about its session: the model it runs and the directory it was started in. Every other payload yields nothing. */
function initFactsOfPayload(payload: Record<string, unknown>): { readonly model: string | undefined; readonly cwd: string | undefined } | undefined {
  if (payload.type !== "system" || payload.subtype !== "init") {
    return undefined;
  }
  return { model: nonEmptyString(payload, "model"), cwd: nonEmptyString(payload, "cwd") };
}

/** What one parsed request body yielded, filed only once the exchange's own response is known to be a success. */
interface RcRequestBodyFacts {
  /** Control requests awaiting an answer, from a worker event batch. */
  readonly controlRequests: readonly Omit<RcPendingRequestRecord, "sessionId" | "observedAt" | "observedSequence">[];
  /** Request ids an event write answered, which retire their pending entries. */
  readonly answeredRequestIds: readonly string[];
  /** Request ids a worker event write withdrew with a `control_cancel_request`, which retire their pending entries as withdrawn. */
  readonly withdrawnRequestIds: readonly string[];
  /** The idle a heartbeat carried. */
  readonly idleSeconds: number | undefined;
  /** The state a worker registration named. */
  readonly workerStatus: string | undefined;
  /** The model a worker registration's metadata named. */
  readonly model?: string;
  /** The worker epoch a worker registration named. */
  readonly workerEpoch: number | undefined;
  /** The payloads of the batch, which the live task book reads the system events out of. */
  readonly payloads: readonly Record<string, unknown>[];
}

/** The kinds of request body the tracker reads, one per exchange shape; each names the fields its parser reads. */
type RcRequestBodyKind = "worker-events" | "client-events" | "heartbeat" | "worker-registration";

/** Reads one bounded request body of the given kind into the facts the tracker files. */
function parseRcRequestBody(kind: RcRequestBodyKind, body: string): RcRequestBodyFacts {
  if (kind === "heartbeat") {
    return { controlRequests: [], answeredRequestIds: [], withdrawnRequestIds: [], idleSeconds: finiteNumber(parseJsonObject(body), "idle_seconds"), workerStatus: undefined, workerEpoch: undefined, payloads: [] };
  }
  if (kind === "worker-registration") {
    // The field the CLI's own worker state update sends is `worker_status` (its `UpdateSessionWorkerState` call, verified in the 2.1.88 source dump and the 2.1.289 bundle's strings), so that is the field the tracker reads.
    const registration = parseJsonObject(body);
    const metadata = registration === undefined || !isRecord(registration.external_metadata) ? undefined : registration.external_metadata;
    const model = nonEmptyString(metadata, "model");
    return { controlRequests: [], answeredRequestIds: [], withdrawnRequestIds: [], idleSeconds: undefined, workerStatus: nonEmptyString(registration, "worker_status"), workerEpoch: finiteNumber(registration, "worker_epoch"), payloads: [], ...(model === undefined ? {} : { model }) };
  }
  const controlRequests: Omit<RcPendingRequestRecord, "sessionId" | "observedAt" | "observedSequence">[] = [];
  const answeredRequestIds: string[] = [];
  const withdrawnRequestIds: string[] = [];
  const payloads = payloadEventsOf(body);
  for (const payload of payloads) {
    const pending = pendingOfControlRequestPayload(payload);
    if (pending !== undefined) {
      controlRequests.push(pending);
      continue;
    }
    answeredRequestIds.push(...answeredRequestIdsOfControlResponsePayload(payload));
    if (kind === "worker-events") {
      withdrawnRequestIds.push(...withdrawnRequestIdsOfControlCancelPayload(payload));
    }
  }
  return { controlRequests, answeredRequestIds, withdrawnRequestIds, idleSeconds: undefined, workerStatus: undefined, workerEpoch: undefined, payloads };
}

/** Creates the tracker. One per door process; everything it holds dies with it. */
export function createRcSessionTracker(deps: RcSessionTrackerDeps): RcSessionTracker {
  const entries = new Map<string, RcSessionRecord>();
  /** The count of pending requests filed so far, across every session: the order a worker registration is compared against. */
  let observationSequence = 0;
  /** Remembers one request id as no longer to be listed, forgetting the oldest remembered id once the window is full, so the record stays bounded however long the session lives. */
  const rememberRetired = (entry: RcSessionRecord, requestId: string): void => {
    // A Set keeps insertion order, so the first id is the oldest remembered; re-remembering an id moves it to the newest end.
    entry.retired.delete(requestId);
    entry.retired.add(requestId);
    if (entry.retired.size > RC_RETIRED_TOMBSTONES_MAX) {
      const [oldest] = entry.retired;
      if (oldest !== undefined) {
        entry.retired.delete(oldest);
      }
    }
  };
  /** Retires one pending request, telling the sink only when it was still pending, so a request answered twice (on the stream and on the worker's own write) retires once. */
  const retirePending = (entry: RcSessionRecord, requestId: string, reason: RcPendingRetireReason): void => {
    if (entry.pending.delete(requestId)) {
      rememberRetired(entry, requestId);
      deps.onTransition?.({ kind: "pending-retired", session: entry.id, requestId, reason, at: deps.now() });
    }
  };
  /**
   * Files one observed control request, telling the sink only of a request not already pending, since the same request is observed both on the worker's event write and on the client read stream. A request that already retired is not filed again (its later copy is the same request, not a new one), and a request already pending keeps the instant it was first observed, so the oldest-first order is the order the worker asked in. A request is counted as dropped instead of stored when its id is not one the protocol mints or the session already holds the pending cap.
   */
  const addPending = (entry: RcSessionRecord, request: Omit<RcPendingRequestRecord, "sessionId" | "observedAt" | "observedSequence">, now: number): void => {
    if (entry.retired.has(request.requestId)) {
      return;
    }
    const already = entry.pending.get(request.requestId);
    if (already !== undefined) {
      entry.pending.set(request.requestId, { ...already, ...request, observedAt: already.observedAt });
      return;
    }
    if (request.requestId.length > RC_REQUEST_ID_MAX_CHARS || entry.pending.size >= RC_PENDING_PER_SESSION_MAX) {
      // Counted once: the id is remembered as retired, so a replay of the same request does not count it again. An id past the length cap is not remembered, since holding it is what the cap refuses.
      if (!entry.retired.has(request.requestId)) {
        entry.droppedPending += 1;
        if (request.requestId.length <= RC_REQUEST_ID_MAX_CHARS) {
          rememberRetired(entry, request.requestId);
        }
      }
      return;
    }
    observationSequence += 1;
    entry.pending.set(request.requestId, { sessionId: entry.id, ...request, observedAt: now, observedSequence: observationSequence });
    deps.onTransition?.({ kind: "pending-born", session: entry.id, requestId: request.requestId, type: request.type, summary: request.summary, at: now });
  };
  const expire = (id: string, reason: RcSessionEndReason): void => {
    const entry = entries.get(id);
    if (entry === undefined) {
      return;
    }
    // The session's outstanding requests retire before the session ends, so a follower holding a pending set never keeps one for a session it has been told is gone.
    for (const requestId of [...entry.pending.keys()]) {
      retirePending(entry, requestId, "session-ended");
    }
    entries.delete(id);
    deps.onTransition?.({ kind: "session-ended", session: id, reason, at: deps.now() });
  };
  const sweep = (): void => {
    for (const [id, entry] of entries) {
      if (deps.now() - entry.lastSeenAt >= deps.idleMs) {
        expire(id, "expired");
      }
    }
  };
  // Every read accessor sweeps first, so what it returns is always exact however long the timer waits; the timer is what bounds memory between reads and what tells the transition sink of a session expiry nobody read.
  const timer = setInterval(sweep, deps.idleMs);
  timer.unref();

  /** Begins describing one session. Only for an id the tracker does not hold: an entry is never replaced, so a session appears once and every appearance is matched by one ending. */
  const birth = (id: string, facts: Readonly<{ oauthAuthorization: string | undefined; anthropicVersion: string | undefined; anthropicClientPlatform: string | undefined; identity: string | undefined }>): RcSessionRecord => {
    const record: RcSessionRecord = { id, createdAt: deps.now(), lastSeenAt: deps.now(), ...facts, pending: new Map(), retired: new Set(), workerState: undefined, workerIdleSeconds: undefined, model: undefined, cwd: undefined, sequenceNum: undefined, liveTasks: new Map(), workerEpoch: undefined, droppedPending: 0, answering: new Set() };
    entries.set(id, record);
    deps.onTransition?.({ kind: "session-appeared", session: id, at: record.createdAt });
    return record;
  };

  /** Persists the entry's client credential whenever it holds an OAuth bearer, so the credential survives this process; the worker-JWT-only moments of a session's life simply leave whatever was last persisted in place. */
  const persistCredential = (entry: RcSessionRecord): void => {
    if (entry.oauthAuthorization !== undefined) {
      deps.credentialStore?.write(entry.id, { authorization: entry.oauthAuthorization, anthropicVersion: entry.anthropicVersion, anthropicClientPlatform: entry.anthropicClientPlatform });
    }
  };

  /** Refreshes a tracked entry from one observed call: the protocol headers and the OAuth-kind bearer are latest-wins because the freshest observed value is the live one. A worker call's JWT is not an OAuth credential, so it refreshes the entry's liveness without touching the injection credential (a worker JWT replayed on the client half is answered 401). */
  const refresh = (entry: RcSessionRecord, facts: Readonly<{ oauthAuthorization: string | undefined; anthropicVersion: string | undefined; anthropicClientPlatform: string | undefined; identity: string | undefined }>): void => {
    entry.lastSeenAt = deps.now();
    entry.oauthAuthorization = facts.oauthAuthorization ?? entry.oauthAuthorization;
    entry.anthropicVersion = facts.anthropicVersion ?? entry.anthropicVersion;
    entry.anthropicClientPlatform = facts.anthropicClientPlatform ?? entry.anthropicClientPlatform;
    entry.identity = facts.identity ?? entry.identity;
    persistCredential(entry);
  };

  /** Files the model and directory a session's init payload states; a field the payload omits leaves the earlier one in place. */
  const noteInit = (entry: RcSessionRecord, payload: Record<string, unknown>): void => {
    const init = initFactsOfPayload(payload);
    if (init !== undefined) {
      entry.model = init.model ?? entry.model;
      entry.cwd = init.cwd ?? entry.cwd;
    }
  };

  const observeExchange = (request: RcObservedRequest): RcExchangeObserver | undefined => {
    const method = (request.method ?? "").toUpperCase();
    if (!isRcSessionExchange(request.url)) {
      return undefined;
    }
    const tail = pathnameOf(request.url).slice(RC_SESSIONS_PATH_PREFIX.length);
    // How far the tracker's observations had reached when this exchange began, which is when the worker sent it: a registration that retires speaks for the requests the worker had asked by then, never for one observed after. A sequence rather than the clock, so a request filed in the same millisecond the registration began is still told apart.
    const startedAtSequence = observationSequence;
    const facts = {
      oauthAuthorization: oauthAuthorizationOf(request.headers),
      anthropicVersion: singleHeader(request.headers, "anthropic-version"),
      anthropicClientPlatform: singleHeader(request.headers, "anthropic-client-platform"),
      identity: request.identity,
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
          // A create answered for a session already tracked (its recurring calls crossed while the create's answer was still arriving) refreshes the entry, never replaces it, so its pending requests, worker state and appearance stand.
          const existing = entries.get(id);
          if (existing === undefined) {
            persistCredential(birth(id, facts));
            return;
          }
          refresh(existing, facts);
        },
      };
    }
    const rest = tail.slice(1);
    const [id] = rest.split("/");
    if (id?.startsWith(RC_SESSION_ID_PREFIX) !== true) {
      return undefined;
    }
    // A client event write is a write into the session, by the door itself or another client, not a call of the session's own: the platform it names is the writer's, so it never becomes the platform every later client-half write replays (the self-hosted goal and compaction verbs write as a person's app, and their write comes back through this observer). The session's facts from such a call keep everything else.
    const isClientWrite = method === "POST" && (rest === `${id}/events` || rest === `${id}/teleport-events`);
    const sessionFacts = isClientWrite ? { ...facts, anthropicClientPlatform: undefined } : facts;
    // Every recurring call for a tracked session refreshes its entry at the request. A session the tracker does not hold yet is born only once the service accepts one of its calls (in `onResponse` below): a refused call (a mistyped or forged id answered 401 or 404, a worker still calling after its session was archived) says nothing is live there, and birthing on it would describe a session that does not exist.
    const tracked = entries.get(id);
    if (tracked !== undefined) {
      refresh(tracked, sessionFacts);
    }

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
        addPending(entryNow, controlRequest, now);
      }
      for (const requestId of factsOfBody.answeredRequestIds) {
        retirePending(entryNow, requestId, "answered");
      }
      for (const requestId of factsOfBody.withdrawnRequestIds) {
        retirePending(entryNow, requestId, "withdrawn");
      }
      for (const payload of factsOfBody.payloads) {
        entryNow.liveTasks = applyAgentTaskEvent(entryNow.liveTasks, id, payload, now);
        noteInit(entryNow, payload);
      }
      entryNow.model = factsOfBody.model ?? entryNow.model;
      if (factsOfBody.idleSeconds !== undefined) {
        entryNow.workerIdleSeconds = { value: factsOfBody.idleSeconds, observedAt: now };
      }
      if (factsOfBody.workerStatus !== undefined) {
        const previous = entryNow.workerState?.value;
        entryNow.workerState = { value: factsOfBody.workerStatus, observedAt: now };
        // A re-registration naming the state the worker already had is not a transition.
        if (previous !== factsOfBody.workerStatus) {
          deps.onTransition?.({ kind: "worker-state", session: id, state: factsOfBody.workerStatus, ...(previous === undefined ? {} : { previous }), at: now });
        }
      }
      // A new worker epoch is a new worker, which waits on nothing its predecessor asked; an `idle` registration is a worker whose turn ended with nothing waiting. Either speaks only for requests observed before the registration was sent, so one asked while it was in flight survives. No other state retires anything: `running` is reported between parallel requests, and `requires_action_details` cannot name the request it waits on for a question or a plan, whose `request_id` there is blank.
      const epochChanged = factsOfBody.workerEpoch !== undefined && entryNow.workerEpoch !== undefined && factsOfBody.workerEpoch !== entryNow.workerEpoch;
      if (factsOfBody.workerEpoch !== undefined) {
        entryNow.workerEpoch = factsOfBody.workerEpoch;
      }
      if (epochChanged || factsOfBody.workerStatus === RC_WORKER_IDLE) {
        for (const [requestId, pending] of entryNow.pending) {
          if (pending.observedSequence <= startedAtSequence) {
            retirePending(entryNow, requestId, "worker-stopped");
          }
        }
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
          expire(id, singleHeader(headers, CONFLICT_REASON_HEADER) === undefined ? "archived" : "conflict");
          return;
        }
        accepted = isSuccessful(status);
        if (accepted && !entries.has(id)) {
          persistCredential(birth(id, sessionFacts));
        }
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
  const pendingSummaryOf = ({ sessionId, requestId, type, summary, questions, unanswerable, oversized, observedAt }: RcPendingRequestRecord): RcPendingRequestSummary => ({ sessionId, requestId, type, summary, ...(questions === undefined ? {} : { questions }), ...(oversized ? { oversized: true } : {}), ...(unanswerable === undefined ? {} : { unanswerable }), observedAt });
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
        .map((entry) => ({
          ...summaryOf(entry),
          workerState: entry.workerState,
          workerIdleSeconds: entry.workerIdleSeconds,
          pending: pendingSorted(entry),
          ...(entry.identity === undefined ? {} : { identity: entry.identity }),
          ...(entry.model === undefined ? {} : { model: entry.model }),
          ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
          ...(entry.droppedPending === 0 ? {} : { pendingDropped: entry.droppedPending }),
        }));
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
      entry.liveTasks = applyAgentTaskEvent(entry.liveTasks, sessionId, event.payload, deps.now());
      noteInit(entry, event.payload);
      const pending = pendingOfControlRequestPayload(event.payload);
      if (pending !== undefined) {
        // Only the worker emits control requests (the ground truth of the client half: the stream's `control_request` envelopes name the worker as their source), so a request from anyone else is not birthed.
        if (event.source === RC_STREAM_WORKER_SOURCE) {
          addPending(entry, pending, deps.now());
        }
        return;
      }
      for (const requestId of answeredRequestIdsOfControlResponsePayload(event.payload)) {
        retirePending(entry, requestId, "answered");
      }
      // The worker's withdrawal of a request it resolved itself; a client cannot withdraw the worker's request, so only the worker's own counts.
      if (event.source === RC_STREAM_WORKER_SOURCE) {
        for (const requestId of withdrawnRequestIdsOfControlCancelPayload(event.payload)) {
          retirePending(entry, requestId, "withdrawn");
        }
      }
    },
    liveTasksOf: (sessionId) => {
      sweep();
      return sortedEntries()
        .filter((entry) => sessionId === undefined || entry.id === sessionId)
        .flatMap((entry) => [...entry.liveTasks.values()].sort((left, right) => left.observedAt - right.observedAt || (left.taskId < right.taskId ? -1 : 1)));
    },
    completePending: (sessionId, requestId) => {
      const entry = entries.get(sessionId);
      if (entry !== undefined) {
        retirePending(entry, requestId, "answered");
      }
    },
    claimPending: (sessionId, requestId) => {
      const entry = entries.get(sessionId);
      if (entry === undefined || !entry.pending.has(requestId) || entry.answering.has(requestId)) {
        return undefined;
      }
      entry.answering.add(requestId);
      return () => {
        entry.answering.delete(requestId);
      };
    },
    pendingToolInputOf: (sessionId, requestId) => entries.get(sessionId)?.pending.get(requestId)?.toolInput,
    close: () => {
      clearInterval(timer);
      deps.onClose?.();
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
      const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.headers, ...(request.session.identity === undefined ? {} : { identity: request.session.identity }) });
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
