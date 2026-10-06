import { HTTP_STATUS } from "../codex/http";
import type { RcObservedCredential } from "./rcWrites";
import type { RcStreamEnvelope, RcStreamEvent } from "./rcSchemas";

/**
 * The client read stream half of the Remote Control protocol: the SSE endpoint (`GET /v1/code/sessions/{cse}/events/stream`) a client holds open to receive the session's events, the presence call that announces a client to it, the parser that turns the wire's Server-Sent Events into envelopes, the fan-out that delivers them to every subscriber, and the door's own attachment.
 *
 * The attachment is the half the door was missing. The CLI routes permission approvals only toward attached clients, and nothing is attached until something holds the stream open, so with no subscriber the CLI falls back to asking locally and the approval never crosses the door. The door therefore plays one client itself: per tracked session it announces a stable client id through the presence endpoint and holds one stream open over its own interception-proof dials, authenticated by the same OAuth-kind bearer the write path replays (the tracker's credential). One stream serves every consumer (a singleton per session, not per consumer): each event is filed with the tracker (whose cursor and pending list it advances) and handed to the fan-out, which the typed API's subscription and the `frontdoor rc watch` verb read.
 *
 * Reconnection follows the protocol's documented resume rule: the query parameter `from_sequence_num` and the `Last-Event-ID` header are sent together, naming the highest sequence number the door has seen for the session (stream events and its own confirmed writes both advance it). A generation whose memory holds no number yet, because it started after the session's traffic, names the persisted cursor instead (the injected fallback read), so a restarted door resumes where the last generation left off rather than at the stream's head. A drop reconnects immediately with that pair. A 401 re-reads the tracker's credential and retries once, since the observed bearer may simply have gone stale; a failure past that backs off to the session's own liveness bound, because retrying harder than the protocol's own give-up cadence would only hammer a session the protocol may have abandoned, and the next observed exchange for the session re-pokes the attachment anyway.
 *
 * Everything here is in memory only: nothing is written to a log, to the capture, or to disk, and the bearer is used on the dial and never surfaced. The one exception is injected, not this module's own effect: the caller may hand the hub a cursor persistence port, and then the session's sequence number alone (never an event payload, never a credential) is handed to it at attachment boundaries, at exactly the cadence the native client persists its own cursor at. The capture's redaction is untouched; a capture and this attachment observe entirely separate paths.
 */

/** The SSE event name the protocol's client stream dispatches its envelopes under; every other event on the wire is not a client event and is skipped. */
const RC_STREAM_EVENT_NAME = "client_event";

/** The byte-order mark the SSE framing permits once at the stream's very start, as a code point number because the check reads `charCodeAt`. */
const SSE_BYTE_ORDER_MARK = 0xfeff;

/**
 * How long a failed attachment backs off before retrying. Not a fresh number: it is the session's own liveness bound (`RC_IDLE_EXPIRY_MS`, the 45 s stream timeout the tracker's idle expiry already derives from), so an attachment that cannot be re-established retries at exactly the cadence the protocol itself gives up on a quiet session at. Production passes that constant; tests pass small values so a backoff is reached in milliseconds.
 */
export const RC_STREAM_BACKOFF_MS = 45_000;

/** The exclusive ceiling of the 2xx success class, whose bounds are fixed hundreds (RFC 9110 section 15); named once so a range check never carries a bare literal. */
const SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** Whether a status is a 2xx success. */
function isSuccessful(status: number): boolean {
  return status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_MAX_EXCLUSIVE;
}

/** One event the SSE parser completed: the fields the wire's own framing carried, before any protocol interpretation. */
export interface SseParsedEvent {
  /** The `event:` field's value, when the block carried one; the protocol's own events always do. */
  readonly event: string | undefined;
  /** The `id:` field's value in force at dispatch (the most recent one the connection saw, per the SSE framing rules); on this stream it carries the event's sequence number. */
  readonly id: string | undefined;
  /** The `data:` lines joined with newlines, exactly as the SSE framing defines. */
  readonly data: string;
}

/**
 * An incremental Server-Sent Events parser: feed it the stream's text chunks as they arrive and it returns the events each write completed. Chunks may split lines, fields and even a CRLF pair anywhere; the parser buffers until a line ending is certain, so a `\r` at a chunk's end waits for the byte that decides whether it is `\r\n`. Comments (`:`-prefixed lines, the protocol's 15 s keepalives) complete nothing, an event with no `data:` line dispatches nothing (the framing's own rule), and the `id:` value persists to the next dispatched event the same way, which is what carries the sequence number of an id-only block forward.
 */
export function createSseParser(): { readonly write: (text: string) => readonly SseParsedEvent[] } {
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let seenAnyText = false;
  return {
    write: (text) => {
      // The framing allows one byte-order mark at the stream's very start; it is not part of any field value, so the first text alone strips it.
      let incoming = text;
      if (!seenAnyText) {
        seenAnyText = true;
        incoming = incoming.charCodeAt(0) === SSE_BYTE_ORDER_MARK ? incoming.slice(1) : incoming;
      }
      buffer += incoming;
      const completed: SseParsedEvent[] = [];
      for (;;) {
        const carriage = buffer.indexOf("\r");
        const lineFeed = buffer.indexOf("\n");
        const end = carriage === -1 ? lineFeed : lineFeed === -1 ? carriage : carriage < lineFeed ? carriage : lineFeed;
        // No terminator at all: nothing to do until more text arrives.
        if (end === -1) {
          break;
        }
        // A `\r` as the buffer's last byte may be half of a `\r\n` whose second byte has not arrived; holding it is the only way not to treat `\r\n` as two line endings.
        if (buffer[end] === "\r" && end === buffer.length - 1) {
          break;
        }
        const after = buffer[end] === "\r" && buffer[end + 1] === "\n" ? end + 2 : end + 1;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(after);
        if (line === "") {
          // The blank line dispatches the block under assembly, but only one that carries data: the framing's own rule for id-only and comment-only blocks.
          if (dataLines.length > 0) {
            completed.push({ event: eventName, id: eventId, data: dataLines.join("\n") });
          }
          eventName = undefined;
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) {
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        // One optional leading space after the colon is part of the framing, not the value.
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") {
          eventName = value;
        } else if (field === "data") {
          dataLines.push(value);
        } else if (field === "id") {
          eventId = value;
        }
        // Every other field name is ignored, as the framing directs.
      }
      return completed;
    },
  };
}

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sequence number an envelope's `sequence_num` field names, or undefined when the field is absent or names none. The number is accepted as either a JSON number or a numeric string, because the real API was observed live returning the assigned number as a JSON string on the write path (`"6"`), and the same service serialises the stream's envelopes; the normalised number is what the door files.
 */
function sequenceNumOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * One parsed SSE event as the protocol's envelope, or undefined when the event is not a client event this half reads: a block under any other event name, or data that is not one JSON object carrying the fields the door relies on (`event_type`, `sequence_num`, `source`). An envelope the door cannot read is one it knows nothing about, never a failure: the stream stays up and the next event is read on its own merits.
 */
export function parseRcStreamEnvelope(parsed: SseParsedEvent): RcStreamEnvelope | undefined {
  if (parsed.event !== RC_STREAM_EVENT_NAME) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(parsed.data);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) {
    return undefined;
  }
  const eventType = data.event_type;
  const sequenceNum = sequenceNumOf(data.sequence_num);
  const source = data.source;
  if (typeof eventType !== "string" || sequenceNum === undefined || typeof source !== "string") {
    return undefined;
  }
  return { ...data, event_type: eventType, sequence_num: sequenceNum, source };
}

/** One answer from the API host the presence call dials: the status and the whole body. Presence answers one small JSON object, never a stream, so the body needs no cap of its own. */
export interface RcPresenceAnswer {
  readonly status: number;
  readonly body: string;
}

/** One answer from the API host the stream dial opens: the status and the body's chunks as they arrive. On a success the chunks are the live stream (consumed incrementally, never buffered); the production dial returns an already-drained empty iterable for any non-2xx answer, whose body is one small error document. */
export interface RcStreamAnswer {
  readonly status: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * The one network effect the client read stream performs, injected so the attachment logic runs against fakes: announce a client's presence, and open the read stream. Production dials the real API host over the door's interception-proof agent; tests redirect to a local stand-in. `resume` names the documented resume pair's value: present only when the door has seen events for the session already, it sends `from_sequence_num` as a query parameter and `Last-Event-ID` as a header together.
 */
export interface RcStreamDial {
  readonly announcePresence: (sessionId: string, headers: Readonly<Record<string, string>>, clientId: string) => Promise<RcPresenceAnswer>;
  readonly openStream: (sessionId: string, headers: Readonly<Record<string, string>>, resume: { readonly fromSequenceNum: number } | undefined, signal: AbortSignal) => Promise<RcStreamAnswer>;
}

/** The fan-out every stream event is handed to: the tracker files what it recognises, and each subscriber receives the event beside it. */
export interface RcEventFanout {
  /** Delivers one event to every subscriber listening for its session (or for every session), synchronously, in publication order. */
  readonly publish: (event: RcStreamEvent) => void;
  /** Adds one listener, told every event whose session it matches; `undefined` listens to every session. Returns the detach function. */
  readonly subscribe: (session: string | undefined, listener: (event: RcStreamEvent) => void) => () => void;
}

/** Creates the fan-out: plain synchronous listener sets, one per session plus one for every-session listeners. Delivery is synchronous so the tracker's filing (which rides the same publish) and every subscriber observe the same order; a subscriber that cannot keep up is bounded where it is bridged to a pull (the typed API's subscription), not here. */
export function createRcEventFanout(): RcEventFanout {
  const perSession = new Map<string, Set<(event: RcStreamEvent) => void>>();
  const every = new Set<(event: RcStreamEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of every) {
        listener(event);
      }
      for (const listener of perSession.get(event.session) ?? []) {
        listener(event);
      }
    },
    subscribe: (session, listener) => {
      if (session === undefined) {
        every.add(listener);
        return () => {
          every.delete(listener);
        };
      }
      const listeners = perSession.get(session) ?? new Set();
      perSession.set(session, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          perSession.delete(session);
        }
      };
    },
  };
}

/** Everything the attachment hub needs, injected so its decisions run against fakes in unit tests. */
export interface RcStreamHubDeps {
  readonly now: () => number;
  /** The tracker's credential accessor: the OAuth-kind bearer and protocol headers the attachment replays, exactly as the write path does. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** The tracker's swept session list: an attachment whose session has expired is dropped, exactly when the tracker itself gives up on it. */
  readonly trackedSessions: () => readonly string[];
  /** Files one envelope with the tracker: advances the session's sequence cursor and births or retires pending control requests, exactly as an observed event-batch body does. */
  readonly fileStreamEvent: (sessionId: string, event: RcStreamEnvelope) => void;
  /** Reads the session's sequence cursor: the highest number the door has seen, from the stream or from its own confirmed writes. */
  readonly sequenceNumOf: (sessionId: string) => number | undefined;
  /** Reads the session's persisted sequence cursor, consulted only when the tracker's in-memory cursor is undefined at attach time (a door generation that started after the session's traffic, the same fresh-generation case the persisted credential solves for attaching at all), so that generation's first stream resumes where the last one left off instead of at the stream's head. */
  readonly storedSequenceNumOf?: (sessionId: string) => number | undefined;
  /** Persists the session's sequence cursor at an attachment boundary (a stream drop, a failed attempt, the attachment's end), never per stream event: the native client persists its own cursor at bridge-session boundaries, and so does this. */
  readonly saveSequenceNum?: (sessionId: string, sequenceNum: number) => void;
  readonly dial: RcStreamDial;
  readonly fanout: RcEventFanout;
  /** Mints the stable client id one session's attachment announces: a v4 UUID or better in production. Stable means it survives reconnects, so the host sees one client, not a new one per drop. */
  readonly newClientId: () => string;
  /** How long a failed attachment backs off; production passes `RC_STREAM_BACKOFF_MS`, tests pass small values so a backoff is reached in milliseconds. */
  readonly backoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The door's log, for attachment lifecycle lines only: never an event payload, never a credential. */
  readonly log?: (line: string) => void;
}

/** The door's client read stream attachment: one stream per tracked session, fanned out to every subscriber. */
export interface RcStreamHub {
  /** Reconciles the attachments against the tracker: attaches a stream to every tracked session whose OAuth credential is known, and drops an attachment whose session has expired or lost its credential. Idempotent, synchronous and total (never throws): the door calls it after every observed Remote Control exchange, so an attachment follows the session it belongs to without any polling of its own. */
  readonly reconcile: () => void;
  /** Stops every attachment and frees their dials. */
  readonly close: () => void;
}

/** What one attachment attempt concluded, which decides how the loop continues. */
type AttemptOutcome = "dropped" | "unauthorized";

/** Creates the attachment hub. One per door process; everything it holds dies with it. */
export function createRcStreamHub(deps: RcStreamHubDeps): RcStreamHub {
  interface Attachment {
    readonly sessionId: string;
    readonly clientId: string;
    readonly controller: AbortController;
    /** Whether this attachment has been stopped: read through a call, because a closure sets it and property narrowing would otherwise hide that across the loop's awaits. */
    readonly isStopped: () => boolean;
    readonly stop: () => void;
  }
  const attachments = new Map<string, Attachment>();
  /** The last cursor this hub persisted per session, so a boundary that moved nothing writes nothing: one write per boundary that advanced the cursor, not one per boundary. */
  const lastSavedSequenceNums = new Map<string, number>();

  /** Persists the session's cursor at an attachment boundary: the tracker's own accessor is the value, and a value this hub already persisted is not written again. */
  const persistCursor = (sessionId: string): void => {
    if (deps.saveSequenceNum === undefined) {
      return;
    }
    const cursor = deps.sequenceNumOf(sessionId);
    if (cursor === undefined || cursor === lastSavedSequenceNums.get(sessionId)) {
      return;
    }
    deps.saveSequenceNum(sessionId, cursor);
    // Recorded only once the port accepted it, so a write that throws is retried at the next boundary rather than remembered as done.
    lastSavedSequenceNums.set(sessionId, cursor);
  };

  const birth = (sessionId: string): Attachment => {
    const controller = new AbortController();
    let stopped = false;
    return {
      sessionId,
      clientId: deps.newClientId(),
      controller,
      isStopped: () => stopped,
      stop: () => {
        stopped = true;
        controller.abort();
      },
    };
  };

  /** The headers every client read stream request sends: the observed OAuth-kind credential and protocol values, replayed verbatim, never invented, exactly as the write path replays them. */
  const streamHeaders = (credential: RcObservedCredential): Record<string, string> => {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (credential.authorization !== undefined) {
      headers.authorization = credential.authorization;
    }
    if (credential.anthropicVersion !== undefined) {
      headers["anthropic-version"] = credential.anthropicVersion;
    }
    if (credential.anthropicClientPlatform !== undefined) {
      headers["anthropic-client-platform"] = credential.anthropicClientPlatform;
    }
    return headers;
  };

  const attempt = async (attachment: Attachment, credential: RcObservedCredential): Promise<AttemptOutcome> => {
    const headers = streamHeaders(credential);
    const presence = await deps.dial.announcePresence(attachment.sessionId, headers, attachment.clientId);
    if (presence.status === HTTP_STATUS.unauthorized) {
      return "unauthorized";
    }
    if (!isSuccessful(presence.status)) {
      throw new Error(`the presence call answered HTTP ${String(presence.status)}: ${presence.body}`);
    }
    // The tracker's in-memory cursor is the primary source; the persisted one is the fallback a fresh generation needs, because its memory starts empty while the channel left off mid-stream.
    const cursor = deps.sequenceNumOf(attachment.sessionId) ?? deps.storedSequenceNumOf?.(attachment.sessionId);
    const resume = cursor === undefined ? undefined : { fromSequenceNum: cursor };
    const answer = await deps.dial.openStream(attachment.sessionId, headers, resume, attachment.controller.signal);
    if (answer.status === HTTP_STATUS.unauthorized) {
      return "unauthorized";
    }
    if (!isSuccessful(answer.status)) {
      throw new Error(`the client read stream answered HTTP ${String(answer.status)}`);
    }
    deps.log?.(`rc stream ${attachment.sessionId}: attached as client ${attachment.clientId}${resume === undefined ? ", reading from the stream's own head" : `, resuming after sequence number ${String(resume.fromSequenceNum)}`}`);
    const parser = createSseParser();
    for await (const chunk of answer.chunks) {
      attachment.controller.signal.throwIfAborted();
      for (const parsed of parser.write(Buffer.from(chunk).toString("utf8"))) {
        const envelope = parseRcStreamEnvelope(parsed);
        if (envelope === undefined) {
          continue;
        }
        deps.fileStreamEvent(attachment.sessionId, envelope);
        deps.fanout.publish({ session: attachment.sessionId, envelope });
      }
    }
    return "dropped";
  };

  const runLoop = async (attachment: Attachment): Promise<void> => {
    // A 401 retries exactly once with a freshly read credential before any backoff, so a bearer that went stale between observation and dial is not punished with a wait.
    let retriedUnauthorized = false;
    for (;;) {
      if (attachment.isStopped()) {
        return;
      }
      const live = deps.trackedSessions().includes(attachment.sessionId);
      const credential = deps.credentialOf(attachment.sessionId);
      if (!live || credential?.authorization === undefined) {
        // The tracker gave up on the session, or only worker calls were observed from here on (the worker JWT they carry does not authorise the client half). The attachment ends; a later observed exchange whose credential is usable re-attaches through reconcile.
        deps.log?.(`rc stream ${attachment.sessionId}: the attachment ended (${live ? "the session's client credential is no longer known" : "the tracker gave up on the session"})`);
        persistCursor(attachment.sessionId);
        if (attachments.get(attachment.sessionId) === attachment) {
          attachments.delete(attachment.sessionId);
        }
        return;
      }
      let outcome: AttemptOutcome;
      try {
        outcome = await attempt(attachment, credential);
      } catch (error) {
        // The attempt's connection is over whether it failed on its own or was stopped: a boundary passed, so the cursor it reached is persisted before anything else happens to the attachment.
        persistCursor(attachment.sessionId);
        if (attachment.isStopped()) {
          return;
        }
        deps.log?.(`rc stream ${attachment.sessionId}: attachment failed (${error instanceof Error ? error.message : String(error)}); backing off`);
        await deps.sleep(deps.backoffMs);
        retriedUnauthorized = false;
        continue;
      }
      if (attachment.isStopped()) {
        return;
      }
      if (outcome === "dropped") {
        // The stream ended of its own accord: the boundary it reached is persisted, then the attachment reconnects at once, resuming from whatever cursor the tracker holds by then.
        persistCursor(attachment.sessionId);
        deps.log?.(`rc stream ${attachment.sessionId}: the stream ended of its own accord, reconnecting`);
        retriedUnauthorized = false;
        continue;
      }
      if (!retriedUnauthorized) {
        retriedUnauthorized = true;
        continue;
      }
      deps.log?.(`rc stream ${attachment.sessionId}: the client read stream refused the observed Authorization bearer past one retry; backing off`);
      await deps.sleep(deps.backoffMs);
      retriedUnauthorized = false;
    }
  };

  return {
    reconcile: () => {
      const live = new Set(deps.trackedSessions());
      for (const [sessionId, attachment] of attachments) {
        if (!live.has(sessionId)) {
          attachment.stop();
          attachments.delete(sessionId);
        }
      }
      for (const sessionId of live) {
        if (attachments.has(sessionId)) {
          continue;
        }
        if (deps.credentialOf(sessionId)?.authorization === undefined) {
          continue;
        }
        const attachment = birth(sessionId);
        attachments.set(sessionId, attachment);
        void runLoop(attachment).catch((error: unknown) => {
          deps.log?.(`rc stream ${sessionId}: the attachment loop ended unexpectedly (${error instanceof Error ? error.message : String(error)})`);
        });
      }
    },
    close: () => {
      for (const attachment of attachments.values()) {
        // Persisted before the stop, synchronously: this is the one boundary the hub itself owns outright, so it never depends on a dial's teardown racing the process's exit.
        persistCursor(attachment.sessionId);
        attachment.stop();
      }
      attachments.clear();
    },
  };
}
