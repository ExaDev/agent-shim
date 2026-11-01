import { describe, expect, it } from "vitest";

import { candidateHeading, describeWindow, percent } from "./candidateText";
import { effectiveWindow } from "./preflight";
import type { QuotaWindow } from "./schema";

const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const THREE_HOURS = 3;
const THREE_HOURS_MS = THREE_HOURS * HOUR_MS;
const QUARTER = 0.25;
const THREE_TENTHS = 0.3;
const TWO_THIRDS = 0.666;
const NINE_TENTHS = 0.9;


describe("candidateHeading", () => {
  it("names the class alone for a member with no score", () => {
    expect(candidateHeading({ class: "unknown", feasible: true })).toBe("[unknown]");
  });

  it("adds the score and the reset it divides by", () => {
    expect(candidateHeading({ class: "scored", score: 0.5, scoreWindow: "sevenDay", feasible: true })).toBe("[scored score 0.50 by 7d reset]");
    expect(candidateHeading({ class: "scored", score: 1.234, scoreWindow: "fiveHour", feasible: true })).toBe("[scored score 1.23 by 5h reset]");
  });

  it("notes a five-hour window that would run dry", () => {
    expect(candidateHeading({ class: "scored", score: 0.5, scoreWindow: "sevenDay", feasible: false })).toBe("[scored score 0.50 by 7d reset] (5h would run dry)");
  });
});

describe("percent", () => {
  it("rounds a fraction to a whole percentage", () => {
    expect(percent(QUARTER)).toBe("25%");
    expect(percent(TWO_THIRDS)).toBe("67%");
  });
});

describe("describeWindow", () => {
  const describeAt = (window: Readonly<QuotaWindow>): string => describeWindow("5h", window, effectiveWindow(window, NOW_MS), NOW_MS);

  it("says how much of a window is used and when it resets", () => {
    expect(describeAt({ utilization: THREE_TENTHS, resetsAt: new Date(NOW_MS + THREE_HOURS_MS).toISOString() })).toBe("5h 30% used, resets in 3h");
  });

  it("says usage is unknown when the window reported none, and omits a reset it was not given", () => {
    expect(describeAt({})).toBe("5h usage unknown");
  });

  it("flags a window the API itself marks nearly used", () => {
    expect(describeAt({ utilization: NINE_TENTHS, status: "allowed_warning" })).toBe("5h 90% used (nearly used)");
  });

  it("says a window whose reset has passed has reset, whatever was last recorded", () => {
    expect(describeAt({ utilization: 1, resetsAt: new Date(NOW_MS - HOUR_MS).toISOString() })).toBe("5h window has reset");
  });
});
