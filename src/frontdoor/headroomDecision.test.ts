import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_MS } from "../usage/pick";
import { NO_ROUTING_SETTING, type RoutingSetting } from "../headroom/routingSetting";
import { createHeadroomDecision } from "./headroomDecision";
import type { Lineage } from "./lineage";

const START_MS = 1_000_000;
const WARM_READ_TOKENS = 5000;
const FRESH_TOKENS = 100;
/** A response whose cache carried almost all of the context. */
const warmCache = { readTokens: WARM_READ_TOKENS, writtenTokens: FRESH_TOKENS, uncachedTokens: 1 };
/** A response that read nothing from the cache: everything was written new. */
const coldCache = { readTokens: 0, writtenTokens: WARM_READ_TOKENS, uncachedTokens: 1 };
const SECOND_MS = 1000;

const up = async (): Promise<boolean> => await Promise.resolve(true);
const down = async (): Promise<boolean> => await Promise.resolve(false);

describe("the per-session headroom decision", () => {
  it("takes the wanted routing for a session it has not seen", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, up)).toBe(true);
    expect(await createHeadroomDecision(() => NO_ROUTING_SETTING).decide("s", false, START_MS, up)).toBe(false);
  });

  it("keeps a session's routing while its cache is warm, whatever is wanted now", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, up)).toBe(true);
    decision.observe({ sessionId: "s", startedAtMs: START_MS + SECOND_MS, endedAtMs: START_MS + SECOND_MS, viaHeadroom: true, cache: warmCache });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(true);
  });

  it("takes the wanted routing again once the cache lifetime has passed", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
    expect(await decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS, up)).toBe(true);
    expect(await decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS + SECOND_MS, up)).toBe(false);
  });

  it("takes the wanted routing again when the last response read nothing from the cache", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", startedAtMs: START_MS + SECOND_MS, endedAtMs: START_MS + SECOND_MS, viaHeadroom: true, cache: coldCache });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(false);
  });

  it("takes the wanted routing again when the cache carried no more of the context than was written afresh", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", startedAtMs: START_MS + SECOND_MS, endedAtMs: START_MS + SECOND_MS, viaHeadroom: true, cache: { readTokens: FRESH_TOKENS, writtenTokens: FRESH_TOKENS, uncachedTokens: 0 } });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(false);
  });

  it("keeps the routing while the cache carried more of the context than was written afresh", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", startedAtMs: START_MS + SECOND_MS, endedAtMs: START_MS + SECOND_MS, viaHeadroom: true, cache: { readTokens: FRESH_TOKENS + 1, writtenTokens: FRESH_TOKENS, uncachedTokens: 0 } });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(true);
  });

  it("decides each session on its own", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("a", true, START_MS, up);
    decision.observe({ sessionId: "a", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
    expect(await decision.decide("b", false, START_MS + SECOND_MS, up)).toBe(false);
    expect(await decision.decide("a", false, START_MS + SECOND_MS, up)).toBe(true);
  });

  it("takes the wanted routing outright for a request with no session id", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide(undefined, true, START_MS, up)).toBe(true);
    expect(await decision.decide(undefined, false, START_MS, up)).toBe(false);
  });

  it("forgets a session whose last response is older than the cache lifetime once another response is observed", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("old", true, START_MS, up);
    decision.observe({ sessionId: "old", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
    await decision.decide("new", true, START_MS + 2 * PROMPT_CACHE_TTL_MS, up);
    decision.observe({ sessionId: "new", startedAtMs: START_MS + 2 * PROMPT_CACHE_TTL_MS, endedAtMs: START_MS + 2 * PROMPT_CACHE_TTL_MS, viaHeadroom: true, cache: warmCache });
    // A session still inside the lifetime would have kept true here; the forgotten one takes what is wanted.
    expect(await decision.decide("old", false, START_MS + 2 * PROMPT_CACHE_TTL_MS + SECOND_MS, up)).toBe(false);
  });

  it("sends a session with no earlier response direct when it wants headroom and the daemon is unavailable", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, down)).toBe(false);
  });

  it("lets a session that went direct rejoin headroom at its next boundary once the daemon is available", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, down)).toBe(false);
    decision.observe({ sessionId: "s", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: coldCache });
    expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(true);
  });

  it("keeps a warm session on headroom through an unavailable daemon, so its request is replayed, not sent uncompressed", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, up)).toBe(true);
    decision.observe({ sessionId: "s", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
    expect(await decision.decide("s", true, START_MS + SECOND_MS, down)).toBe(true);
  });

  it("does not ask whether the daemon is available when headroom is not wanted", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    let asked = 0;
    const counted = async (): Promise<boolean> => {
      asked += 1;
      return await Promise.resolve(true);
    };
    expect(await decision.decide("s", false, START_MS, counted)).toBe(false);
    expect(asked).toBe(0);
  });

  describe("with a live routing setting", () => {
    const withSetting = (setting: RoutingSetting) => createHeadroomDecision(() => setting);

    it("takes a session's own setting over the global one and the launch flag", async () => {
      const decision = withSetting({ schemaVersion: 1, global: { viaHeadroom: false }, sessions: { s: { viaHeadroom: true } } });
      expect(await decision.decide("s", false, START_MS, up)).toBe(true);
      expect(await decision.decide("other", true, START_MS, up)).toBe(false);
    });

    it("takes the global setting for a session with none of its own, and the launch flag when there is neither", async () => {
      expect(await withSetting({ schemaVersion: 1, global: { viaHeadroom: true }, sessions: {} }).decide("s", false, START_MS, up)).toBe(true);
      expect(await withSetting(NO_ROUTING_SETTING).decide("s", true, START_MS, up)).toBe(true);
    });

    it("applies a changed setting at the next boundary, not mid-cache", async () => {
      let setting: RoutingSetting = NO_ROUTING_SETTING;
      const decision = createHeadroomDecision(() => setting);
      expect(await decision.decide("s", true, START_MS, up)).toBe(true);
      decision.observe({ sessionId: "s", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
      setting = { schemaVersion: 1, global: { viaHeadroom: false }, sessions: {} };
      expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(true);
      expect(await decision.decide("s", true, START_MS + PROMPT_CACHE_TTL_MS + SECOND_MS, up)).toBe(false);
    });

    it("applies a setting made with --now to the next request, once, and then waits for a boundary again", async () => {
      let setting: RoutingSetting = NO_ROUTING_SETTING;
      const decision = createHeadroomDecision(() => setting);
      expect(await decision.decide("s", true, START_MS, up)).toBe(true);
      decision.observe({ sessionId: "s", startedAtMs: START_MS, endedAtMs: START_MS, viaHeadroom: true, cache: warmCache });
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: false, force: 7 } } };
      expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(false);
      decision.observe({ sessionId: "s", startedAtMs: START_MS + SECOND_MS, endedAtMs: START_MS + SECOND_MS, viaHeadroom: true, cache: warmCache });
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: true, force: 7 } } };
      expect(await decision.decide("s", true, START_MS + 2 * SECOND_MS, up)).toBe(false);
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: true, force: 8 } } };
      expect(await decision.decide("s", true, START_MS + 2 * SECOND_MS + SECOND_MS, up)).toBe(true);
    });
  });

  describe("a session whose prefix headroom keeps changing", () => {
    const THREAD_KEYS = ["k0", "k1", "k2", "k3", "k4", "k5"] as const;
    const CACHED = 5000;
    /** A response that wrote `CACHED` tokens and read nothing: the first of a thread. */
    const wrote = { readTokens: 0, writtenTokens: CACHED, uncachedTokens: 0 };
    /** A response that read back the whole of what the thread's previous response left cached, plus a little. */
    const hit = { readTokens: CACHED + FRESH_TOKENS, writtenTokens: FRESH_TOKENS, uncachedTokens: 0 };
    /** A response that read back almost none of it: the prefix was not found. */
    const missed = { readTokens: FRESH_TOKENS, writtenTokens: CACHED, uncachedTokens: 0 };

    /** Runs one request of a thread through the decision and its response back, a second after the last, returning whether it went through headroom. */
    async function turn(decision: ReturnType<typeof createHeadroomDecision>, index: number, lineage: Lineage, cache: { readonly readTokens: number; readonly writtenTokens: number; readonly uncachedTokens: number }, viaHeadroom = true): Promise<boolean> {
      const startedAtMs = START_MS + index * SECOND_MS;
      const via = await decision.decide("s", true, startedAtMs, up, { receivedAtMs: startedAtMs, lineage });
      decision.observe({ sessionId: "s", startedAtMs, endedAtMs: startedAtMs + SECOND_MS / 2, viaHeadroom, cache });
      return via;
    }
    const link = (index: number): Lineage => ({ ownKey: THREAD_KEYS[index] ?? "", parentKey: index === 0 ? undefined : THREAD_KEYS[index - 1] });
    /** Turns are numbered from zero, so the fourth is index three. */
    const FOURTH_TURN = 3;

    it("is taken off headroom at its next boundary after two responses in a row missed what their own thread left cached", async () => {
      const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
      expect(await turn(decision, 0, link(0), wrote)).toBe(true);
      expect(await turn(decision, 1, link(1), missed)).toBe(true);
      expect(await turn(decision, 2, link(2), missed)).toBe(true);
      expect(await turn(decision, FOURTH_TURN, link(FOURTH_TURN), missed)).toBe(false);
    });

    it("keeps a session whose thread keeps reading back what it wrote", async () => {
      const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
      await turn(decision, 0, link(0), wrote);
      await turn(decision, 1, link(1), hit);
      await turn(decision, 2, link(2), hit);
      expect(await turn(decision, FOURTH_TURN, link(FOURTH_TURN), hit)).toBe(true);
    });

    it("does not blame headroom for a subagent's or fork's responses, which are matched with their own thread and not the session's last write", async () => {
      const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
      await turn(decision, 0, link(0), wrote);
      // A subagent answers under the same session id with a lineage of its own that has no predecessor: its low read is not a miss, however often it happens.
      await turn(decision, 1, { ownKey: "sub-a", parentKey: undefined }, missed);
      await turn(decision, 2, { ownKey: "sub-b", parentKey: undefined }, missed);
      await turn(decision, FOURTH_TURN, { ownKey: "sub-c", parentKey: undefined }, missed);
      const fifth = FOURTH_TURN + 1;
      expect(await turn(decision, fifth, link(1), hit)).toBe(true);
    });

    it("does not count a response that arrives after the shortest cache lifetime, or one that did not go through headroom", async () => {
      const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
      await turn(decision, 0, link(0), wrote);
      await turn(decision, 1, link(1), missed, false);
      await turn(decision, 2, link(2), missed, false);
      expect(await turn(decision, FOURTH_TURN, link(FOURTH_TURN), missed, false)).toBe(true);
    });
  });
});
