import path from "node:path";
import { z } from "zod";

import { CLIENT_SESSION_ID_PATTERN } from "../usage/schema";
import { readStateText } from "./cacheFile";
import type { SessionCost } from "./cost";
import type { StatuslinePorts } from "./ports";

/** The directory of the statusline's state directory that holds the ledger: one directory per local calendar day, and in it one file per session. */
export const DAILY_LEDGER_DIRECTORY = "daily-cost";

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;

/** A session unseen for this long is a new one to the ledger: spend since it was last drawn is not carried into a new day. */
const SESSION_MAX_AGE_MS = HOURS_PER_DAY * MS_PER_HOUR;

/** An entry's last-seen time is refreshed at most this often when nothing else about it changed, so a render that adds nothing does not rewrite the file; the lag is a twenty-fourth of the age at which a session counts as new. */
const LAST_SEEN_REFRESH_MS = SESSION_MAX_AGE_MS / HOURS_PER_DAY;

/** An entry's file name: a session id, which cannot name another path or start with a dot, then `.json`. A temporary file `writeText` leaves beside it while it writes starts with a dot, so it never reads as an entry, whether it is mid-write or left by a process that was killed. */
const ENTRY_FILE = new RegExp(`^${CLIENT_SESSION_ID_PATTERN.source.slice(1, -1)}\\.json$`);
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const usd = z.number().nonnegative();

/**
 * One session's account on one day: the cost when the session was first seen (`baselineUsd`), so only what it spent afterwards counts for the day; the highest cost seen since (`totalUsd`); where the figures came from; and when it was last seen. The absolute total is stored, never a delta, so a render that is overwritten by another of the same session costs nothing: the next one stores the right total again. A session binds to the source of its first figure, because the client's figure and the door's estimate are two scales and a baseline taken on one means nothing on the other.
 */
const EntrySchema = z.strictObject({ baselineUsd: usd, totalUsd: usd, source: z.enum(["native", "estimate"]), seenAtMs: z.number().int().positive() });
type Entry = z.infer<typeof EntrySchema>;

/** The local calendar day an instant falls on, so the day's total starts again at the person's own midnight and not at UTC's. */
function localDay(nowMs: number): string {
  const date = new Date(nowMs);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The entry a file holds, or undefined when there is none or it is not one. A damaged file is read as none and not reported: a session's file for today is replaced by the session's next render that lists the `dailyCost` segment and has a cost to record, as on its first render of the day (see `advance`), and its file for the day before is only read, for the carry. */
function parseEntry(text: string | undefined): Entry | undefined {
  if (text === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = EntrySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The entry a render at `nowMs` leaves for the session, and whether it differs from the `existing` one. A session first seen today starts from its figure then, except that one drawn on the day before, within the last day, with the same source, starts from the total it had then: the spend since that last render, some of it before midnight, lands on the new day, because nothing says where in the gap it fell. */
function advance(existing: Entry | undefined, carried: Entry | undefined, cost: SessionCost, nowMs: number): { readonly entry: Entry; readonly changed: boolean } | undefined {
  if (existing === undefined) {
    const carry = carried?.source === cost.source && nowMs - carried.seenAtMs <= SESSION_MAX_AGE_MS ? carried.totalUsd : undefined;
    const baselineUsd = carry ?? cost.usd;
    return { entry: { baselineUsd, totalUsd: Math.max(baselineUsd, cost.usd), source: cost.source, seenAtMs: nowMs }, changed: true };
  }
  if (existing.source !== cost.source) {
    return undefined;
  }
  if (cost.usd > existing.totalUsd || nowMs - existing.seenAtMs >= LAST_SEEN_REFRESH_MS) {
    return { entry: { ...existing, totalUsd: Math.max(existing.totalUsd, cost.usd), seenAtMs: nowMs }, changed: true };
  }
  return { entry: existing, changed: false };
}

/**
 * Today's spend across every session that has been seen on this machine, or undefined while none has: folds the session's cost into its own file for the day and returns what the day's sessions have spent since each was first seen. Each session writes only its own file, so sessions drawing at the same moment cannot overwrite one another's entries, and the day's total is the sum of the files. The day before is kept, for a session that spans midnight to carry from, and days earlier than that are removed; a day dated after today (the clock was set back, or the person travelled west) is left alone, since removing it would lose spend that is real.
 *
 * A session is bound to the source of its first figure, and a figure from the other source is not counted. So a session that started on the door's estimate (a routed session with `cost.routed` on) and later shows the client's own figure (the client reports a positive one once the door has no complete estimate, for example after a switch to an unpriced model) stops contributing to the day from that render on, keeping what it had added, while the cost segment itself draws the new figure on its own scale.
 */
export function recordDailySpend(ports: StatuslinePorts, nowMs: number, sessionId: string | undefined, cost: SessionCost | undefined): number | undefined {
  const root = path.join(ports.stateDirectory, DAILY_LEDGER_DIRECTORY);
  const today = localDay(nowMs);
  const days = (ports.listDirectory(root) ?? []).filter((name) => DAY_NAME.test(name));
  const previous = days.filter((day) => day < today).sort().at(-1);
  for (const day of days) {
    if (day < today && day !== previous) {
      ports.removePath(path.join(root, day));
    }
  }
  const todayDirectory = path.join(root, today);
  if (sessionId !== undefined && cost !== undefined && CLIENT_SESSION_ID_PATTERN.test(sessionId)) {
    const file = path.join(todayDirectory, `${sessionId}.json`);
    const carried = previous === undefined ? undefined : parseEntry(readStateText(ports, path.join(root, previous, `${sessionId}.json`)));
    const next = advance(parseEntry(readStateText(ports, file)), carried, cost, nowMs);
    if (next?.changed === true) {
      ports.writeText(file, `${JSON.stringify(next.entry)}\n`);
    }
  }
  const entries = (ports.listDirectory(todayDirectory) ?? []).filter((name) => ENTRY_FILE.test(name)).flatMap((name) => {
    const entry = parseEntry(readStateText(ports, path.join(todayDirectory, name)));
    return entry === undefined ? [] : [entry];
  });
  return entries.length === 0 ? undefined : entries.reduce((sum, entry) => sum + (entry.totalUsd - entry.baselineUsd), 0);
}
