import { describe, expect, it } from "vitest";

import { buildUsageSnapshot, unifiedQuotaHeaders, type HeaderReader } from "./quota";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MS_PER_SECOND = 1000;
const FIVE_HOUR_MINUTES = "300";
const SEVEN_DAY_MINUTES = "10080";
const FIVE_HOUR_RESET = 1_792_425_000;
const SEVEN_DAY_RESET = 1_792_875_000;

function reader(headers: Readonly<Record<string, string>>): HeaderReader {
  return { get: (name) => headers[name] ?? null };
}

/** The backend's usual layout: the five-hour window is the primary slot and the weekly window the secondary. */
const FIVE_HOUR_FIRST = reader({
  "x-codex-primary-window-minutes": FIVE_HOUR_MINUTES,
  "x-codex-primary-used-percent": "61",
  "x-codex-primary-reset-at": String(FIVE_HOUR_RESET),
  "x-codex-secondary-window-minutes": SEVEN_DAY_MINUTES,
  "x-codex-secondary-used-percent": "9",
  "x-codex-secondary-reset-at": String(SEVEN_DAY_RESET),
});

/** An account with no five-hour window: the weekly window arrives as the primary slot alone. */
const WEEKLY_ONLY = reader({
  "x-codex-primary-window-minutes": SEVEN_DAY_MINUTES,
  "x-codex-primary-used-percent": "40",
  "x-codex-primary-reset-at": String(SEVEN_DAY_RESET),
});

describe("unifiedQuotaHeaders", () => {
  it("tells the windows apart by their reported length, whichever slot carries them", () => {
    expect(unifiedQuotaHeaders(FIVE_HOUR_FIRST, false, undefined)).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.61",
      "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
      "anthropic-ratelimit-unified-7d-utilization": "0.09",
      "anthropic-ratelimit-unified-7d-reset": String(SEVEN_DAY_RESET),
      "anthropic-ratelimit-unified-reset": String(FIVE_HOUR_RESET),
    });
    const swapped = reader({
      "x-codex-primary-window-minutes": SEVEN_DAY_MINUTES,
      "x-codex-primary-used-percent": "9",
      "x-codex-primary-reset-at": String(SEVEN_DAY_RESET),
      "x-codex-secondary-window-minutes": FIVE_HOUR_MINUTES,
      "x-codex-secondary-used-percent": "61",
      "x-codex-secondary-reset-at": String(FIVE_HOUR_RESET),
    });
    expect(unifiedQuotaHeaders(swapped, false, undefined)).toEqual(unifiedQuotaHeaders(FIVE_HOUR_FIRST, false, undefined));
  });

  it("reports utilisation as a fraction, the form Claude Code parses", () => {
    expect(unifiedQuotaHeaders(WEEKLY_ONLY, false, undefined)).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.4",
      "anthropic-ratelimit-unified-7d-reset": String(SEVEN_DAY_RESET),
      "anthropic-ratelimit-unified-reset": String(SEVEN_DAY_RESET),
    });
  });

  it("reads no window whose length is neither the five-hour nor the weekly one", () => {
    const odd = reader({ "x-codex-primary-window-minutes": "1440", "x-codex-primary-used-percent": "50", "x-codex-primary-reset-at": String(FIVE_HOUR_RESET) });
    expect(unifiedQuotaHeaders(odd, false, undefined)).toEqual({ "anthropic-ratelimit-unified-status": "allowed" });
  });

  it("reports the weekly window used up on a refusal whose headers describe no window", () => {
    expect(unifiedQuotaHeaders(reader({}), true, { message: "usage limit", resets_at: SEVEN_DAY_RESET })).toEqual({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "anthropic-ratelimit-unified-7d-reset": String(SEVEN_DAY_RESET),
      "anthropic-ratelimit-unified-reset": String(SEVEN_DAY_RESET),
    });
  });

  it("states no window when nothing describes one and the request was not refused", () => {
    expect(unifiedQuotaHeaders(reader({}), false, undefined)).toEqual({ "anthropic-ratelimit-unified-status": "allowed" });
  });
});

describe("buildUsageSnapshot", () => {
  it("files each window under its own length with whole-percent figures", () => {
    expect(buildUsageSnapshot(FIVE_HOUR_FIRST, undefined, NOW_MS)).toEqual({
      updated_at: new Date(NOW_MS).toISOString(),
      five_hour: { used_percentage: 61, resets_at: new Date(FIVE_HOUR_RESET * MS_PER_SECOND).toISOString() },
      seven_day: { used_percentage: 9, resets_at: new Date(SEVEN_DAY_RESET * MS_PER_SECOND).toISOString() },
    });
  });

  it("omits the five-hour window for an account that has none", () => {
    expect(buildUsageSnapshot(WEEKLY_ONLY, undefined, NOW_MS)).toEqual({
      updated_at: new Date(NOW_MS).toISOString(),
      seven_day: { used_percentage: 40, resets_at: new Date(SEVEN_DAY_RESET * MS_PER_SECOND).toISOString() },
    });
  });

  it("is undefined when the headers describe no window and nothing was refused", () => {
    expect(buildUsageSnapshot(reader({}), undefined, NOW_MS)).toBeUndefined();
  });
});
