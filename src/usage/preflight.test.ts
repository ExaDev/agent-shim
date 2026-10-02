import { describe, expect, it } from "vitest";

import { quotaWarnings } from "./preflight";
import type { UsageSnapshot } from "./schema";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const MINUTES_PER_HOUR = 60;
const MINUTE_MS = 60_000;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const LAST_SEEN_HOURS_AGO = 3;
const LAST_SEEN_MINUTES_AGO = 5;

type Unified = NonNullable<NonNullable<UsageSnapshot["providers"][string]["rateLimit"]>["unified"]>;

function snapshotWith(unified: Unified | undefined, observedAt = new Date(NOW_MS - LAST_SEEN_HOURS_AGO * HOUR_MS).toISOString(), provider = "anthropic"): UsageSnapshot {
  const at = new Date(NOW_MS - LAST_SEEN_HOURS_AGO * HOUR_MS).toISOString();
  return {
    schemaVersion: 1,
    identity: "work",
    updatedAt: at,
    providers: { [provider]: { lastRequestAt: at, lastStatus: 200, rateLimit: { observedAt, headers: {}, ...(unified === undefined ? {} : { unified }) } } },
  };
}

const future = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

describe("quotaWarnings", () => {
  it("says nothing without a snapshot, without rate-limit state, or for a provider the snapshot has no state for", () => {
    expect(quotaWarnings(undefined, "anthropic", NOW_MS)).toEqual([]);
    expect(quotaWarnings(snapshotWith(undefined), "anthropic", NOW_MS)).toEqual([]);
    expect(quotaWarnings(snapshotWith({ fiveHour: { status: "rejected", resetsAt: future(HOUR_MS) } }), "z", NOW_MS)).toEqual([]);
  });

  it("says nothing while both windows are allowed", () => {
    const unified: Unified = { status: "allowed", fiveHour: { utilization: 0.2, status: "allowed", resetsAt: future(HOUR_MS) }, sevenDay: { utilization: 0.4, status: "allowed", resetsAt: future(DAY_MS) } };
    expect(quotaWarnings(snapshotWith(unified), "anthropic", NOW_MS)).toEqual([]);
  });

  it("warns for a window the API marked allowed_warning, with its reset and the age of the observation", () => {
    const resetsAt = future(DAY_MS);
    const [warning, ...rest] = quotaWarnings(snapshotWith({ sevenDay: { status: "allowed_warning", resetsAt } }), "anthropic", NOW_MS);
    expect(rest).toEqual([]);
    expect(warning).toBe(`claude-use: identity work: the seven-day quota is nearly used, resets ${resetsAt} (last seen ${String(LAST_SEEN_HOURS_AGO)}h ago)`);
  });

  it("calls a rejected window exhausted, and reports both windows when both are over", () => {
    const warnings = quotaWarnings(snapshotWith({ fiveHour: { status: "rejected", resetsAt: future(HOUR_MS) }, sevenDay: { status: "rejected", resetsAt: future(DAY_MS) } }), "anthropic", NOW_MS);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("five-hour quota is exhausted");
    expect(warnings[1]).toContain("seven-day quota is exhausted");
  });

  it("drops a warning whose window has reset since it was observed, but keeps one with no reset time", () => {
    expect(quotaWarnings(snapshotWith({ fiveHour: { status: "rejected", resetsAt: new Date(NOW_MS - 1).toISOString() } }), "anthropic", NOW_MS)).toEqual([]);
    expect(quotaWarnings(snapshotWith({ fiveHour: { status: "rejected" } }), "anthropic", NOW_MS)).toHaveLength(1);
  });

  it("reads the state of the provider the launch uses", () => {
    const warnings = quotaWarnings(snapshotWith({ sevenDay: { status: "rejected", resetsAt: future(DAY_MS) } }, undefined, "z"), "z", NOW_MS);
    expect(warnings).toHaveLength(1);
  });

  it("states the age in the largest whole unit", () => {
    const observed = (agoMs: number): string => new Date(NOW_MS - agoMs).toISOString();
    const ageOf = (agoMs: number): string => quotaWarnings(snapshotWith({ sevenDay: { status: "rejected", resetsAt: future(DAY_MS) } }, observed(agoMs)), "anthropic", NOW_MS)[0] ?? "";
    expect(ageOf(LAST_SEEN_MINUTES_AGO * MINUTE_MS)).toContain(`last seen ${String(LAST_SEEN_MINUTES_AGO)}m ago`);
    expect(ageOf(2 * HOUR_MS)).toContain("last seen 2h ago");
    expect(ageOf(LAST_SEEN_HOURS_AGO * DAY_MS)).toContain(`last seen ${String(LAST_SEEN_HOURS_AGO)}d ago`);
  });
});
