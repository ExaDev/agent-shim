import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { mountRouterClient } from "./apiTestMount";
import { DOOR_EVENT_BUFFER_EVENTS } from "./eventHub";
import { RcSessionEventSchema, RcSessionEventsReadOutputSchema, createRcSessionEventLog, type RcSessionEvent, type RcSessionEventLog } from "./rcEventLog";
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

/** One case's own mount: a fresh log behind the router, so no case depends on what another appended. */
async function mountedLog(capacity: number = CAPACITY): Promise<{ readonly log: RcSessionEventLog; readonly client: RouterClient<RcSessionEventsApiRouter>; readonly url: string; readonly close: () => Promise<void> }> {
  const log = createRcSessionEventLog({ generation: GENERATION, capacity });
  const mounted = await mountRouterClient(createRcSessionEventsApiRouter({ expectedToken: CONTROL_TOKEN, sessionEvents: log }), CONTROL_TOKEN, CONTROL_TOKEN);
  return { log, ...mounted };
}

describe("the session events surface of the typed API", () => {
  it("pages the log through the typed client and over REST, and answers an expired cursor as an explicit expiry", async () => {
    const { log, client, url, close } = await mountedLog();
    try {
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
    } finally {
      await close();
    }
  });

  it("pages a caller that names no limit at the default, and refuses a limit past one consumer buffer", async () => {
    // The suite's own log retains only a small window, so the default is exercised against a log roomy enough to hold more than one default page.
    const roomy = createRcSessionEventLog({ generation: GENERATION, capacity: DOOR_EVENT_BUFFER_EVENTS + 1 });
    for (let at = 0; at < DOOR_EVENT_BUFFER_EVENTS + 1; at += 1) {
      roomy.append({ kind: "session-appeared", session: SESSION_A, at });
    }
    const mounted = await mountRouterClient(createRcSessionEventsApiRouter({ expectedToken: CONTROL_TOKEN, sessionEvents: roomy }), CONTROL_TOKEN, CONTROL_TOKEN);
    try {
      const page = await mounted.client.rcSessions.eventsPage({});
      expect(page.status === "ok" ? page.events.length : undefined).toBe(DOOR_EVENT_BUFFER_EVENTS);
      expect(page).toMatchObject({ status: "ok", more: true });
      expect(await mounted.client.rcSessions.eventsPage({ limit: DOOR_EVENT_BUFFER_EVENTS })).toMatchObject({ status: "ok", more: true });
      await expect(mounted.client.rcSessions.eventsPage({ limit: DOOR_EVENT_BUFFER_EVENTS + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      await mounted.close();
    }
  });

  it("streams over REST with each cursor as the SSE id, and resumes from Last-Event-ID ahead of the since query", async () => {
    const { log, url, close } = await mountedLog();
    try {
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
    } finally {
      await close();
    }
  });

  it("ends an open SSE response when the log closes, so a retiring door's drain is not held open by a subscriber", async () => {
    const closing = createRcSessionEventLog({ generation: GENERATION, capacity: CAPACITY });
    const mounted = await mountRouterClient(createRcSessionEventsApiRouter({ expectedToken: CONTROL_TOKEN, sessionEvents: closing }), CONTROL_TOKEN, CONTROL_TOKEN);
    try {
      const answered = await fetch(`${mounted.url}/rest/rc/session-events`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
      if (answered.body === null) {
        throw new Error("expected a streaming body");
      }
      const reader = answered.body.getReader();
      const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("the SSE response did not end within the test's wait budget"));
        }, WAIT_BUDGET_MS);
      });
      closing.close();
      for (;;) {
        const { done } = await Promise.race([reader.read(), deadline]);
        if (done) {
          break;
        }
      }
    } finally {
      await mounted.close();
    }
  });

  it("follows live through the typed client and refuses an evicted cursor with GONE, naming the head", async () => {
    const { log, client, close } = await mountedLog();
    try {
      const leave = new AbortController();
      const stream = await client.rcSessions.events({}, { signal: leave.signal });
      // The follower's start was fixed when the request was handled, so an append before the first pull is still delivered.
      log.append({ kind: "session-ended", session: SESSION_B, reason: "archived", at: 5 });
      const delivered = await stream.next();
      expect(delivered.done).toBe(false);
      expect(delivered.value).toMatchObject({ kind: "session-ended", session: SESSION_B, reason: "archived" });
      leave.abort();

      // This case's own log is filled past its window, so the event after the origin is evicted and a resume from the origin cannot be honoured.
      for (let at = 0; at < CAPACITY; at += 1) {
        log.append({ kind: "session-appeared", session: SESSION_A, at });
      }
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
    } finally {
      await close();
    }
  });
});
