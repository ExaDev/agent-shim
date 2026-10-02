import path from "node:path";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { AccountMetadataError, isIdentityName } from "./account";
import { parseUnifiedRateLimit } from "./rateLimit";
import { listLogSegments, readUsageSnapshot, segmentDay, segmentName, snapshotPath, UsageSnapshotError } from "./read";
import { USAGE_SCHEMA_VERSION, UsageRecordSchema, UsageSnapshotSchema, type AccountMetadata, type ProviderUsageState, type UsageRecord, type UsageSnapshot } from "./schema";

/** The filesystem effects the usage store's writer performs, all owner-only. */
export type UsageFs = Pick<FarmFs, "mkdirPrivate" | "writeFilePrivate" | "appendFilePrivate" | "readFileUtf8" | "readdir" | "removeRecursive">;

const DAY_MS = 86_400_000;
const DAYS_IN_WEEK = 7;

/**
 * How long the usage log keeps records: seven days, the longest quota window any upstream claude-use routes to enforces (Anthropic's subscription `seven_day` window, and the weekly windows z.ai's GLM Coding Plan and MiniMax's Token Plan document). Consumers ask the log how a credential's quota was spent within its current windows; a record older than the longest window can no longer count against any of them. Segments are pruned whole, by day, so the log always covers at least the full window.
 */
export const USAGE_RETENTION_MS = DAYS_IN_WEEK * DAY_MS;

/** Removes every log segment whose day ended before the retention window began. Safe to race: removing a segment another pruner already removed does nothing. */
export function pruneUsageLog(fs: Pick<UsageFs, "readdir" | "removeRecursive">, logDir: string, nowMs: number): void {
  const cutoff = nowMs - USAGE_RETENTION_MS;
  for (const segment of listLogSegments(fs, logDir)) {
    if (segment.endsAt <= cutoff) {
      fs.removeRecursive(path.join(logDir, segment.name));
    }
  }
}

/** Everything the store's writer depends on. */
export interface UsageStoreDeps {
  readonly fs: UsageFs;
  readonly paths: Pick<LayoutPaths, "usageDir" | "usageLogDir" | "usageSnapshotsDir">;
  /** This process's pid, which names its own log segments: one writer per segment is what makes concurrent writers safe without locking. */
  readonly pid: number;
  readonly now: () => number;
  /** The identity's current account metadata, copied into its snapshot on every write so the snapshot is never staler than the last request. */
  readonly readAccount: (identity: string) => AccountMetadata | undefined;
  readonly log: (line: string) => void;
}

/** The store's writer. */
export interface UsageStore {
  /** Validates and appends one record, then refreshes its identity's snapshot. Throws on a write failure; the caller (the usage middleware) catches. */
  readonly record: (record: UsageRecord) => void;
}

/** The later of two ISO instants. */
function later(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

/** When a record's response head was seen: what its rate-limit headers and limit describe. */
function observedAt(record: UsageRecord): string {
  return new Date(Date.parse(record.at) + record.latencyMs).toISOString();
}

/**
 * Folds one record into its provider's latest state. Each part keeps whichever observation is newest, so records folded out of order (two door generations overlapping, each writing its own) still leave the latest state, never an older one.
 */
export function foldProviderState(current: ProviderUsageState | undefined, record: UsageRecord): ProviderUsageState {
  const seen = observedAt(record);
  const newest = current === undefined || record.at.localeCompare(current.lastRequestAt) >= 0;
  const rateLimit =
    record.rateLimitHeaders === undefined || (current?.rateLimit !== undefined && current.rateLimit.observedAt.localeCompare(seen) > 0)
      ? current?.rateLimit
      : (() => {
          const unified = parseUnifiedRateLimit(record.rateLimitHeaders);
          return { observedAt: seen, headers: record.rateLimitHeaders, ...(unified === undefined ? {} : { unified }) };
        })();
  const lastLimit =
    record.limit === undefined || (current?.lastLimit !== undefined && current.lastLimit.observedAt.localeCompare(seen) > 0)
      ? current?.lastLimit
      : { ...record.limit, observedAt: seen, status: record.status };
  const lastModel = newest ? (record.model ?? current?.lastModel) : (current.lastModel ?? record.model);
  return {
    lastRequestAt: current === undefined ? record.at : later(current.lastRequestAt, record.at),
    lastStatus: newest ? record.status : current.lastStatus,
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(lastLimit === undefined ? {} : { lastLimit }),
  };
}

/**
 * The usage store's writer, owned by the front-door process.
 *
 * The log is append-only JSON Lines under `usage/log/`, one segment per writing process per UTC day (`<YYYY-MM-DD>.<pid>.jsonl`). Every segment has exactly one writer, so concurrent writers (two door generations overlapping during a restart) can never interleave within a line, and readers (`claude-use usage`, other tools) need no lock: the only partial line they can meet is a segment's unfinished last one, which they skip. Retention is enforced by pruning whole segments on the first write of each day.
 *
 * Each identity's snapshot (`usage/snapshots/<identity>.json`) is rewritten atomically (a temporary sibling renamed into place) after every record, so a reader always sees a whole snapshot. Two writers racing on one snapshot can each overwrite the other's newest observation for a provider, but never corrupt the file; the next record repairs it, and the log, not the snapshot, is the record of truth. A snapshot that cannot be read (a newer schema, a corrupted file) is replaced with a fresh one, and the replacement is logged.
 *
 * Everything is created owner-only: the directories 0700, the files 0600.
 */
export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const { fs, paths } = deps;
  let prunedDay: string | undefined;

  const updateSnapshot = (record: UsageRecord, identity: string): void => {
    if (!isIdentityName(identity)) {
      // The identity header came from a launch whose name cannot be a file name here: the log keeps the record, and no snapshot is named after it.
      deps.log(`usage: no snapshot for identity "${identity}", which is not a valid identity name`);
      return;
    }
    let current: UsageSnapshot | undefined;
    try {
      current = readUsageSnapshot(fs, paths.usageSnapshotsDir, identity);
    } catch (error) {
      if (!(error instanceof UsageSnapshotError)) {
        throw error;
      }
      deps.log(`usage: replacing an unreadable snapshot: ${error.message}`);
    }
    let account: AccountMetadata | undefined;
    try {
      account = deps.readAccount(identity);
    } catch (error) {
      if (!(error instanceof AccountMetadataError)) {
        throw error;
      }
      // The quota state is what consumers act on; an unreadable profile must not hold it back. The snapshot goes out without an account, and the reason is logged.
      deps.log(`usage: snapshot for ${identity} written without account metadata: ${error.message}`);
    }
    const snapshot = UsageSnapshotSchema.parse({
      schemaVersion: USAGE_SCHEMA_VERSION,
      identity,
      updatedAt: new Date(deps.now()).toISOString(),
      ...(account === undefined ? {} : { account }),
      providers: { ...current?.providers, [record.provider]: foldProviderState(current?.providers[record.provider], record) },
    } satisfies UsageSnapshot);
    fs.mkdirPrivate(paths.usageSnapshotsDir);
    fs.writeFilePrivate(snapshotPath(paths.usageSnapshotsDir, identity), `${JSON.stringify(snapshot, null, 2)}\n`);
  };

  return {
    record: (input) => {
      // Validated before anything touches disk: the strict schema is what guarantees nothing beyond the named metadata fields is ever written.
      const record = UsageRecordSchema.parse(input);
      const nowMs = deps.now();
      fs.mkdirPrivate(paths.usageDir);
      fs.mkdirPrivate(paths.usageLogDir);
      const day = segmentDay(nowMs);
      if (prunedDay !== day) {
        pruneUsageLog(fs, paths.usageLogDir, nowMs);
        prunedDay = day;
      }
      fs.appendFilePrivate(path.join(paths.usageLogDir, segmentName(day, deps.pid)), `${JSON.stringify(record)}\n`);
      if (record.identity !== undefined) {
        updateSnapshot(record, record.identity);
      }
    },
  };
}
