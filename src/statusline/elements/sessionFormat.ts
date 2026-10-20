import type { Translate } from "../messages/catalogues";

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

/** How long ago something happened, given the time since: the language's `just now` for a time that has not come yet, then `12s ago`, `5m ago`, `2h 5m ago`, `3d 4h ago`, with the units written the same in every language and the word `ago` placed as the language places it. */
export function formatAgo(ms: number, t: Translate): string {
  if (ms < 0) {
    return t("time.justNow");
  }
  const seconds = Math.floor(ms / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return t("time.ago", { value: `${String(seconds)}s` });
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return t("time.ago", { value: `${String(minutes)}m` });
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return t("time.ago", { value: twoUnits(hours, minutes % MINUTES_PER_HOUR, "h", "m") });
  }
  return t("time.ago", { value: twoUnits(Math.floor(hours / HOURS_PER_DAY), hours % HOURS_PER_DAY, "d", "h") });
}
