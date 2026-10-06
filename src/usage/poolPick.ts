import path from "node:path";
import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { AccountMetadataError, readAccountMetadata } from "./account";
import { FIVE_HOUR_WINDOW_MS, rankPool, type PoolMember, type PoolRanking, type StickyPick } from "./pick";
import { readUsageLog, readUsageSnapshot, UsageSnapshotError, type UsageReadFs } from "./read";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { USAGE_RETENTION_MS } from "./store";

/**
 * The store-backed side of pool picking: loads each member's recorded state and ranks it with `rankPool`, and keeps the per-directory record of the last pick. The launcher and `agent-shim pool pick` both go through `rankPoolFromStore`, so the command shows exactly what a launch would choose.
 */

/** The reads a pool ranking needs: snapshots, the log and each member's login file. */
export type PoolPickFs = UsageReadFs & Pick<FarmFs, "readFileUtf8">;

type PoolPickPaths = Pick<LayoutPaths, "identitiesDir" | "usageLogDir" | "usageSnapshotsDir">;

const SCHEMA_VERSION = 1;

/** One directory's last pick. */
const PickEntrySchema = z.strictObject({ identity: z.string().min(1), at: z.iso.datetime() });

/** The `usage/picks.json` file: the last pool pick per directory, keyed by absolute directory. */
const PicksFileSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  picks: z.record(z.string().min(1), PickEntrySchema),
});
type PicksFile = z.infer<typeof PicksFileSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads each member's snapshot, login metadata and the part of the log that reaches into the current five-hour window. A member whose state cannot be read is carried with the reason instead of failing the pick. */
export function loadPoolMembers(fs: PoolPickFs, paths: PoolPickPaths, identities: readonly string[], nowMs: number): readonly PoolMember[] {
  const windowStartMs = nowMs - FIVE_HOUR_WINDOW_MS;
  const log = readUsageLog(fs, paths.usageLogDir, { sinceMs: windowStartMs });
  return identities.map((identity): PoolMember => {
    const records = log.records.filter((record) => record.identity === identity && record.provider === ANTHROPIC_PROVIDER && Date.parse(record.at) >= windowStartMs);
    try {
      const snapshot = readUsageSnapshot(fs, paths.usageSnapshotsDir, identity);
      const account = readAccountMetadata(fs, paths.identitiesDir, identity) ?? snapshot?.account;
      return { identity, records, ...(snapshot === undefined ? {} : { snapshot }), ...(account === undefined ? {} : { account }) };
    } catch (error) {
      if (error instanceof UsageSnapshotError || error instanceof AccountMetadataError) {
        return { identity, records, readError: errorMessage(error) };
      }
      throw error;
    }
  });
}

/** Ranks `identities` from what the usage store recorded, as of `nowMs`, in the pool's preference order ("score" when `preference` is absent). */
export function rankPoolFromStore(params: Readonly<{ fs: PoolPickFs; paths: PoolPickPaths; identities: readonly string[]; nowMs: number; sticky?: StickyPick; resuming: boolean; preference?: "score" | "listed" }>): PoolRanking {
  return rankPool({
    members: loadPoolMembers(params.fs, params.paths, params.identities, params.nowMs),
    nowMs: params.nowMs,
    resuming: params.resuming,
    ...(params.sticky === undefined ? {} : { sticky: params.sticky }),
    ...(params.preference === undefined ? {} : { preference: params.preference }),
  });
}

/** What reading the picks file found: the entries, and why they are empty when the file was unreadable. */
interface PicksRead {
  readonly file: PicksFile;
  readonly problem?: string;
}

function readPicksFile(fs: Pick<FarmFs, "readFileUtf8">, file: string): PicksRead {
  const empty: PicksFile = { schemaVersion: SCHEMA_VERSION, picks: {} };
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return { file: empty };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file: empty, problem: `${file} is not valid JSON` };
  }
  const result = PicksFileSchema.safeParse(parsed);
  return result.success ? { file: result.data } : { file: empty, problem: `${file} is not a picks file this agent-shim can read` };
}

/** The identity last picked from a pool for `directory`, with a note when the picks file was unreadable (a hint lost, never a launch blocked). */
export function readStickyPick(fs: Pick<FarmFs, "readFileUtf8">, picksFile: string, directory: string): { readonly sticky?: StickyPick; readonly problem?: string } {
  const read = readPicksFile(fs, picksFile);
  const entry = read.file.picks[directory];
  return { ...(entry === undefined ? {} : { sticky: entry }), ...(read.problem === undefined ? {} : { problem: read.problem }) };
}

/**
 * Records that `identity` was picked for `directory` at `nowMs`, dropping entries older than the usage log's retention so the file stays bounded by what the rest of the store keeps. The write is a whole-file atomic replace; two launches finishing together can lose one entry, which only costs a cache hint.
 */
export function recordStickyPick(fs: Pick<FarmFs, "readFileUtf8" | "writeFilePrivate" | "mkdirPrivate">, picksFile: string, directory: string, identity: string, nowMs: number): void {
  const current = readPicksFile(fs, picksFile).file.picks;
  const kept = Object.entries(current).filter(([, entry]) => nowMs - Date.parse(entry.at) <= USAGE_RETENTION_MS);
  const next: PicksFile = { schemaVersion: SCHEMA_VERSION, picks: { ...Object.fromEntries(kept), [directory]: { identity, at: new Date(nowMs).toISOString() } } };
  fs.mkdirPrivate(path.dirname(picksFile));
  fs.writeFilePrivate(picksFile, `${JSON.stringify(next, null, 2)}\n`);
}
