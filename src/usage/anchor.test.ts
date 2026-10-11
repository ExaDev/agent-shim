import { describe, expect, it } from "vitest";

import type { Anchor } from "../config/schema";
import { anchorInstants, dueAnchor, formatAnchor, parseAnchor } from "./anchor";

const LONDON = "Europe/London";
const ZONE_FREE_DEFAULT = "UTC";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TWO_DAYS_MS = 2 * DAY_MS;
const DAYS_IN_WEEK = 7;
const NINE = 9;
const NINE_DAYS_MS = NINE * DAY_MS;

const utc = (iso: string): number => Date.parse(iso);

describe("parseAnchor", () => {
  it("reads weekday lists, ranges, shorthands and an optional zone", () => {
    expect(parseAnchor("mon@06:00")).toEqual({ days: ["mon"], time: "06:00" });
    expect(parseAnchor("mon,wed,fri@07:30/Europe/London")).toEqual({ days: ["mon", "wed", "fri"], time: "07:30", timeZone: "Europe/London" });
    expect(parseAnchor("mon-fri@06:00").days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(parseAnchor("fri-mon@06:00").days).toEqual(["fri", "sat", "sun", "mon"]);
    expect(parseAnchor("weekdays@06:00").days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(parseAnchor("daily@06:00").days).toHaveLength(DAYS_IN_WEEK);
    expect(parseAnchor("mon,mon@06:00").days).toEqual(["mon"]);
  });

  it.each(["mon", "mon@6:00", "mon@25:00", "mon@06:60", "funday@06:00", "mon@06:00/Not/AZone", "mon-fri-sun@06:00"])("rejects %s, naming what is wrong", (spec) => {
    expect(() => parseAnchor(spec)).toThrow(/anchor|weekday/);
  });

  it("round-trips through formatAnchor", () => {
    const anchor = parseAnchor("mon,thu@06:00/Europe/London");
    expect(parseAnchor(formatAnchor(anchor))).toEqual(anchor);
  });
});

describe("anchorInstants", () => {
  const monday6: readonly Anchor[] = [{ days: ["mon"], time: "06:00", timeZone: LONDON }];

  it("finds a weekday's anchor at its wall-clock time in the zone, summer or winter", () => {
    // 2026-10-12 is a Monday in British Summer Time; 2026-11-02 is a Monday after the clocks went back.
    expect(anchorInstants(monday6, utc("2026-10-11T12:00:00Z"), utc("2026-10-13T00:00:00Z"), ZONE_FREE_DEFAULT)).toEqual([utc("2026-10-12T05:00:00Z")]);
    expect(anchorInstants(monday6, utc("2026-11-01T12:00:00Z"), utc("2026-11-03T00:00:00Z"), ZONE_FREE_DEFAULT)).toEqual([utc("2026-11-02T06:00:00Z")]);
  });

  it("reads an anchor with no zone in the default zone", () => {
    expect(anchorInstants([{ days: ["mon"], time: "06:00" }], utc("2026-10-11T12:00:00Z"), utc("2026-10-13T00:00:00Z"), "America/New_York")).toEqual([utc("2026-10-12T10:00:00Z")]);
  });

  it("excludes the lower bound and includes the upper one", () => {
    const anchors: readonly Anchor[] = [{ days: ["mon"], time: "06:00", timeZone: "UTC" }];
    const at = utc("2026-10-12T06:00:00Z");
    expect(anchorInstants(anchors, at, at + HOUR_MS, ZONE_FREE_DEFAULT)).toEqual([]);
    expect(anchorInstants(anchors, at - HOUR_MS, at, ZONE_FREE_DEFAULT)).toEqual([at]);
  });

  it("puts a time the clocks skip after the gap and a time they repeat on its first showing", () => {
    const daily: readonly Anchor[] = [{ days: ["sun"], time: "01:30", timeZone: LONDON }];
    // 2026-03-29: 01:00 GMT became 02:00 BST, so 01:30 never showed; 2026-10-25: 02:00 BST became 01:00 GMT, so 01:30 showed twice.
    expect(anchorInstants(daily, utc("2026-03-28T12:00:00Z"), utc("2026-03-30T00:00:00Z"), ZONE_FREE_DEFAULT)).toEqual([utc("2026-03-29T01:30:00Z")]);
    expect(anchorInstants(daily, utc("2026-10-24T12:00:00Z"), utc("2026-10-26T00:00:00Z"), ZONE_FREE_DEFAULT)).toEqual([utc("2026-10-25T00:30:00Z")]);
  });

  it("lists several anchors oldest first", () => {
    const both: readonly Anchor[] = [{ days: ["tue"], time: "06:00", timeZone: "UTC" }, { days: ["mon"], time: "18:00", timeZone: "UTC" }];
    expect(anchorInstants(both, utc("2026-10-11T00:00:00Z"), utc("2026-10-14T00:00:00Z"), ZONE_FREE_DEFAULT)).toEqual([utc("2026-10-12T18:00:00Z"), utc("2026-10-13T06:00:00Z")]);
  });
});

describe("dueAnchor", () => {
  const weekdays: readonly Anchor[] = [{ days: ["mon", "tue", "wed", "thu", "fri"], time: "06:00", timeZone: "UTC" }];

  it("is the latest anchor since the last one handled, and nothing before the next falls", () => {
    const handled = utc("2026-10-12T06:00:00Z");
    expect(dueAnchor(weekdays, utc("2026-10-12T09:00:00Z"), handled, ZONE_FREE_DEFAULT)).toBeUndefined();
    expect(dueAnchor(weekdays, utc("2026-10-13T06:03:00Z"), handled, ZONE_FREE_DEFAULT)).toBe(utc("2026-10-13T06:00:00Z"));
  });

  it("returns only the latest of several missed anchors, never replaying each", () => {
    expect(dueAnchor(weekdays, utc("2026-10-16T12:00:00Z"), utc("2026-10-12T06:00:00Z"), ZONE_FREE_DEFAULT)).toBe(utc("2026-10-16T06:00:00Z"));
  });

  it("looks back at most a week when the handled time is older", () => {
    const now = utc("2026-10-14T12:00:00Z");
    expect(dueAnchor(weekdays, now, now - NINE_DAYS_MS, ZONE_FREE_DEFAULT)).toBe(utc("2026-10-14T06:00:00Z"));
    expect(dueAnchor(weekdays, now, now - TWO_DAYS_MS, ZONE_FREE_DEFAULT)).toBe(utc("2026-10-14T06:00:00Z"));
  });
});
