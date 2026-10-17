import { describe, expect, it } from "vitest";

import { selectMember, type EvaluatedCandidate, type SelectionCandidate } from "./engine";

const CAPABLE = { vision: true, tools: true, thinking: true };

/** A candidate over named fields, with the defaults a standing candidate carries. */
function candidate(overrides: Partial<SelectionCandidate> & { ref: string }): EvaluatedCandidate {
  return {
    candidate: {
      order: 0,
      available: true,
      remainingAllowance: undefined,
      hoursToReset: undefined,
      pressure: undefined,
      feasible: true,
      latencyMs: undefined,
      successRate: undefined,
      pricePerMTok: undefined,
      isCurrent: false,
      ...overrides,
    },
    capabilities: CAPABLE,
  };
}

/** Three members in list order: a the preference, b the fallback, c the spare. */
function trio(overrides: Record<string, Partial<SelectionCandidate>> = {}): EvaluatedCandidate[] {
  return [
    candidate({ ref: "a", order: 0, ...overrides.a }),
    candidate({ ref: "b", order: 1, ...overrides.b }),
    candidate({ ref: "c", order: 2, ...overrides.c }),
  ];
}

describe("ordered", () => {
  it("serves the first member with quota, and says so", () => {
    expect(selectMember("ordered", trio())).toMatchObject({ ref: "a" });
  });

  it("keeps the model the session is already on while it has quota, whatever the list prefers", () => {
    expect(selectMember("ordered", trio({ b: { isCurrent: true } }))).toMatchObject({ ref: "b" });
  });

  it("falls to the fallback with the most spendable allowance when the preference is spent", () => {
    const selection = selectMember("ordered", trio({ a: { available: false }, b: { pressure: 0.5 }, c: { pressure: 2 } }));
    expect(selection.ref).toBe("c");
  });

  it("treats an unknown allowance as worth less than any measured one", () => {
    expect(selectMember("ordered", trio({ a: { available: false }, b: {}, c: { pressure: 0.1 } })).ref).toBe("c");
  });

  it("serves from the member whose window lifts soonest when every one is spent", () => {
    const selection = selectMember("ordered", trio({ a: { available: false, hoursToReset: 8 }, b: { available: false, hoursToReset: 2 }, c: { available: false, hoursToReset: 5 } }));
    expect(selection.ref).toBe("b");
    expect(selection.reasons.join("\n")).toContain("lifts soonest");
  });
});

describe("the ranked modes", () => {
  it("most-allowance serves the member holding the most allowance, not the list's preference", () => {
    expect(selectMember("most-allowance", trio({ a: { remainingAllowance: 0.2 }, b: { remainingAllowance: 0.8 } })).ref).toBe("b");
  });

  it("soonest-reset serves the member whose allowance is the most use-it-or-lose-it", () => {
    expect(selectMember("soonest-reset", trio({ a: { hoursToReset: 20 }, b: { hoursToReset: 3 } })).ref).toBe("b");
  });

  it("lowest-latency serves the fastest observed, and an unobserved latency never wins", () => {
    expect(selectMember("lowest-latency", trio({ a: { latencyMs: 900 }, b: {}, c: { latencyMs: 300 } })).ref).toBe("c");
  });

  it("highest-success serves the most reliable observed", () => {
    expect(selectMember("highest-success", trio({ a: { successRate: 0.9 }, b: { successRate: 0.99 } })).ref).toBe("b");
  });

  it("cheapest serves the lowest blended price", () => {
    expect(selectMember("cheapest", trio({ a: { pricePerMTok: 5 }, b: { pricePerMTok: 1 } })).ref).toBe("b");
  });

  it("skips spent members and falls back to ordered's spent-handling when none is available", () => {
    const allSpent = trio({ a: { available: false }, b: { available: false, hoursToReset: 9 }, c: { available: false, hoursToReset: 1 } });
    expect(selectMember("most-allowance", allSpent).ref).toBe("c");
    expect(selectMember("cheapest", trio({ a: { available: false } }))).toMatchObject({ ref: "b" });
  });

  it("keeps the current member when it ties the best, and names the switch when it does not", () => {
    expect(selectMember("cheapest", trio({ a: { pricePerMTok: 1 }, b: { pricePerMTok: 1, isCurrent: true } })).ref).toBe("b");
    const switched = selectMember("cheapest", trio({ a: { pricePerMTok: 5, isCurrent: true }, b: { pricePerMTok: 1 } }));
    expect(switched.ref).toBe("b");
    expect(switched.reasons.join("\n")).toContain("re-sending the conversation");
  });
});

describe("spread", () => {
  it("walks the available members in list order, one turn at a time", () => {
    expect(selectMember("spread", trio(), { rotation: 0 }).ref).toBe("a");
    expect(selectMember("spread", trio(), { rotation: 1 }).ref).toBe("b");
    expect(selectMember("spread", trio(), { rotation: 2 }).ref).toBe("c");
    expect(selectMember("spread", trio(), { rotation: 3 }).ref).toBe("a");
  });

  it("skips spent members without counting their turns", () => {
    expect(selectMember("spread", trio({ b: { available: false } }), { rotation: 1 }).ref).toBe("c");
  });
});

describe("adaptive", () => {
  const needs = { hasImage: false, hasTools: false, thinking: false, contextTokens: 1000 };

  it("rules out a candidate the request's needs exclude, and serves the best of what stands", () => {
    const pool = [
      candidate({ ref: "a", order: 0 }),
      { candidate: { ...candidate({ ref: "blind", order: 1 }).candidate }, capabilities: { vision: false, tools: true, thinking: true } },
      candidate({ ref: "c", order: 2 }),
    ];
    const selection = selectMember("adaptive", pool, { needs: { ...needs, hasImage: true } });
    expect(selection.ref).toBe("a");
    expect(selection.reasons.join("\n")).toContain("blind does not accept images");
  });

  it("rules out a candidate projected to run dry and one that has been failing", () => {
    const selection = selectMember("adaptive", trio({ a: { feasible: false }, b: { successRate: 0.3 } }));
    expect(selection.ref).toBe("c");
    expect(selection.reasons.join("\n")).toContain("would run dry");
    expect(selection.reasons.join("\n")).toContain("has been failing");
  });

  it("keeps the current member while it stands, rather than re-sending the conversation", () => {
    const selection = selectMember("adaptive", trio({ b: { isCurrent: true, pressure: 0.1 }, a: { pressure: 2 } }));
    expect(selection.ref).toBe("b");
    expect(selection.reasons.join("\n")).toContain("already on");
  });

  it("moves off the current member only when the gain beats the cost of re-sending the conversation", () => {
    const pool = (): ReturnType<typeof trio> => trio({ b: { isCurrent: true, pressure: 1 }, a: { pressure: 1.5 } });
    // Half again the allowance to spend against a small conversation: the gain (0.5) beats the cost (0.01).
    const small = selectMember("adaptive", pool(), { needs: { ...needs, contextTokens: 10_000 } });
    expect(small.ref).toBe("a");
    expect(small.reasons.join("\n")).toContain("re-sending the conversation costs");
    // The same gain against a conversation that half fills the largest window: the cost (0.5) is not beaten.
    const large = selectMember("adaptive", pool(), { needs: { ...needs, contextTokens: 500_000 } });
    expect(large.ref).toBe("b");
    expect(large.reasons.join("\n")).toContain("does not beat");
  });

  it("stays on the current member when the request states no size or there is no pressure to compare", () => {
    expect(selectMember("adaptive", trio({ b: { isCurrent: true, pressure: 1 }, a: { pressure: 9 } })).ref).toBe("b");
    expect(selectMember("adaptive", trio({ b: { isCurrent: true }, a: { pressure: 9 } }), { needs }).ref).toBe("b");
  });

  it("falls back to ordered when nothing stands", () => {
    const selection = selectMember("adaptive", trio({ a: { feasible: false }, b: { feasible: false }, c: { feasible: false } }));
    expect(selection.ref).toBe("a");
    expect(selection.reasons.join("\n")).toContain("nothing stands");
  });
});
