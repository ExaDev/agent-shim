import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_MS } from "../usage/pick";
import { createHeadroomDecision } from "./headroomDecision";

const START_MS = 1_000_000;
const WARM_READ_TOKENS = 5000;
const SECOND_MS = 1000;

describe("the per-session headroom decision", () => {
  it("takes the wanted routing for a session it has not seen", () => {
    const decision = createHeadroomDecision();
    expect(decision.decide("s", true, START_MS)).toBe(true);
    expect(createHeadroomDecision().decide("s", false, START_MS)).toBe(false);
  });

  it("keeps a session's routing while its cache is warm, whatever is wanted now", () => {
    const decision = createHeadroomDecision();
    expect(decision.decide("s", true, START_MS)).toBe(true);
    decision.observe({ sessionId: "s", endedAtMs: START_MS + SECOND_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    expect(decision.decide("s", false, START_MS + 2 * SECOND_MS)).toBe(true);
  });

  it("takes the wanted routing again once the cache lifetime has passed", () => {
    const decision = createHeadroomDecision();
    decision.decide("s", true, START_MS);
    decision.observe({ sessionId: "s", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    expect(decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS)).toBe(true);
    expect(decision.decide("s", false, START_MS + PROMPT_CACHE_TTL_MS + SECOND_MS)).toBe(false);
  });

  it("takes the wanted routing again when the last response read nothing from the cache", () => {
    const decision = createHeadroomDecision();
    decision.decide("s", true, START_MS);
    decision.observe({ sessionId: "s", endedAtMs: START_MS + SECOND_MS, cacheReadInputTokens: 0 });
    expect(decision.decide("s", false, START_MS + 2 * SECOND_MS)).toBe(false);
  });

  it("decides each session on its own", () => {
    const decision = createHeadroomDecision();
    decision.decide("a", true, START_MS);
    decision.observe({ sessionId: "a", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    expect(decision.decide("b", false, START_MS + SECOND_MS)).toBe(false);
    expect(decision.decide("a", false, START_MS + SECOND_MS)).toBe(true);
  });

  it("takes the wanted routing outright for a request with no session id", () => {
    const decision = createHeadroomDecision();
    expect(decision.decide(undefined, true, START_MS)).toBe(true);
    expect(decision.decide(undefined, false, START_MS)).toBe(false);
  });

  it("forgets a session whose last response is older than the cache lifetime once another response is observed", () => {
    const decision = createHeadroomDecision();
    decision.decide("old", true, START_MS);
    decision.observe({ sessionId: "old", endedAtMs: START_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    decision.decide("new", true, START_MS + 2 * PROMPT_CACHE_TTL_MS);
    decision.observe({ sessionId: "new", endedAtMs: START_MS + 2 * PROMPT_CACHE_TTL_MS, cacheReadInputTokens: WARM_READ_TOKENS });
    // A session still inside the lifetime would have kept true here; the forgotten one takes what is wanted.
    expect(decision.decide("old", false, START_MS + 2 * PROMPT_CACHE_TTL_MS + SECOND_MS)).toBe(false);
  });
});
