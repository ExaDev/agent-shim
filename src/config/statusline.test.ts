import { describe, expect, it } from "vitest";

import { MAX_STATUSLINE_LABEL_CHARS, resolveStatusline, STATUSLINE_DEFAULTS, StatuslineChangeSchema, StatuslineSchema } from "./statusline";

const OVER_LONG_LABEL = "x".repeat(MAX_STATUSLINE_LABEL_CHARS + 1);
const WARN_ABOVE_DEFAULT_CRITICAL = 95;
const CRITICAL_ABOVE_WARN = 99;

describe("StatuslineSchema", () => {
  it("accepts every key and none", () => {
    expect(StatuslineSchema.parse({})).toEqual({});
    const full = { header: ["account", "model"], bars: ["quota"], warnAt: 50, criticalAt: 80, fiveHourLabel: "Session", sevenDayLabel: "Week", barWidth: 6 };
    expect(StatuslineSchema.parse(full)).toEqual(full);
  });

  it("accepts an empty list, which hides the whole group", () => {
    expect(StatuslineSchema.parse({ header: [], bars: [] })).toEqual({ header: [], bars: [] });
  });

  it("refuses an unknown segment, a repeated segment and an unknown key", () => {
    expect(StatuslineSchema.safeParse({ header: ["colour"] }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ header: ["model", "model"] }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ bars: ["context", "context"] }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ theme: "dark" }).success).toBe(false);
  });

  it("refuses thresholds and a width outside their ranges", () => {
    for (const bad of [{ warnAt: 0 }, { criticalAt: 101 }, { warnAt: 50.5 }, { barWidth: 0 }, { barWidth: 41 }, { barWidth: 2.5 }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a label that is empty, too long, or carries control characters or edge whitespace", () => {
    for (const bad of ["", OVER_LONG_LABEL, "5\u001b[31mh", "line\nbreak", " 5h", "5h ", "a\tb"]) {
      expect(StatuslineSchema.safeParse({ fiveHourLabel: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(StatuslineSchema.safeParse({ fiveHourLabel: "5 hour" }).success).toBe(true);
  });
});

describe("StatuslineChangeSchema", () => {
  it("accepts false for every key as a clear, and refuses true", () => {
    expect(StatuslineChangeSchema.parse({ header: false, bars: false, warnAt: false, criticalAt: false, fiveHourLabel: false, sevenDayLabel: false, barWidth: false })).toBeDefined();
    expect(StatuslineChangeSchema.safeParse({ warnAt: true }).success).toBe(false);
  });
});

describe("resolveStatusline", () => {
  it("fills every absent key from the defaults", () => {
    expect(resolveStatusline(undefined)).toEqual(STATUSLINE_DEFAULTS);
    expect(resolveStatusline({ barWidth: 6 })).toEqual({ ...STATUSLINE_DEFAULTS, barWidth: 6 });
  });

  it("refuses a warning threshold at or above the critical one, whichever side the setting came from", () => {
    expect(() => resolveStatusline({ warnAt: WARN_ABOVE_DEFAULT_CRITICAL })).toThrow(/warnAt \(95\) must be below criticalAt \(90\)/);
    expect(() => resolveStatusline({ criticalAt: 60 })).toThrow(/warnAt \(70\) must be below criticalAt \(60\)/);
    expect(() => resolveStatusline({ warnAt: 80, criticalAt: 80 })).toThrow(RangeError);
    expect(resolveStatusline({ warnAt: WARN_ABOVE_DEFAULT_CRITICAL, criticalAt: CRITICAL_ABOVE_WARN }).warnAt).toBe(WARN_ABOVE_DEFAULT_CRITICAL);
  });
});
