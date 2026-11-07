import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { mountRouterClient } from "./apiTestMount";
import { RcSessionEventSchema, RcSessionEventsReadOutputSchema, createRcSessionEventLog, type RcSessionEvent } from "./rcEventLog";
import { createRcSessionEventsApiRouter, type RcSessionEventsApiRouter } from "./rcEventLogApi";
import { createSseParser, type SseParsedEvent } from "./rcStream";
import type { RouterClient } from "@orpc/server";

/** The token the mounted router accepts. */
const CONTROL_TOKEN = "unit-session-events-token";
/** A made-up door generation id of the production shape. */
const GENERATION = "00000000-0000-4000-8000-0000000000cc";
/** Two made-up session ids of the protocol's shape. */
const SESSION_A = "cse_00000000-0000-4000-8000-00000000000a";
const SESSION_B = "cse_00000000-0000-4000-8000-00000000000b";
/** A small retention bound, so a test can push a cursor out of the window in a few appends. */
const CAPACITY = 4;
/** How long an SSE read may wait for its frame. Loopback runs in milliseconds; the bound exists only so an overloaded machine fails visibly instead of hanging the suite. */
const WAIT_BUDGET_MS = 5_000;
/** How long a test waits for a subscription's request to land before appending, generous against a loopback hop's real sub-millisecond cost. */
const SETTLE_MS = 50;

/** Reads SSE frames off a response body until `count` data-bearing frames have arrived, then cancels the body. */
async function sseFrames(body: Readonly<ReadableStream<Uint8Array>>, count: number): Promise<readonly SseParsedEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const frames: SseParsedEvent[] = [];
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("the SSE read timed out within the test's wait budget"));
    }, WAIT_BUDGET_MS);
  });
  while (frames.length < count) {
    const { value, done } = await Promise.race([reader.read(), deadline]);
    if (done) {
      throw new Error("the SSE stream ended before the expected frames arrived");
    }
    frames.push(...parser.write(decoder.decode(value, { stream: true })));
  }
  await reader.cancel();
  return frames;
}

/** The session event one SSE `message` frame carries, validated through the published schema rather than cast. */
function eventOfFrame(frame: SseParsedEvent): RcSessionEvent {
  const parsed: unknown = JSON.parse(frame.data);
  return RcSessionEventSchema.parse(parsed);
}

describe("the session events surface of the typed API", () => {
  const log = createRcSessionEventLog({ generation: GENERATION, capacity: CAPACITY });
  let client: RouterClient<RcSessionEventsApiRouter>;
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const mounted = await mountRouterClient(createRcSessionEventsApiRouter({ expectedToken: CONTROL_TOKEN, sessionEvents: log }), CONTROL_TOKEN, CONTROL_TOKEN);
    client = mounted.client;
    url = mounted.url;
    close = mounted.close;
  });

  afterAll(async () => {
    await close();
  });

  it("pages the log through the typed client and over REST, and answers an expired cursor as an explicit expiry", async () => {
    const start = log.head();
    log.append({ kind: "session-appeared", session: SESSION_A, at: 1 });
    log.append({ kind: "session-appeared", session: SESSION_B, at: 2 });
    const page = await client.rcSessions.eventsPage({ since: start, limit: 1 });
    expect(page).toMatchObject({ status: "ok", events: [{ session: SESSION_A }], more: true });

    const answered = await fetch(`${url}/rest/rc/session-events/page`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_TOKEN}` }, body: JSON.stringify({ since: page.status === "ok" ? page.cursor : start }) });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    const rest = RcSessionEventsReadOutputSchema.parse(await answered.json());
    expect(rest).toMatchObject({ status: "ok", events: [{ session: SESSION_B }], more: false });

    const expired = await client.rcSessions.eventsPage({ since: "00000000-0000-4000-8000-0000000000dd.1" });
    expect(expired).toMatchObject({ status: "expired", head: log.head() });
  });

  it("streams over REST with each cursor as the SSE id, and resumes from Last-Event-ID ahead of the since query", async () => {
    const before = log.head();
    log.append({ kind: "worker-state", session: SESSION_A, state: "running", at: 3 });
    log.append({ kind: "worker-state", session: SESSION_A, state: "idle", previous: "running", at: 4 });
    const cursors = log.read({ since: before });
    if (cursors.status !== "ok") {
      throw new Error("expected the two appends to be readable");
    }
    const [first, second] = cursors.events;
    if (first === undefined || second === undefined) {
      throw new Error("expected two events");
    }
    // The header names the first event as seen, the stale query names an older point: the header wins, so only the second replays.
    const answered = await fetch(`${url}/rest/rc/session-events?since=${encodeURIComponent(before)}`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "last-event-id": first.cursor } });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    expect(answered.headers.get("content-type")).toContain("text/event-stream");
    if (answered.body === null) {
      throw new Error("expected a streaming body");
    }
    const [frame] = await sseFrames(answered.body, 1);
    if (frame === undefined) {
      throw new Error("expected one frame");
    }
    expect(frame.id).toBe(second.cursor);
    expect(eventOfFrame(frame)).toEqual(second);
  });

  it("follows live through the typed client and refuses an evicted cursor with GONE, naming the head", async () => {
    const leave = new AbortController();
    const stream = await client.rcSessions.events({}, { signal: leave.signal });
    const next = stream.next();
    // The follower starts at the head of the moment its request lands; the append waits for that.
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    log.append({ kind: "session-ended", session: SESSION_B, reason: "archived", at: 5 });
    const delivered = await next;
    expect(delivered.done).toBe(false);
    expect(delivered.value).toMatchObject({ kind: "session-ended", session: SESSION_B, reason: "archived" });
    leave.abort();

    // Five events are recorded and the newest four retained, so the oldest a resume can continue after is the first; the origin is past it.
    const evictedFrom = `${GENERATION}.0`;
    const refused = await (async () => {
      const iterator = await client.rcSessions.events({ since: evictedFrom });
      await iterator.next();
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: "GONE", data: { head: log.head() } });
    expect(refused instanceof Error ? refused.message : "").toContain("cursor expired, resync from status");
  });
});
