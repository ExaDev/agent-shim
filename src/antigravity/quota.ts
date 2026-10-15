/**
 * Antigravity quota and rate-limit translation into Anthropic unified headers.
 */

import { CCPA_DEFAULT_PROJECT_ID, CCPA_ENDPOINT, CCPA_USER_AGENT } from "./cloudUpstream";

const MS_PER_SECOND = 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const FRACTION_DIGITS = 3;
const EXHAUSTED_FRACTION = "1.000";

interface AntigravityQuotaBucket {
  readonly remaining_fraction?: number;
  readonly reset_in_seconds?: number;
}

export type AntigravityQuotaMap = Readonly<Record<string, AntigravityQuotaBucket | undefined>>;

export interface AntigravityQuotaParams {
  readonly quota?: AntigravityQuotaMap;
  readonly rejected?: boolean;
  readonly nowMs: number;
  readonly retryAfterSeconds?: number;
  readonly model?: string;
}

const GEMINI_5H_KEYS = ["gemini-5h", "gemini_5h", "gemini"] as const;
const GEMINI_WEEKLY_KEYS = ["gemini-weekly", "gemini_weekly"] as const;
const THIRD_PARTY_5H_KEYS = ["3p-5h", "claude-5h", "3p_5h", "claude_5h", "claude"] as const;
const THIRD_PARTY_WEEKLY_KEYS = ["3p-weekly", "claude-weekly", "3p_weekly", "claude_weekly"] as const;

function findBucket(quota: AntigravityQuotaMap, keys: readonly string[]): AntigravityQuotaBucket | undefined {
  for (const key of keys) {
    const bucket = quota[key];
    if (bucket !== undefined) {
      return bucket;
    }
  }
  return undefined;
}

/** Utilization is a used fraction from 0 to 1 (`0.81` is 81% used), the form the real API's headers carry: an integer percent here reads as a vast fraction, which Claude Code clamps to an exhausted window. */
function calculateUtilization(remainingFraction?: number): string | undefined {
  if (remainingFraction === undefined || !Number.isFinite(remainingFraction)) {
    return undefined;
  }
  const clampedRem = Math.max(0, Math.min(1, remainingFraction));
  const used = Math.max(0, 1 - clampedRem);
  return used.toFixed(FRACTION_DIGITS);
}

function calculateResetTimestamp(nowSec: number, resetInSeconds?: number): string | undefined {
  if (resetInSeconds === undefined || !Number.isFinite(resetInSeconds) || resetInSeconds < 0) {
    return undefined;
  }
  return String(nowSec + Math.ceil(resetInSeconds));
}

/**
 * Parses a `retry-after` header value (seconds or HTTP date), falling back to a default.
 */
export function parseRetryAfterSeconds(raw: string | null | undefined, defaultSeconds = DEFAULT_RETRY_AFTER_SECONDS): number {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return defaultSeconds;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const parsedDate = Date.parse(raw);
  if (!Number.isNaN(parsedDate)) {
    const diffSec = Math.ceil((parsedDate - Date.now()) / MS_PER_SECOND);
    return Math.max(1, diffSec);
  }
  return defaultSeconds;
}

/**
 * Derives the `anthropic-ratelimit-unified-*` headers from Antigravity quota state or 429 status.
 */
export function unifiedAntigravityQuotaHeaders(params: AntigravityQuotaParams): Record<string, string> {
  const rejected = params.rejected === true;
  const nowSec = Math.floor(params.nowMs / MS_PER_SECOND);
  const headers: Record<string, string> = {
    "anthropic-ratelimit-unified-status": rejected ? "rejected" : "allowed",
  };

  const modelLower = (params.model ?? "").toLowerCase();
  const isGemini = modelLower.includes("gemini");
  const fiveHourKeys = isGemini ? GEMINI_5H_KEYS : THIRD_PARTY_5H_KEYS;
  const weeklyKeys = isGemini ? GEMINI_WEEKLY_KEYS : THIRD_PARTY_WEEKLY_KEYS;

  const quota = params.quota ?? {};
  const b5h = findBucket(quota, fiveHourKeys);
  const bWk = findBucket(quota, weeklyKeys);

  const used5h = calculateUtilization(b5h?.remaining_fraction);
  const reset5h = calculateResetTimestamp(nowSec, b5h?.reset_in_seconds);

  const used7d = calculateUtilization(bWk?.remaining_fraction);
  const reset7d = calculateResetTimestamp(nowSec, bWk?.reset_in_seconds);

  let earliestResetSec: number | undefined;

  if (used5h !== undefined && reset5h !== undefined) {
    headers["anthropic-ratelimit-unified-5h-utilization"] = used5h;
    headers["anthropic-ratelimit-unified-5h-reset"] = reset5h;
    earliestResetSec = Number(reset5h);
  }

  if (used7d !== undefined && reset7d !== undefined) {
    headers["anthropic-ratelimit-unified-7d-utilization"] = used7d;
    headers["anthropic-ratelimit-unified-7d-reset"] = reset7d;
    const reset7dSec = Number(reset7d);
    earliestResetSec = earliestResetSec === undefined ? reset7dSec : Math.min(earliestResetSec, reset7dSec);
  }

  if (rejected) {
    const retrySec = params.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    const fallbackReset = String(nowSec + retrySec);
    if (headers["anthropic-ratelimit-unified-5h-utilization"] === undefined) {
      headers["anthropic-ratelimit-unified-5h-utilization"] = EXHAUSTED_FRACTION;
      headers["anthropic-ratelimit-unified-5h-reset"] = fallbackReset;
    }
    if (headers["anthropic-ratelimit-unified-7d-utilization"] === undefined) {
      headers["anthropic-ratelimit-unified-7d-utilization"] = EXHAUSTED_FRACTION;
      headers["anthropic-ratelimit-unified-7d-reset"] = fallbackReset;
    }
    earliestResetSec = earliestResetSec === undefined ? nowSec + retrySec : Math.min(earliestResetSec, nowSec + retrySec);
  }

  if (earliestResetSec !== undefined) {
    headers["anthropic-ratelimit-unified-reset"] = String(earliestResetSec);
  }

  return headers;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one retrieveUserQuotaSummary bucket into the quota map's shape: the API names camelCase fields and an absolute reset time, the map carries the proto-JSON names a quota translation consumes. */
function bucketToEntry(bucket: unknown, nowMs: number): { key: string; entry: AntigravityQuotaBucket } | undefined {
  if (!isRecord(bucket) || typeof bucket.bucketId !== "string") {
    return undefined;
  }
  const remainingFraction = typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction) ? bucket.remainingFraction : undefined;
  const resetMs = typeof bucket.resetTime === "string" ? Date.parse(bucket.resetTime) : Number.NaN;
  const resetInSeconds = Number.isNaN(resetMs) ? undefined : Math.max(0, Math.ceil((resetMs - nowMs) / MS_PER_SECOND));
  if (remainingFraction === undefined && resetInSeconds === undefined) {
    return undefined;
  }
  return {
    key: bucket.bucketId,
    entry: {
      ...(remainingFraction === undefined ? {} : { remaining_fraction: remainingFraction }),
      ...(resetInSeconds === undefined ? {} : { reset_in_seconds: resetInSeconds }),
    },
  };
}

export interface AntigravityQuotaFetchParams {
  readonly token: string;
  readonly endpoint?: string;
  readonly projectId?: string;
  readonly nowMs: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Reads the account's live quota windows from the Cloud Code endpoint's retrieveUserQuotaSummary, the same RPC the Antigravity CLI's usage display polls. Returns the buckets keyed by their backend id (gemini-5h, gemini-weekly, ...); a failed or unparseable read is undefined so a request's headers degrade to status-only rather than failing the request.
 */
export async function fetchAntigravityQuotaSummary(params: AntigravityQuotaFetchParams): Promise<AntigravityQuotaMap | undefined> {
  const fetchFn = params.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${params.endpoint ?? CCPA_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
        "User-Agent": CCPA_USER_AGENT,
      },
      body: JSON.stringify({ project: params.projectId ?? CCPA_DEFAULT_PROJECT_ID }),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.groups)) {
    return undefined;
  }
  const map: Record<string, AntigravityQuotaBucket> = {};
  for (const group of parsed.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      continue;
    }
    for (const bucket of group.buckets) {
      const read = bucketToEntry(bucket, params.nowMs);
      if (read !== undefined) {
        map[read.key] = read.entry;
      }
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/** How long a quota read stays fresh: the shortest window the summary reports is five hours, so a refresh cadence of one minute observes any movement of it with room to spare while staying far from the endpoint's attention. */
const ANTIGRAVITY_QUOTA_REFRESH_MS = 60_000;

export interface CachedAntigravityQuotaSourceParams {
  /** Reads the live summary; injected so tests never touch the network. */
  readonly fetchSummary: (nowMs: number) => Promise<AntigravityQuotaMap | undefined>;
  readonly now: () => number;
  readonly refreshMs?: number;
}

/**
 * A quota source for a route: returns the last read and, once it is stale, kicks one detached refresh whose result lands for later requests. A request never waits on the quota endpoint, a refresh already in flight is joined rather than duplicated, and a read that fails leaves the last good map in place until it succeeds again.
 */
export function createCachedAntigravityQuotaSource(params: CachedAntigravityQuotaSourceParams): () => AntigravityQuotaMap | undefined {
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached: AntigravityQuotaMap | undefined;
  let refresh: Promise<void> | undefined;
  const refreshMs = params.refreshMs ?? ANTIGRAVITY_QUOTA_REFRESH_MS;
  const run = async (): Promise<void> => {
    const nowMs = params.now();
    const read = await params.fetchSummary(nowMs);
    if (read !== undefined) {
      cached = read;
    }
    cachedAt = params.now();
  };
  return () => {
    const nowMs = params.now();
    if (nowMs - cachedAt < refreshMs) {
      return cached;
    }
    refresh ??= run().finally(() => {
      refresh = undefined;
    });
    return cached;
  };
}
