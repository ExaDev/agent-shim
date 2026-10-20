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
 * `atMs` as a wall-clock time in the machine's locale and time zone, written under `settings.clock`: `14:30`, or `20 Oct 14:30` when the day is not `nowMs`'s own, so a time more than a day away is never mistaken for one today. The hour is written the way the locale writes it in the cycle in use (`09:30` in a 24-hour cycle, `9:30 AM` in a 12-hour one). The caller adds any wording around it.
 */
export function formatWallClock(atMs: number, nowMs: number, clock: StatuslinePorts["clock"], settings: ResolvedStatusline["clock"]): string {
  const { locale, timeZone } = clock;
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    minute: "2-digit",
    ...(settings.seconds ? { second: "2-digit" } : {}),
    ...(settings.hourCycle === "auto" ? {} : { hourCycle: settings.hourCycle }),
  };
  // Only the cycle in use says how the hour is written: a 24-hour clock pads it (`09:30`) and a 12-hour one does not (`9:30 AM`).
  const cycle = formatterFor(locale, { ...options, hour: "numeric" }).resolvedOptions().hourCycle;
  const time = formatterFor(locale, { ...options, hour: cycle === "h23" || cycle === "h24" ? "2-digit" : "numeric" }).format(atMs);
  const dayKey = formatterFor(DAY_KEY_LOCALE, { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  if (dayKey.format(atMs) === dayKey.format(nowMs)) {
    return time;
  }
  return `${formatterFor(locale, { timeZone, month: "short", day: "numeric" }).format(atMs)} ${time}`;
}
