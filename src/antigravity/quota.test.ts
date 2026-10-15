import { describe, expect, it } from "vitest";

import {
  parseRetryAfterSeconds,
  unifiedAntigravityQuotaHeaders,
  type AntigravityQuotaMap,
} from "./quota";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = 1_700_000_000;
const SECONDS_IN_HOUR = 3600;
const SECONDS_IN_DAY = 86_400;
const FIVE = 5;
const SEVEN = 7;
const FIVE_HOURS_SEC = FIVE * SECONDS_IN_HOUR;
const SEVEN_DAYS_SEC = SEVEN * SECONDS_IN_DAY;
const HALF_HOUR_SEC = 1800;
const TEST_RETRY_SEC = 45;
const DEFAULT_RETRY_SEC = 60;
const RETRY_AFTER_TEST_SEC = 120;

describe("unifiedAntigravityQuotaHeaders", () => {
  it("translates local gemini quota buckets into Anthropic unified headers", () => {
    const quota: AntigravityQuotaMap = {
      "gemini-5h": {
        remaining_fraction: 0.75,
        reset_in_seconds: FIVE_HOURS_SEC,
      },
      "gemini-weekly": {
        remaining_fraction: 0.9,
        reset_in_seconds: SEVEN_DAYS_SEC,
      },
    };

    const headers = unifiedAntigravityQuotaHeaders({
      quota,
      rejected: false,
      nowMs: NOW_MS,
      model: "gemini-2.5-pro",
    });

    expect(headers["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("25");
    expect(headers["anthropic-ratelimit-unified-5h-reset"]).toBe(String(NOW_SEC + FIVE_HOURS_SEC));
    expect(headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("10");
    expect(headers["anthropic-ratelimit-unified-7d-reset"]).toBe(String(NOW_SEC + SEVEN_DAYS_SEC));
    expect(headers["anthropic-ratelimit-unified-reset"]).toBe(String(NOW_SEC + FIVE_HOURS_SEC));
  });

  it("selects 3p/claude buckets when model is non-gemini", () => {
    const quota: AntigravityQuotaMap = {
      "3p-5h": {
        remaining_fraction: 0.4,
        reset_in_seconds: HALF_HOUR_SEC,
      },
      "3p-weekly": {
        remaining_fraction: 0.6,
        reset_in_seconds: SEVEN_DAYS_SEC,
      },
    };

    const headers = unifiedAntigravityQuotaHeaders({
      quota,
      rejected: false,
      nowMs: NOW_MS,
      model: "claude-sonnet-4-5",
    });

    expect(headers["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("60");
    expect(headers["anthropic-ratelimit-unified-5h-reset"]).toBe(String(NOW_SEC + HALF_HOUR_SEC));
    expect(headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("40");
    expect(headers["anthropic-ratelimit-unified-reset"]).toBe(String(NOW_SEC + HALF_HOUR_SEC));
  });

  it("synthesizes rejected headers on quota rejection", () => {
    const headers = unifiedAntigravityQuotaHeaders({
      rejected: true,
      nowMs: NOW_MS,
      retryAfterSeconds: RETRY_AFTER_TEST_SEC,
    });

    expect(headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("100");
    expect(headers["anthropic-ratelimit-unified-5h-reset"]).toBe(String(NOW_SEC + RETRY_AFTER_TEST_SEC));
    expect(headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("100");
    expect(headers["anthropic-ratelimit-unified-reset"]).toBe(String(NOW_SEC + RETRY_AFTER_TEST_SEC));
  });

  it("returns allowed status when quota is empty and not rejected", () => {
    const headers = unifiedAntigravityQuotaHeaders({
      nowMs: NOW_MS,
    });

    expect(headers["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(headers["anthropic-ratelimit-unified-5h-utilization"]).toBeUndefined();
    expect(headers["anthropic-ratelimit-unified-7d-utilization"]).toBeUndefined();
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses numeric string", () => {
    expect(parseRetryAfterSeconds("45")).toBe(TEST_RETRY_SEC);
  });

  it("falls back to default on null, undefined, or empty", () => {
    expect(parseRetryAfterSeconds(null)).toBe(DEFAULT_RETRY_SEC);
    expect(parseRetryAfterSeconds(undefined)).toBe(DEFAULT_RETRY_SEC);
    expect(parseRetryAfterSeconds("   ")).toBe(DEFAULT_RETRY_SEC);
  });
});
