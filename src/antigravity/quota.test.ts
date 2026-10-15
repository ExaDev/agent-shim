import { describe, expect, it } from "vitest";

import {
  createCachedAntigravityQuotaSource,
  fetchAntigravityQuotaSummary,
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

describe("fetchAntigravityQuotaSummary", () => {
  const DAYS_IN_WEEK = 7;
  const SECONDS_IN_WEEK = SECONDS_IN_DAY * DAYS_IN_WEEK;
  const summaryBody = {
    groups: [
      {
        buckets: [
          { bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2023-11-14T23:13:20Z" },
          { bucketId: "gemini-weekly", remainingFraction: 0.8, resetTime: "2023-11-21T23:13:20Z" },
          { bucketId: "malformed" },
        ],
      },
      { buckets: "not an array" },
    ],
  };

  it("maps the summary's camelCase buckets onto the quota map keyed by bucket id", async () => {
    const fetchFn: typeof fetch = async () => await Promise.resolve(new Response(JSON.stringify(summaryBody), { status: 200 }));
    const map = await fetchAntigravityQuotaSummary({ token: "t", nowMs: NOW_MS, fetchFn });
    expect(map).toEqual({
      "gemini-5h": { remaining_fraction: 0.25, reset_in_seconds: SECONDS_IN_HOUR },
      "gemini-weekly": { remaining_fraction: 0.8, reset_in_seconds: SECONDS_IN_WEEK + SECONDS_IN_HOUR },
    });
  });

  it("answers undefined for a failed read, an unparseable body, or a summary with no buckets", async () => {
    const failing: typeof fetch = async () => await Promise.resolve(new Response("{}", { status: 500 }));
    expect(await fetchAntigravityQuotaSummary({ token: "t", nowMs: NOW_MS, fetchFn: failing })).toBeUndefined();
    const garbage: typeof fetch = async () => await Promise.resolve(new Response("not json", { status: 200 }));
    expect(await fetchAntigravityQuotaSummary({ token: "t", nowMs: NOW_MS, fetchFn: garbage })).toBeUndefined();
    const empty: typeof fetch = async () => await Promise.resolve(new Response(JSON.stringify({ groups: [] }), { status: 200 }));
    expect(await fetchAntigravityQuotaSummary({ token: "t", nowMs: NOW_MS, fetchFn: empty })).toBeUndefined();
  });
});

describe("createCachedAntigravityQuotaSource", () => {
  const REFRESH_MS = 60_000;
  const STILL_FRESH_MS = 30_000;
  const STALE_MS = 120_000;

  it("returns nothing until the first refresh lands, then the read map until it goes stale", async () => {
    let nowMs = NOW_MS;
    let reads = 0;
    const source = createCachedAntigravityQuotaSource({
      now: () => nowMs,
      refreshMs: REFRESH_MS,
      fetchSummary: async () => {
        reads += 1;
        return await Promise.resolve({ "gemini-5h": { remaining_fraction: 0.5 } });
      },
    });
    expect(source()).toBeUndefined();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(source()).toEqual({ "gemini-5h": { remaining_fraction: 0.5 } });
    nowMs += STILL_FRESH_MS;
    expect(source()).toEqual({ "gemini-5h": { remaining_fraction: 0.5 } });
    expect(reads).toBe(1);
  });

  it("joins one in-flight refresh rather than duplicating it, and keeps the last good map when a read fails", async () => {
    let nowMs = NOW_MS;
    let reads = 0;
    let succeed = true;
    const source = createCachedAntigravityQuotaSource({
      now: () => nowMs,
      refreshMs: REFRESH_MS,
      fetchSummary: async () => {
        reads += 1;
        const read: AntigravityQuotaMap | undefined = succeed ? { "3p-5h": { remaining_fraction: 0.9 } } : undefined;
        return await Promise.resolve(read);
      },
    });
    source();
    source();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reads).toBe(1);
    nowMs += STALE_MS;
    succeed = false;
    expect(source()).toEqual({ "3p-5h": { remaining_fraction: 0.9 } });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(source()).toEqual({ "3p-5h": { remaining_fraction: 0.9 } });
    expect(reads).toBe(2);
  });
});
