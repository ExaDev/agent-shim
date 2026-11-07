import { z } from "zod";

import { DOOR_EVENT_BUFFER_EVENTS } from "./eventHub";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import { RC_PENDING_SUMMARY_EXCERPT_CHARS } from "./rcSessions";

/**
 * The door-level supervision log of the Remote Control sessions it observes: one ordered, bounded, in-memory record of the moments a supervisor of many sessions acts on (a session appearing or ending, its worker state changing, a control request awaiting an answer being born or retired), each tagged with its session and stamped with a monotonic cursor, so one subscription follows every session at once and a reconnecting subscriber resumes exactly after the last event it saw.
 *
 * The log is fed, never polled: the session tracker (`rcSessions.ts`) hands each transition to the injected sink as it files the fact that caused it, so the log's order is the tracker's own order of observation. A cursor names one door generation and one position in it; a cursor this log can no longer honour (its events were evicted past the retention bound, or it was issued by another generation of the door) is answered with an explicit expiry naming the current head, never by silently skipping what it would have missed, because a supervisor that missed a retirement would otherwise act on a request that is already gone. The recovery is the status read (`rc.status`), which states every session's present state, followed by a resume from the head the expiry named.
 *
 * Everything here is in memory only and dies with the door process, exactly like the tracker it is fed from: nothing is written to a log, to the capture, or to disk, and no event carries a credential.
 */

/**
 * The longest id or label one event field holds, in UTF-16 code units: the session id, the request id, a request's type and a worker state. A session id already names a file in the credential store, so the filesystem's component limit is the ceiling it can reach in practice, and the other protocol tokens are ids and enum-like labels of the same order. A longer value is no protocol token, so it is stored cut to this length with the cut marker rather than retained whole.
 */
export const RC_SESSION_EVENT_TOKEN_MAX_CHARS = 255;

/** What marks a field the log stored cut. */
const CUT_MARKER = "...";

/**
 * The longest summary a pending birth holds: the tool name (a token), the space after it, and the tracker's input excerpt with its own cut marker (`RC_PENDING_SUMMARY_EXCERPT_CHARS`), which is the summary's whole shape.
 */
export const RC_SESSION_EVENT_SUMMARY_MAX_CHARS = RC_SESSION_EVENT_TOKEN_MAX_CHARS + " ".length + RC_PENDING_SUMMARY_EXCERPT_CHARS + CUT_MARKER.length;

/** The longest door generation id a cursor names: the text form of a v4 UUID, which is what the door mints. */
const RC_SESSION_EVENT_GENERATION_MAX_CHARS = "00000000-0000-4000-8000-000000000000".length;

/** The most digits a sequence can have: every sequence is a safe integer. */
const SEQUENCE_MAX_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

/** How many bytes one stored number occupies: an IEEE 754 double. */
const NUMBER_BYTES = Float64Array.BYTES_PER_ELEMENT;

/** The number fields every event carries: `at` and `sequence`. */
const NUMBER_FIELDS = ["at", "sequence"].length;

/** How many bytes one UTF-16 code unit occupies at most in a JavaScript string's storage, so a byte budget converts to string lengths without assuming one-byte text. */
const BYTES_PER_CODE_UNIT = Uint16Array.BYTES_PER_ELEMENT;

/** The longest `kind` and `reason` labels, read off the closed sets that define them. */
const KIND_MAX_CHARS = Math.max(...["session-appeared", "session-ended", "worker-state", "pending-born", "pending-retired"].map((kind) => kind.length));

/**
 * The most bytes one recorded event's fields occupy: its cursor, session, kind and two numbers, plus the largest kind-specific fields, which are a pending birth's request id, type and summary (a worker state's two labels and every reason are shorter). Object and property overhead is the engine's and grows with the field count, not with any value the protocol controls, so the bound is on what an observed value can make large.
 */
export const RC_SESSION_EVENT_MAX_BYTES =
  (RC_SESSION_EVENT_GENERATION_MAX_CHARS + ".".length + SEQUENCE_MAX_DIGITS + RC_SESSION_EVENT_TOKEN_MAX_CHARS + KIND_MAX_CHARS + RC_SESSION_EVENT_TOKEN_MAX_CHARS + RC_SESSION_EVENT_TOKEN_MAX_CHARS + RC_SESSION_EVENT_SUMMARY_MAX_CHARS) * BYTES_PER_CODE_UNIT + NUMBER_FIELDS * NUMBER_BYTES;

/**
 * How many events the log retains before it evicts the oldest: as many of the largest possible events as its memory budget holds, which bounds the log's memory whatever mix of events fills it. The budget is the protocol's own documented cap on one event batch (`CONTROL_BODY_CAP_BYTES`), which the door already buffers in full for one control request: the supervision log is a digest of many such batches, so holding no more than one batch's worth keeps it within a bound the door already accepts.
 */
export const RC_SESSION_EVENT_LOG_CAPACITY = Math.floor(CONTROL_BODY_CAP_BYTES / RC_SESSION_EVENT_MAX_BYTES);

/** Why the tracker stopped describing a session: its liveness bound passed with no traffic, an accepted archive ended it by design, or the service closed it with a conflict header. */
export const RC_SESSION_END_REASONS = ["expired", "archived", "conflict"] as const;

/** Why a control request stopped awaiting an answer: a `control_response` answered it (whoever sent it), its answer deadline passed, or its session ended with it still outstanding. */
export const RC_PENDING_RETIRE_REASONS = ["answered", "expired", "session-ended"] as const;

/** One reason a session ended. */
export type RcSessionEndReason = (typeof RC_SESSION_END_REASONS)[number];

/** One reason a pending request retired. */
export type RcPendingRetireReason = (typeof RC_PENDING_RETIRE_REASONS)[number];

/** The fields every transition carries: the session it describes and when the tracker filed it, in epoch milliseconds from the tracker's injected clock. */
const transitionBase = { session: z.string(), at: z.number() };

/** The fields the log stamps on every transition it records: the opaque cursor a resume names, and the event's position within this door generation, which increases by one per event so a gap is visible. */
const cursorFields = { cursor: z.string(), sequence: z.int().positive() };

/** A session the tracker began describing. */
const sessionAppearedShape = { kind: z.literal("session-appeared"), ...transitionBase };
/** A session the tracker stopped describing, and why. */
const sessionEndedShape = { kind: z.literal("session-ended"), reason: z.enum(RC_SESSION_END_REASONS), ...transitionBase };
/** The worker state changed: the state the worker now reports (`idle`, `running`, `requires_action` and kin, carried as the worker's own string because the vocabulary grows with the CLI), and the state it replaced, absent for the first state the door learnt. */
const workerStateShape = { kind: z.literal("worker-state"), state: z.string(), previous: z.string().optional(), ...transitionBase };
/** A control request began awaiting an answer: the id a `control_response` must echo, its subtype, and the one-line summary the pending list shows. */
const pendingBornShape = { kind: z.literal("pending-born"), requestId: z.string(), type: z.string(), summary: z.string(), ...transitionBase };
/** A control request stopped awaiting an answer, and why. */
const pendingRetiredShape = { kind: z.literal("pending-retired"), requestId: z.string(), reason: z.enum(RC_PENDING_RETIRE_REASONS), ...transitionBase };

/** One transition as the tracker hands it to the log's sink, before the log stamps it. */
export const RcSessionTransitionSchema = z.discriminatedUnion("kind", [
  z.strictObject(sessionAppearedShape),
  z.strictObject(sessionEndedShape),
  z.strictObject(workerStateShape),
  z.strictObject(pendingBornShape),
  z.strictObject(pendingRetiredShape),
]);

/** One transition as the tracker hands it to the log's sink. */
export type RcSessionTransition = z.output<typeof RcSessionTransitionSchema>;

/** One recorded event: a transition with the cursor and sequence the log stamped on it. */
export const RcSessionEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...cursorFields, ...sessionAppearedShape }),
  z.strictObject({ ...cursorFields, ...sessionEndedShape }),
  z.strictObject({ ...cursorFields, ...workerStateShape }),
  z.strictObject({ ...cursorFields, ...pendingBornShape }),
  z.strictObject({ ...cursorFields, ...pendingRetiredShape }),
]);

/** One recorded event, as every in-process consumer handles it. */
export type RcSessionEvent = z.output<typeof RcSessionEventSchema>;

/** What one read asks for: the events after `since` (from the oldest retained when omitted), optionally one session's alone, at most `limit` of them. */
export const RcSessionEventsReadInputSchema = z.strictObject({
  /** The cursor of the last event the caller saw; every retained event when omitted. */
  since: z.string().min(1).optional(),
  /** One `cse_` session id; every session when omitted. */
  session: z.string().min(1).optional(),
  /** The most events one answer carries; every event after `since` when omitted. */
  limit: z.int().positive().optional(),
});

/** What one read asks for. */
export type RcSessionEventsReadInput = z.output<typeof RcSessionEventsReadInputSchema>;

/**
 * What one page read asks for over the typed API: the log's own read, with the page size defaulted and capped so a caller naming none still receives a bounded answer. A page answer lands whole in its reader's memory (an agent's context, through the MCP tool), so an unbounded default would hand it the whole window.
 */
export const RcSessionEventsPageInputSchema = RcSessionEventsReadInputSchema.extend({
  /** The most events this page carries. When omitted, the bound the door's event backbone already holds per slow consumer (`DOOR_EVENT_BUFFER_EVENTS`, oRPC's own documented default for that case), so a reader with no stated preference receives one consumer buffer's worth at a time. At most the whole retained window (`RC_SESSION_EVENT_LOG_CAPACITY`), since no page can return more than the log holds. */
  limit: z.int().positive().max(RC_SESSION_EVENT_LOG_CAPACITY).default(DOOR_EVENT_BUFFER_EVENTS),
});

/** The query the event stream takes: where to resume (the SSE `Last-Event-ID` header outranks it on a reconnect) and an optional session filter. */
export const RcSessionEventsStreamInputSchema = RcSessionEventsReadInputSchema.omit({ limit: true });

/**
 * One read's answer. `ok` carries the events in order and the cursor the next read resumes after (the last event returned, or the head when the read reached it, so a filtered read never rescans what it already passed), with `more` saying whether the limit cut the answer short and `head` naming the newest event whatever the filter and limit, the cursor a follower that has just read the status starts after. `expired` says the cursor can no longer be honoured and names the head to resume after once the status read has restated the present.
 */
export const RcSessionEventsReadOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), events: z.readonly(z.array(RcSessionEventSchema)), cursor: z.string(), more: z.boolean(), head: z.string() }),
  z.strictObject({ status: z.literal("expired"), message: z.string(), head: z.string() }),
]);

/** One read's answer. */
export type RcSessionEventsRead = z.output<typeof RcSessionEventsReadOutputSchema>;

/** Everything the log needs, injected so its behaviour runs against fixed values in tests. */
export interface RcSessionEventLogDeps {
  /** This door generation's identity, minted once per process (a v4 UUID in production): a cursor names it, so a cursor from another generation is refused rather than misread as a position in this one. Must not contain the cursor separator. */
  readonly generation: string;
  /** How many events the log retains; production passes `RC_SESSION_EVENT_LOG_CAPACITY`, tests pass small values so an eviction is reached in a few appends. */
  readonly capacity: number;
}

/** The door's supervision log. */
export interface RcSessionEventLog {
  /** The tracker's sink: records one transition at the next sequence and tells every waiting follower. Synchronous, so the log's order is the order the tracker filed its facts in. */
  readonly append: (transition: RcSessionTransition) => void;
  /** The cursor naming the newest recorded event (sequence 0 of this generation while none has been recorded): where a subscriber that has just read the status resumes after. */
  readonly head: () => string;
  /** Reads the events after a cursor, or answers that the cursor has expired. */
  readonly read: (input: Readonly<RcSessionEventsReadInput>) => RcSessionEventsRead;
  /** Adds a listener told after every append, which a follower waits on instead of polling. Returns the detach function. */
  readonly onAppend: (listener: () => void) => () => void;
}

/** What separates a cursor's generation from its sequence: never part of a UUID, so the split is unambiguous. */
const CURSOR_SEPARATOR = ".";

/** The message every expiry carries after its own reason, saying what to do about it. */
const RESYNC_ADVICE = "cursor expired, resync from status: read `rc status` for every session's present state, then resume after the head this answer names";

/** Formats one cursor. */
function cursorOf(generation: string, sequence: number): string {
  return `${generation}${CURSOR_SEPARATOR}${String(sequence)}`;
}

/** Parses one cursor into its generation and sequence, or undefined when the text is not a cursor's shape. */
function parseCursor(cursor: string): { readonly generation: string; readonly sequence: number } | undefined {
  const at = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (at <= 0) {
    return undefined;
  }
  const digits = cursor.slice(at + 1);
  if (!/^[0-9]+$/.test(digits)) {
    return undefined;
  }
  return { generation: cursor.slice(0, at), sequence: Number(digits) };
}

/** One stored text field, cut to its cap with the cut marker when it is longer. */
function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - CUT_MARKER.length)}${CUT_MARKER}`;
}

/** One transition with every text field an observed value controls held to its cap, so no event the log retains is larger than `RC_SESSION_EVENT_MAX_BYTES`. */
function boundedTransition(transition: RcSessionTransition): RcSessionTransition {
  const session = bounded(transition.session, RC_SESSION_EVENT_TOKEN_MAX_CHARS);
  if (transition.kind === "worker-state") {
    return { ...transition, session, state: bounded(transition.state, RC_SESSION_EVENT_TOKEN_MAX_CHARS), ...(transition.previous === undefined ? {} : { previous: bounded(transition.previous, RC_SESSION_EVENT_TOKEN_MAX_CHARS) }) };
  }
  if (transition.kind === "pending-born") {
    return { ...transition, session, requestId: bounded(transition.requestId, RC_SESSION_EVENT_TOKEN_MAX_CHARS), type: bounded(transition.type, RC_SESSION_EVENT_TOKEN_MAX_CHARS), summary: bounded(transition.summary, RC_SESSION_EVENT_SUMMARY_MAX_CHARS) };
  }
  if (transition.kind === "pending-retired") {
    return { ...transition, session, requestId: bounded(transition.requestId, RC_SESSION_EVENT_TOKEN_MAX_CHARS) };
  }
  return { ...transition, session };
}

/** Creates the log. One per door process; everything it holds dies with it. Throws when the generation id is longer than a UUID or contains the cursor separator, since either would make a cursor ambiguous or unbounded. */
export function createRcSessionEventLog(deps: RcSessionEventLogDeps): RcSessionEventLog {
  if (deps.generation.includes(CURSOR_SEPARATOR)) {
    throw new Error(`a door generation id must not contain "${CURSOR_SEPARATOR}", which separates a cursor's generation from its sequence`);
  }
  if (deps.generation.length > RC_SESSION_EVENT_GENERATION_MAX_CHARS) {
    throw new Error(`a door generation id must be at most ${String(RC_SESSION_EVENT_GENERATION_MAX_CHARS)} characters, a UUID's length`);
  }
  /** The retained events, oldest first; `events[0].sequence` is the oldest a resume can still continue after, less one. */
  const events: RcSessionEvent[] = [];
  let lastSequence = 0;
  const listeners = new Set<() => void>();

  const expired = (reason: string): RcSessionEventsRead => ({ status: "expired", message: `${reason}; ${RESYNC_ADVICE}`, head: cursorOf(deps.generation, lastSequence) });

  return {
    append: (transition) => {
      lastSequence += 1;
      events.push({ ...boundedTransition(transition), cursor: cursorOf(deps.generation, lastSequence), sequence: lastSequence });
      if (events.length > deps.capacity) {
        events.splice(0, events.length - deps.capacity);
      }
      for (const listener of listeners) {
        listener();
      }
    },
    head: () => cursorOf(deps.generation, lastSequence),
    read: ({ since, session, limit }) => {
      let after = 0;
      if (since !== undefined) {
        const parsed = parseCursor(since);
        if (parsed === undefined) {
          return expired(`"${since}" is not a cursor this door issues`);
        }
        if (parsed.generation !== deps.generation) {
          return expired(`the cursor "${since}" was issued by another generation of the front door, whose events this one never held`);
        }
        if (parsed.sequence > lastSequence) {
          return expired(`the cursor "${since}" names an event past this door's newest`);
        }
        const oldest = events[0]?.sequence ?? lastSequence + 1;
        // A cursor is honoured exactly while every event after it is still retained: the oldest retained event must be the one right after it, or earlier.
        if (parsed.sequence < oldest - 1) {
          return expired(`the events after "${since}" have been evicted (the log retains the newest ${String(deps.capacity)} and the oldest it still holds is "${cursorOf(deps.generation, oldest)}")`);
        }
        after = parsed.sequence;
      }
      const selected: RcSessionEvent[] = [];
      let cursor = cursorOf(deps.generation, lastSequence);
      let more = false;
      for (const event of events) {
        if (event.sequence <= after || (session !== undefined && event.session !== session)) {
          continue;
        }
        if (limit !== undefined && selected.length === limit) {
          more = true;
          cursor = selected.at(-1)?.cursor ?? cursor;
          break;
        }
        selected.push(event);
      }
      return { status: "ok", events: selected, cursor, more, head: cursorOf(deps.generation, lastSequence) };
    },
    onAppend: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Thrown by `followRcSessionEvents` when the cursor it resumes from, or one it reached itself because its consumer fell further behind than the log retains, can no longer be honoured. */
export class RcSessionEventCursorExpiredError extends Error {
  /** The cursor naming the log's newest event at the moment of the refusal: where to resume after once the status read has restated the present. */
  readonly head: string;

  constructor(message: string, head: string) {
    super(message);
    this.name = "RcSessionEventCursorExpiredError";
    this.head = head;
  }
}

/**
 * Follows the log as an async iterator: yields every event after `since` (after the head at the moment of the call when omitted, so a fresh follower sees only what happens next), optionally one session's alone, then waits on the log's own append notification for each further event, never polling. Throws `RcSessionEventCursorExpiredError` when the cursor cannot be honoured, at the start or later if the consumer falls further behind than the log retains, and ends quietly by throwing the signal's reason once `signal` aborts.
 */
export async function* followRcSessionEvents(log: RcSessionEventLog, input: Readonly<{ since?: string | undefined; session?: string | undefined }>, signal?: AbortSignal): AsyncGenerator<RcSessionEvent, void> {
  let cursor = input.since ?? log.head();
  const aborted = new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => {
      resolve();
    }, { once: true });
  });
  for (;;) {
    signal?.throwIfAborted();
    // The wake is registered before the read, so an event appended between the read and the wait can never be slept past.
    let wake: (() => void) | undefined;
    const appended = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const detach = log.onAppend(() => {
      wake?.();
    });
    try {
      const read = log.read({ since: cursor, ...(input.session === undefined ? {} : { session: input.session }) });
      if (read.status === "expired") {
        throw new RcSessionEventCursorExpiredError(read.message, read.head);
      }
      if (read.events.length === 0) {
        cursor = read.cursor;
        await Promise.race([appended, aborted]);
        continue;
      }
      for (const event of read.events) {
        yield event;
        cursor = event.cursor;
      }
      // A filtered read may have passed events of other sessions after the last one it yielded; resuming after the read's own cursor never rescans them.
      cursor = read.cursor;
    } finally {
      detach();
    }
  }
}
