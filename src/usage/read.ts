import path from "node:path";

import type { FarmFs } from "../launcher/ports";
import { isIdentityName } from "./account";
import { USAGE_SCHEMA_VERSION, UsageRecordSchema, UsageSnapshotSchema, type LimitKind, type UsageRecord, type UsageSnapshot } from "./schema";

/**
 * The read side of the usage store: pure over an injected filesystem, so the CLI, the library surface and tests all read the same way, and nothing here writes.
 */

/** The filesystem reads the usage store's readers need. */
export type UsageReadFs = Pick<FarmFs, "readFileUtf8" | "readdir">;

/** A log segment's file name: the UTC day its records were written on, then the writing process's pid. */
const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})\.(\d+)\.jsonl$/;

const DAY_MS = 86_400_000;

/** The UTC day an instant falls on, as a segment names it. */
export function segmentDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, "YYYY-MM-DD".length);
}

/** A segment's file name for one writer on one day. */
export function segmentName(day: string, pid: number): string {
  return `${day}.${String(pid)}.jsonl`;
}

/** One log segment found on disk. */
export interface LogSegment {
  readonly name: string;
  readonly day: string;
  /** The epoch milliseconds the segment's day ends at: no record in it is later. */
  readonly endsAt: number;
}

/** Lists the log's segments, oldest day first; files that are not segments (a stray temporary file) are not the log's and are ignored. */
export function listLogSegments(fs: Pick<FarmFs, "readdir">, logDir: string): readonly LogSegment[] {
  return fs
    .readdir(logDir)
    .flatMap((name) => {
      const match = SEGMENT_RE.exec(name);
      const day = match?.[1];
      if (day === undefined) {
        return [];
      }
      return [{ name, day, endsAt: Date.parse(`${day}T00:00:00.000Z`) + DAY_MS }];
    })
    .sort((left, right) => left.day.localeCompare(right.day) || left.name.localeCompare(right.name));
}

/** What a log read found. */
export interface UsageLogRead {
  /** Every valid record at or after the cut-off, oldest first. */
  readonly records: readonly UsageRecord[];
  /** Complete lines that did not parse as a record of this schema version: a corrupted line, or one a newer agent-shim wrote. Reported, never silently dropped. */
  readonly invalidLines: number;
}

/**
 * Reads the usage log, optionally only from `sinceMs` on. Each segment has a single writer that appends whole lines, so the only incomplete line a reader can meet is the last one of a segment still being written, which has no trailing newline yet; it is left for the next read rather than counted as invalid.
 */
export function readUsageLog(fs: UsageReadFs, logDir: string, options: { readonly sinceMs?: number } = {}): UsageLogRead {
  const { sinceMs } = options;
  const records: UsageRecord[] = [];
  let invalidLines = 0;
  for (const segment of listLogSegments(fs, logDir)) {
    if (sinceMs !== undefined && segment.endsAt <= sinceMs) {
      continue;
    }
    const read = readSegment(fs, logDir, segment);
    if (read === undefined) {
      continue;
    }
    invalidLines += read.invalidLines;
    for (const record of read.records) {
      if (sinceMs === undefined || Date.parse(record.at) >= sinceMs) {
        records.push(record);
      }
    }
  }
  records.sort((left, right) => left.at.localeCompare(right.at));
  return { records, invalidLines };
}

/** One segment's valid records in file order, and how many complete lines were not records; undefined for a segment pruned between the listing and the read. */
function readSegment(fs: UsageReadFs, logDir: string, segment: LogSegment): UsageLogRead | undefined {
  const contents = fs.readFileUtf8(path.join(logDir, segment.name));
  if (contents === undefined) {
    return undefined;
  }
  const records: UsageRecord[] = [];
  let invalidLines = 0;
  const lines = contents.split("\n");
  // Everything after the last newline is a write still in progress (or nothing at all).
  lines.pop();
  for (const line of lines) {
    if (line === "") {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = UsageRecordSchema.safeParse(raw);
    if (!parsed.success) {
      invalidLines += 1;
      continue;
    }
    records.push(parsed.data);
  }
  return { records, invalidLines };
}

/**
 * The newest `count` valid records, oldest first: exactly `readUsageLog(fs, logDir).records.slice(-count)`, without reading the segments that cannot hold one of them. Segments are read a day at a time, newest day first, and reading stops once the `count`-th newest record held is no earlier than the instant the next older day ends, because no record in an older segment is later than that instant (`LogSegment.endsAt`). A record is stamped before it is written, so a day's segments can hold records from just before the day began; that is why the stop test compares against the older day's end instead of assuming the days are disjoint.
 */
export function readRecentUsageRecords(fs: UsageReadFs, logDir: string, count: number): readonly UsageRecord[] {
  const byDay = new Map<string, LogSegment[]>();
  for (const segment of listLogSegments(fs, logDir)) {
    byDay.set(segment.day, [...(byDay.get(segment.day) ?? []), segment]);
  }
  const days = [...byDay.values()];
  // Oldest segment first, as `readUsageLog` concatenates, so the stable sort below breaks ties the same way.
  let records: UsageRecord[] = [];
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const dayRecords: UsageRecord[] = [];
    for (const segment of days[index] ?? []) {
      dayRecords.push(...(readSegment(fs, logDir, segment)?.records ?? []));
    }
    records = [...dayRecords, ...records];
    records.sort((left, right) => left.at.localeCompare(right.at));
    const olderDay = days[index - 1]?.[0];
    const newestHeld = records[records.length - count];
    if (olderDay === undefined || (newestHeld !== undefined && Date.parse(newestHeld.at) >= olderDay.endsAt)) {
      break;
    }
  }
  return records.slice(-count);
}

/** Raised for a snapshot file that exists but does not hold a snapshot of this schema version. */
export class UsageSnapshotError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file} is not a usage snapshot this agent-shim can read (schema version ${String(USAGE_SCHEMA_VERSION)}): ${detail}`);
    this.name = "UsageSnapshotError";
  }
}

/** The path of an identity's snapshot. Throws for an invalid identity name, which could otherwise name a path outside the snapshots directory. */
export function snapshotPath(snapshotsDir: string, identity: string): string {
  if (!isIdentityName(identity)) {
    throw new Error(`"${identity}" is not a valid identity name.`);
  }
  return path.join(snapshotsDir, `${identity}.json`);
}

/** Reads one identity's snapshot: undefined when it has none yet, `UsageSnapshotError` when the file is there but unreadable. */
export function readUsageSnapshot(fs: Pick<FarmFs, "readFileUtf8">, snapshotsDir: string, identity: string): UsageSnapshot | undefined {
  const file = snapshotPath(snapshotsDir, identity);
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageSnapshotError(file, "not valid JSON");
  }
  const snapshot = UsageSnapshotSchema.safeParse(parsed);
  if (!snapshot.success) {
    throw new UsageSnapshotError(file, snapshot.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return snapshot.data;
}

/** Reads every identity's snapshot, by identity name. */
export function listUsageSnapshots(fs: UsageReadFs, snapshotsDir: string): readonly UsageSnapshot[] {
  return fs
    .readdir(snapshotsDir)
    .flatMap((name) => {
      if (!name.endsWith(".json")) {
        return [];
      }
      const identity = name.slice(0, -".json".length);
      if (!isIdentityName(identity)) {
        return [];
      }
      const snapshot = readUsageSnapshot(fs, snapshotsDir, identity);
      return snapshot === undefined ? [] : [snapshot];
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
}

/** Token totals across a set of records. */
interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/** The totals for one identity and provider over a set of records. */
export interface UsageSummary {
  /** The identity, or undefined for requests from a launch that resolved none. */
  readonly identity: string | undefined;
  readonly provider: string;
  readonly requests: number;
  /** Responses with a status of 400 or above (refusals included). */
  readonly failed: number;
  /** Classified refusals, by kind. */
  readonly limits: Readonly<Record<LimitKind, number>>;
  readonly tokens: TokenTotals;
  readonly firstAt: string;
  readonly lastAt: string;
  /** The models the responses named, most-used first. */
  readonly models: readonly string[];
}

/** The lowest status that is an error response. */
const FIRST_ERROR_STATUS = 400;

/** Groups records by identity and provider and totals each group, ordered by identity then provider. */
export function summariseUsage(records: readonly UsageRecord[]): readonly UsageSummary[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = `${record.identity ?? ""}\u0000${record.provider}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [record]);
    } else {
      group.push(record);
    }
  }
  const summaries = [...groups.values()].flatMap((group) => {
    const [first] = group;
    const last = group.at(-1);
    if (first === undefined || last === undefined) {
      return [];
    }
    const modelCounts = new Map<string, number>();
    for (const record of group) {
      if (record.model !== undefined) {
        modelCounts.set(record.model, (modelCounts.get(record.model) ?? 0) + 1);
      }
    }
    const sum = (field: keyof TokenTotals): number => group.reduce((total, record) => total + (record.usage?.[field] ?? 0), 0);
    return [
      {
        identity: first.identity,
        provider: first.provider,
        requests: group.length,
        failed: group.filter((record) => record.status >= FIRST_ERROR_STATUS).length,
        limits: {
          "rate-limited": group.filter((record) => record.limit?.kind === "rate-limited").length,
          "quota-exhausted": group.filter((record) => record.limit?.kind === "quota-exhausted").length,
        },
        tokens: {
          inputTokens: sum("inputTokens"),
          outputTokens: sum("outputTokens"),
          cacheCreationInputTokens: sum("cacheCreationInputTokens"),
          cacheReadInputTokens: sum("cacheReadInputTokens"),
        },
        firstAt: first.at,
        lastAt: last.at,
        models: [...modelCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([model]) => model),
      },
    ];
  });
  return summaries.sort((left, right) => (left.identity ?? "").localeCompare(right.identity ?? "") || left.provider.localeCompare(right.provider));
}
