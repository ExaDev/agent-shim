const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** How long a session has run: `<1m`, `5m`, `1h 5m`. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / (MS_PER_SECOND * SECONDS_PER_MINUTE));
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m`;
  }
  return `${String(Math.floor(minutes / MINUTES_PER_HOUR))}h ${String(minutes % MINUTES_PER_HOUR)}m`;
}

/** The two largest whole units of a span, as `value` and its remainder: `2h 5m`, `3d`. */
function twoUnits(larger: number, smaller: number, largerUnit: string, smallerUnit: string): string {
  return smaller > 0 ? `${String(larger)}${largerUnit} ${String(smaller)}${smallerUnit}` : `${String(larger)}${largerUnit}`;
}

/** How long ago something happened, given the time since: `just now` for a time that has not come yet, then `12s ago`, `5m ago`, `2h 5m ago`, `3d 4h ago`. */
export function formatAgo(ms: number): string {
  if (ms < 0) {
    return "just now";
  }
  const seconds = Math.floor(ms / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${twoUnits(hours, minutes % MINUTES_PER_HOUR, "h", "m")} ago`;
  }
  return `${twoUnits(Math.floor(hours / HOURS_PER_DAY), hours % HOURS_PER_DAY, "d", "h")} ago`;
}

/** A moment as `2026-10-19 20:05` in the time zone `timeZone` (an IANA name). */
export function formatStartDate(atMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(atMs);
  const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
}
