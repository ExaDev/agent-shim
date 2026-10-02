import { z } from "zod";

import { ProviderQuotaSchema, type ProviderQuota, type ProviderQuotaWindow } from "./schema";

/** One GET against a provider's usage endpoint: the status and body text, or a rejection for a transport failure. */
export type QuotaHttpGet = (url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<{ readonly status: number; readonly text: string }>;

/** A provider whose quota can only be read from its own usage endpoint, because its responses carry no quota headers. */
export interface ProviderQuotaAdapter {
  /** Names the endpoint in the snapshot (`ProviderQuota.source`). */
  readonly source: string;
  /** Whether a provider with this base URL is served by this adapter. */
  readonly matches: (baseUrl: string) => boolean;
  /** Fetches the quota with the provider's API key. Throws `ProviderQuotaError` for a refusal or a response that is not what the endpoint documents. */
  readonly fetch: (apiKey: string, http: QuotaHttpGet, signal: AbortSignal, nowMs: number) => Promise<ProviderQuota>;
}

/** A provider's usage endpoint refused the request or answered something this project cannot read. The message never contains the key. */
export class ProviderQuotaError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} usage endpoint: ${detail}`);
    this.name = "ProviderQuotaError";
  }
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;
const PERCENT = 100;
const HTTP_OK = 200;

const ZAI_SOURCE = "z.ai";
const ZAI_HOST = "api.z.ai";
const ZAI_QUOTA_URL = `https://${ZAI_HOST}/api/monitor/usage/quota/limit`;

/**
 * The period codes z.ai's quota endpoint reports a window's length in, observed against a live Coding Plan account: `unit: 3` with `number: 5` is the five-hour token window and `unit: 5` with `number: 1` the monthly tool allowance (the first-party usage plugin labels them "5 Hour" and "1 Month"). A month is taken as 30 days; z.ai documents no unit table, so the lengths other codes would mean are not guessed.
 */
const ZAI_UNIT_HOURS = 3;
const ZAI_UNIT_MONTHS = 5;
const ZAI_UNIT_MS: ReadonlyMap<number, number> = new Map([
  [ZAI_UNIT_HOURS, SECONDS_PER_HOUR * MS_PER_SECOND],
  [ZAI_UNIT_MONTHS, DAYS_PER_MONTH * HOURS_PER_DAY * SECONDS_PER_HOUR * MS_PER_SECOND],
]);

/** What z.ai names each limit type, in the snapshot's terms. */
const ZAI_MEASURES: Readonly<Record<string, string>> = { TOKENS_LIMIT: "tokens", TIME_LIMIT: "tool-calls" };

const ZaiLimitSchema = z.object({
  type: z.string(),
  unit: z.number().int(),
  number: z.number().int().positive(),
  percentage: z.number().nonnegative(),
  nextResetTime: z.number().positive().optional(),
  usage: z.number().nonnegative().optional(),
  currentValue: z.number().nonnegative().optional(),
  remaining: z.number().nonnegative().optional(),
});

const ZaiResponseSchema = z.object({
  success: z.boolean(),
  msg: z.string().optional(),
  data: z.object({ level: z.string().optional(), limits: z.array(ZaiLimitSchema) }),
});

function zaiWindow(limit: z.infer<typeof ZaiLimitSchema>): ProviderQuotaWindow {
  const unitMs = ZAI_UNIT_MS.get(limit.unit);
  return {
    measures: ZAI_MEASURES[limit.type] ?? limit.type.toLowerCase(),
    ...(unitMs === undefined ? { period: `unit ${String(limit.unit)} x ${String(limit.number)}` } : { periodMs: unitMs * limit.number }),
    utilization: limit.percentage / PERCENT,
    ...(limit.nextResetTime === undefined ? {} : { resetsAt: new Date(limit.nextResetTime).toISOString() }),
    ...(limit.usage === undefined ? {} : { limit: limit.usage }),
    ...(limit.currentValue === undefined ? {} : { used: limit.currentValue }),
    ...(limit.remaining === undefined ? {} : { remaining: limit.remaining }),
  };
}

/** z.ai's quota endpoint for the GLM Coding Plan. It takes the same key Claude Code authenticates with, sent raw in `Authorization` with no `Bearer` prefix. */
export const zaiQuotaAdapter: ProviderQuotaAdapter = {
  source: ZAI_SOURCE,
  matches: (baseUrl) => URL.canParse(baseUrl) && new URL(baseUrl).hostname === ZAI_HOST,
  fetch: async (apiKey, http, signal, nowMs) => {
    const response = await http(ZAI_QUOTA_URL, { authorization: apiKey, accept: "application/json" }, signal);
    if (response.status !== HTTP_OK) {
      throw new ProviderQuotaError(ZAI_SOURCE, `answered HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw new ProviderQuotaError(ZAI_SOURCE, "answered something that is not JSON");
    }
    const parsed = ZaiResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderQuotaError(ZAI_SOURCE, `answered an unexpected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    if (!parsed.data.success) {
      throw new ProviderQuotaError(ZAI_SOURCE, `reported failure${parsed.data.msg === undefined ? "" : `: ${parsed.data.msg}`}`);
    }
    return ProviderQuotaSchema.parse({
      observedAt: new Date(nowMs).toISOString(),
      source: ZAI_SOURCE,
      ...(parsed.data.data.level === undefined ? {} : { level: parsed.data.data.level }),
      windows: parsed.data.data.limits.map(zaiWindow),
    } satisfies ProviderQuota);
  },
};

/** Every adapter the project has, in match order. */
const PROVIDER_QUOTA_ADAPTERS: readonly ProviderQuotaAdapter[] = [zaiQuotaAdapter];

/** The adapter serving a provider with this base URL, or undefined when its quota is not readable from an endpoint. */
export function adapterFor(baseUrl: string): ProviderQuotaAdapter | undefined {
  return PROVIDER_QUOTA_ADAPTERS.find((adapter) => adapter.matches(baseUrl));
}

/**
 * How long a quota stays current enough that fetching it again would tell nothing new. Every window reports its use as a whole percentage, so the figure cannot change faster than one percent of the shortest window; fetching more often than that only repeats it. Windows with no known length are ignored, and a quota with none is never considered current (zero), so it is fetched on every demand.
 */
export function quotaFreshnessMs(quota: ProviderQuota): number {
  const lengths = quota.windows.flatMap((window) => (window.periodMs === undefined ? [] : [window.periodMs]));
  return lengths.length === 0 ? 0 : Math.min(...lengths) / PERCENT;
}
