import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { translatorFor } from "./messages/catalogues";
import { formatResetTime } from "./resetTime";

const NOW_MS = Date.parse("2026-10-16T09:00:00.000Z");
const CLOCK = { locale: "en-GB", timeZone: "UTC" };
const FIVE_HOUR_PERIOD_MS = 18_000_000;
/** A reset that rounds to no time left, and one that rounds to a second. */
const UNDER_HALF_A_SECOND_MS = 400;
const OVER_HALF_A_SECOND_MS = 600;
/** Resets in 1h 30m, at 10:30 today; the window began 3h 30m ago, so 70% of it has gone. */
const SOON = { resetsAt: "2026-10-16T10:30:00.000Z", periodMs: FIVE_HOUR_PERIOD_MS };
const NEXT_WEEK = { resetsAt: "2026-10-20T10:30:00.000Z", periodMs: undefined };

function textFor(window: Readonly<Parameters<typeof formatResetTime>[0]>, usage: Readonly<NonNullable<StatuslineSettings["usage"]>>) {
  return formatResetTime(window, NOW_MS, resolveStatusline({ usage }), CLOCK, translatorFor("en"), false);
}

describe("formatResetTime", () => {
  it("tells the time left in the statusline's own duration form by default", () => {
    expect(textFor(SOON, {})).toEqual({ text: "1h 30m", pending: true });
  });

  it("tells the wall-clock time, with the day when it is not today", () => {
    expect(textFor(SOON, { timeFormat: "absolute" })).toEqual({ text: "at 10:30", pending: true });
    expect(textFor(NEXT_WEEK, { timeFormat: "absolute" })).toEqual({ text: "at 20 Oct 10:30", pending: true });
  });

  it("tells both the time left and the wall-clock time", () => {
    expect(textFor(SOON, { timeFormat: "both" }).text).toBe("1h 30m, at 10:30");
  });

  it("tells the share of the window already gone, and that share beside the wall-clock time", () => {
    expect(textFor(SOON, { timeFormat: "elapsed" }).text).toBe("70% elapsed");
    expect(textFor(SOON, { timeFormat: "elapsedAndAbsolute" }).text).toBe("70% elapsed, at 10:30");
  });

  it("says nothing of a share it cannot work out, and keeps the wall-clock time beside it", () => {
    expect(textFor(NEXT_WEEK, { timeFormat: "elapsed" }).text).toBe("");
    expect(textFor(NEXT_WEEK, { timeFormat: "elapsedAndAbsolute" }).text).toBe("at 20 Oct 10:30");
  });

  it("introduces a reset still to come when asked to, except in the elapsed forms, and never one that is past", () => {
    const labelled = (window: Readonly<Parameters<typeof formatResetTime>[0]>, usage: Readonly<NonNullable<StatuslineSettings["usage"]>>): string => formatResetTime(window, NOW_MS, resolveStatusline({ usage }), CLOCK, translatorFor("en"), true).text;
    expect(labelled(SOON, {})).toBe("resets in 1h 30m");
    expect(labelled(SOON, { timeFormat: "absolute" })).toBe("resets at 10:30");
    expect(labelled(SOON, { timeFormat: "both" })).toBe("resets in 1h 30m, at 10:30");
    expect(labelled(SOON, { timeFormat: "elapsed" })).toBe("70% elapsed");
    expect(labelled(SOON, { timeFormat: "elapsedAndAbsolute" })).toBe("70% elapsed, at 10:30");
    expect(labelled({ resetsAt: "2026-10-16T08:00:00.000Z", periodMs: FIVE_HOUR_PERIOD_MS }, {})).toBe("available");
  });

  it("calls a reset that is past or unknown available in every form that tells a time, and a past window wholly elapsed", () => {
    const past = { resetsAt: "2026-10-16T08:00:00.000Z", periodMs: FIVE_HOUR_PERIOD_MS };
    for (const timeFormat of ["relative", "absolute", "both"] as const) {
      expect(textFor(past, { timeFormat }), timeFormat).toEqual({ text: "available", pending: false });
      expect(textFor({ resetsAt: undefined, periodMs: undefined }, { timeFormat }).text, timeFormat).toBe("available");
    }
    expect(textFor(past, { timeFormat: "elapsed" })).toEqual({ text: "100% elapsed", pending: false });
    expect(textFor(past, { timeFormat: "elapsedAndAbsolute" }).text).toBe("100% elapsed");
    expect(textFor({ resetsAt: undefined, periodMs: FIVE_HOUR_PERIOD_MS }, { timeFormat: "elapsed" }).text).toBe("");
  });

  it("calls a reset under half a second away available, not time left, and a reset just over it pending", () => {
    const withinHalfSecond = { resetsAt: new Date(NOW_MS + UNDER_HALF_A_SECOND_MS).toISOString(), periodMs: FIVE_HOUR_PERIOD_MS };
    for (const timeFormat of ["relative", "absolute", "both"] as const) {
      expect(textFor(withinHalfSecond, { timeFormat }), timeFormat).toEqual({ text: "available", pending: false });
    }
    expect(textFor(withinHalfSecond, { timeFormat: "elapsedAndAbsolute" }).text).toBe("100% elapsed");
    const justOver = { resetsAt: new Date(NOW_MS + OVER_HALF_A_SECOND_MS).toISOString(), periodMs: FIVE_HOUR_PERIOD_MS };
    expect(textFor(justOver, { timeFormat: "both" })).toEqual({ text: "1s, at 09:00", pending: true });
  });

  it("tells the seconds left when less than a minute remains", () => {
    const FORTY_FIVE_SECONDS_MS = 45_000;
    expect(textFor({ resetsAt: new Date(NOW_MS + FORTY_FIVE_SECONDS_MS).toISOString(), periodMs: undefined }, {})).toEqual({ text: "45s", pending: true });
    expect(textFor({ resetsAt: new Date(NOW_MS + 2 * FORTY_FIVE_SECONDS_MS).toISOString(), periodMs: undefined }, {}).text).toBe("1m");
  });

  it("writes the wall-clock time under the clock settings", () => {
    const settings = resolveStatusline({ usage: { timeFormat: "absolute" }, clock: { hourCycle: "h12", seconds: true } });
    expect(formatResetTime(SOON, NOW_MS, settings, CLOCK, translatorFor("en"), false).text).toBe("at 10:30:00 am");
  });
});
