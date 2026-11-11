import { describe, expect, it } from "vitest";

import { holdFrom, within } from "./elapsedWindow";

const WINDOW_MS = 1000;
const STAMP_MS = 5000;
const AN_HOUR_MS = 3_600_000;

describe("being within a window after a stamp", () => {
  it.each([
    ["at the stamp", STAMP_MS, true],
    ["one millisecond before the window ends", STAMP_MS + WINDOW_MS - 1, true],
    ["when the window has ended", STAMP_MS + WINDOW_MS, false],
    ["after the window", STAMP_MS + WINDOW_MS + 1, false],
    ["one millisecond before the stamp, the clock having stepped back", STAMP_MS - 1, false],
    ["an hour before the stamp", STAMP_MS - AN_HOUR_MS, false],
  ])("is decided %s", (_label, nowMs, expected) => {
    expect(within(STAMP_MS, nowMs, WINDOW_MS)).toBe(expected);
  });
});

describe("holding something back for a window after a stamp", () => {
  it.each([
    ["at the stamp", STAMP_MS, true, STAMP_MS],
    ["one millisecond before the window ends", STAMP_MS + WINDOW_MS - 1, true, STAMP_MS],
    ["when the window has ended", STAMP_MS + WINDOW_MS, false, STAMP_MS],
    ["after the window", STAMP_MS + WINDOW_MS + 1, false, STAMP_MS],
    ["one millisecond before the stamp, the clock having stepped back, which restarts the window from now", STAMP_MS - 1, true, STAMP_MS - 1],
    ["an hour before the stamp, which restarts the window from now and holds for the whole of it", STAMP_MS - AN_HOUR_MS, true, STAMP_MS - AN_HOUR_MS],
  ])("is decided %s", (_label, nowMs, held, sinceMs) => {
    expect(holdFrom(STAMP_MS, nowMs, WINDOW_MS)).toEqual({ held, sinceMs });
  });

  it("lifts after one whole window from a restart, however far the clock had stepped back", () => {
    const restarted = holdFrom(STAMP_MS, STAMP_MS - AN_HOUR_MS, WINDOW_MS);
    expect(holdFrom(restarted.sinceMs, STAMP_MS - AN_HOUR_MS + WINDOW_MS - 1, WINDOW_MS).held).toBe(true);
    expect(holdFrom(restarted.sinceMs, STAMP_MS - AN_HOUR_MS + WINDOW_MS, WINDOW_MS).held).toBe(false);
  });
});
