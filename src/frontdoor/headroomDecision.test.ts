import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_MS } from "../usage/pick";
import { NO_ROUTING_SETTING, type RoutingSetting } from "../headroom/routingSetting";
import { createHeadroomDecision } from "./headroomDecision";

const START_MS = 1_000_000;
const WARM_READ_TOKENS = 5000;
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
    decision.observe({ sessionId: "s", endedAtMs: START_MS + SECOND_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(true);
  });

  it("takes the wanted routing again once the cache lifetime has passed", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    expect(await decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS, up)).toBe(true);
    expect(await decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS + SECOND_MS, up)).toBe(false);
  });

  it("takes the wanted routing again when the last response read nothing from the cache", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("s", true, START_MS, up);
    decision.observe({ sessionId: "s", endedAtMs: START_MS + SECOND_MS, cacheReadInputTokens: 0 });
    expect(await decision.decide("s", false, START_MS + 2 * SECOND_MS, up)).toBe(false);
  });

  it("decides each session on its own", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    await decision.decide("a", true, START_MS, up);
    decision.observe({ sessionId: "a", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
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
    decision.observe({ sessionId: "old", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    await decision.decide("new", true, START_MS + 2 * PROMPT_CACHE_TTL_MS, up);
    decision.observe({ sessionId: "new", endedAtMs: START_MS + 2 * PROMPT_CACHE_TTL_MS, cacheReadInputTokens: WARM_READ_TOKENS });
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
    decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: 0 });
    expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(true);
  });

  it("keeps a warm session on headroom through an unavailable daemon, so its request is replayed, not sent uncompressed", async () => {
    const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
    expect(await decision.decide("s", true, START_MS, up)).toBe(true);
    decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
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
      decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
      setting = { schemaVersion: 1, global: { viaHeadroom: false }, sessions: {} };
      expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(true);
      expect(await decision.decide("s", true, START_MS + PROMPT_CACHE_TTL_MS + SECOND_MS, up)).toBe(false);
    });

    it("applies a setting made with --now to the next request, once, and then waits for a boundary again", async () => {
      let setting: RoutingSetting = NO_ROUTING_SETTING;
      const decision = createHeadroomDecision(() => setting);
      expect(await decision.decide("s", true, START_MS, up)).toBe(true);
      decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: false, force: 7 } } };
      expect(await decision.decide("s", true, START_MS + SECOND_MS, up)).toBe(false);
      decision.observe({ sessionId: "s", endedAtMs: START_MS + SECOND_MS, cacheReadInputTokens: WARM_READ_TOKENS });
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: true, force: 7 } } };
      expect(await decision.decide("s", true, START_MS + 2 * SECOND_MS, up)).toBe(false);
      setting = { schemaVersion: 1, sessions: { s: { viaHeadroom: true, force: 8 } } };
      expect(await decision.decide("s", true, START_MS + 2 * SECOND_MS + SECOND_MS, up)).toBe(true);
    });
  });
});
