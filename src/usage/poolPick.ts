import path from "node:path";
import { z } from "zod";

import { CliError } from "../cliError";
import type { Pool } from "../config/schema";
import type { UsageRecord } from "./schema";
import { poolNameOf } from "../launcher/identity";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { poolMemberIdentity } from "../config/schema";
import { groupSharedLogins, loginKeyOf } from "../identityAccounts";
import { AccountMetadataError, readAccountMetadata } from "./account";
import { rankPool, type PoolMember, type PoolRanking, type StickyPick } from "./pick";
import { readUsageLog, readUsageSnapshot, UsageSnapshotError, type UsageReadFs } from "./read";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { USAGE_RETENTION_MS } from "./store";
import { FIVE_HOUR_WINDOW_MS } from "./windowLengths";

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

/** A member whose launch cannot be resolved to a provider because a configuration file it reads is unreadable: the provider it names, when something still named one, and why the file could not be read. The member is ranked on what is known and reported with the reason, and the launch that picks it refuses with the file's own error. */
export interface UnreadableProvider {
  readonly named?: string;
  readonly reason: string;
}

/** The provider a launch of a member routes through, by the member's name: undefined when the launch spends the member's own Claude account, and an `UnreadableProvider` when the files that decide it cannot be read. */
export type ProviderOf = (identity: string) => string | UnreadableProvider | undefined;

/**
 * Reads each member's snapshot, login metadata and the part of the log that reaches into the current five-hour window. Members are named by identity name, and their state is filed under the id `idOf` gives (the directory the identity is stored in, which a rename keeps): the snapshot, the login and the log records the front door wrote from the session's identity header. A name `idOf` knows no id for has no state. A member whose state cannot be read is carried with the reason instead of failing the pick.
 *
 * `providerOf` names the provider a member's launch spends, when it does not spend the member's Claude account: the member then carries that provider and its records are the ones the front door logged for it. A member whose provider cannot be resolved carries the reason too, so it is ranked as unknown and reported rather than failing the pick for the others. Without `providerOf` every member is the Claude account's.
 */
export function loadPoolMembers(fs: PoolPickFs, paths: PoolPickPaths, identities: readonly string[], nowMs: number, idOf: (name: string) => string | undefined, providerOf?: ProviderOf): readonly PoolMember[] {
  const windowStartMs = nowMs - FIVE_HOUR_WINDOW_MS;
  const log = readUsageLog(fs, paths.usageLogDir, { sinceMs: windowStartMs });
  // The log is read for the window already (`sinceMs`), so each record is in it. Grouped once by who it is for, each member takes its group instead of searching the whole log.
  const recordsOf = new Map<string, UsageRecord[]>();
  for (const record of log.records) {
    if (record.identity === undefined) {
      continue;
    }
    const key = `${record.identity}\u0000${record.provider}`;
    const group = recordsOf.get(key);
    if (group === undefined) {
      recordsOf.set(key, [record]);
    } else {
      group.push(record);
    }
  }
  return identities.map((identity): PoolMember => {
    const id = idOf(identity);
    if (id === undefined) {
      return { identity, records: [] };
    }
    const resolved = providerOf?.(identity);
    const provider = typeof resolved === "object" ? resolved.named : resolved;
    const providerField = {
      ...(provider === undefined ? {} : { provider }),
      ...(typeof resolved === "object" ? { providerError: resolved.reason } : {}),
    };
    const records = recordsOf.get(`${id}\u0000${provider ?? ANTHROPIC_PROVIDER}`) ?? [];
    try {
      const snapshot = readUsageSnapshot(fs, paths.usageSnapshotsDir, id);
      const account = readAccountMetadata(fs, paths.identitiesDir, id) ?? snapshot?.account;
      return { identity, records, ...providerField, ...(snapshot === undefined ? {} : { snapshot }), ...(account === undefined ? {} : { account }) };
    } catch (error) {
      if (error instanceof UsageSnapshotError || error instanceof AccountMetadataError) {
        return { identity, records, ...providerField, readError: errorMessage(error) };
      }
      throw error;
    }
  });
}

/** When a member's usage snapshot was written, as a comparable instant. A member with no snapshot sorts before every member that has one. */
function snapshotAgeKey(member: PoolMember): number {
  return member.snapshot === undefined ? Number.NEGATIVE_INFINITY : Date.parse(member.snapshot.updatedAt);
}

/**
 * Marks all but one of the direct members that hold the same login (same account uuid and organisation uuid, `loginKeyOf`) as twins of the one whose usage snapshot is freshest, which stands for the login. Members of one login draw on one quota window, so ranking each would count it twice, and a twin looks usable while its sibling is limited. The earliest listed member wins a tie. A nested `pool:<name>` entry is not grouped, so its pool keeps its own evaluation, a member with no account uuid is never grouped, and neither is a member whose launch spends a provider, since the Claude login it shares is not the quota it draws on. Returns `members` in the same order.
 */
function collapseSharedLogins(members: readonly PoolMember[]): readonly PoolMember[] {
  // Members that spend the same provider credential are deliberately not grouped either: the pick is equivalent whichever of them it names, so only their reasons can differ, and each reports its own slice.
  const groups = groupSharedLogins(members, (member) => (member.nested === undefined && member.provider === undefined && member.account !== undefined ? loginKeyOf(member.account) : undefined));
  const representativeOf = new Map<PoolMember, string>();
  for (const group of groups) {
    const representative = group.reduce((freshest, member) => (snapshotAgeKey(member) > snapshotAgeKey(freshest) ? member : freshest));
    for (const member of group) {
      if (member !== representative) {
        representativeOf.set(member, representative.identity);
      }
    }
  }
  return members.map((member) => {
    const representative = representativeOf.get(member);
    return representative === undefined ? member : { ...member, sameLoginAs: representative };
  });
}

/** The last pick, moved onto the member that stands for its login when it was a twin in `members`: the conversation's prompt cache is per organisation, so the representative on the same login is as warm. */
function stickyOnRepresentative(sticky: StickyPick | undefined, members: readonly PoolMember[]): StickyPick | undefined {
  const twin = sticky === undefined ? undefined : members.find((member) => member.identity === sticky.identity && member.sameLoginAs !== undefined);
  return sticky === undefined || twin?.sameLoginAs === undefined ? sticky : { ...sticky, identity: twin.sameLoginAs };
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
  /** The size in tokens of the context a resumed conversation continues with, when the launch resumes one whose transcript was read. */
  readonly resumeContextTokens?: number;
  /** The context tokens already moving onto each member, by identity, so a pool ranked for several moving sessions counts the ones already placed. */
  readonly committedContextTokens?: Readonly<Record<string, number>>;
  /** The id (the directory it is stored in) of the identity of a name, or undefined when none is named so: a member whose identity was removed is skipped exactly as a launch skips it, and a member's state is read from where it is filed. */
  readonly identityIdOf: (name: string) => string | undefined;
  /** The provider a launch of each member routes through, so each member is ranked on that provider's quota in place of its Claude account's. Absent when no member's launch spends a provider. */
  readonly providerOf?: ProviderOf;
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
  const missing = direct.filter((entry) => input.identityIdOf(poolMemberIdentity(entry)) === undefined).map((entry) => ({ pool: poolName, identity: poolMemberIdentity(entry) }));
  const loaded = new Map(loadPoolMembers(input.fs, input.paths, direct.filter((entry) => input.identityIdOf(poolMemberIdentity(entry)) !== undefined).map(poolMemberIdentity), input.nowMs, input.identityIdOf, input.providerOf).map((member) => [member.identity, member]));
  const members: PoolMember[] = [];
  for (const entry of pool.identities) {
    const nestedName = poolNameOf(poolMemberIdentity(entry));
    if (nestedName === undefined) {
      const member = loaded.get(poolMemberIdentity(entry));
      if (member !== undefined) {
        members.push(typeof entry === "string" ? member : { ...member, policy: entry.when });
      }
      continue;
    }
    assertNestable(input.pools, poolName, poolMemberIdentity(entry), nestedName, childStack);
    const nested = nestedMember(input, nestedName, childStack, sticky);
    // A condition on a nested entry guards the whole subtree: it rides the contributed pick's member, so the same rule skips or demotes the entry whatever it nests.
    members.push(typeof entry === "string" ? nested.member : { ...nested.member, policy: entry.when });
    missing.push(...nested.missing);
  }
  const collapsed = collapseSharedLogins(members);
  const stickyPick = stickyOnRepresentative(sticky, collapsed);
  const ranking = rankPool({
    members: collapsed,
    nowMs: input.nowMs,
    resuming: input.resuming,
    ...(input.resumeContextTokens === undefined ? {} : { resumeContextTokens: input.resumeContextTokens }),
    ...(input.committedContextTokens === undefined ? {} : { committedContextTokens: input.committedContextTokens }),
    ...(stickyPick === undefined ? {} : { sticky: stickyPick }),
    ...(pool.preference === undefined ? {} : { preference: pool.preference }),
  });
  return { ranking, missing };
}

/** Refuses a nested `pool:<name>` entry that names a pool that is not defined or that closes a cycle. `childStack` is the chain of pools above and including the one holding the entry. */
function assertNestable(pools: Readonly<Record<string, Pool>>, poolName: string, member: string, nestedName: string, childStack: readonly string[]): void {
  if (pools[nestedName] === undefined) {
    throw new PoolGraphError(`Pool "${poolName}" member "${member}" names a pool that is not defined.`);
  }
  if (childStack.includes(nestedName)) {
    throw new PoolGraphError(`Pool "${poolName}" member "${member}" closes a cycle: ${[...childStack.slice(childStack.indexOf(nestedName)), nestedName].join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
  }
}

/** What one nested `pool:<name>` entry contributes: its pool's pick as a member of the picked identity (re-ranked from that identity's own recorded state, with the composition in its reasons), or the entry's refusal when the nested pool has nothing to pick. */
function nestedMember(input: Readonly<RankPoolGraphInput>, nestedName: string, childStack: readonly string[], sticky: StickyPick | undefined): { readonly member: PoolMember; readonly missing: PoolGraphRanking["missing"] } {
  const nested = rankNamedPool(input, nestedName, childStack, sticky);
  const pick = nested.ranking.pick;
  if (pick !== undefined) {
    const [member] = loadPoolMembers(input.fs, input.paths, [pick.identity], input.nowMs, input.identityIdOf, input.providerOf);
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

/**
 * The concrete identities the pool named `poolName` can launch as, in member order with a nested `pool:<name>` entry replaced by the identities of that pool at the entry's position, each identity once. It reads no usage and no identity file, so it lists every identity the pool graph names, whether or not it exists or is eligible: ranking is `rankPoolGraph`'s job.
 *
 * Throws `PoolGraphError` when the pool, or a pool it nests, is not defined, or when the graph reaches a pool it is already inside.
 */
export function poolIdentities(pools: Readonly<Record<string, Pool>>, poolName: string): readonly string[] {
  const found = new Set<string>();
  collectPoolIdentities(pools, poolName, [], found);
  return [...found];
}

function collectPoolIdentities(pools: Readonly<Record<string, Pool>>, poolName: string, stack: readonly string[], found: Set<string>): void {
  const pool = pools[poolName];
  if (pool === undefined) {
    throw new PoolGraphError(`No pool named "${poolName}". Run \`agent-shim pool add ${poolName} --identity <name>...\` first.`);
  }
  const childStack = [...stack, poolName];
  for (const entry of pool.identities) {
    const nestedName = poolNameOf(poolMemberIdentity(entry));
    if (nestedName === undefined) {
      found.add(poolMemberIdentity(entry));
      continue;
    }
    assertNestable(pools, poolName, poolMemberIdentity(entry), nestedName, childStack);
    collectPoolIdentities(pools, nestedName, childStack, found);
  }
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

/**
 * The picks file's text with every pick of identity `from` recorded as `to`, and how many that was. Undefined when `raw` is not a picks file this release can read (the reader treats it as empty too) or records no pick of `from`.
 */
export function picksWithIdentityRenamed(raw: string, from: string, to: string): { readonly text: string; readonly renamed: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = PicksFileSchema.safeParse(parsed);
  if (!result.success) {
    return undefined;
  }
  const entries = Object.entries(result.data.picks);
  const renamed = entries.filter(([, entry]) => entry.identity === from).length;
  if (renamed === 0) {
    return undefined;
  }
  const next: PicksFile = { ...result.data, picks: Object.fromEntries(entries.map(([directory, entry]) => [directory, entry.identity === from ? { ...entry, identity: to } : entry])) };
  return { text: `${JSON.stringify(next, null, 2)}\n`, renamed };
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
