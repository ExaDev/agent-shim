import { describe, expect, it } from "vitest";

import { planOf } from "./plan";

const MAX_BIG = 20;
const MAX_SMALL = 5;

describe("planOf", () => {
  it("reads the multiplier off a Max tier, preferring the organisation's tier", () => {
    expect(planOf({ organizationRateLimitTier: "default_claude_max_20x", userRateLimitTier: "default_claude_max_5x" })).toEqual({ kind: "subscription", capacity: MAX_BIG, recognised: true, tier: "default_claude_max_20x" });
    expect(planOf({ userRateLimitTier: "default_claude_max_5x" })).toEqual({ kind: "subscription", capacity: MAX_SMALL, recognised: true, tier: "default_claude_max_5x" });
  });

  it("counts a bare pro tier as the base capacity", () => {
    expect(planOf({ organizationRateLimitTier: "default_claude_pro" })).toEqual({ kind: "subscription", capacity: 1, recognised: true, tier: "default_claude_pro" });
  });

  it("classes a zero tier as pay-per-use", () => {
    expect(planOf({ organizationRateLimitTier: "default_claude_zero" })).toEqual({ kind: "pay-per-use", tier: "default_claude_zero" });
  });

  it("classes a seat whose own tier is zero as pay-per-use whatever its organisation's tier says", () => {
    expect(planOf({ organizationRateLimitTier: "default_raven_enterprise", userRateLimitTier: "default_claude_zero" })).toEqual({ kind: "pay-per-use", tier: "default_claude_zero" });
    expect(planOf({ organizationRateLimitTier: "default_claude_max_20x", userRateLimitTier: "default_claude_zero" })).toEqual({ kind: "pay-per-use", tier: "default_claude_zero" });
  });

  it("counts an unrecognised or missing tier as capacity 1 and says it guessed", () => {
    expect(planOf({ organizationRateLimitTier: "default_something_new" })).toEqual({ kind: "subscription", capacity: 1, recognised: false, tier: "default_something_new" });
    expect(planOf(undefined)).toEqual({ kind: "subscription", capacity: 1, recognised: false });
  });
});
