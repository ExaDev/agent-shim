import { AnchorSchema, WEEKDAYS, type Anchor, type Weekday } from "../config/schema";

/**
 * Anchors: the wall-clock times at which an identity should have a five-hour window open. Pure: the zone a bare anchor means and the clock both come in as values, so the front door's keeper and the tests share one reading of "when is the next anchor".
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const DAYS_IN_WEEK = 7;
const MS_PER_DAY = 86_400_000;
/** Midnight to midnight, with a day either side of a search, so a zone's offset from UTC (at most a day either way) never hides a local date that holds an instant in range. */
const SEARCH_MARGIN_DAYS = 1;

/** The `--anchor` spelling of every weekday, for `daily` and `weekdays`. */
const WORKING_DAYS = 5;
const WEEKDAY_SHORTHANDS: Readonly<Record<string, readonly Weekday[]>> = { daily: WEEKDAYS, weekdays: WEEKDAYS.slice(0, WORKING_DAYS) };

/** The offset of `timeZone` from UTC at an instant, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const wholeSecondMs = Math.floor(utcMs / MS_PER_SECOND) * MS_PER_SECOND;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(wholeSecondMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second")) - wholeSecondMs;
}

/**
 * The instant a wall-clock time falls on in `timeZone`. A time the zone skips (the hour a clock springs forward over) lands at the equivalent instant after the gap; a time it shows twice (the hour a clock falls back over) lands on its first showing.
 */
function wallTimeToUtcMs(date: { readonly year: number; readonly month: number; readonly day: number }, minutesOfDay: number, timeZone: string): number {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day) + minutesOfDay * MS_PER_MINUTE;
  // The offsets in force a day either side bracket any single transition, so each is a candidate reading of the wall time; one is valid when the zone really has that offset at the instant it implies.
  const candidates = [zoneOffsetMs(asUtc - MS_PER_DAY, timeZone), zoneOffsetMs(asUtc + MS_PER_DAY, timeZone)].map((offset) => ({ offset, instant: asUtc - offset }));
  const valid = candidates.filter(({ offset, instant }) => zoneOffsetMs(instant, timeZone) === offset).map(({ instant }) => instant);
  // No valid reading is a time the zone skips; the offset from before the gap places it just after.
  return valid.length === 0 ? asUtc - (candidates[0]?.offset ?? 0) : Math.min(...valid);
}

/** The local calendar date an instant falls on in `timeZone`. */
function localDate(utcMs: number, timeZone: string): { readonly year: number; readonly month: number; readonly day: number } {
  const local = new Date(utcMs + zoneOffsetMs(utcMs, timeZone));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

function weekdayOf(date: { readonly year: number; readonly month: number; readonly day: number }): Weekday {
  const sundayFirst = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const day = WEEKDAYS[(sundayFirst + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK];
  if (day === undefined) {
    throw new RangeError(`no weekday for day number ${String(sundayFirst)}`);
  }
  return day;
}

function minutesOfDayOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * MINUTES_PER_HOUR + (minutes ?? 0);
}

/**
 * Every instant the anchors fall on within `(afterMs, uptoMs]`, oldest first. An anchor without a `timeZone` is read in `defaultTimeZone`.
 */
export function anchorInstants(anchors: readonly Anchor[], afterMs: number, uptoMs: number, defaultTimeZone: string): readonly number[] {
  const instants = anchors.flatMap((anchor) => {
    const timeZone = anchor.timeZone ?? defaultTimeZone;
    const minutesOfDay = minutesOfDayOf(anchor.time);
    const first = localDate(afterMs - SEARCH_MARGIN_DAYS * MS_PER_DAY, timeZone);
    const found: number[] = [];
    for (let offset = 0; ; offset += 1) {
      const date = localDate(Date.UTC(first.year, first.month - 1, first.day + offset) + MS_PER_DAY / 2, "UTC");
      const instant = wallTimeToUtcMs(date, minutesOfDay, timeZone);
      if (instant > uptoMs + SEARCH_MARGIN_DAYS * MS_PER_DAY) {
        return found;
      }
      if (instant > afterMs && instant <= uptoMs && anchor.days.includes(weekdayOf(date))) {
        found.push(instant);
      }
    }
  });
  return instants.sort((left, right) => left - right);
}

/**
 * The latest anchor instant in `(handledMs, nowMs]`, or undefined when none has fallen since `handledMs`. The search looks back at most a week, which holds every anchor of a weekly schedule, so a keeper that was down for longer still finds only the latest one rather than replaying each missed day.
 */
export function dueAnchor(anchors: readonly Anchor[], nowMs: number, handledMs: number, defaultTimeZone: string): number | undefined {
  const since = Math.max(handledMs, nowMs - DAYS_IN_WEEK * MS_PER_DAY);
  return anchorInstants(anchors, since, nowMs, defaultTimeZone).at(-1);
}

/** A weekday name, or a range of them (`mon-fri`, wrapping past Sunday: `fri-mon`), as the weekdays it covers. */
function parseDayItem(item: string): readonly Weekday[] {
  const [from, to, ...extra] = item.split("-");
  const index = (name: string | undefined): number => WEEKDAYS.findIndex((day) => day === name);
  if (from === undefined || extra.length > 0 || index(from) === -1 || (to !== undefined && index(to) === -1)) {
    throw new Error(`"${item}" is not a weekday (${WEEKDAYS.join(", ")}) or a range such as mon-fri`);
  }
  if (to === undefined) {
    return [WEEKDAYS[index(from)] ?? "mon"];
  }
  const length = ((index(to) - index(from) + DAYS_IN_WEEK) % DAYS_IN_WEEK) + 1;
  return Array.from({ length }, (_, step) => WEEKDAYS[(index(from) + step) % DAYS_IN_WEEK] ?? "mon");
}

/**
 * Parses an anchor as `--anchor` spells it: `<days>@<HH:MM>[/<time zone>]`, where days are `daily`, `weekdays`, or a comma-separated list of weekday names and ranges (`mon,wed,fri`, `mon-fri`, `sat-sun`). Throws an `Error` naming what is wrong.
 */
export function parseAnchor(spec: string): Anchor {
  const match = /^(?<days>[^@]+)@(?<time>[^/]+)(?:\/(?<zone>.+))?$/.exec(spec);
  const { days, time, zone } = match?.groups ?? {};
  if (days === undefined || time === undefined) {
    throw new Error(`"${spec}" is not an anchor: write <days>@<HH:MM>[/<time zone>], such as mon-fri@06:00 or sat,sun@08:30/Europe/London`);
  }
  const named = WEEKDAY_SHORTHANDS[days] ?? days.split(",").flatMap(parseDayItem);
  const parsed = AnchorSchema.safeParse({ days: [...new Set(named)], time, ...(zone === undefined ? {} : { timeZone: zone }) });
  if (!parsed.success) {
    throw new Error(`"${spec}" is not an anchor: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

/** The anchor spelling, for option help and usage errors. */
export const ANCHOR_SYNTAX = "<days>@<HH:MM>[/<time zone>], where days are daily, weekdays, or weekday names and ranges such as mon,wed or mon-fri, and the zone defaults to the machine's own";

/** An anchor in the spelling `parseAnchor` reads. */
export function formatAnchor(anchor: Readonly<Anchor>): string {
  return `${anchor.days.join(",")}@${anchor.time}${anchor.timeZone === undefined ? "" : `/${anchor.timeZone}`}`;
}

/** The runtime's own time zone, what an anchor without one means. */
export function machineTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
