import { describe, expect, it } from "vitest";

import { collectResets, formatPeriod, formatResetRow } from "./resets";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "./schema";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIVE_HOURS = 5;
const THIRTY_DAYS = 30;
const THREE_DAYS = 3;
const TEN_DAYS = 10;
const FIVE_HOURS_MS = FIVE_HOURS * HOUR_MS;
const THIRTY_DAYS_MS = THIRTY_DAYS * DAY_MS;
const U56 = 0.56;
const U10 = 0.1;
const U30 = 0.3;
const FULL = 1;

const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

function snapshot(identity: string, state: UsageSnapshot["providers"][string]): UsageSnapshot {
  return { schemaVersion: USAGE_SCHEMA_VERSION, identity, updatedAt: at(0), providers: { anthropic: state } };
}

const observedAt = at(-HOUR_MS);

describe("collectResets", () => {
  it("lists each window once, soonest reset first, then windows already reset, then windows with no reset time", () => {
    const { resets } = collectResets(
      [
        snapshot("far", { rateLimit: { observedAt, headers: {}, unified: { fiveHour: { utilization: U10, resetsAt: at(FIVE_HOURS_MS) }, sevenDay: { utilization: U30, resetsAt: at(THREE_DAYS * DAY_MS) } } } }),
        snapshot("soon", { rateLimit: { observedAt, headers: {}, unified: { fiveHour: { utilization: U56, resetsAt: at(HOUR_MS) }, sevenDay: { utilization: U10 } } } }),
        snapshot("old", { rateLimit: { observedAt, headers: {}, unified: { sevenDay: { utilization: FULL, resetsAt: at(-HOUR_MS), status: "rejected" } } } }),
      ],
      NOW_MS,
    );
    expect(resets.map((row) => `${row.identity} ${row.window}`)).toEqual(["soon 5h", "far 5h", "far 7d", "old 7d", "soon 7d"]);
  });

  it("reads a window past its reset as reset and empty, as effectiveWindow does", () => {
    const { resets } = collectResets([snapshot("old", { rateLimit: { observedAt, headers: {}, unified: { sevenDay: { utilization: FULL, resetsAt: at(-HOUR_MS), status: "rejected" } } } })], NOW_MS);
    expect(resets).toEqual([{ identity: "old", provider: "anthropic", window: "7d", observedAt, resetsAt: at(-HOUR_MS), reset: true, utilization: 0 }]);
  });

  it("carries a pending window's utilisation and status", () => {
    const { resets } = collectResets([snapshot("a", { rateLimit: { observedAt, headers: {}, unified: { fiveHour: { utilization: U56, resetsAt: at(HOUR_MS), status: "allowed_warning" } } } })], NOW_MS);
    expect(resets[0]).toMatchObject({ reset: false, utilization: U56, status: "allowed_warning" });
  });

  it("lists a provider's own quota windows labelled by what they measure and their period", () => {
    const { resets } = collectResets(
      [snapshot("z", { quota: { observedAt, source: "z.ai", windows: [{ measures: "tokens", periodMs: FIVE_HOURS_MS, utilization: U30, resetsAt: at(2 * HOUR_MS) }, { measures: "tool-calls", periodMs: THIRTY_DAYS_MS, utilization: U10, resetsAt: at(TEN_DAYS * DAY_MS) }] } })],
      NOW_MS,
    );
    expect(resets.map((row) => row.window)).toEqual(["tokens 5h", "tool-calls 30d"]);
  });

  it("is empty for snapshots that recorded no windows", () => {
    expect(collectResets([snapshot("none", {})], NOW_MS).resets).toEqual([]);
  });
});

describe("formatPeriod", () => {
  it("states a whole number of days as days, other lengths as hours, and an unrecognised unit in the provider's words", () => {
    expect(formatPeriod({ measures: "tokens", periodMs: 2 * DAY_MS, utilization: 0 })).toBe("2d");
    expect(formatPeriod({ measures: "tokens", periodMs: FIVE_HOURS_MS, utilization: 0 })).toBe("5h");
    expect(formatPeriod({ measures: "tokens", period: "unit 4 x 1", utilization: 0 })).toBe("unit 4 x 1");
  });
});

describe("formatResetRow", () => {
  it("says when a pending window resets and how long that is, and that a passed one has reset", () => {
    const { resets } = collectResets(
      [snapshot("a", { rateLimit: { observedAt, headers: {}, unified: { fiveHour: { utilization: U56, resetsAt: at(2 * HOUR_MS) }, sevenDay: { utilization: FULL, resetsAt: at(-HOUR_MS) } } } })],
      NOW_MS,
    );
    expect(resets.map((row) => formatResetRow(row, NOW_MS))).toEqual([`a / anthropic: 5h 56% used, resets ${at(2 * HOUR_MS)} (in 2h)`, `a / anthropic: 7d 0% used, reset at ${at(-HOUR_MS)}`]);
  });
});
