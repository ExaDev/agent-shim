import { describe, expect, it } from "vitest";

import { candidateOf } from "./candidates";

describe("candidateOf", () => {
  it("counts a member with no recorded windows as available with every ranked signal absent", () => {
    expect(candidateOf("z/glm-5.3", 0, {}, false)).toEqual({ ref: "z/glm-5.3", order: 0, available: true, feasible: true, isCurrent: false });
  });

  it("reads the binding window: the smallest remaining allowance and the soonest reset", () => {
    const candidate = candidateOf("z/glm-5.3", 1, { quota: { fiveHour: { remaining: 0.5, hoursUntilReset: 1 }, sevenDay: { remaining: 0.2, hoursUntilReset: 40 } } }, true);
    expect(candidate).toMatchObject({ available: true, remainingAllowance: 0.2, hoursToReset: 1, isCurrent: true });
  });

  it("marks a member whose every recorded window is spent unavailable", () => {
    expect(candidateOf("z/1", 0, { quota: { sevenDay: { remaining: 0, hoursUntilReset: 12 } } }, false)).toMatchObject({ available: false, feasible: false });
  });

  it("computes the pressure of a steady burn against the share of the period left", () => {
    // Half the allowance left with 80% of the five-hour period gone: a steady burn would leave far more than half unspent, so the pressure is high.
    const rushed = candidateOf("z/1", 0, { quota: { fiveHour: { remaining: 0.5, hoursUntilReset: 1 } } }, false);
    expect(rushed.pressure).toBeGreaterThan(1);
    // The same allowance with the whole period still to run is an even split.
    const even = candidateOf("z/1", 0, { quota: { sevenDay: { remaining: 0.5, hoursUntilReset: 84 } } }, false);
    expect(even.pressure).toBeCloseTo(1);
  });

  it("marks a member infeasible when the pace its window has run at would exhaust the rest before the reset, and feasible when it would last", () => {
    // Ten percent left with two of five hours gone: the pace so far (0.45 of the allowance an hour) leaves minutes, not the three hours still to run.
    expect(candidateOf("z/1", 0, { quota: { fiveHour: { remaining: 0.1, hoursUntilReset: 3 } } }, false)).toMatchObject({ available: true, feasible: false });
    // Sixty percent left with four of five hours gone: the pace (0.1 an hour) lasts six hours against one to run.
    expect(candidateOf("z/1", 0, { quota: { fiveHour: { remaining: 0.6, hoursUntilReset: 1 } } }, false)).toMatchObject({ feasible: true });
  });

  it("does not project a window that has only just opened, where one burst is all the pace says", () => {
    expect(candidateOf("z/1", 0, { quota: { fiveHour: { remaining: 0.1, hoursUntilReset: 4.9 } } }, false)).toMatchObject({ feasible: true });
  });

  it("blends the configured price with the observed token mix", () => {
    // Three input tokens at 1 and one output token at 3: a quarter of the spend is the output price, so the blend is weighted by the mix.
    const INPUT_SHARE = 3;
    const OUTPUT_SHARE = 1;
    const TOTAL = INPUT_SHARE + OUTPUT_SHARE;
    const INPUT_PRICE = 1;
    const OUTPUT_PRICE = 3;
    const candidate = candidateOf("z/1", 0, { observation: { latencyMs: 800, successRate: 0.9, tokenMix: { input: INPUT_SHARE, output: OUTPUT_SHARE, cacheRead: 0 } }, price: { input: INPUT_PRICE, output: OUTPUT_PRICE } }, false);
    expect(candidate).toMatchObject({ latencyMs: 800, successRate: 0.9, pricePerMTok: (INPUT_SHARE * INPUT_PRICE + OUTPUT_SHARE * OUTPUT_PRICE) / TOTAL });
  });
});
