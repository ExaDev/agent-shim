/**
 * Antigravity quota and rate-limit translation into Anthropic unified headers.
 */

const MS_PER_SECOND = 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const PERCENT_MULTIPLIER = 100;
const EXHAUSTED_PERCENT = "100";

export interface AntigravityQuotaBucket {
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

function calculateUtilization(remainingFraction?: number): string | undefined {
  if (remainingFraction === undefined || !Number.isFinite(remainingFraction)) {
    return undefined;
  }
  const clampedRem = Math.max(0, Math.min(1, remainingFraction));
  const used = Math.max(0, 1 - clampedRem);
  return String(Math.round(used * PERCENT_MULTIPLIER));
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
      headers["anthropic-ratelimit-unified-5h-utilization"] = EXHAUSTED_PERCENT;
      headers["anthropic-ratelimit-unified-5h-reset"] = fallbackReset;
    }
    if (headers["anthropic-ratelimit-unified-7d-utilization"] === undefined) {
      headers["anthropic-ratelimit-unified-7d-utilization"] = EXHAUSTED_PERCENT;
      headers["anthropic-ratelimit-unified-7d-reset"] = fallbackReset;
    }
    earliestResetSec = earliestResetSec === undefined ? nowSec + retrySec : Math.min(earliestResetSec, nowSec + retrySec);
  }

  if (earliestResetSec !== undefined) {
    headers["anthropic-ratelimit-unified-reset"] = String(earliestResetSec);
  }

  return headers;
}
