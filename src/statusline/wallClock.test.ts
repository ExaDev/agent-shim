import { describe, expect, it } from "vitest";

import { STATUSLINE_DEFAULTS, type ResolvedStatusline } from "../config/statusline";
import { formatWallClock } from "./wallClock";

const NOW_MS = Date.parse("2026-10-16T00:01:00.000Z");
const BRITISH_CLOCK = { locale: "en-GB", timeZone: "UTC" };
const AMERICAN_CLOCK = { locale: "en-US", timeZone: "UTC" };
const GERMAN_CLOCK = { locale: "de-DE", timeZone: "UTC" };

/** The instants a day's clock face distinguishes, all on the same day as `NOW_MS`. */
const JUST_AFTER_MIDNIGHT_MS = Date.parse("2026-10-16T00:05:00.000Z");
const MORNING_MS = Date.parse("2026-10-16T09:05:00.000Z");
const NOON_MS = Date.parse("2026-10-16T12:00:00.000Z");
const AFTERNOON_MS = Date.parse("2026-10-16T14:30:07.000Z");
const ANOTHER_DAY_MS = Date.parse("2026-10-20T14:30:07.000Z");

function clockSettings(overrides: Readonly<Partial<ResolvedStatusline["clock"]>>): ResolvedStatusline["clock"] {
  return { ...STATUSLINE_DEFAULTS.clock, ...overrides };
}

describe("formatWallClock", () => {
  it("writes a time later today as the time alone, in the locale's own hour cycle", () => {
    expect(formatWallClock(AFTERNOON_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("14:30");
    expect(formatWallClock(AFTERNOON_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("2:30 PM");
    expect(formatWallClock(AFTERNOON_MS, NOW_MS, GERMAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("14:30");
  });

  it("pads the hour of a 24-hour clock and not that of a 12-hour one", () => {
    expect(formatWallClock(MORNING_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("09:05");
    expect(formatWallClock(MORNING_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("9:05 AM");
    expect(formatWallClock(MORNING_MS, NOW_MS, AMERICAN_CLOCK, clockSettings({ hourCycle: "h23" }))).toBe("09:05");
    expect(formatWallClock(MORNING_MS, NOW_MS, BRITISH_CLOCK, clockSettings({ hourCycle: "h12" }))).toBe("9:05 am");
  });

  it("adds the date to a time on another day", () => {
    expect(formatWallClock(ANOTHER_DAY_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("20 Oct 14:30");
    expect(formatWallClock(ANOTHER_DAY_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("Oct 20 2:30 PM");
  });

  it("writes midnight and noon as each hour cycle defines them", () => {
    const at = (atMs: number, clock: typeof BRITISH_CLOCK, hourCycle: ResolvedStatusline["clock"]["hourCycle"]): string => formatWallClock(atMs, NOW_MS, clock, clockSettings({ hourCycle }));
    expect(at(JUST_AFTER_MIDNIGHT_MS, BRITISH_CLOCK, "h23")).toBe("00:05");
    expect(at(JUST_AFTER_MIDNIGHT_MS, BRITISH_CLOCK, "h24")).toBe("24:05");
    expect(at(JUST_AFTER_MIDNIGHT_MS, AMERICAN_CLOCK, "h12")).toBe("12:05 AM");
    expect(at(JUST_AFTER_MIDNIGHT_MS, AMERICAN_CLOCK, "h11")).toBe("0:05 AM");
    expect(at(NOON_MS, AMERICAN_CLOCK, "h12")).toBe("12:00 PM");
    expect(at(NOON_MS, AMERICAN_CLOCK, "h11")).toBe("0:00 PM");
    expect(at(NOON_MS, BRITISH_CLOCK, "h23")).toBe("12:00");
    expect(at(NOON_MS, BRITISH_CLOCK, "auto")).toBe("12:00");
  });

  it("includes seconds when clock.seconds is set", () => {
    expect(formatWallClock(AFTERNOON_MS, NOW_MS, BRITISH_CLOCK, clockSettings({ seconds: true }))).toBe("14:30:07");
    expect(formatWallClock(AFTERNOON_MS, NOW_MS, AMERICAN_CLOCK, clockSettings({ seconds: true }))).toBe("2:30:07 PM");
  });

  it("tells the time, and which day it is, in the clock's time zone", () => {
    const tokyo = { locale: "en-GB", timeZone: "Asia/Tokyo" };
    // Now is 09:01 on the 16th in Tokyo. 20:00 UTC is 05:00 on the 17th there, and 12:00 UTC is 21:00 on the 16th.
    expect(formatWallClock(Date.parse("2026-10-16T20:00:00.000Z"), NOW_MS, tokyo, STATUSLINE_DEFAULTS.clock)).toBe("17 Oct 05:00");
    expect(formatWallClock(NOON_MS, NOW_MS, tokyo, STATUSLINE_DEFAULTS.clock)).toBe("21:00");
  });

  it("changes the day at the zone's midnight, not at UTC's", () => {
    const newYork = { locale: "en-GB", timeZone: "America/New_York" };
    // 23:30 on the 16th in New York (UTC-4) is 03:30 UTC on the 17th, and an hour later is the 17th there.
    const lateNow = Date.parse("2026-10-17T03:30:00.000Z");
    expect(formatWallClock(Date.parse("2026-10-17T03:59:00.000Z"), lateNow, newYork, STATUSLINE_DEFAULTS.clock)).toBe("23:59");
    expect(formatWallClock(Date.parse("2026-10-17T04:01:00.000Z"), lateNow, newYork, STATUSLINE_DEFAULTS.clock)).toBe("17 Oct 00:01");
  });

  it("tells the repeated hour when the clocks go back, and the day around it, in the zone's own terms", () => {
    const london = { locale: "en-GB", timeZone: "Europe/London" };
    // Clocks go back at 02:00 BST on 25 October 2026, so 01:30 happens twice: at 00:30 UTC (BST) and 01:30 UTC (GMT).
    const before = Date.parse("2026-10-24T22:00:00.000Z");
    expect(formatWallClock(Date.parse("2026-10-25T00:30:00.000Z"), before, london, STATUSLINE_DEFAULTS.clock)).toBe("25 Oct 01:30");
    expect(formatWallClock(Date.parse("2026-10-25T01:30:00.000Z"), before, london, STATUSLINE_DEFAULTS.clock)).toBe("25 Oct 01:30");
    // An hour later in UTC terms, the wall clock reads 02:30 GMT, with the offset change absorbed.
    expect(formatWallClock(Date.parse("2026-10-25T02:30:00.000Z"), before, london, STATUSLINE_DEFAULTS.clock)).toBe("25 Oct 02:30");
  });
});
