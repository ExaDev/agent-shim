import { describe, expect, it } from "vitest";

import { evaluateWhen } from "../resolve/conditions";
import { quotaFactsOf, windowFacts } from "./quotaFacts";

const NOW_MS = Date.parse("2026-10-09T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const FRACTION_USED = 0.42;
const instant = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

describe("windowFacts", () => {
  it("states a window as the fraction left, the fraction used and the hours until it resets", () => {
    expect(windowFacts({ utilization: FRACTION_USED, resetsAt: instant(DAY_HOURS * HOUR_MS) }, NOW_MS)).toEqual({ remaining: 1 - FRACTION_USED, utilization: FRACTION_USED, hoursUntilReset: DAY_HOURS });
  });

  it("leaves out a window that cannot answer every fact, rather than guessing the missing one", () => {
    expect(windowFacts({ utilization: FRACTION_USED }, NOW_MS)).toBeUndefined();
    expect(windowFacts({ resetsAt: instant(HOUR_MS) }, NOW_MS)).toBeUndefined();
    expect(windowFacts(undefined, NOW_MS)).toBeUndefined();
  });
});

describe("quotaFactsOf", () => {
  const extraUsage = { overageStatus: "allowed", overageUtilization: FRACTION_USED, overageResetsAt: instant(DAY_HOURS * HOUR_MS) };

  it("reads the extra-usage allowance as a window of its own when the account has no plan window", () => {
    expect(quotaFactsOf(extraUsage, NOW_MS)).toEqual({ extraUsage: { remaining: 1 - FRACTION_USED, utilization: FRACTION_USED, hoursUntilReset: DAY_HOURS } });
  });

  it("never offers the allowance of an account that has plan windows, where extra usage is only a fallback", () => {
    const facts = quotaFactsOf({ ...extraUsage, sevenDay: { utilization: FRACTION_USED, resetsAt: instant(HOUR_MS) } }, NOW_MS);
    expect(facts.extraUsage).toBeUndefined();
    expect(facts.sevenDay).toBeDefined();
  });

  it("answers nothing for a state that has not been recorded", () => {
    expect(quotaFactsOf(undefined, NOW_MS)).toEqual({});
  });

  it("feeds the condition references `quota.extraUsage.*` and `provider.<name>.extraUsage.*`", () => {
    const facts = quotaFactsOf(extraUsage, NOW_MS);
    const below = (key: string) => ({ kind: "compare", op: "lt", left: { kind: "reference", key }, right: { kind: "numberLiteral", value: 0.5 } }) as const;
    expect(evaluateWhen(below("quota.extraUsage.utilization"), { nowMs: NOW_MS, env: {}, pool: facts })).toMatchObject({ status: "definite", passed: true });
    expect(evaluateWhen(below("provider.novus.extraUsage.utilization"), { nowMs: NOW_MS, env: {}, providerQuota: { novus: facts } })).toMatchObject({ status: "definite", passed: true });
    expect(evaluateWhen(below("quota.extraUsage.utilization"), { nowMs: NOW_MS, env: {}, pool: {} })).toMatchObject({ status: "indeterminate" });
  });
});
