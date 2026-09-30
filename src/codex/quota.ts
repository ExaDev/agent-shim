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
const EXHAUSTED_PERCENT = "100";

/**
 * The `anthropic-ratelimit-unified-*` headers Claude Code reads (it parses only this family), derived from the backend's quota headers. Their presence on a 429 is what switches Claude Code from generic backoff to its plan-limit wait. The backend's primary (7-day) window becomes the 7d window, and a secondary window, when the account has one, becomes 5h; each window needs both its utilisation and reset fields or Claude Code ignores it. `anthropic-ratelimit-unified-reset` is the earlier of the two resets.
 */
export function unifiedQuotaHeaders(upstream: HeaderReader, rejected: boolean, quotaError: CodexErrorDetail | undefined): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-ratelimit-unified-status": rejected ? "rejected" : "allowed" };
  const used7d = upstream.get("x-codex-primary-used-percent") ?? (rejected ? EXHAUSTED_PERCENT : null);
  const reset7d = upstream.get("x-codex-primary-reset-at") ?? (quotaError?.resets_at === undefined ? null : String(quotaError.resets_at));
  if (used7d !== null && reset7d !== null) {
    headers["anthropic-ratelimit-unified-7d-utilization"] = used7d;
    headers["anthropic-ratelimit-unified-7d-reset"] = reset7d;
    headers["anthropic-ratelimit-unified-reset"] = reset7d;
  }
  if (Number(upstream.get("x-codex-secondary-window-minutes")) > 0) {
    const used5h = upstream.get("x-codex-secondary-used-percent");
    const reset5h = upstream.get("x-codex-secondary-reset-at");
    if (used5h !== null && used5h !== "" && reset5h !== null && reset5h !== "") {
      headers["anthropic-ratelimit-unified-5h-utilization"] = used5h;
      headers["anthropic-ratelimit-unified-5h-reset"] = reset5h;
      const overall = headers["anthropic-ratelimit-unified-reset"];
      if (overall !== undefined) {
        headers["anthropic-ratelimit-unified-reset"] = String(Math.min(Number(overall), Number(reset5h)));
      }
    }
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

/** Builds the usage snapshot from an upstream response's quota headers, or undefined when they describe no window at all. */
export function buildUsageSnapshot(upstream: HeaderReader, quotaError: CodexErrorDetail | undefined, nowMs: number): UsageSnapshot | undefined {
  const used7 = upstream.get("x-codex-primary-used-percent") ?? (quotaError === undefined ? null : EXHAUSTED_PERCENT);
  const reset7 = upstream.get("x-codex-primary-reset-at") ?? (quotaError?.resets_at === undefined ? null : String(quotaError.resets_at));
  const sevenDay = used7 !== null && reset7 !== null ? { used_percentage: Number(used7), resets_at: new Date(Number(reset7) * MS_PER_SECOND).toISOString() } : undefined;
  let fiveHour: SnapshotWindow | undefined;
  if (Number(upstream.get("x-codex-secondary-window-minutes")) > 0) {
    const used5 = upstream.get("x-codex-secondary-used-percent");
    const reset5 = upstream.get("x-codex-secondary-reset-at");
    if (used5 !== null && reset5 !== null) {
      fiveHour = { used_percentage: Number(used5), resets_at: new Date(Number(reset5) * MS_PER_SECOND).toISOString() };
    }
  }
  if (sevenDay === undefined && fiveHour === undefined) {
    return undefined;
  }
  return {
    updated_at: new Date(nowMs).toISOString(),
    ...(sevenDay === undefined ? {} : { seven_day: sevenDay }),
    ...(fiveHour === undefined ? {} : { five_hour: fiveHour }),
  };
}

/** The `retry-after` seconds for a 429: the quota envelope's own reset countdown, else the primary window's header, so Claude Code paces its retries instead of hammering blind. Undefined when neither gives a positive number. */
export function retryAfterSeconds(upstream: HeaderReader, quotaError: CodexErrorDetail | undefined): number | undefined {
  const seconds = quotaError?.resets_in_seconds ?? Number(upstream.get("x-codex-primary-reset-after-seconds"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}
