import { z } from "zod";

import { RC_PENDING_SUMMARY_EXCERPT_CHARS, RC_REQUEST_PARSE_CAP_BYTES } from "./rcSessions";

/**
 * The door-level supervision log of the Remote Control sessions it observes: one ordered, bounded, in-memory record of the moments a supervisor of many sessions acts on (a session appearing or ending, its worker state changing, a control request awaiting an answer being born or retired), each tagged with its session and stamped with a monotonic cursor, so one subscription follows every session at once and a reconnecting subscriber resumes exactly after the last event it saw.
 *
 * The log is fed, never polled: the session tracker (`rcSessions.ts`) hands each transition to the injected sink as it files the fact that caused it, so the log's order is the tracker's own order of observation. A cursor names one door generation and one position in it; a cursor this log can no longer honour (its events were evicted past the retention bound, or it was issued by another generation of the door) is answered with an explicit expiry naming the current head, never by silently skipping what it would have missed, because a supervisor that missed a retirement would otherwise act on a request that is already gone. The recovery is the status read (`rc.status`), which states every session's present state, followed by a resume from the head the expiry named.
 *
 * Everything here is in memory only and dies with the door process, exactly like the tracker it is fed from: nothing is written to a log, to the capture, or to disk, and no event carries a credential.
 */

/**
 * How many events the log retains before it evicts the oldest. Derived, not chosen: the log's memory budget is the tracker's own bound on one exchange's worth of parsed JSON (`RC_REQUEST_PARSE_CAP_BYTES`), the budget this surface already deems a reasonable amount of protocol state to hold for one purpose, and the event whose size dominates the log is a pending birth, whose summary is held to the excerpt budget (`RC_PENDING_SUMMARY_EXCERPT_CHARS`). The quotient is therefore the number of the largest events that budget holds, which bounds the log's memory whatever mix of events fills it.
 */
export const RC_SESSION_EVENT_LOG_CAPACITY = Math.floor(RC_REQUEST_PARSE_CAP_BYTES / RC_PENDING_SUMMARY_EXCERPT_CHARS);

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

/** The query the event stream takes: where to resume (the SSE `Last-Event-ID` header outranks it on a reconnect) and an optional session filter. */
export const RcSessionEventsStreamInputSchema = RcSessionEventsReadInputSchema.omit({ limit: true });

/**
 * One read's answer. `ok` carries the events in order and the cursor the next read resumes after (the last event returned, or the head when the read reached it, so a filtered read never rescans what it already passed), with `more` saying whether the limit cut the answer short. `expired` says the cursor can no longer be honoured and names the head to resume after once the status read has restated the present.
 */
export const RcSessionEventsReadOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), events: z.readonly(z.array(RcSessionEventSchema)), cursor: z.string(), more: z.boolean() }),
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

/** Creates the log. One per door process; everything it holds dies with it. */
export function createRcSessionEventLog(deps: RcSessionEventLogDeps): RcSessionEventLog {
  if (deps.generation.includes(CURSOR_SEPARATOR)) {
    throw new Error(`a door generation id must not contain "${CURSOR_SEPARATOR}", which separates a cursor's generation from its sequence`);
  }
  /** The retained events, oldest first; `events[0].sequence` is the oldest a resume can still continue after, less one. */
  const events: RcSessionEvent[] = [];
  let lastSequence = 0;
  const listeners = new Set<() => void>();

  const expired = (reason: string): RcSessionEventsRead => ({ status: "expired", message: `${reason}; ${RESYNC_ADVICE}`, head: cursorOf(deps.generation, lastSequence) });

  return {
    append: (transition) => {
      lastSequence += 1;
      events.push({ ...transition, cursor: cursorOf(deps.generation, lastSequence), sequence: lastSequence });
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
      return { status: "ok", events: selected, cursor, more };
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
