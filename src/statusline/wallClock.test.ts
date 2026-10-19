import { describe, expect, it } from "vitest";

import { STATUSLINE_DEFAULTS } from "../config/statusline";
import { formatWallClock } from "./wallClock";

const NOW_MS = Date.parse("2026-10-16T09:00:00.000Z");
const LATER_TODAY_MS = Date.parse("2026-10-16T14:30:07.000Z");
const LATER_AFTERNOON_MS = Date.parse("2026-10-16T15:30:07.000Z");
const ANOTHER_DAY_MS = Date.parse("2026-10-20T14:30:07.000Z");
const BRITISH_CLOCK = { locale: "en-GB", timeZone: "UTC" };
const AMERICAN_CLOCK = { locale: "en-US", timeZone: "UTC" };

describe("formatWallClock", () => {
  it("writes a time later today as the time alone, in the locale's own hour cycle", () => {
    expect(formatWallClock(LATER_TODAY_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("14:30");
    expect(formatWallClock(LATER_TODAY_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("02:30 PM");
  });

  it("adds the date to a time on another day", () => {
    expect(formatWallClock(ANOTHER_DAY_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("20 Oct 14:30");
    expect(formatWallClock(ANOTHER_DAY_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("Oct 20 02:30 PM");
  });

  it("forces the hour cycle that clock.hourCycle names, whatever the locale prefers", () => {
    expect(formatWallClock(LATER_AFTERNOON_MS, NOW_MS, BRITISH_CLOCK, { ...STATUSLINE_DEFAULTS.clock, hourCycle: "h12" })).toBe("03:30 pm");
    expect(formatWallClock(LATER_AFTERNOON_MS, NOW_MS, AMERICAN_CLOCK, { ...STATUSLINE_DEFAULTS.clock, hourCycle: "h23" })).toBe("15:30");
  });

  it("includes seconds when clock.seconds is set", () => {
    expect(formatWallClock(LATER_TODAY_MS, NOW_MS, BRITISH_CLOCK, { ...STATUSLINE_DEFAULTS.clock, seconds: true })).toBe("14:30:07");
  });

  it("tells the time, and which day it is, in the clock's time zone", () => {
    const tokyo = { locale: "en-GB", timeZone: "Asia/Tokyo" };
    // 20:00 UTC is 05:00 the next morning in Tokyo, a different day from now (18:00 on the 16th there).
    expect(formatWallClock(Date.parse("2026-10-16T20:00:00.000Z"), NOW_MS, tokyo, STATUSLINE_DEFAULTS.clock)).toBe("17 Oct 05:00");
    expect(formatWallClock(Date.parse("2026-10-16T12:00:00.000Z"), NOW_MS, tokyo, STATUSLINE_DEFAULTS.clock)).toBe("21:00");
  });
});
