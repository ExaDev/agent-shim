import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import { createRcEventFanout, createRcStreamHub, createSseParser, parseRcStreamEnvelope, type RcPresenceAnswer, type RcStreamAnswer, type RcStreamDial, type SseParsedEvent } from "./rcStream";

/** A made-up session id of the protocol's shape. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
/** Another session's id, so the fan-out's per-session filtering is asserted across two sessions rather than inferred from one. */
const OTHER_SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
/** The bearers the fakes present: the OAuth-kind prefix alone (the shortest string the prefix check still accepts). */
const CREATE_BEARER = "Bearer sk-ant-oat";
/** The request id a scripted control request carries, which a `control_response` must echo. */
const REQUEST_ID = "req_00000000-0000-4000-8000-00000000000a";
/** Where the fake clocks start, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
/** The tracker's own idle bound, the same production constant the door passes. */
const IDLE_MS = 45_000;
/** The sequence numbers the scripted stream events carry, one per assertion so each names its own number. */
const FIRST_SEQUENCE_NUM = 5;
const LATER_SEQUENCE_NUM = 6;
const EARLIER_SEQUENCE_NUM = 4;
const RESPONSE_SEQUENCE_NUM = 7;
const WRITE_HIGH_SEQUENCE_NUM = 9;
const WRITE_MID_SEQUENCE_NUM = 8;
const WRITE_LOW_SEQUENCE_NUM = 2;
const OTHER_SESSION_SEQUENCE_NUM = 7;
const HELD_SEQUENCE_NUM = 8;
const ATTACHED_SEQUENCE_NUM = 12;
/** The cursor a previous door generation persisted, which a fresh generation's first attach resumes from: higher than every write-path number so the assertions name the store's value, not a number the tracker could have produced itself. */
const PERSISTED_SEQUENCE_NUM = 21;
/** The first event the stream delivers after resuming from the persisted cursor, and a later one past it, so the save assertions name the final cursor rather than the first. */
const POST_RESUME_SEQUENCE_NUM = 23;
const STREAM_EVENT_LAST_SEQUENCE_NUM = 14;
/** The backoff the hub under test is configured with, so the sleep the tests resolve by hand is the documented one. */
const BACKOFF_MS = 45_000;
/** How many stream calls the 401 case ends having made: the refused pair, then the successful third after the backoff resolves. */
const STREAM_CALLS_AFTER_BACKOFF = 3;
/** How long a tick waits for the hub's detached loop to run its next steps: the scripted dial resolves immediately, so the loop's awaits are microtasks, and one macrotask turn covers any number of them plus the stream generator's own wake. */
const TICK_MS = 20;
/** The presence answer's stand-in refresh interval: the scripted dial answers the protocol's documented shape, and only the request's shape is asserted. */
const PRESENCE_REFRESH_SECONDS = 60;
/** The sequence numbers the receipt tests' events carry past the first attached one, each named so no assertion carries an offset literal. */
const SECOND_STREAM_EVENT_SEQUENCE_NUM = ATTACHED_SEQUENCE_NUM + 1;
const THIRD_STREAM_EVENT_SEQUENCE_NUM = SECOND_STREAM_EVENT_SEQUENCE_NUM + 1;
const FOURTH_STREAM_EVENT_SEQUENCE_NUM = THIRD_STREAM_EVENT_SEQUENCE_NUM + 1;

/** Receipt calls once one has landed after the failures: the two refused events, then the one that unlatched the log. */
const STREAM_RECEIPT_CALLS_UNLATCHED = 3;
/** Receipt failure log lines after the latch resets: the first failure, then the first failure after the landed receipt unlatched it. */
const LOGGED_RECEIPT_FAILURES_AFTER_RELATCH = 2;

/** One envelope of the protocol's documented shape, as the API host would serialise it into one SSE block. */
function sseBlock(envelope: Readonly<Record<string, unknown>>, sequenceNum: number): string {
  return `event: client_event\nid: ${String(sequenceNum)}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** One exchange driven through the tracker the way the door's adapters drive it: request facts, then the response head and end. */
function exchange(tracker: RcSessionTracker, request: Readonly<{ method: string; url: string; authorization?: string }>): { readonly respond: (status: number, body?: string) => void } {
  const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.authorization === undefined ? {} : { authorization: request.authorization } });
  return {
    respond: (status, body = "") => {
      observed?.onResponse(status, {});
      if (body !== "") {
        observed?.onBodyChunk(Buffer.from(body, "utf8"));
      }
      observed?.onEnd();
    },
  };
}

/** Births one tracked session carrying the OAuth-kind credential the client half needs, the way the CLI's create exchange would. */
function birthSession(tracker: RcSessionTracker): void {
  exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: CREATE_BEARER }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
}

/** A byte stream the test writes to and ends by choice: what a held-open SSE response looks like to the hub. */
function controlledStream(): { readonly chunks: AsyncIterable<Uint8Array>; readonly push: (text: string) => void; readonly end: () => void } {
  const queued: Uint8Array[] = [];
  // Held in an object so the generator's closure reads the field's declared type rather than a source-order narrowing of a bare `let`, which control-flow analysis would freeze at its initialiser inside the closure.
  const state: { finished: boolean; wake: () => void } = { finished: false, wake: () => undefined };
  const chunks = (async function* () {
    for (;;) {
      while (queued.length > 0) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
        }
      }
      if (state.finished) {
        return;
      }
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
    }
  })();
  return {
    chunks,
    push: (text) => {
      queued.push(Buffer.from(text, "utf8"));
      state.wake();
    },
    end: () => {
      state.finished = true;
      state.wake();
    },
  };
}

/** An empty byte stream: the shape a refused stream answer's chunks take (its real body is drained elsewhere). */
const NO_CHUNKS: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
    next: async () => await Promise.resolve({ done: true, value: undefined }),
  }),
};

/** One scripted dialling of the client read stream: what the presence, receipt and stream calls received, and what each call is answered with. */
interface ScriptedDial {
  readonly dial: RcStreamDial;
  readonly presenceCalls: { readonly sessionId: string; readonly headers: Readonly<Record<string, string>>; readonly clientId: string; readonly clear: boolean }[];
  readonly receiptCalls: { readonly sessionId: string; readonly headers: Readonly<Record<string, string>>; readonly eventId: string | undefined }[];
  readonly streamCalls: { readonly sessionId: string; readonly headers: Readonly<Record<string, string>>; readonly resume: { readonly fromSequenceNum: number } | undefined }[];
  /** Scripts the next stream answer: the default is a held-open 200 the test pushes to. */
  readonly answerNextStreamWith: (answer: RcStreamAnswer | (() => RcStreamAnswer)) => void;
  readonly answerNextPresenceWith: (answer: RcPresenceAnswer | (() => RcPresenceAnswer)) => void;
  /** Scripts the next receipt answer: the default is the 200 an accepted receipt earns. */
  readonly answerNextReceiptWith: (answer: RcPresenceAnswer | (() => RcPresenceAnswer)) => void;
}

/** A dial whose answers the test scripts, recording every call it receives. */
function scriptedDial(): ScriptedDial {
  const presenceCalls: { sessionId: string; headers: Record<string, string>; clientId: string; clear: boolean }[] = [];
  const receiptCalls: { sessionId: string; headers: Record<string, string>; eventId: string | undefined }[] = [];
  const streamCalls: { sessionId: string; headers: Record<string, string>; resume: { fromSequenceNum: number } | undefined }[] = [];
  const presenceAnswers: (RcPresenceAnswer | (() => RcPresenceAnswer))[] = [];
  const receiptAnswers: (RcPresenceAnswer | (() => RcPresenceAnswer))[] = [];
  const streamAnswers: (RcStreamAnswer | (() => RcStreamAnswer))[] = [];
  const settlePresence = (value: RcPresenceAnswer | (() => RcPresenceAnswer)): RcPresenceAnswer => (typeof value === "function" ? value() : value);
  const settleStream = (value: RcStreamAnswer | (() => RcStreamAnswer)): RcStreamAnswer => (typeof value === "function" ? value() : value);
  return {
    dial: {
      announcePresence: async (sessionId, headers, clientId, clear) => {
        presenceCalls.push({ sessionId, headers: { ...headers }, clientId, clear });
        return await Promise.resolve(settlePresence(presenceAnswers.shift() ?? { status: HTTP_STATUS.ok, body: JSON.stringify({ refresh_after_seconds: PRESENCE_REFRESH_SECONDS }) }));
      },
      markRead: async (sessionId, headers, eventId) => {
        receiptCalls.push({ sessionId, headers: { ...headers }, eventId });
        return await Promise.resolve(settlePresence(receiptAnswers.shift() ?? { status: HTTP_STATUS.ok, body: "{}" }));
      },
      openStream: async (sessionId, headers, resume) => {
        streamCalls.push({ sessionId, headers: { ...headers }, resume });
        return await Promise.resolve(settleStream(streamAnswers.shift() ?? { status: HTTP_STATUS.ok, chunks: controlledStream().chunks }));
      },
    },
    presenceCalls,
    receiptCalls,
    streamCalls,
    answerNextStreamWith: (answer) => {
      streamAnswers.push(answer);
    },
    answerNextPresenceWith: (answer) => {
      presenceAnswers.push(answer);
    },
    answerNextReceiptWith: (answer) => {
      receiptAnswers.push(answer);
    },
  };
}

/** The hub over a real tracker and a scripted dial, with a backoff sleep the test resolves by hand and an ordered log of every dial and sleep, so a test can prove what happened before what. The cursor ports are absent by default, so a test opts into exactly the persistence behaviour it asserts, and `logs` collects the hub's own log lines when a test asserts them. */
function hubOver(scripted: ScriptedDial, tracker: RcSessionTracker, ports: { readonly storedSequenceNumOf?: (sessionId: string) => number | undefined; readonly saveSequenceNum?: (sessionId: string, sequenceNum: number) => void; readonly logs?: string[] } = {}): { readonly subscribeFanout: ReturnType<typeof createRcEventFanout>; readonly hub: ReturnType<typeof createRcStreamHub>; readonly order: string[]; readonly resolveSleep: () => void } {
  const fanout = createRcEventFanout();
  const order: string[] = [];
  let resolveSleep: (() => void) | undefined;
  const hub = createRcStreamHub({
    now: () => Date.now(),
    credentialOf: tracker.credentialOf,
    trackedSessions: () => tracker.list().map((session) => session.id),
    fileStreamEvent: tracker.fileStreamEvent,
    sequenceNumOf: tracker.sequenceNumOf,
    ...ports,
    ...(ports.logs === undefined ? {} : { log: (line: string) => {
        ports.logs?.push(line);
      } }),
    dial: {
      announcePresence: async (sessionId, headers, clientId, clear) => {
        order.push(clear ? "presence-clear" : "presence");
        return await scripted.dial.announcePresence(sessionId, headers, clientId, clear);
      },
      markRead: async (sessionId, headers, eventId) => {
        order.push("receipt");
        return await scripted.dial.markRead(sessionId, headers, eventId);
      },
      openStream: async (sessionId, headers, resume, signal) => {
        order.push("stream");
        return await scripted.dial.openStream(sessionId, headers, resume, signal);
      },
    },
    fanout,
    newClientId: () => "door-client-id",
    backoffMs: BACKOFF_MS,
    sleep: async () => {
      order.push("sleep");
      await new Promise<void>((resolve) => {
        resolveSleep = () => {
          resolve();
        };
      });
    },
  });
  return { subscribeFanout: fanout, hub, order, resolveSleep: () => {
      resolveSleep?.();
    } };
}

/** Waits long enough for the hub's detached loop to have run its next steps. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, TICK_MS);
  });
}

describe("the SSE parser", () => {
  it("parses events split across arbitrary chunk boundaries, including a CRLF pair and a multi-byte code point split between chunks", () => {
    const parser = createSseParser();
    const whole = `event: client_event\nid: 7\ndata: {"a":" é "}\n\nevent: client_event\r\nid: 8\r\ndata: {"b":2}\r\n\r\n`;
    // One code point at a time is the harshest splitting there is: no field, no line ending, and no code point is guaranteed to survive inside one write.
    const events: SseParsedEvent[] = [];
    for (const character of whole) {
      for (const parsed of parser.write(character)) {
        events.push(parsed);
      }
    }
    expect(events).toEqual([
      { event: "client_event", id: "7", data: '{"a":" é "}' },
      { event: "client_event", id: "8", data: '{"b":2}' },
    ]);
  });

  it("completes nothing for keepalive comments, and the event after one arrives intact", () => {
    const parser = createSseParser();
    expect(parser.write(": keepalive\n\n")).toEqual([]);
    expect(parser.write(":")).toEqual([]);
    expect(parser.write(" another comment\n")).toEqual([]);
    expect(parser.write(`\nevent: client_event\nid: 9\ndata: {"ok":true}\n\n`)).toEqual([{ event: "client_event", id: "9", data: '{"ok":true}' }]);
  });

  it("carries the id line's number to the event it belongs to, persists an id-only block's number to the next dispatched event, and joins multi-line data with newlines", () => {
    const parser = createSseParser();
    // An id-only block dispatches nothing, but its id is the connection's last event id, so the next dispatched event carries it (the SSE framing's own rule, and what makes a sequence number survive a data-less block).
    expect(parser.write("id: 11\n\n")).toEqual([]);
    expect(parser.write('event: client_event\ndata: {"line":1}\ndata: {"line":2}\n\n')).toEqual([{ event: "client_event", id: "11", data: '{"line":1}\n{"line":2}' }]);
  });

  it("strips one byte-order mark at the stream's start and none afterwards", () => {
    const parser = createSseParser();
    expect([...parser.write("﻿event: client_event\ndata: {}\n\n")]).toEqual([{ event: "client_event", id: undefined, data: "{}" }]);
    // A mark that arrives mid-stream, after the first text, is field content like any other byte: it corrupts the field name it prefixes (so that block carries no event name) and is not stripped anywhere else.
    expect(parser.write("﻿event: client_event\ndata: {}\n\n")).toEqual([{ event: undefined, id: undefined, data: "{}" }]);
  });
});

describe("the client read stream envelope", () => {
  it("reads the documented envelope shape, carrying the fields the door relies on and forwarding the rest verbatim", () => {
    const envelope = parseRcStreamEnvelope({ event: "client_event", id: "41", data: JSON.stringify({ event_id: "ev-1", event_type: "control_request", sequence_num: 41, source: "worker", payload: { type: "control_request", request_id: REQUEST_ID }, created_at: "2026-10-05T12:00:00Z" }) });
    expect(envelope).toEqual({ event_id: "ev-1", event_type: "control_request", sequence_num: 41, source: "worker", payload: { type: "control_request", request_id: REQUEST_ID }, created_at: "2026-10-05T12:00:00Z" });
  });

  it("reads an envelope whose sequence number the host serialised as a JSON string, and refuses every event it cannot read", () => {
    expect(parseRcStreamEnvelope({ event: "client_event", id: undefined, data: JSON.stringify({ event_type: "user", sequence_num: "42", source: "worker" }) })).toEqual({ event_type: "user", sequence_num: 42, source: "worker" });
    // A block under any other event name is not a client event.
    expect(parseRcStreamEnvelope({ event: "presence", id: "1", data: "{}" })).toBeUndefined();
    // Data that is not one JSON object, or that misses a field the door relies on, or that types one wrongly.
    expect(parseRcStreamEnvelope({ event: "client_event", id: undefined, data: "not json" })).toBeUndefined();
    expect(parseRcStreamEnvelope({ event: "client_event", id: undefined, data: "[1,2]" })).toBeUndefined();
    expect(parseRcStreamEnvelope({ event: "client_event", id: undefined, data: JSON.stringify({ event_type: "user", source: "worker" }) })).toBeUndefined();
    expect(parseRcStreamEnvelope({ event: "client_event", id: undefined, data: JSON.stringify({ event_type: "user", sequence_num: 1.5, source: "worker" }) })).toBeUndefined();
  });
});

describe("the event fan-out", () => {
  it("delivers to two subscribers, and a detached one receives nothing further while the other keeps receiving", () => {
    const fanout = createRcEventFanout();
    const first: string[] = [];
    const second: string[] = [];
    const detachSecond = fanout.subscribe(SESSION_ID, (event) => {
      second.push(event.envelope.event_type);
    });
    fanout.subscribe(undefined, (event) => {
      first.push(event.envelope.event_type);
    });
    fanout.publish({ session: SESSION_ID, envelope: { event_type: "user", sequence_num: 1, source: "worker" } });
    detachSecond();
    fanout.publish({ session: SESSION_ID, envelope: { event_type: "result", sequence_num: 2, source: "worker" } });
    expect(first).toEqual(["user", "result"]);
    expect(second).toEqual(["user"]);
  });

  it("delivers a session's events only to that session's subscribers, and every session's to an every-session subscriber", () => {
    const fanout = createRcEventFanout();
    const mine: number[] = [];
    const all: number[] = [];
    fanout.subscribe(SESSION_ID, (event) => {
      mine.push(event.envelope.sequence_num);
    });
    fanout.subscribe(undefined, (event) => {
      all.push(event.envelope.sequence_num);
    });
    fanout.publish({ session: OTHER_SESSION_ID, envelope: { event_type: "user", sequence_num: OTHER_SESSION_SEQUENCE_NUM, source: "worker" } });
    fanout.publish({ session: SESSION_ID, envelope: { event_type: "user", sequence_num: HELD_SEQUENCE_NUM, source: "worker" } });
    expect(mine).toEqual([HELD_SEQUENCE_NUM]);
    expect(all).toEqual([OTHER_SESSION_SEQUENCE_NUM, HELD_SEQUENCE_NUM]);
  });
});

describe("the client read stream attachment", () => {
  it("files a stream control_request as a pending entry exactly as an observed worker-event body does, retires one a control_response answers, and advances the cursor", () => {
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: IDLE_MS });
    birthSession(tracker);
    tracker.fileStreamEvent(SESSION_ID, { event_type: "control_request", sequence_num: FIRST_SEQUENCE_NUM, source: "worker", payload: { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pnpm test" } } } });
    expect(tracker.pendingOf(SESSION_ID)).toEqual([{ sessionId: SESSION_ID, requestId: REQUEST_ID, type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: CLOCK_START_MS }]);
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(FIRST_SEQUENCE_NUM);
    // A control_request from any source but the worker is not a request the door can answer, so it births nothing.
    tracker.fileStreamEvent(SESSION_ID, { event_type: "control_request", sequence_num: LATER_SEQUENCE_NUM, source: "someone-else", payload: { type: "control_request", request_id: "req_other", request: { subtype: "can_use_tool", tool_name: "Bash" } } });
    expect(tracker.pendingOf(SESSION_ID).map((pending) => pending.requestId)).toEqual([REQUEST_ID]);
    // The cursor holds the highest number seen, not merely the latest.
    tracker.fileStreamEvent(SESSION_ID, { event_type: "user", sequence_num: EARLIER_SEQUENCE_NUM, source: "worker", payload: { type: "user" } });
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(LATER_SEQUENCE_NUM);
    // A control_response on the stream retires the request it answers, whoever answered it.
    tracker.fileStreamEvent(SESSION_ID, { event_type: "control_response", sequence_num: RESPONSE_SEQUENCE_NUM, source: "client-1", payload: { type: "control_response", response: { subtype: "success", request_id: REQUEST_ID, response: { behavior: "allow" } } } });
    expect(tracker.pendingOf(SESSION_ID)).toEqual([]);
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(RESPONSE_SEQUENCE_NUM);
    // The door's own confirmed writes advance the same cursor, and never lower it.
    tracker.noteSequenceNums(SESSION_ID, [WRITE_HIGH_SEQUENCE_NUM, WRITE_MID_SEQUENCE_NUM]);
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(WRITE_HIGH_SEQUENCE_NUM);
    tracker.noteSequenceNums(SESSION_ID, [WRITE_LOW_SEQUENCE_NUM]);
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(WRITE_HIGH_SEQUENCE_NUM);
  });

  it("attaches with presence over the observed credential, files and fans out the stream's events, and reconnects after a drop resuming from the cursor", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const first = controlledStream();
    const second = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: first.chunks });
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: second.chunks });
    const { subscribeFanout: fanout, hub } = hubOver(scripted, tracker);
    const received: number[] = [];
    fanout.subscribe(SESSION_ID, (event) => {
      received.push(event.envelope.sequence_num);
    });

    hub.reconcile();
    await tick();
    // The attachment announced one stable client id and opened one stream with the observed credential, and no resume: nothing has been seen yet.
    expect(scripted.presenceCalls).toEqual([{ sessionId: SESSION_ID, headers: { accept: "text/event-stream", authorization: CREATE_BEARER }, clientId: "door-client-id", clear: false }]);
    expect(scripted.streamCalls).toEqual([{ sessionId: SESSION_ID, headers: { accept: "text/event-stream", authorization: CREATE_BEARER }, resume: undefined }]);

    // Events on the held stream reach the subscriber and file with the tracker.
    first.push(sseBlock({ event_type: "control_request", sequence_num: ATTACHED_SEQUENCE_NUM, source: "worker", payload: { type: "control_request", request_id: REQUEST_ID, request: { subtype: "can_use_tool", tool_name: "Bash" } } }, ATTACHED_SEQUENCE_NUM));
    await tick();
    expect(received).toEqual([ATTACHED_SEQUENCE_NUM]);
    expect(tracker.pendingOf(SESSION_ID).map((pending) => pending.requestId)).toEqual([REQUEST_ID]);
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(ATTACHED_SEQUENCE_NUM);

    // A drop reconnects at once, resuming from the highest sequence number the door has seen.
    first.end();
    await tick();
    expect(scripted.streamCalls.length).toBe(2);
    expect(scripted.streamCalls[1]?.resume).toEqual({ fromSequenceNum: ATTACHED_SEQUENCE_NUM });
    hub.close();
  });

  it("resumes a fresh generation's first attach from the persisted cursor, and from the tracker's own cursor once one exists", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const first = controlledStream();
    const second = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: first.chunks });
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: second.chunks });
    const storedCalls: string[] = [];
    const saves: { readonly sessionId: string; readonly sequenceNum: number }[] = [];
    const { hub } = hubOver(scripted, tracker, {
      storedSequenceNumOf: (sessionId) => {
        storedCalls.push(sessionId);
        return PERSISTED_SEQUENCE_NUM;
      },
      saveSequenceNum: (sessionId, sequenceNum) => {
        saves.push({ sessionId, sequenceNum });
      },
    });

    hub.reconcile();
    await tick();
    // The tracker's memory holds no number (this generation started after the session's traffic), so the first attach names the persisted cursor: the fresh generation resumes where the last one left off instead of at the stream's head.
    expect(scripted.streamCalls[0]?.resume).toEqual({ fromSequenceNum: PERSISTED_SEQUENCE_NUM });
    expect(storedCalls).toEqual([SESSION_ID]);

    // One event past the persisted cursor arrives, then the stream drops: the boundary persists the final cursor, and the reconnect resumes from the tracker's own number without consulting the store again.
    first.push(sseBlock({ event_type: "user", sequence_num: POST_RESUME_SEQUENCE_NUM, source: "worker" }, POST_RESUME_SEQUENCE_NUM));
    await tick();
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(POST_RESUME_SEQUENCE_NUM);
    expect(saves).toEqual([]);
    first.end();
    await tick();
    expect(saves).toEqual([{ sessionId: SESSION_ID, sequenceNum: POST_RESUME_SEQUENCE_NUM }]);
    expect(scripted.streamCalls[1]?.resume).toEqual({ fromSequenceNum: POST_RESUME_SEQUENCE_NUM });
    expect(storedCalls).toEqual([SESSION_ID]);

    // Closing the hub is another boundary, but one that moved nothing: the unchanged cursor is not written a second time.
    hub.close();
    expect(saves).toEqual([{ sessionId: SESSION_ID, sequenceNum: POST_RESUME_SEQUENCE_NUM }]);
  });

  it("attaches from the stream's own head when no cursor is known, and never consults the store once the tracker's cursor is defined", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    // A door whose own confirmed write already advanced the cursor attaches from that number: the tracker's in-memory accessor is the primary source, and the store is not even read.
    tracker.noteSequenceNums(SESSION_ID, [WRITE_HIGH_SEQUENCE_NUM]);
    const scripted = scriptedDial();
    const storedCalls: string[] = [];
    const { hub } = hubOver(scripted, tracker, {
      storedSequenceNumOf: (sessionId) => {
        storedCalls.push(sessionId);
        return PERSISTED_SEQUENCE_NUM;
      },
    });

    hub.reconcile();
    await tick();
    expect(scripted.streamCalls[0]?.resume).toEqual({ fromSequenceNum: WRITE_HIGH_SEQUENCE_NUM });
    expect(storedCalls).toEqual([]);
    hub.close();

    // Without the fallback port at all, a tracker that holds no number attaches the way the door always did before the cursor was persisted: from the stream's own head. This is the discrimination check: the fallback is what turns this undefined into the persisted cursor.
    const freshTracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(freshTracker);
    const fallbackAbsent = scriptedDial();
    const { hub: hubWithoutFallback } = hubOver(fallbackAbsent, freshTracker);
    hubWithoutFallback.reconcile();
    await tick();
    expect(fallbackAbsent.streamCalls[0]?.resume).toBeUndefined();
    hubWithoutFallback.close();
  });

  it("saves the cursor once per attachment end with the final cursor, and never per stream event", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const held = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: held.chunks });
    const saves: { readonly sessionId: string; readonly sequenceNum: number }[] = [];
    const { hub } = hubOver(scripted, tracker, {
      saveSequenceNum: (sessionId, sequenceNum) => {
        saves.push({ sessionId, sequenceNum });
      },
    });

    hub.reconcile();
    await tick();
    // Three events cross the held stream and none of them writes the file: the native client persists at bridge-session boundaries, not per event, and so does the hub.
    for (const sequenceNum of [ATTACHED_SEQUENCE_NUM, SECOND_STREAM_EVENT_SEQUENCE_NUM, STREAM_EVENT_LAST_SEQUENCE_NUM]) {
      held.push(sseBlock({ event_type: "user", sequence_num: sequenceNum, source: "worker" }, sequenceNum));
    }
    await tick();
    expect(tracker.sequenceNumOf(SESSION_ID)).toBe(STREAM_EVENT_LAST_SEQUENCE_NUM);
    expect(saves).toEqual([]);

    // The attachment's end is the boundary: one save, carrying the final cursor.
    hub.close();
    expect(saves).toEqual([{ sessionId: SESSION_ID, sequenceNum: STREAM_EVENT_LAST_SEQUENCE_NUM }]);
    // The close is idempotent, which is what lets the supervisor's shutdown call it unconditionally: a second call finds no attachment and the memo still holds the final cursor, so nothing is written twice.
    hub.close();
    expect(saves).toEqual([{ sessionId: SESSION_ID, sequenceNum: STREAM_EVENT_LAST_SEQUENCE_NUM }]);
  });

  it("re-reads the credential and retries once on a 401, then backs off rather than hammering", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.unauthorized, chunks: NO_CHUNKS });
    scripted.answerNextStreamWith({ status: HTTP_STATUS.unauthorized, chunks: NO_CHUNKS });
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: controlledStream().chunks });
    const { hub, order, resolveSleep } = hubOver(scripted, tracker);

    hub.reconcile();
    await tick();
    // The first 401 retried at once, with the credential accessor re-read at the top of the attempt, and only the second 401 backed off: presence, stream, presence, stream, then sleep, in that order.
    expect(order).toEqual(["presence", "stream", "presence", "stream", "sleep"]);
    // The backoff holds: no third attempt until the sleep resolves.
    expect(scripted.streamCalls.length).toBe(2);

    resolveSleep();
    await tick();
    expect(scripted.streamCalls.length).toBe(STREAM_CALLS_AFTER_BACKOFF);
    expect(order).toEqual(["presence", "stream", "presence", "stream", "sleep", "presence", "stream"]);
    hub.close();
  });

  it("drops an attachment whose session the tracker has expired, and stops cleanly on close", async () => {
    let now = 0;
    const tracker = createRcSessionTracker({ now: () => now, idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const { hub } = hubOver(scripted, tracker);
    hub.reconcile();
    await tick();
    expect(scripted.streamCalls.length).toBe(1);

    now += IDLE_MS;
    hub.reconcile();
    expect(tracker.list()).toEqual([]);
    // The expiry dropped the attachment and close stops everything: no further dial happens.
    hub.close();
    await tick();
    expect(scripted.streamCalls.length).toBe(1);
  });

  it("sends one read receipt per chunk naming its last event id, and never receipts a receipt", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const first = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: first.chunks });
    const { hub } = hubOver(scripted, tracker);
    hub.reconcile();
    await tick();

    // One chunk carrying two events: one receipt, naming the chunk's last event id, filed after both.
    first.push(sseBlock({ event_type: "user", event_id: "event-a", sequence_num: ATTACHED_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, ATTACHED_SEQUENCE_NUM) + sseBlock({ event_type: "user", event_id: "event-b", sequence_num: SECOND_STREAM_EVENT_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, SECOND_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    expect(scripted.receiptCalls).toEqual([{ sessionId: SESSION_ID, headers: { accept: "text/event-stream", authorization: CREATE_BEARER }, eventId: "event-b" }]);

    // A chunk whose only event carries no event id owes no receipt, and a receipt event never becomes the next receipt's target.
    first.push(sseBlock({ event_type: "user", sequence_num: THIRD_STREAM_EVENT_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, THIRD_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    first.push(sseBlock({ event_type: "mark_read", event_id: "event-receipt", sequence_num: FOURTH_STREAM_EVENT_SEQUENCE_NUM, source: "client", payload: { type: "mark_read", event_id: "event-b" } }, FOURTH_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    expect(scripted.receiptCalls.length).toBe(1);
    hub.close();
  });

  it("logs one read-receipt failure per attachment, not one per event, and unlatches when a receipt lands", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const first = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: first.chunks });
    const logs: string[] = [];
    const { hub } = hubOver(scripted, tracker, { logs });
    hub.reconcile();
    await tick();

    scripted.answerNextReceiptWith(() => {
      throw new Error("receipt host refused");
    });
    first.push(sseBlock({ event_type: "user", event_id: "event-a", sequence_num: ATTACHED_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, ATTACHED_SEQUENCE_NUM));
    await tick();
    first.push(sseBlock({ event_type: "user", event_id: "event-b", sequence_num: SECOND_STREAM_EVENT_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, SECOND_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    expect(logs.filter((line) => line.includes("read receipt")).length).toBe(1);

    // A receipt that lands unlatches the log, so the next failure is news again.
    first.push(sseBlock({ event_type: "user", event_id: "event-c", sequence_num: THIRD_STREAM_EVENT_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, THIRD_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    expect(scripted.receiptCalls.length).toBe(STREAM_RECEIPT_CALLS_UNLATCHED);
    scripted.answerNextReceiptWith(() => {
      throw new Error("receipt host refused");
    });
    first.push(sseBlock({ event_type: "user", event_id: "event-d", sequence_num: FOURTH_STREAM_EVENT_SEQUENCE_NUM, source: "worker", payload: { type: "user" } }, FOURTH_STREAM_EVENT_SEQUENCE_NUM));
    await tick();
    expect(logs.filter((line) => line.includes("read receipt")).length).toBe(LOGGED_RECEIPT_FAILURES_AFTER_RELATCH);
    hub.close();
  });

  it("retires its presence with the clear semantics when it ends for good, and never on a drop that reconnects", async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: IDLE_MS });
    birthSession(tracker);
    const scripted = scriptedDial();
    const first = controlledStream();
    const second = controlledStream();
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: first.chunks });
    scripted.answerNextStreamWith({ status: HTTP_STATUS.ok, chunks: second.chunks });
    const { hub } = hubOver(scripted, tracker);
    hub.reconcile();
    await tick();

    // A drop reconnects: the client was never gone, so every further announcement is a pulse.
    first.end();
    await tick();
    expect(scripted.presenceCalls.every((call) => !call.clear)).toBe(true);

    // The hub's own close is an end for good: one clear, under the client id the attachment announced.
    hub.close();
    await tick();
    expect(scripted.presenceCalls[scripted.presenceCalls.length - 1]).toEqual({ sessionId: SESSION_ID, headers: { accept: "text/event-stream", authorization: CREATE_BEARER }, clientId: "door-client-id", clear: true });
    expect(scripted.presenceCalls.filter((call) => call.clear)).toHaveLength(1);
  });
});
