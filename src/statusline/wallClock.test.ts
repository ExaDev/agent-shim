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

  it("pads the hour as the locale does in the cycle in use", () => {
    expect(formatWallClock(MORNING_MS, NOW_MS, BRITISH_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("09:05");
    expect(formatWallClock(MORNING_MS, NOW_MS, AMERICAN_CLOCK, STATUSLINE_DEFAULTS.clock)).toBe("9:05 AM");
    expect(formatWallClock(MORNING_MS, NOW_MS, AMERICAN_CLOCK, clockSettings({ hourCycle: "h23" }))).toBe("09:05");
    // British English pads the hour in a 12-hour cycle too, as its own short time form does.
    expect(formatWallClock(MORNING_MS, NOW_MS, BRITISH_CLOCK, clockSettings({ hourCycle: "h12" }))).toBe("09:05 am");
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

  it("tells the repeated hour the same way twice, and keeps the day of a 25-hour day whole", () => {
    const london = { locale: "en-GB", timeZone: "Europe/London" };
    // The clocks go back at 02:00 BST on 25 October 2026, so 01:30 happens twice: at 00:30 UTC (BST) and again at 01:30 UTC (GMT).
    const lateOnThe24th = Date.parse("2026-10-24T22:00:00.000Z");
    expect(formatWallClock(Date.parse("2026-10-25T00:30:00.000Z"), lateOnThe24th, london, STATUSLINE_DEFAULTS.clock)).toBe("25 Oct 01:30");
    expect(formatWallClock(Date.parse("2026-10-25T01:30:00.000Z"), lateOnThe24th, london, STATUSLINE_DEFAULTS.clock)).toBe("25 Oct 01:30");
    // From 00:10 UTC (01:10 BST) on the 25th, 01:30 UTC (01:30 GMT) is the same day, and 23:30 UTC (23:30 GMT) is too, a full day of 24 hours and then some after the 24th's midnight in London.
    const earlyOnThe25th = Date.parse("2026-10-25T00:10:00.000Z");
    expect(formatWallClock(Date.parse("2026-10-25T01:30:00.000Z"), earlyOnThe25th, london, STATUSLINE_DEFAULTS.clock)).toBe("01:30");
    expect(formatWallClock(Date.parse("2026-10-25T23:30:00.000Z"), earlyOnThe25th, london, STATUSLINE_DEFAULTS.clock)).toBe("23:30");
    // The next local midnight is at 00:00 UTC on the 26th, not an hour earlier as on an ordinary day.
    expect(formatWallClock(Date.parse("2026-10-25T23:59:00.000Z"), earlyOnThe25th, london, STATUSLINE_DEFAULTS.clock)).toBe("23:59");
    expect(formatWallClock(Date.parse("2026-10-26T00:01:00.000Z"), earlyOnThe25th, london, STATUSLINE_DEFAULTS.clock)).toBe("26 Oct 00:01");
  });

  it("writes the time in the locale's own form: its padding, separator, digits and day period", () => {
    const at = (locale: string, hourCycle: ResolvedStatusline["clock"]["hourCycle"] = "auto", seconds = false): string => formatWallClock(MORNING_MS, NOW_MS, { locale, timeZone: "UTC" }, clockSettings({ hourCycle, seconds }));
    expect(at("ja-JP")).toBe("9:05");
    expect(at("es")).toBe("9:05");
    expect(at("cs")).toBe("9:05");
    expect(at("fi")).toBe("9.05");
    expect(at("fi", "auto", true)).toBe("9.05.00");
    expect(at("gu-IN")).toBe("09:05 AM");
    expect(at("de-DE")).toBe("09:05");
    expect(at("ja-JP", "h12")).toBe("午前9:05");
  });
});
