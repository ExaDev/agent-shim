import { describe, expect, it, vi } from "vitest";

import { adapterFor, openRouterQuotaAdapter, ProviderQuotaError, quotaFreshnessMs, zaiQuotaAdapter, type QuotaHttpGet } from "./providerQuota";
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
    expect(adapterFor("https://api.synthetic.new/anthropic")).toBeUndefined();
  });
});

describe("quotaFreshnessMs", () => {
  it("is the shortest known window length divided by 100", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([THIRTY_DAYS_MS, FIVE_HOURS_MS]))).toBe(FIVE_HOURS_MS / PERCENT);
  });

  it("ignores windows with no known length", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([undefined, THIRTY_DAYS_MS]))).toBe(THIRTY_DAYS_MS / PERCENT);
  });

  it("is never (infinite) when no window has a known length or there are none, so only an explicit request refreshes it", () => {
    expect(quotaFreshnessMs(quotaWithPeriods([undefined]))).toBe(Number.POSITIVE_INFINITY);
    expect(quotaFreshnessMs(quotaWithPeriods([]))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("openRouterQuotaAdapter", () => {
  const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
  const KEY_URL = "https://openrouter.ai/api/v1/key";
  const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
  const HTTP_FORBIDDEN = 403;
  const FREE_LIMIT = 1000;
  const FREE_USED = 250;
  const CREDITS_TOTAL = 15;
  const CREDITS_USED = 15.504849611;
  const KEY_CAP = 50;
  const KEY_REMAINING = 20;
  const NEXT_MIDNIGHT = "2026-10-03T00:00:00.000Z";
  const FRACTION_USED = 0.25;
  const CAP_USED = KEY_CAP - KEY_REMAINING;
  const CAP_FRACTION = CAP_USED / KEY_CAP;
  const OVERSPENT_FRACTION = CREDITS_USED / CREDITS_TOTAL;

  const unlimitedKey = { data: { limit: null, limit_remaining: null, limit_reset: null, is_free_tier: false, usage: 0.44, free_model_daily_requests: { used: FREE_USED, limit: FREE_LIMIT, remaining: FREE_LIMIT - FREE_USED } } };
  const cappedKey = { data: { ...unlimitedKey.data, limit: KEY_CAP, limit_remaining: KEY_REMAINING, limit_reset: "monthly" } };
  const credits = { data: { total_credits: CREDITS_TOTAL, total_usage: CREDITS_USED } };

  function routedHttp(answers: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>): ReturnType<typeof vi.fn<QuotaHttpGet>> {
    return vi.fn<QuotaHttpGet>().mockImplementation(async (url) => {
      const answer = answers[url];
      if (answer === undefined) {
        throw new Error(`unexpected request to ${url}`);
      }
      return await Promise.resolve({ status: answer.status, text: JSON.stringify(answer.body) });
    });
  }

  async function fetchOpenRouterQuota(http: QuotaHttpGet): Promise<ProviderQuota> {
    return await openRouterQuotaAdapter.fetch(API_KEY, http, new AbortController().signal, NOW_MS);
  }

  it("serves openrouter.ai and nothing else", () => {
    expect(openRouterQuotaAdapter.matches(OPENROUTER_BASE_URL)).toBe(true);
    expect(openRouterQuotaAdapter.matches("https://api.z.ai/api/anthropic")).toBe(false);
    expect(openRouterQuotaAdapter.matches("https://evil.example/openrouter.ai")).toBe(false);
    expect(openRouterQuotaAdapter.matches("not a url")).toBe(false);
    expect(adapterFor(OPENROUTER_BASE_URL)).toBe(openRouterQuotaAdapter);
  });

  it("asks both endpoints with the key as a bearer token", async () => {
    const http = routedHttp({ [KEY_URL]: { status: HTTP_OK, body: unlimitedKey }, [CREDITS_URL]: { status: HTTP_OK, body: credits } });
    await fetchOpenRouterQuota(http);
    expect(http.mock.calls.map(([url]) => url)).toEqual([KEY_URL, CREDITS_URL]);
    for (const [, headers] of http.mock.calls) {
      expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    }
  });

  it("reports the account credits, overspent as used above the limit with nothing remaining, and the free-model allowance resetting at the next UTC midnight", async () => {
    const quota = await fetchOpenRouterQuota(routedHttp({ [KEY_URL]: { status: HTTP_OK, body: unlimitedKey }, [CREDITS_URL]: { status: HTTP_OK, body: credits } }));
    expect(quota).toEqual({
      observedAt: new Date(NOW_MS).toISOString(),
      source: "OpenRouter",
      windows: [
        { measures: "account-credits", period: "prepaid", utilization: OVERSPENT_FRACTION, limit: CREDITS_TOTAL, used: CREDITS_USED, remaining: 0 },
        { measures: "free-model-requests", periodMs: HOURS_PER_DAY * MS_PER_HOUR, utilization: FRACTION_USED, resetsAt: NEXT_MIDNIGHT, limit: FREE_LIMIT, used: FREE_USED, remaining: FREE_LIMIT - FREE_USED },
      ],
    });
  });

  it("adds the key's own spending cap, with its reset type, when the key has one", async () => {
    const quota = await fetchOpenRouterQuota(routedHttp({ [KEY_URL]: { status: HTTP_OK, body: cappedKey }, [CREDITS_URL]: { status: HTTP_OK, body: credits } }));
    expect(quota.windows[0]).toEqual({ measures: "key-credits", period: "monthly", utilization: CAP_FRACTION, limit: KEY_CAP, used: CAP_USED, remaining: KEY_REMAINING });
  });

  it("leaves the account balance out when the credits endpoint refuses a regular key", async () => {
    const quota = await fetchOpenRouterQuota(routedHttp({ [KEY_URL]: { status: HTTP_OK, body: unlimitedKey }, [CREDITS_URL]: { status: HTTP_FORBIDDEN, body: {} } }));
    expect(quota.windows.map((window) => window.measures)).toEqual(["free-model-requests"]);
  });

  it("marks a free-tier key", async () => {
    const freeTier = { data: { ...unlimitedKey.data, is_free_tier: true } };
    const quota = await fetchOpenRouterQuota(routedHttp({ [KEY_URL]: { status: HTTP_OK, body: freeTier }, [CREDITS_URL]: { status: HTTP_OK, body: credits } }));
    expect(quota.level).toBe("free");
  });

  it("fails on a refused key, a server error or a wrong shape without ever printing the key", async () => {
    const refused = routedHttp({ [KEY_URL]: { status: HTTP_FORBIDDEN, body: { error: API_KEY } } });
    await expect(fetchOpenRouterQuota(refused)).rejects.toThrow(ProviderQuotaError);
    const serverError = routedHttp({ [KEY_URL]: { status: HTTP_SERVER_ERROR, body: { error: API_KEY } }, [CREDITS_URL]: { status: HTTP_OK, body: credits } });
    await expect(fetchOpenRouterQuota(serverError)).rejects.toThrow("answered HTTP 500");
    const wrongShape = routedHttp({ [KEY_URL]: { status: HTTP_OK, body: { data: { limit: "lots" } } }, [CREDITS_URL]: { status: HTTP_OK, body: credits } });
    const failure = await fetchOpenRouterQuota(wrongShape).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderQuotaError);
    expect(String(failure)).not.toContain(API_KEY);
  });
});
