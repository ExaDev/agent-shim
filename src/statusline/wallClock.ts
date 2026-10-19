import type { ResolvedStatusline } from "../config/statusline";
import type { StatuslinePorts } from "./ports";

/** The locale that writes a calendar day as year, month and day in one fixed order, so two instants are on the same day exactly when their keys are equal whatever locale the times themselves are written in. */
const DAY_KEY_LOCALE = "en-CA";

/**
 * `atMs` as a wall-clock time in the machine's locale and time zone, written under `settings.clock`: `14:30`, or `Oct 20 14:30` when the day is not `nowMs`'s own, so a time more than a day away is never mistaken for one today. The caller adds any wording around it.
 */
export function formatWallClock(atMs: number, nowMs: number, clock: StatuslinePorts["clock"], settings: ResolvedStatusline["clock"]): string {
  const { locale, timeZone } = clock;
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    ...(settings.seconds ? { second: "2-digit" } : {}),
    ...(settings.hourCycle === "auto" ? {} : { hourCycle: settings.hourCycle }),
  }).format(atMs);
  const dayKey = new Intl.DateTimeFormat(DAY_KEY_LOCALE, { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  if (dayKey.format(atMs) === dayKey.format(nowMs)) {
    return time;
  }
  return `${new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric" }).format(atMs)} ${time}`;
}
