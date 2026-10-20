import type { ResolvedStatusline } from "../config/statusline";
import type { StatuslinePorts } from "./ports";

/** The locale that writes a calendar day as year, month and day in one fixed order, so two instants are on the same day exactly when their keys are equal whatever locale the times themselves are written in. */
const DAY_KEY_LOCALE = "en-CA";

/** Formatters already built, by the locale, time zone and options they were built from: constructing one is far dearer than using it, and a render writes several times with the same few. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string, options: Readonly<Intl.DateTimeFormatOptions>): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let formatter = FORMATTERS.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/**
 * `atMs` as a wall-clock time in the machine's locale and time zone, written under `settings.clock`: `14:30`, or `20 Oct 14:30` when the day is not `nowMs`'s own, so a time more than a day away is never mistaken for one today. The time is the locale's own short time form (or its medium form with seconds) in the hour cycle in use, so its padding, separators, digits and day period are the locale's: `09:30` for British English, `9:30` for Japanese, `9.30` for Finnish, `9:30 AM` for American English. The caller adds any wording around it.
 */
export function formatWallClock(atMs: number, nowMs: number, clock: StatuslinePorts["clock"], settings: ResolvedStatusline["clock"]): string {
  const { locale, timeZone } = clock;
  const time = formatterFor(locale, {
    timeZone,
    timeStyle: settings.seconds ? "medium" : "short",
    ...(settings.hourCycle === "auto" ? {} : { hourCycle: settings.hourCycle }),
  }).format(atMs);
  const dayKey = formatterFor(DAY_KEY_LOCALE, { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  if (dayKey.format(atMs) === dayKey.format(nowMs)) {
    return time;
  }
  return `${formatterFor(locale, { timeZone, month: "short", day: "numeric" }).format(atMs)} ${time}`;
}
