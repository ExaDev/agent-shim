import { describe, expect, it, vi } from "vitest";

import { adapterFor, ProviderQuotaError, quotaFreshnessMs, zaiQuotaAdapter, type QuotaHttpGet } from "./providerQuota";
import type { ProviderQuota, ProviderQuotaWindow } from "./schema";

const API_KEY = "REDACTED";
const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;
const PERCENT = 100;
const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;
const FIVE = 5;
const ONE = 1;
const FIVE_HOURS_MS = FIVE * MS_PER_HOUR;
const THIRTY_DAYS_MS = DAYS_PER_MONTH * HOURS_PER_DAY * MS_PER_HOUR;
const TOKENS_RESET_MS = Date.parse("2026-10-02T15:00:00.000Z");
const TOOLS_RESET_MS = Date.parse("2026-10-20T00:00:00.000Z");
const TOKENS_PERCENTAGE = 13;
const TOOLS_PERCENTAGE = 1;
const TOOLS_USAGE = 4000;
const TOOLS_CURRENT_VALUE = 61;
const TOOLS_REMAINING = 3939;
const HOURS_UNIT = 3;
const MONTHS_UNIT = 5;
const UNKNOWN_UNIT = 4;

const zaiBody = {
  code: HTTP_OK,
  msg: "Operation successful",
  success: true,
  data: {
    level: "max",
    limits: [
      { type: "TOKENS_LIMIT", unit: HOURS_UNIT, number: FIVE, percentage: TOKENS_PERCENTAGE, nextResetTime: TOKENS_RESET_MS },
      {
        type: "TIME_LIMIT",
        unit: MONTHS_UNIT,
        number: ONE,
        usage: TOOLS_USAGE,
        currentValue: TOOLS_CURRENT_VALUE,
        remaining: TOOLS_REMAINING,
        percentage: TOOLS_PERCENTAGE,
        nextResetTime: TOOLS_RESET_MS,
        usageDetails: [{ modelCode: "search-prime", usage: TOOLS_CURRENT_VALUE }],
      },
    ],
  },
};

function httpAnswering(status: number, text: string): ReturnType<typeof vi.fn<QuotaHttpGet>> {
  return vi.fn<QuotaHttpGet>().mockResolvedValue({ status, text });
}

async function fetchQuota(http: QuotaHttpGet): Promise<ProviderQuota> {
  return await zaiQuotaAdapter.fetch(API_KEY, http, new AbortController().signal, NOW_MS);
}

async function rejection(http: QuotaHttpGet): Promise<Error> {
  try {
    await fetchQuota(http);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected the adapter to reject");
}

function windowAt(quota: ProviderQuota, index: number): ProviderQuotaWindow {
  const found = quota.windows[index];
  if (found === undefined) {
    throw new Error(`expected a window at index ${String(index)}`);
  }
  return found;
}

function quotaWithPeriods(periods: readonly (number | undefined)[]): ProviderQuota {
  return {
    observedAt: new Date(NOW_MS).toISOString(),
    source: "z.ai",
    windows: periods.map((periodMs) => ({ measures: "tokens", utilization: 0, ...(periodMs === undefined ? { period: "unit 4 x 1" } : { periodMs }) })),
  };
}

describe("zaiQuotaAdapter.fetch", () => {
  it("requests the quota endpoint with the key raw in authorization and the signal it was given", async () => {
    const http = httpAnswering(HTTP_OK, JSON.stringify(zaiBody));
    const signal = new AbortController().signal;

    await zaiQuotaAdapter.fetch(API_KEY, http, signal, NOW_MS);

    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(ZAI_QUOTA_URL, { authorization: API_KEY, accept: "application/json" }, signal);
  });

  it("maps the tokens and tool-calls limits to windows", async () => {
    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(zaiBody)));

    expect(quota).toEqual({
      observedAt: new Date(NOW_MS).toISOString(),
      source: "z.ai",
      level: "max",
      windows: [
        { measures: "tokens", periodMs: FIVE_HOURS_MS, utilization: TOKENS_PERCENTAGE / PERCENT, resetsAt: new Date(TOKENS_RESET_MS).toISOString() },
        {
          measures: "tool-calls",
          periodMs: THIRTY_DAYS_MS,
          utilization: TOOLS_PERCENTAGE / PERCENT,
          resetsAt: new Date(TOOLS_RESET_MS).toISOString(),
          limit: TOOLS_USAGE,
          used: TOOLS_CURRENT_VALUE,
          remaining: TOOLS_REMAINING,
        },
      ],
    });
  });

  it("puts limit, used and remaining only on the window that reports them", async () => {
    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(zaiBody)));
    const tokens = windowAt(quota, 0);

    expect(tokens).not.toHaveProperty("limit");
    expect(tokens).not.toHaveProperty("used");
    expect(tokens).not.toHaveProperty("remaining");
  });

  it("never carries the key into the returned quota", async () => {
    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(zaiBody)));

    expect(JSON.stringify(quota)).not.toContain(API_KEY);
  });

  it("omits level when the endpoint reports none", async () => {
    const withoutLevel = { ...zaiBody, data: { limits: zaiBody.data.limits } };

    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(withoutLevel)));

    expect(quota).not.toHaveProperty("level");
  });

  it("keeps a window with an unrecognised unit, describing its period instead of guessing a length", async () => {
    const body = { ...zaiBody, data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: UNKNOWN_UNIT, number: ONE, percentage: TOKENS_PERCENTAGE }] } };

    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(body)));
    const only = windowAt(quota, 0);

    expect(only.period).toBe(`unit ${String(UNKNOWN_UNIT)} x ${String(ONE)}`);
    expect(only).not.toHaveProperty("periodMs");
    expect(only).not.toHaveProperty("resetsAt");
    expect(only.utilization).toBe(TOKENS_PERCENTAGE / PERCENT);
  });

  it("names a limit type it does not know after the lower-cased type", async () => {
    const body = { ...zaiBody, data: { limits: [{ type: "IMAGE_LIMIT", unit: HOURS_UNIT, number: ONE, percentage: 0 }] } };

    const quota = await fetchQuota(httpAnswering(HTTP_OK, JSON.stringify(body)));

    expect(windowAt(quota, 0).measures).toBe("image_limit");
  });

  it.each([
    ["HTTP 401", HTTP_UNAUTHORIZED, `denied for ${API_KEY}`],
    ["HTTP 500", HTTP_SERVER_ERROR, `failure for ${API_KEY}`],
    ["a body that is not JSON", HTTP_OK, `<html>${API_KEY}</html>`],
    ["a body of the wrong shape", HTTP_OK, JSON.stringify({ success: true, data: { limits: "none", echoed: API_KEY } })],
    ["success: false", HTTP_OK, JSON.stringify({ ...zaiBody, success: false, msg: "plan expired" })],
  ])("throws a ProviderQuotaError for %s whose message does not contain the key", async (_label, status, text) => {
    const error = await rejection(httpAnswering(status, text));

    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect(error.message).toMatch(/^z\.ai usage endpoint: /);
    expect(error.message).not.toContain(API_KEY);
  });

  it("reports the HTTP status and the endpoint's own failure message", async () => {
    expect((await rejection(httpAnswering(HTTP_UNAUTHORIZED, ""))).message).toContain(String(HTTP_UNAUTHORIZED));
    expect((await rejection(httpAnswering(HTTP_OK, JSON.stringify({ ...zaiBody, success: false, msg: "plan expired" })))).message).toContain("plan expired");
  });

  it("lets a transport rejection through unchanged", async () => {
    const http = vi.fn<QuotaHttpGet>().mockRejectedValue(new Error("socket hang up"));

    await expect(fetchQuota(http)).rejects.toThrow("socket hang up");
  });
});

describe("zaiQuotaAdapter.matches", () => {
  it("accepts the z.ai Anthropic base URL", () => {
    expect(zaiQuotaAdapter.matches(ZAI_BASE_URL)).toBe(true);
  });

  it.each(["https://api.anthropic.com", "https://api.z.ai.example.com/api/anthropic", "https://example.com/api.z.ai", "not a url", ""])("rejects %s", (baseUrl) => {
    expect(zaiQuotaAdapter.matches(baseUrl)).toBe(false);
  });
});

describe("adapterFor", () => {
  it("returns the z.ai adapter for a z.ai base URL", () => {
    expect(adapterFor(ZAI_BASE_URL)).toBe(zaiQuotaAdapter);
  });

  it("returns undefined for a provider no adapter serves", () => {
    expect(adapterFor("https://openrouter.ai/api")).toBeUndefined();
  });
});

describe("quotaFreshnessMs", () => {
  it("is the shortest known window length divided by 100", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([THIRTY_DAYS_MS, FIVE_HOURS_MS]))).toBe(FIVE_HOURS_MS / PERCENT);
  });

  it("ignores windows with no known length", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([undefined, THIRTY_DAYS_MS]))).toBe(THIRTY_DAYS_MS / PERCENT);
  });

  it("is zero when no window has a known length or there are none", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([undefined]))).toBe(0);
    expect(quotaFreshnessMs(quotaWithPeriods([]))).toBe(0);
  });
});
