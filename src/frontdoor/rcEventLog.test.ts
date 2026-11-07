import { describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import {
  RC_SESSION_EVENT_LOG_CAPACITY,
  RC_SESSION_EVENT_MAX_BYTES,
  RC_SESSION_EVENT_SUMMARY_MAX_CHARS,
  RC_SESSION_EVENT_TOKEN_MAX_CHARS,
  RcSessionEventCursorExpiredError,
  RcSessionEventSchema,
  createRcSessionEventLog,
  followRcSessionEvents,
  type RcSessionEvent,
  type RcSessionEventLog,
  type RcSessionTransition,
} from "./rcEventLog";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import { RC_IDLE_EXPIRY_MS, RC_PENDING_DEADLINE_MS, RC_REQUEST_PARSE_CAP_BYTES, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";

/** A made-up door generation id of the production shape. */
const GENERATION = "00000000-0000-4000-8000-0000000000aa";
/** Another generation, as a restarted door would mint. */
const OTHER_GENERATION = "00000000-0000-4000-8000-0000000000bb";
/** Two made-up session ids of the protocol's shape. */
const SESSION_A = "cse_00000000-0000-4000-8000-00000000000a";
const SESSION_B = "cse_00000000-0000-4000-8000-00000000000b";
const SESSION_C = "cse_00000000-0000-4000-8000-00000000000c";
/** A small retention bound, so an eviction is reached in a few appends. */
const SMALL_CAPACITY = 3;
/** How many events the retention case appends, each from a distinct parse-cap-sized source: enough that a log pinning its sources would retain far more than the case's bound, yet few enough that the case allocates a bounded amount. */
const RETENTION_EVENTS = 64;
/** The fraction of the pinned cost the retention cases allow: far above what the stored fields occupy and far below the failure, so neither collector noise nor a pinned source can pass for the other. */
const RETENTION_BOUND_DIVISOR = 4;
/** The most the retention cases' heap may grow by: that fraction of what keeping one parse-cap-sized source alive per event would cost. */
const RETENTION_BOUND_BYTES = (RETENTION_EVENTS * RC_REQUEST_PARSE_CAP_BYTES) / RETENTION_BOUND_DIVISOR;
/** How much of the parse cap the worker event batch around a request's input takes: generous room for the JSON envelope, so the batch stays parsed. */
const BATCH_ENVELOPE_MARGIN_BYTES = 1_024;
/** A retention bound the tests never reach. */
const ROOMY_CAPACITY = 100;

/** A session-appeared transition for one session at one instant. */
function appeared(session: string, at: number): RcSessionTransition {
  return { kind: "session-appeared", session, at };
}

/** Collects the next `count` events a follower yields. */
async function take(iterator: Readonly<AsyncGenerator<RcSessionEvent, void>>, count: number): Promise<readonly RcSessionEvent[]> {
  const taken: RcSessionEvent[] = [];
  while (taken.length < count) {
    taken.push(await eventOf(iterator.next()));
  }
  return taken;
}

/** The event one pull resolved to: a follower never ends on its own, so a done result is a failure of the test's premise. */
async function eventOf(pull: Readonly<Promise<IteratorResult<RcSessionEvent, void>>>): Promise<RcSessionEvent> {
  const next = await pull;
  if (next.done === true) {
    throw new Error("the follower ended, which it never does on its own");
  }
  return next.value;
}

/** A log whose append listeners are counted, so a test can assert that a follower detached. */
function countedLog(): { readonly log: RcSessionEventLog; readonly attached: () => number } {
  const inner = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
  let count = 0;
  return {
    log: {
      ...inner,
      onAppend: (listener) => {
        count += 1;
        const detach = inner.onAppend(listener);
        return () => {
          count -= 1;
          detach();
        };
      },
    },
    attached: () => count,
  };
}

/** Settles every microtask the follower's wake chain queues, so a test can assert what a waiting follower has not yet yielded. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("the session event log", () => {
  it("holds every retained event's fields to their caps, so a log full of worst-case events stays within its memory budget", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: RC_SESSION_EVENT_LOG_CAPACITY });
    // Every observed value far past any cap: the tracker's own parse budget is what bounds a value before it reaches the log. The values are built once and shared, so this case measures the stored fields; whether a cut keeps its whole source alive is the next case's.
    const huge = (letter: string): string => letter.repeat(RC_REQUEST_PARSE_CAP_BYTES);
    const [session, requestId, type, summary, state, previous] = ["s", "r", "t", "x", "w", "p"].map(huge);
    if (session === undefined || requestId === undefined || type === undefined || summary === undefined || state === undefined || previous === undefined) {
      throw new Error("expected six values");
    }
    const overflow = 2;
    for (let at = 0; at < RC_SESSION_EVENT_LOG_CAPACITY + overflow; at += 1) {
      log.append({ kind: "pending-born", session, requestId, type, summary, at });
    }
    log.append({ kind: "worker-state", session, state, previous, at: 0 });
    const read = log.read({});
    if (read.status !== "ok") {
      throw new Error("expected the retained window to be readable");
    }
    expect(read.events).toHaveLength(RC_SESSION_EVENT_LOG_CAPACITY);
    /** The storage one event's values occupy, at the widest per-unit cost a string can have. */
    const sizeOf = (event: RcSessionEvent): number =>
      Object.values(event).reduce<number>((total, value) => total + (typeof value === "string" ? value.length * Uint16Array.BYTES_PER_ELEMENT : Float64Array.BYTES_PER_ELEMENT), 0);
    for (const event of read.events) {
      expect(sizeOf(event)).toBeLessThanOrEqual(RC_SESSION_EVENT_MAX_BYTES);
      expect(event.session.length).toBeLessThanOrEqual(RC_SESSION_EVENT_TOKEN_MAX_CHARS);
      expect(event.session.endsWith("...")).toBe(true);
    }
    const born = read.events.find((event) => event.kind === "pending-born");
    expect(born?.kind === "pending-born" ? born.summary.length : undefined).toBe(RC_SESSION_EVENT_SUMMARY_MAX_CHARS);
    const retained = read.events.reduce((total, event) => total + sizeOf(event), 0);
    expect(retained).toBeLessThanOrEqual(CONTROL_BODY_CAP_BYTES);
  });

  it("keeps no cut field's whole source alive, so retained memory follows the stored fields rather than the observed values", () => {
    // `gc` is exposed to every test worker by vitest.config.ts, so the measurement reads live memory rather than garbage the collector has not reached yet.
    const collect = globalThis.gc;
    if (collect === undefined) {
      throw new Error("this case needs the test workers started with --expose-gc (vitest.config.ts)");
    }
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: RETENTION_EVENTS });
    collect();
    const before = process.memoryUsage().heapUsed;
    for (let at = 0; at < RETENTION_EVENTS; at += 1) {
      // A distinct source per event, as every parsed request body is: a cut that pinned its source would retain one parse cap's worth of characters per field.
      const source = `${String(at)}:`.padEnd(RC_REQUEST_PARSE_CAP_BYTES, "x");
      log.append({ kind: "pending-born", session: source, requestId: source, type: source, summary: source, at });
    }
    collect();
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(RETENTION_BOUND_BYTES);
    expect(log.read({}).status).toBe("ok");
  });

  it("keeps no uncut field's source alive either, on the tracker's own production path", () => {
    const collect = globalThis.gc;
    if (collect === undefined) {
      throw new Error("this case needs the test workers started with --expose-gc (vitest.config.ts)");
    }
    // Room for every event the case makes (the appearance, then a birth and a retirement per request), so no birth the measurement depends on is evicted.
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: 1 + 2 * RETENTION_EVENTS });
    const tracker = createRcSessionTracker({ now: () => 0, idleMs: RC_IDLE_EXPIRY_MS, onTransition: log.append });
    try {
      // An input just inside the parse cap once the batch around it is serialised: the tracker's summary is the tool name and an excerpt of this input's whole JSON, short enough to need no cut, built over a slice of the parsed body.
      const inputChars = RC_REQUEST_PARSE_CAP_BYTES - BATCH_ENVELOPE_MARGIN_BYTES;
      collect();
      const before = process.memoryUsage().heapUsed;
      for (let at = 0; at < RETENTION_EVENTS; at += 1) {
        const body = JSON.stringify({ worker_epoch: 1, events: [{ payload: { type: "control_request", request_id: `req_${String(at)}`, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `${String(at)}:`.padEnd(inputChars, "x") } } } }] });
        const observed = tracker.observeExchange({ method: "POST", url: `/v1/code/sessions/${SESSION_A}/worker/events`, headers: { authorization: "Bearer sk-ant-REDACTED" } });
        observed?.onRequestChunk?.(Buffer.from(body, "utf8"));
        observed?.onRequestEnd?.();
        observed?.onResponse(HTTP_STATUS.ok, {});
        observed?.onEnd();
      }
      // The tracker's own pending list holds the same summaries; retiring them leaves the log as the only holder, which is what this case measures.
      for (let at = 0; at < RETENTION_EVENTS; at += 1) {
        tracker.completePending(SESSION_A, `req_${String(at)}`);
      }
      collect();
      const grown = process.memoryUsage().heapUsed - before;
      const read = log.read({});
      expect(read.status === "ok" ? read.events.filter((event) => event.kind === "pending-born").length : 0).toBe(RETENTION_EVENTS);
      expect(grown).toBeLessThan(RETENTION_BOUND_BYTES);
    } finally {
      tracker.close();
    }
  });

  it("refuses a generation id longer than a UUID", () => {
    expect(() => createRcSessionEventLog({ generation: `${GENERATION}0`, capacity: ROOMY_CAPACITY })).toThrow(/at most/);
  });

  it("stamps each transition with a cursor and a sequence that rises by one, in append order, across sessions", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    expect(log.head()).toBe(`${GENERATION}.0`);
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    log.append({ kind: "worker-state", session: SESSION_A, state: "running", at: 3 });
    const read = log.read({});
    expect(read).toEqual({
      status: "ok",
      events: [
        { kind: "session-appeared", session: SESSION_A, at: 1, cursor: `${GENERATION}.1`, sequence: 1 },
        { kind: "session-appeared", session: SESSION_B, at: 2, cursor: `${GENERATION}.2`, sequence: 2 },
        { kind: "worker-state", session: SESSION_A, state: "running", at: 3, cursor: `${GENERATION}.3`, sequence: 3 },
      ],
      cursor: `${GENERATION}.3`,
      more: false,
      head: `${GENERATION}.3`,
    });
    expect(log.head()).toBe(`${GENERATION}.3`);
    // Every recorded event satisfies the schema the typed API validates its output through.
    if (read.status === "ok") {
      for (const event of read.events) {
        expect(RcSessionEventSchema.parse(event)).toEqual(event);
      }
    }
  });

  it("resumes after a cursor with exactly the events after it, and with none when the cursor is the head", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    expect(log.read({ since: `${GENERATION}.1` })).toMatchObject({ status: "ok", events: [{ sequence: 2 }], cursor: `${GENERATION}.2` });
    expect(log.read({ since: log.head() })).toEqual({ status: "ok", events: [], cursor: `${GENERATION}.2`, more: false, head: `${GENERATION}.2` });
  });

  it("pages with a limit, naming the last returned event as the cursor and saying more remain", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    log.append({ kind: "worker-state", session: SESSION_B, state: "idle", at: 3 });
    const first = log.read({ limit: 2 });
    // A limited page names the head beyond its own cursor, so a reader knows how far the log runs without paging to the end.
    expect(first).toMatchObject({ status: "ok", cursor: `${GENERATION}.2`, more: true, head: `${GENERATION}.3` });
    const second = first.status === "ok" ? log.read({ since: first.cursor, limit: 2 }) : first;
    expect(second).toMatchObject({ status: "ok", events: [{ sequence: 3 }], cursor: `${GENERATION}.3`, more: false });
  });

  it("filters to one session while the cursor it answers still covers every session's events it passed", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    expect(log.read({ session: SESSION_A })).toMatchObject({ status: "ok", events: [{ session: SESSION_A }], cursor: `${GENERATION}.2`, head: `${GENERATION}.2` });
  });

  it("answers a cursor whose following events were evicted with an explicit expiry naming the head, and honours the oldest cursor still covered", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: SMALL_CAPACITY });
    for (let at = 1; at <= SMALL_CAPACITY + 2; at += 1) {
      log.append(appeared(SESSION_A, at));
    }
    // Events 3, 4 and 5 are retained: a resume after 2 is whole, a resume after 1 would silently miss event 2.
    expect(log.read({ since: `${GENERATION}.2` })).toMatchObject({ status: "ok", events: [{ sequence: 3 }, { sequence: 4 }, { sequence: 5 }] });
    const gone = log.read({ since: `${GENERATION}.1` });
    expect(gone).toMatchObject({ status: "expired", head: `${GENERATION}.5` });
    expect(gone.status === "expired" ? gone.message : "").toContain("cursor expired, resync from status");
    // Omitting the cursor reads the retained window from its oldest, which is never an expiry.
    expect(log.read({})).toMatchObject({ status: "ok", events: [{ sequence: 3 }, { sequence: 4 }, { sequence: 5 }] });
  });

  it("refuses a cursor from another door generation, one past the head and one of no cursor's shape, each as an expiry", () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    log.append(appeared(SESSION_A, 1));
    expect(log.read({ since: `${OTHER_GENERATION}.1` })).toMatchObject({ status: "expired", head: `${GENERATION}.1` });
    expect(log.read({ since: `${GENERATION}.2` })).toMatchObject({ status: "expired" });
    expect(log.read({ since: "not-a-cursor" })).toMatchObject({ status: "expired" });
  });

  it("refuses a generation id containing the cursor separator", () => {
    expect(() => createRcSessionEventLog({ generation: "a.b", capacity: ROOMY_CAPACITY })).toThrow(/must not contain/);
  });
});

describe("following the session event log", () => {
  it("yields only what happens after it starts when no cursor is named, waiting on the append rather than polling", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    log.append(appeared(SESSION_A, 1));
    const follower = followRcSessionEvents(log, {});
    const next = follower.next();
    await settle();
    log.append(appeared(SESSION_B, 2));
    expect((await eventOf(next))).toMatchObject({ session: SESSION_B, sequence: 2 });
    await follower.return();
  });

  it("replays the gap after a reconnect's cursor and then continues live, with nothing missed and nothing repeated", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    const first = followRcSessionEvents(log, {});
    const firstNext = first.next();
    await settle();
    log.append(appeared(SESSION_A, 1));
    const seen = await eventOf(firstNext);
    await first.return();
    // The subscriber is disconnected while two more transitions happen, then reconnects naming the last cursor it saw.
    log.append(appeared(SESSION_B, 2));
    log.append({ kind: "worker-state", session: SESSION_A, state: "running", at: 3 });
    const resumed = followRcSessionEvents(log, { since: seen.cursor });
    const replayed = await take(resumed, 2);
    expect(replayed.map((event) => event.cursor)).toEqual([`${GENERATION}.2`, `${GENERATION}.3`]);
    const live = resumed.next();
    await settle();
    log.append({ kind: "worker-state", session: SESSION_A, state: "idle", previous: "running", at: 4 });
    expect((await eventOf(live)).cursor).toBe(`${GENERATION}.4`);
    await resumed.return();
  });

  it("throws the expiry when a reconnect's cursor fell out of the retained window, carrying the head to resume after", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: SMALL_CAPACITY });
    for (let at = 1; at <= SMALL_CAPACITY + 1; at += 1) {
      log.append(appeared(SESSION_A, at));
    }
    const follower = followRcSessionEvents(log, { since: `${GENERATION}.0` });
    const failure = await follower.next().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RcSessionEventCursorExpiredError);
    expect(failure instanceof RcSessionEventCursorExpiredError ? failure.head : undefined).toBe(`${GENERATION}.${String(SMALL_CAPACITY + 1)}`);
  });

  it("throws the expiry when its own consumer falls further behind than the log retains, rather than skipping", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: SMALL_CAPACITY });
    const follower = followRcSessionEvents(log, {});
    const next = follower.next();
    await settle();
    log.append(appeared(SESSION_A, 1));
    expect((await eventOf(next)).sequence).toBe(1);
    // The consumer stops pulling while more than the window's worth of events is appended.
    for (let at = 2; at <= SMALL_CAPACITY + 2; at += 1) {
      log.append(appeared(SESSION_A, at));
    }
    await expect(follower.next()).rejects.toBeInstanceOf(RcSessionEventCursorExpiredError);
  });

  it("serves two concurrent followers the same events in the same order, each at its own pace", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    const fast = followRcSessionEvents(log, {});
    const slow = followRcSessionEvents(log, { since: log.head() });
    const fastFirst = fast.next();
    await settle();
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    const fastEvents = [(await eventOf(fastFirst)), ...(await take(fast, 1))];
    const slowEvents = await take(slow, 2);
    expect(fastEvents.map((event) => event.cursor)).toEqual([`${GENERATION}.1`, `${GENERATION}.2`]);
    expect(slowEvents).toEqual(fastEvents);
    await fast.return();
    await slow.return();
  });

  it("follows one session alone when named", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    const follower = followRcSessionEvents(log, { session: SESSION_B, since: log.head() });
    log.append(appeared(SESSION_A, 1));
    log.append(appeared(SESSION_B, 2));
    expect((await eventOf(follower.next()))).toMatchObject({ session: SESSION_B, sequence: 2 });
    await follower.return();
  });

  it("rejects with the signal's own reason when it aborts while waiting, detaching from the log", async () => {
    const { log, attached } = countedLog();
    const leave = new AbortController();
    const follower = followRcSessionEvents(log, {}, leave.signal);
    const next = follower.next();
    await settle();
    expect(attached()).toBe(1);
    const reason = new Error("the subscriber left");
    leave.abort(reason);
    await expect(next).rejects.toBe(reason);
    expect(attached()).toBe(0);
  });

  it("detaches from the log when its consumer returns", async () => {
    const { log, attached } = countedLog();
    const follower = followRcSessionEvents(log, {});
    const next = follower.next();
    await settle();
    log.append(appeared(SESSION_A, 1));
    await eventOf(next);
    expect(attached()).toBe(1);
    await follower.return();
    expect(attached()).toBe(0);
  });

  it("fixes its start when created, so an event appended before the first pull is delivered", async () => {
    const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
    const follower = followRcSessionEvents(log, {});
    log.append(appeared(SESSION_A, 1));
    expect((await eventOf(follower.next())).sequence).toBe(1);
    await follower.return();
  });

  it("returns once the log closes, waking a follower that waits", async () => {
    const { log, attached } = countedLog();
    const follower = followRcSessionEvents(log, {});
    const next = follower.next();
    await settle();
    log.close();
    expect(await next).toEqual({ value: undefined, done: true });
    expect(attached()).toBe(0);
    // A follower created after the close returns at once.
    expect(await followRcSessionEvents(log, {}).next()).toEqual({ value: undefined, done: true });
  });
});

/** Drives one exchange through the tracker the way the door's adapters drive it: request facts, the request body and its end, then the response. */
function exchange(tracker: RcSessionTracker, method: string, url: string, requestBody?: string, responseHeaders: Readonly<Record<string, string>> = {}, status: number = HTTP_STATUS.ok): void {
  const observed = tracker.observeExchange({ method, url, headers: { authorization: "Bearer sk-ant-REDACTED" } });
  if (requestBody !== undefined) {
    observed?.onRequestChunk?.(Buffer.from(requestBody, "utf8"));
    observed?.onRequestEnd?.();
  }
  observed?.onResponse(status, responseHeaders);
  observed?.onEnd();
}

/** One recorded event with its cursor, sequence and instant dropped, so a test asserts what happened and in which order without restating the stamps. */
function withoutStamps(event: RcSessionEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "cursor" && key !== "sequence" && key !== "at"));
}

/** A tracker feeding a log over a mutable fake clock. */
function trackedLog(): { readonly tracker: RcSessionTracker; readonly log: RcSessionEventLog; readonly advance: (ms: number) => void; readonly kinds: () => readonly unknown[] } {
  let now = 0;
  const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
  const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS, onTransition: log.append });
  return {
    tracker,
    log,
    advance: (ms) => {
      now += ms;
    },
    kinds: () => {
      const read = log.read({});
      return read.status === "ok" ? read.events.map((event) => withoutStamps(event)) : [];
    },
  };
}

describe("the tracker's transitions into the log", () => {
  const workerEvents = (...payloads: readonly unknown[]): string => JSON.stringify({ worker_epoch: 1, events: payloads.map((payload) => ({ payload })) });
  const canUseTool = { type: "control_request", request_id: "req_1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } };

  it("records a session appearing, its worker state changing (and not a re-registration of the same state), and a pending request's birth and answer", () => {
    const { tracker, kinds } = trackedLog();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/heartbeat`, "{}");
    exchange(tracker, "PUT", `/v1/code/sessions/${SESSION_A}/worker`, JSON.stringify({ worker_status: "running" }));
    exchange(tracker, "PUT", `/v1/code/sessions/${SESSION_A}/worker`, JSON.stringify({ worker_status: "running" }));
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
    // The same request seen again on the client read stream is the same pending request, born once.
    tracker.fileStreamEvent(SESSION_A, { event_type: "control_request", sequence_num: 1, source: "worker", payload: canUseTool });
    exchange(tracker, "PUT", `/v1/code/sessions/${SESSION_A}/worker`, JSON.stringify({ worker_status: "requires_action" }));
    tracker.completePending(SESSION_A, "req_1");
    tracker.completePending(SESSION_A, "req_1");
    expect(kinds()).toEqual([
      { kind: "session-appeared", session: SESSION_A },
      { kind: "worker-state", session: SESSION_A, state: "running" },
      { kind: "pending-born", session: SESSION_A, requestId: "req_1", type: "can_use_tool", summary: 'Bash {"command":"ls"}' },
      { kind: "worker-state", session: SESSION_A, state: "requires_action", previous: "running" },
      { kind: "pending-retired", session: SESSION_A, requestId: "req_1", reason: "answered" },
    ]);
  });

  it("never re-births a request the door answered between the worker's write and the stream's copy of it, until its deadline has passed", () => {
    const { tracker, advance, kinds } = trackedLog();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
    // A supervisor answers at once, before the client read stream has delivered its own copy of the request.
    tracker.completePending(SESSION_A, "req_1");
    tracker.fileStreamEvent(SESSION_A, { event_type: "control_request", sequence_num: 1, source: "worker", payload: canUseTool });
    expect(tracker.pendingOf(SESSION_A)).toEqual([]);
    expect(kinds().filter((event) => typeof event === "object" && event !== null && "kind" in event && event.kind === "pending-born")).toHaveLength(1);
    // Past one answer deadline the retirement is forgotten, so the record of it stays bounded.
    advance(RC_PENDING_DEADLINE_MS);
    tracker.pendingOf();
    tracker.fileStreamEvent(SESSION_A, { event_type: "control_request", sequence_num: 2, source: "worker", payload: canUseTool });
    expect(tracker.pendingOf(SESSION_A).map((request) => request.requestId)).toEqual(["req_1"]);
  });

  it("records a pending request retiring at its deadline", () => {
    const { tracker, advance, kinds } = trackedLog();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
    advance(RC_PENDING_DEADLINE_MS);
    tracker.pendingOf();
    expect(kinds().at(-1)).toEqual({ kind: "pending-retired", session: SESSION_A, requestId: "req_1", reason: "expired" });
  });

  it("records a session ending by idle expiry, by archive and by conflict, retiring its outstanding requests first", () => {
    const { tracker, advance, kinds } = trackedLog();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_B}/worker/heartbeat`, "{}");
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/archive`);
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_B}/worker/heartbeat`, "{}", { "x-ccr-conflict-reason": "superseded" });
    // A worker still calling after its session was archived is refused, and a refused call never brings the session back.
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/heartbeat`, "{}", {}, HTTP_STATUS.notFound);
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_C}/worker/heartbeat`, "{}");
    advance(RC_IDLE_EXPIRY_MS);
    tracker.list();
    expect(kinds()).toEqual([
      { kind: "session-appeared", session: SESSION_A },
      { kind: "pending-born", session: SESSION_A, requestId: "req_1", type: "can_use_tool", summary: 'Bash {"command":"ls"}' },
      { kind: "session-appeared", session: SESSION_B },
      { kind: "pending-retired", session: SESSION_A, requestId: "req_1", reason: "session-ended" },
      { kind: "session-ended", session: SESSION_A, reason: "archived" },
      { kind: "session-ended", session: SESSION_B, reason: "conflict" },
      { kind: "session-appeared", session: SESSION_C },
      { kind: "session-ended", session: SESSION_C, reason: "expired" },
    ]);
  });

  it("births a session only on an accepted call, and balances every appearance with one ending", () => {
    const { tracker, kinds } = trackedLog();
    // A refused call names no live session, whatever id it carries.
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/heartbeat`, "{}", {}, HTTP_STATUS.unauthorized);
    expect(tracker.list()).toEqual([]);
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
    // The create's answer arrives after the session's calls have already crossed: it refreshes the entry rather than replacing it, so the pending request stands and the session appears once.
    const create = tracker.observeExchange({ method: "POST", url: "/v1/code/sessions", headers: { authorization: "Bearer sk-ant-REDACTED" } });
    create?.onResponse(HTTP_STATUS.ok, {});
    create?.onBodyChunk(Buffer.from(JSON.stringify({ session: { id: SESSION_A } }), "utf8"));
    create?.onEnd();
    expect(tracker.pendingOf(SESSION_A).map((request) => request.requestId)).toEqual(["req_1"]);
    // A session the service accepts again after an archive is live again: it appears anew only after its ending.
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/archive`);
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/heartbeat`, "{}");
    expect(kinds()).toEqual([
      { kind: "session-appeared", session: SESSION_A },
      { kind: "pending-born", session: SESSION_A, requestId: "req_1", type: "can_use_tool", summary: 'Bash {"command":"ls"}' },
      { kind: "pending-retired", session: SESSION_A, requestId: "req_1", reason: "session-ended" },
      { kind: "session-ended", session: SESSION_A, reason: "archived" },
      { kind: "session-appeared", session: SESSION_A },
    ]);
  });

  it("emits a deadline expiry from the sweep timer alone, with no read to prompt it, and ends followers when the tracker closes", async () => {
    vi.useFakeTimers();
    try {
      const log = createRcSessionEventLog({ generation: GENERATION, capacity: ROOMY_CAPACITY });
      const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS, onTransition: log.append, onClose: log.close });
      exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/events`, workerEvents(canUseTool));
      const follower = followRcSessionEvents(log, {});
      // The sweep runs at the shorter of its two deadlines, so one answer deadline past the birth, plus one sweep period, the timer alone has retired the request.
      await vi.advanceTimersByTimeAsync(RC_PENDING_DEADLINE_MS + Math.min(RC_IDLE_EXPIRY_MS, RC_PENDING_DEADLINE_MS));
      expect(await eventOf(follower.next())).toMatchObject({ kind: "pending-retired", session: SESSION_A, requestId: "req_1", reason: "expired" });
      tracker.close();
      expect(await follower.next()).toEqual({ value: undefined, done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a session ending to a live follower", async () => {
    const { tracker, log } = trackedLog();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/worker/heartbeat`, "{}");
    const follower = followRcSessionEvents(log, {});
    const next = follower.next();
    await settle();
    exchange(tracker, "POST", `/v1/code/sessions/${SESSION_A}/archive`);
    expect((await eventOf(next))).toMatchObject({ kind: "session-ended", session: SESSION_A, reason: "archived" });
    await follower.return();
  });
});
