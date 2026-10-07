import path from "node:path";
import { z } from "zod";

import { CliError } from "../cliError";
import type { Pool } from "../config/schema";
import { poolNameOf } from "../launcher/identity";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { poolMemberIdentity } from "../config/schema";
import { AccountMetadataError, readAccountMetadata } from "./account";
import { FIVE_HOUR_WINDOW_MS, rankPool, type PoolMember, type PoolRanking, type StickyPick } from "./pick";
import { readUsageLog, readUsageSnapshot, UsageSnapshotError, type UsageReadFs } from "./read";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { USAGE_RETENTION_MS } from "./store";

/**
 * The store-backed side of pool picking: loads each member's recorded state and ranks it with `rankPool`, and keeps the per-directory record of the last pick. The launcher and `agent-shim pool pick` both go through `rankPoolGraph`, so the command shows exactly what a launch would choose.
 */

/** Raised while ranking a pool graph: a member names a pool that is not defined, or the graph reaches a pool it is already inside. `pool add` and `pool set` refuse both at write time; this is the guard for pools edited since. */
export class PoolGraphError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "PoolGraphError";
  }
}

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

/** Everything ranking a whole pool graph needs, injected so it runs against the same fakes as the rest of the launcher. */
export interface RankPoolGraphInput {
  readonly fs: PoolPickFs;
  readonly paths: PoolPickPaths;
  /** Every defined pool, so a nested `pool:<name>` entry can be ranked with its own policy. */
  readonly pools: Readonly<Record<string, Pool>>;
  readonly poolName: string;
  readonly nowMs: number;
  readonly sticky?: StickyPick;
  readonly resuming: boolean;
  /** Whether an identity exists on disk, so a member whose identity was removed is skipped exactly as a launch skips it. */
  readonly identityExists: (name: string) => boolean;
}

/** A pool graph's ranking, plus the identity entries anywhere in it that no longer exist. */
export interface PoolGraphRanking {
  readonly ranking: PoolRanking;
  readonly missing: readonly { readonly pool: string; readonly identity: string }[];
}

/**
 * Ranks the pool named `poolName` and everything it nests, as of `nowMs`, each pool with its own preference. A nested `pool:<name>` entry is ranked first, depth-first, and contributes its pick at the entry's position; when every member of the nested pool is refused the entry itself is ineligible, carrying the nested pool's earliest return. The sticky pick and the resuming flag thread through to every depth, so cache warmth is honoured however deep the sticky identity sits. Throws `PoolGraphError` for a member naming an undefined pool or for a cycle, naming the chain.
 */
export function rankPoolGraph(input: Readonly<RankPoolGraphInput>): PoolGraphRanking {
  return rankNamedPool(input, input.poolName, [], input.sticky);
}

/** Ranks one pool of the graph. `stack` is the chain of pools being ranked above this one, including this one, for the cycle guard. */
function rankNamedPool(input: Readonly<RankPoolGraphInput>, poolName: string, stack: readonly string[], sticky: StickyPick | undefined): PoolGraphRanking {
  const pool = input.pools[poolName];
  if (pool === undefined) {
    throw new PoolGraphError(`No pool named "${poolName}". Run \`agent-shim pool add ${poolName} --identity <name>...\` first.`);
  }
  const childStack = [...stack, poolName];

  // One log read per level: the direct identity entries are loaded as a batch, then laid down in member order around the nested entries' contributions.
  const direct = pool.identities.filter((entry) => poolNameOf(poolMemberIdentity(entry)) === undefined);
  const missing = direct.filter((entry) => !input.identityExists(poolMemberIdentity(entry))).map((entry) => ({ pool: poolName, identity: poolMemberIdentity(entry) }));
  const loaded = new Map(loadPoolMembers(input.fs, input.paths, direct.filter((entry) => input.identityExists(poolMemberIdentity(entry))).map(poolMemberIdentity), input.nowMs).map((member) => [member.identity, member]));
  const members: PoolMember[] = [];
  for (const entry of pool.identities) {
    const nestedName = poolNameOf(poolMemberIdentity(entry));
    if (nestedName === undefined) {
      const member = loaded.get(poolMemberIdentity(entry));
      if (member !== undefined) {
        members.push(member);
      }
      continue;
    }
    if (input.pools[nestedName] === undefined) {
      throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" names a pool that is not defined.`);
    }
    if (childStack.includes(nestedName)) {
      throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" closes a cycle: ${[...childStack.slice(childStack.indexOf(nestedName)), nestedName].join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
    }
    const nested = nestedMember(input, nestedName, childStack, sticky);
    members.push(nested.member);
    missing.push(...nested.missing);
  }
  const ranking = rankPool({
    members,
    nowMs: input.nowMs,
    resuming: input.resuming,
    ...(sticky === undefined ? {} : { sticky }),
    ...(pool.preference === undefined ? {} : { preference: pool.preference }),
  });
  return { ranking, missing };
}

/** What one nested `pool:<name>` entry contributes: its pool's pick as a member of the picked identity (re-ranked from that identity's own recorded state, with the composition in its reasons), or the entry's refusal when the nested pool has nothing to pick. */
function nestedMember(input: Readonly<RankPoolGraphInput>, nestedName: string, childStack: readonly string[], sticky: StickyPick | undefined): { readonly member: PoolMember; readonly missing: PoolGraphRanking["missing"] } {
  const nested = rankNamedPool(input, nestedName, childStack, sticky);
  const pick = nested.ranking.pick;
  if (pick !== undefined) {
    const [member] = loadPoolMembers(input.fs, input.paths, [pick.identity], input.nowMs);
    return { member: { ...(member ?? { identity: pick.identity, records: [] }), nested: { kind: "pick", pool: nestedName, reasons: pick.reasons } }, missing: nested.missing };
  }
  const earliestReturn = nested.ranking.earliestReturn;
  return {
    member: {
      identity: earliestReturn?.identity ?? `pool:${nestedName}`,
      records: [],
      nested: { kind: "refused", pool: nestedName, ...(earliestReturn === undefined ? {} : { earliestReturn }) },
    },
    missing: nested.missing,
  };
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
