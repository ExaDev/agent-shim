import type { UsageSnapshot } from "./schema";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** The statuses Anthropic's unified headers use for a window that is close to or past its limit: the API's own judgement, so no threshold of ours decides what counts as "nearly out". */
const WARNING_STATUSES: ReadonlySet<string> = new Set(["allowed_warning", "rejected"]);

/** A duration as its largest whole unit, such as `3h` or `2d`. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / (MS_PER_SECOND * SECONDS_PER_MINUTE));
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(Math.max(minutes, 0))}m`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_PER_DAY ? `${String(hours)}h` : `${String(Math.floor(hours / HOURS_PER_DAY))}d`;
}

/**
 * The launch-time warnings for an identity's quota, from the last rate-limit state the front door recorded for the provider this launch will use (`anthropic` for an OAuth launch). A window is reported when the API itself last marked it `allowed_warning` or `rejected`, and only while that window has not reset since: a reset time in the past means the observation describes a window that no longer exists. Each warning states how old the observation is, because the snapshot only changes when a request goes through the front door. Warnings never block a launch.
 */
export function quotaWarnings(snapshot: UsageSnapshot | undefined, provider: string, nowMs: number): string[] {
  const rateLimit = snapshot?.providers[provider]?.rateLimit;
  const unified = rateLimit?.unified;
  if (snapshot === undefined || rateLimit === undefined || unified === undefined) {
    return [];
  }
  const age = formatAge(nowMs - Date.parse(rateLimit.observedAt));
  const windows = [
    { name: "five-hour", window: unified.fiveHour },
    { name: "seven-day", window: unified.sevenDay },
  ];
  return windows.flatMap(({ name, window }) => {
    if (window?.status === undefined || !WARNING_STATUSES.has(window.status)) {
      return [];
    }
    if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) {
      return [];
    }
    const reset = window.resetsAt === undefined ? "" : `, resets ${window.resetsAt}`;
    const verdict = window.status === "rejected" ? "exhausted" : "nearly used";
    return [`claude-use: identity ${snapshot.identity}: the ${name} quota is ${verdict}${reset} (last seen ${age} ago)`];
  });
}
