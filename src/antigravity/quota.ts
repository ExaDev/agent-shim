/**
 * Antigravity quota and rate-limit translation into Anthropic unified headers.
 */

import { exhaustionHeaders } from "../usage/unifiedRefusal";
import { CCPA_DEFAULT_PROJECT_ID, CCPA_ENDPOINT, CCPA_USER_AGENT } from "./cloudUpstream";

const MS_PER_SECOND = 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const FRACTION_DIGITS = 3;

export interface AntigravityQuotaBucket {
  readonly remaining_fraction?: number;
  readonly reset_in_seconds?: number;
}

export type AntigravityQuotaMap = Readonly<Record<string, AntigravityQuotaBucket | undefined>>;

export interface AntigravityQuotaParams {
  readonly quota?: AntigravityQuotaMap;
  readonly rejected?: boolean;
  readonly nowMs: number;
  readonly model?: string;
}

const GEMINI_5H_KEYS = ["gemini-5h", "gemini_5h", "gemini"] as const;
const GEMINI_WEEKLY_KEYS = ["gemini-weekly", "gemini_weekly"] as const;
const ARGON_WEEKLY_KEYS = ["gemini-argon-wtu-weekly"] as const;
const THIRD_PARTY_5H_KEYS =["3p-5h", "claude-5h", "3p_5h", "claude_5h", "claude"] as const;
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

/** The quota windows an Antigravity account holds, in display order: each is named for the model family it limits (the Gemini family's five-hour and weekly windows, the third-party Claude and GPT-OSS pair, and Gemini 4 Argon's weekly window of its own) and found by the same bucket ids a model's own selection uses. */
const QUOTA_FAMILY_WINDOWS = [
  { label: "Gem 5h", keys: GEMINI_5H_KEYS },
  { label: "Gem Wk", keys: GEMINI_WEEKLY_KEYS },
  { label: "3P 5h", keys: THIRD_PARTY_5H_KEYS },
  { label: "3P Wk", keys: THIRD_PARTY_WEEKLY_KEYS },
  { label: "Argon Wk", keys: ARGON_WEEKLY_KEYS },
] as const;

/** Every quota window the map holds, labelled by the family it limits and in a fixed order, whichever model is in use: a session shows the whole account's limits, not just the window its current model draws on. */
export function antigravityFamilyBuckets(quota: AntigravityQuotaMap): readonly { readonly label: string; readonly bucket: AntigravityQuotaBucket }[] {
  return QUOTA_FAMILY_WINDOWS.flatMap(({ label, keys }) => {
    const bucket = findBucket(quota, keys);
    return bucket === undefined ? [] : [{ label, bucket }];
  });
}

/**
 * The five-hour and weekly buckets a model draws from: a gemini model its gemini buckets, any other model the third-party ones. The map is the one the quota endpoint's translation and the Antigravity CLI's own statusline payload share, keyed by bucket id.
 */
export function selectAntigravityBuckets(quota: AntigravityQuotaMap, model: string | undefined): { readonly fiveHour: AntigravityQuotaBucket | undefined; readonly weekly: AntigravityQuotaBucket | undefined } {
  const lower = (model ?? "").toLowerCase();
  // Gemini 4 Argon draws on a weekly window of its own and has no five-hour one, so the Gemini family's five-hour bucket (spent, or not) says nothing about it.
  if (lower.includes("argon")) {
    return { fiveHour: undefined, weekly: findBucket(quota, ARGON_WEEKLY_KEYS) };
  }
  const isGemini = lower.includes("gemini");
  return {
    fiveHour: findBucket(quota, isGemini ? GEMINI_5H_KEYS : THIRD_PARTY_5H_KEYS),
    weekly: findBucket(quota, isGemini ? GEMINI_WEEKLY_KEYS : THIRD_PARTY_WEEKLY_KEYS),
  };
}

const SECONDS_PER_HOUR = 3600;
const HOURS_PER_FIVE_HOUR_WINDOW = 5;
const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;
const FIVE_HOUR_PERIOD_SECONDS = HOURS_PER_FIVE_HOUR_WINDOW * SECONDS_PER_HOUR;
const WEEK_PERIOD_SECONDS = DAYS_PER_WEEK * HOURS_PER_DAY * SECONDS_PER_HOUR;

/** How much more allowance a window holds than its remaining time would let a steady burn use: the allowance left over the share of its period still to run. Above one, spending at the pace the period implies would still leave allowance to lapse unused at the reset, so the window is worth spending now; at one it is on pace, and below one it is being drawn faster than its period refills, so it is worth sparing. A window not yet used since its reset has all of its allowance and all of its period, which is one: neutral, neither urgent nor spared. */
function windowPressure(bucket: AntigravityQuotaBucket | undefined, periodSeconds: number): number | undefined {
  const remaining = bucket?.remaining_fraction;
  const resetIn = bucket?.reset_in_seconds;
  if (remaining === undefined || resetIn === undefined || !Number.isFinite(remaining) || !Number.isFinite(resetIn)) {
    return undefined;
  }
  const periodLeft = Math.min(1, Math.max(resetIn, 1) / periodSeconds);
  return Math.max(0, remaining) / periodLeft;
}

/**
 * How worth spending a model's quota is right now, across both of its windows (five-hour and weekly): the lower of the two windows' pressures, because a request must clear both, so the tighter window limits how fast the allowance can be used. Undefined when neither window's state is known.
 */
export function antigravityQuotaPressure(quota: AntigravityQuotaMap | undefined, model: string): number | undefined {
  const { fiveHour, weekly } = selectAntigravityBuckets(quota ?? {}, model);
  const pressures = [windowPressure(fiveHour, FIVE_HOUR_PERIOD_SECONDS), windowPressure(weekly, WEEK_PERIOD_SECONDS)].filter((pressure) => pressure !== undefined);
  return pressures.length === 0 ? undefined : Math.min(...pressures);
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
 * Derives the `anthropic-ratelimit-unified-*` headers from Antigravity quota state or 429 status. Emits nothing when the quota map names no bucket and the response was allowed: a status-only block would tell the usage snapshot the windows are gone, erasing the last known ones on a response served while the quota cache was cold.
 */
export function unifiedAntigravityQuotaHeaders(params: AntigravityQuotaParams): Record<string, string> {
  const rejected = params.rejected === true;
  const nowSec = Math.floor(params.nowMs / MS_PER_SECOND);

  const { fiveHour: b5h, weekly: bWk } = selectAntigravityBuckets(params.quota ?? {}, params.model);

  const used5h = calculateUtilization(b5h?.remaining_fraction);
  const reset5h = calculateResetTimestamp(nowSec, b5h?.reset_in_seconds);

  const used7d = calculateUtilization(bWk?.remaining_fraction);
  const reset7d = calculateResetTimestamp(nowSec, bWk?.reset_in_seconds);

  const exhaustion = rejected ? antigravityQuotaExhaustion(params.quota, params.model, params.nowMs) : undefined;
  // A rejection with no window known to be exhausted is an ordinary throttle (a per-minute limit, a cold quota cache), not the subscription limit: claiming a window would make the client report a limit the account has not reached, so it gets no unified headers and the route's retry-after alone.
  if (rejected && exhaustion === undefined) {
    return {};
  }
  if (!rejected && used5h === undefined && reset5h === undefined && used7d === undefined && reset7d === undefined) {
    return {};
  }

  const headers: Record<string, string> = {
    "anthropic-ratelimit-unified-status": rejected ? "rejected" : "allowed",
  };

  let earliestResetSec: number | undefined;

  if (used5h !== undefined && reset5h !== undefined) {
    headers["anthropic-ratelimit-unified-5h-utilization"] = used5h;
    headers["anthropic-ratelimit-unified-5h-reset"] = reset5h;
    earliestResetSec = Number(reset5h);
    if (rejected) {
      headers["anthropic-ratelimit-unified-5h-status"] = exhaustion?.exhaustedWindows.includes("five_hour") === true ? "rejected" : "allowed";
    }
  }

  if (used7d !== undefined && reset7d !== undefined) {
    headers["anthropic-ratelimit-unified-7d-utilization"] = used7d;
    headers["anthropic-ratelimit-unified-7d-reset"] = reset7d;
    const reset7dSec = Number(reset7d);
    earliestResetSec = earliestResetSec === undefined ? reset7dSec : Math.min(earliestResetSec, reset7dSec);
    if (rejected) {
      headers["anthropic-ratelimit-unified-7d-status"] = exhaustion?.exhaustedWindows.includes("seven_day") === true ? "rejected" : "allowed";
    }
  }

  if (exhaustion !== undefined) {
    // The window that binds names itself and the instant it lifts, as the real API does, so the client can say which limit was hit and when it ends, and retrying before then cannot succeed: the overall reset is that instant, not the earliest of several windows (of which an unexhausted one resets sooner).
    return { ...headers, ...exhaustionHeaders({ window: exhaustion.window, resetSec: exhaustion.resetSec, nowSec }) };
  }

  if (earliestResetSec !== undefined) {
    headers["anthropic-ratelimit-unified-reset"] = String(earliestResetSec);
  }

  return headers;
}

/** The subscription windows the Antigravity CLI's quota map names, as the unified rate-limit family spells them. */
type AntigravityWindow = "five_hour" | "seven_day";

/** Which windows are spent and when the last of them lifts: the next request can succeed only after every spent window has reset, so the binding one is the latest. */
export interface AntigravityExhaustion {
  readonly window: AntigravityWindow;
  /** The instant the binding window resets, in epoch seconds. */
  readonly resetSec: number;
  /** Every spent window, binding or not. */
  readonly exhaustedWindows: readonly AntigravityWindow[];
}

/**
 * The windows of the model's own buckets that have nothing remaining, with the binding one named. Undefined when the quota map is absent or no bucket with a known reset is spent, which a caller must read as "not known to be a quota limit", never as "not limited".
 */
export function antigravityQuotaExhaustion(quota: AntigravityQuotaMap | undefined, model: string | undefined, nowMs: number): AntigravityExhaustion | undefined {
  const { fiveHour, weekly } = selectAntigravityBuckets(quota ?? {}, model);
  const nowSec = Math.floor(nowMs / MS_PER_SECOND);
  const spent: { window: AntigravityWindow; resetSec: number }[] = [];
  for (const [window, bucket] of [["five_hour", fiveHour], ["seven_day", weekly]] as const) {
    const remaining = bucket?.remaining_fraction;
    const resetIn = bucket?.reset_in_seconds;
    if (remaining !== undefined && Number.isFinite(remaining) && remaining <= 0 && resetIn !== undefined && Number.isFinite(resetIn) && resetIn >= 0) {
      spent.push({ window, resetSec: nowSec + Math.ceil(resetIn) });
    }
  }
  const binding = spent.reduce<{ window: AntigravityWindow; resetSec: number } | undefined>((latest, next) => (latest === undefined || next.resetSec > latest.resetSec ? next : latest), undefined);
  return binding === undefined ? undefined : { window: binding.window, resetSec: binding.resetSec, exhaustedWindows: spent.map((entry) => entry.window) };
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
  // The instant `cached` was read from the endpoint: its reset_in_seconds count from then, not from when a response is built from it.
  let readAtMs = Number.NEGATIVE_INFINITY;
  let refresh: Promise<void> | undefined;
  const refreshMs = params.refreshMs ?? ANTIGRAVITY_QUOTA_REFRESH_MS;
  const run = async (): Promise<void> => {
    const nowMs = params.now();
    const read = await params.fetchSummary(nowMs);
    if (read !== undefined) {
      cached = read;
      readAtMs = nowMs;
    }
    cachedAt = params.now();
  };
  return () => {
    const nowMs = params.now();
    if (nowMs - cachedAt >= refreshMs) {
      refresh ??= run().finally(() => {
        refresh = undefined;
      });
    }
    return cached === undefined ? undefined : ageQuotaMap(cached, nowMs - readAtMs);
  };
}

/** A quota map brought forward by the time since it was read, so each bucket's seconds-to-reset describe now rather than the read: served unaged, a response built a minute after the read would put every reset a minute too late. */
function ageQuotaMap(quota: AntigravityQuotaMap, elapsedMs: number): AntigravityQuotaMap {
  const elapsedSec = elapsedMs / MS_PER_SECOND;
  return Object.fromEntries(
    Object.entries(quota).map(([key, bucket]) => [key, bucket?.reset_in_seconds === undefined ? bucket : { ...bucket, reset_in_seconds: Math.max(0, bucket.reset_in_seconds - elapsedSec) }]),
  );
}
