import type { CodexErrorDetail } from "./events";

/** Reads one response header, or null when absent: the shape of the Fetch API's `Headers.get`. */
export interface HeaderReader {
  readonly get: (name: string) => string | null;
}

/**
 * The subscription quota headers the backend sends on every response (both windows' used percentage, window length and reset times). Forwarded verbatim so they reach Claude Code and anything diagnosing it, and read to derive the Anthropic rate-limit headers below.
 */
const QUOTA_FORWARD_HEADERS = [
  "x-codex-active-limit",
  "x-codex-plan-type",
  "x-codex-primary-used-percent",
  "x-codex-secondary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-secondary-window-minutes",
  "x-codex-primary-over-secondary-limit-percent",
  "x-codex-primary-reset-after-seconds",
  "x-codex-secondary-reset-after-seconds",
  "x-codex-primary-reset-at",
  "x-codex-secondary-reset-at",
] as const;

/** The quota headers present on an upstream response. */
export function quotaHeaders(upstream: HeaderReader): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of QUOTA_FORWARD_HEADERS) {
    const value = upstream.get(name);
    if (value !== null && value !== "") {
      headers[name] = value;
    }
  }
  return headers;
}

/** The percentage a refused request reports when the backend's headers say nothing: a quota refusal means the window is used up. */
const EXHAUSTED_PERCENT = 100;

const FULL_PERCENT = 100;
const MINUTES_PER_HOUR = 60;
const FIVE_HOUR_WINDOW_HOURS = 5;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/** The length the backend's `*-window-minutes` headers report for the five-hour window. */
const FIVE_HOUR_MINUTES = FIVE_HOUR_WINDOW_HOURS * MINUTES_PER_HOUR;

/** The length the backend's `*-window-minutes` headers report for the weekly window. */
const SEVEN_DAY_MINUTES = DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR;

/** One quota window as the backend reports it: whole percent used, and the epoch-seconds reset exactly as the header gave it. */
interface WindowReading {
  readonly usedPercent: number;
  readonly resetAt: string;
}

interface WindowReadings {
  readonly fiveHour: WindowReading | undefined;
  readonly sevenDay: WindowReading | undefined;
}

/**
 * The five-hour and weekly windows in an upstream response, told apart by their reported length and never by position: the backend's `primary` is the five-hour window on an account that has one and the weekly window on one that does not, so the slot a window arrives in says nothing about which window it is. A slot missing its used percentage or reset, or of any other length, is not read. When the headers describe no window at all and the request was refused, the weekly window is reported used up, resetting when the primary header or the quota envelope says.
 */
function windowReadings(upstream: HeaderReader, exhausted: boolean, quotaError: CodexErrorDetail | undefined): WindowReadings {
  let fiveHour: WindowReading | undefined;
  let sevenDay: WindowReading | undefined;
  for (const slot of ["primary", "secondary"] as const) {
    const minutes = Number(upstream.get(`x-codex-${slot}-window-minutes`));
    const used = upstream.get(`x-codex-${slot}-used-percent`);
    const reset = upstream.get(`x-codex-${slot}-reset-at`);
    if (used === null || used === "" || reset === null || reset === "") {
      continue;
    }
    const reading = { usedPercent: Number(used), resetAt: reset };
    if (minutes === FIVE_HOUR_MINUTES) {
      fiveHour = reading;
    } else if (minutes === SEVEN_DAY_MINUTES) {
      sevenDay = reading;
    }
  }
  if (fiveHour === undefined && sevenDay === undefined && exhausted) {
    const reset = upstream.get("x-codex-primary-reset-at") ?? (quotaError?.resets_at === undefined ? null : String(quotaError.resets_at));
    if (reset !== null && reset !== "") {
      sevenDay = { usedPercent: EXHAUSTED_PERCENT, resetAt: reset };
    }
  }
  return { fiveHour, sevenDay };
}

/**
 * The `anthropic-ratelimit-unified-*` headers Claude Code reads (it parses only this family), derived from the backend's quota headers. Their presence on a 429 is what switches Claude Code from generic backoff to its plan-limit wait. Each window needs both its utilisation and reset fields or Claude Code ignores it, and utilisation is a fraction there where the backend reports whole percent. `anthropic-ratelimit-unified-reset` is the earliest reset among the windows present.
 */
export function unifiedQuotaHeaders(upstream: HeaderReader, rejected: boolean, quotaError: CodexErrorDetail | undefined): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-ratelimit-unified-status": rejected ? "rejected" : "allowed" };
  const { fiveHour, sevenDay } = windowReadings(upstream, rejected, quotaError);
  const resets: number[] = [];
  for (const [name, reading] of [["7d", sevenDay], ["5h", fiveHour]] as const) {
    if (reading !== undefined) {
      headers[`anthropic-ratelimit-unified-${name}-utilization`] = String(reading.usedPercent / FULL_PERCENT);
      headers[`anthropic-ratelimit-unified-${name}-reset`] = reading.resetAt;
      resets.push(Number(reading.resetAt));
    }
  }
  if (resets.length > 0) {
    headers["anthropic-ratelimit-unified-reset"] = String(Math.min(...resets));
  }
  return headers;
}

/** Milliseconds per second, for the epoch-second reset times the backend reports. */
const MS_PER_SECOND = 1000;

/** One quota window in the usage snapshot. */
interface SnapshotWindow {
  readonly used_percentage: number;
  readonly resets_at: string;
}

/**
 * The usage sidecar snapshot a statusline (claude-hud's `display.externalUsagePath`) reads, since Claude Code emits its own rate-limit payload only for subscriber-auth sessions and never for a provider launch. The reader ignores it once older than its freshness window, so it expires by itself between sessions.
 */
export interface UsageSnapshot {
  readonly updated_at: string;
  readonly seven_day?: SnapshotWindow;
  readonly five_hour?: SnapshotWindow;
}

/** One window as the snapshot states it. */
function snapshotWindow(reading: WindowReading | undefined): SnapshotWindow | undefined {
  return reading === undefined ? undefined : { used_percentage: reading.usedPercent, resets_at: new Date(Number(reading.resetAt) * MS_PER_SECOND).toISOString() };
}

/** Builds the usage snapshot from an upstream response's quota headers, or undefined when they describe no window at all. */
export function buildUsageSnapshot(upstream: HeaderReader, quotaError: CodexErrorDetail | undefined, nowMs: number): UsageSnapshot | undefined {
  const { fiveHour, sevenDay } = windowReadings(upstream, quotaError !== undefined, quotaError);
  const fiveHourWindow = snapshotWindow(fiveHour);
  const sevenDayWindow = snapshotWindow(sevenDay);
  if (sevenDayWindow === undefined && fiveHourWindow === undefined) {
    return undefined;
  }
  return {
    updated_at: new Date(nowMs).toISOString(),
    ...(sevenDayWindow === undefined ? {} : { seven_day: sevenDayWindow }),
    ...(fiveHourWindow === undefined ? {} : { five_hour: fiveHourWindow }),
  };
}

/** The `retry-after` seconds for a 429: the quota envelope's own reset countdown, else the primary window's header, so Claude Code paces its retries instead of hammering blind. Undefined when neither gives a positive number. */
export function retryAfterSeconds(upstream: HeaderReader, quotaError: CodexErrorDetail | undefined): number | undefined {
  const seconds = quotaError?.resets_in_seconds ?? Number(upstream.get("x-codex-primary-reset-after-seconds"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}
