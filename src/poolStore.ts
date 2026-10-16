import { CliError, UsageError } from "./cliError";
import { readGlobalConfig } from "./configProfilesStore";
import { applyPatch } from "./config/store";
import { GlobalConfigSchema, PoolNameSchema, PoolSchema, poolMemberIdentity, type Pool, type PoolPreference } from "./config/schema";

/** One pool member entry, whichever form it takes: the plain selector string, or the object form carrying its policy condition. */
export type PoolMemberEntry = Pool["identities"][number];
import { poolNameOf } from "./launcher/identity";
import type { LayoutPaths } from "./paths";

/** Raised when a command names a pool that is not defined in the global config. */
export class PoolNotFoundError extends CliError {
  constructor(readonly poolName: string) {
    super(`No pool named "${poolName}". Run \`agent-shim pool add ${poolName} --identity <name>...\` first.`);
    this.name = "PoolNotFoundError";
  }
}

/** Raised by `addPool` when a pool with the given name is already defined. */
export class PoolAlreadyExistsError extends CliError {
  constructor(readonly poolName: string) {
    super(`A pool named "${poolName}" already exists. Use \`agent-shim pool set ${poolName}\` to change its members.`);
    this.name = "PoolAlreadyExistsError";
  }
}

/** Raised when a pool name fails `PoolNameSchema`. */
class InvalidPoolNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(`"${attemptedName}" is not a valid pool name: it must start with a letter or number and may then contain letters, numbers, dots, hyphens and underscores.`);
    this.name = "InvalidPoolNameError";
  }
}

/** The pools defined in `~/.agent-shim/config.json`, by name. */
export function readPools(paths: LayoutPaths): Readonly<Record<string, Pool>> {
  return readGlobalConfig(paths)?.pools ?? {};
}

/** The pool named `name`; throws `PoolNotFoundError` when none is defined. */
export function requirePool(paths: LayoutPaths, name: string): Pool {
  const pool = readPools(paths)[name];
  if (pool === undefined) {
    throw new PoolNotFoundError(name);
  }
  return pool;
}

/**
 * Writes the whole `pools` map back, because `applyPatch` replaces top-level keys wholesale. Whether identity members exist is the caller's concern (the `pool` command checks it, and `doctor` re-checks it later, since removing an identity does not rewrite the pools that list it); nested members and cycles are checked here, in `validateMembers`, because only the store sees the whole graph.
 */
function writePools(paths: LayoutPaths, pools: Readonly<Record<string, Pool>>): void {
  applyPatch(paths.globalConfigFile, GlobalConfigSchema, { pools }, { defaults: {} });
}

/**
 * The chain of pool names a cycle through `name` would follow in `pools`, or undefined when no nested member reaches back to it. Pure graph walk over the given pool map, so `pool add`/`pool set` can check the map the write would produce and `doctor` the map on disk.
 */
export function poolCycleOf(pools: Readonly<Record<string, Pool>>, name: string): readonly string[] | undefined {
  const walk = (current: string, path: readonly string[]): readonly string[] | undefined => {
    for (const entry of pools[current]?.identities ?? []) {
      const nested = poolNameOf(poolMemberIdentity(entry));
      if (nested === undefined) {
        continue;
      }
      // Reaching `name` again is the cycle being looked for; any other pool already on the path is a different cycle, which cannot reach `name` through itself.
      if (nested === name) {
        return [...path, nested];
      }
      if (path.includes(nested)) {
        continue;
      }
      const found = walk(nested, [...path, nested]);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(name, [name]);
}

/**
 * Refuses member entries only the store can see the problems with: a `pool:<name>` entry naming a pool that is not defined, and any nesting that would make the pool reach itself. Identity entries are the command's concern (`requireIdentities`); a nested entry's own identities are checked the same way when that pool was written.
 */
function validateMembers(pools: Readonly<Record<string, Pool>>, name: string, members: readonly PoolMemberEntry[]): void {
  for (const entry of members) {
    const identity = poolMemberIdentity(entry);
    const nested = poolNameOf(identity);
    if (nested !== undefined && nested !== name && pools[nested] === undefined) {
      throw new UsageError(`Member "${identity}" of pool "${name}" names a pool that is not defined. Run \`agent-shim pool add ${nested} --identity <name>...\` first.`);
    }
  }
  const cycle = poolCycleOf({ ...pools, [name]: { identities: [...members] } }, name);
  if (cycle !== undefined) {
    throw new UsageError(`Member "pool:${cycle[1] ?? name}" would make pool "${name}" reach itself: ${cycle.join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
  }
}

/** Refuses a pool whose settings contradict each other (a setting that needs another switched on), naming the pool and what is wrong, before anything is written. */
function requireConsistent(name: string, pool: Pool): void {
  const parsed = PoolSchema.safeParse(pool);
  if (!parsed.success) {
    throw new UsageError(`Pool "${name}": ${parsed.error.issues.map((issue) => issue.message).join("; ")}.`);
  }
}

/** The settings of a pool beside its members: every `Pool` field but `identities`, each one optional. A field left undefined is the pool's default for it. */
export type PoolPolicy = { readonly [Field in keyof Omit<Pool, "identities">]?: Omit<Pool, "identities">[Field] | undefined };

/** The policy fields `policy` actually sets, as the object a pool stores: a pool carries only what it changes, so an undefined field is left out, and a switch that is off is the same as an absent one. Accepts a whole `Pool` and returns just its policy. */
export function poolPolicyOf(policy: PoolPolicy): PoolPolicy {
  return {
    ...(policy.preference === undefined ? {} : { preference: policy.preference }),
    ...(policy.resumeOnLimit === true ? { resumeOnLimit: true } : {}),
    ...(policy.compactBeforeLimit === true ? { compactBeforeLimit: true } : {}),
    ...(policy.compactAtUtilisation === undefined ? {} : { compactAtUtilisation: policy.compactAtUtilisation }),
  };
}

/** What a change to an existing pool may name: the full new member list, and the policy fields to set, where `false` clears a field back to its default. A field left undefined is kept as it is. */
export interface PoolChange {
  readonly identities?: readonly PoolMemberEntry[] | undefined;
  readonly preference?: PoolPreference | false | undefined;
  /** True switches resuming on a spent quota on, false switches it off. */
  readonly resumeOnLimit?: boolean | undefined;
  /** True switches compacting before the quota is spent on, false switches it off. */
  readonly compactBeforeLimit?: boolean | undefined;
  /** The percent of a window to compact at, or false to clear it back to the launcher's own decision. */
  readonly compactAtUtilisation?: number | false | undefined;
}

/** Whether `change` names anything to change. */
export function isPoolChange(change: PoolChange): boolean {
  return change.identities !== undefined || change.preference !== undefined || change.resumeOnLimit !== undefined || change.compactBeforeLimit !== undefined || change.compactAtUtilisation !== undefined;
}

/** Defines a new pool. Throws `InvalidPoolNameError` for a name `PoolNameSchema` rejects, `PoolAlreadyExistsError` for one already defined, and `UsageError` for a nested member that names an undefined pool or a cycle. */
export function addPool(paths: LayoutPaths, name: string, identities: readonly PoolMemberEntry[], policy: PoolPolicy = {}): Pool {
  if (!PoolNameSchema.safeParse(name).success) {
    throw new InvalidPoolNameError(name);
  }
  const pools = readPools(paths);
  if (pools[name] !== undefined) {
    throw new PoolAlreadyExistsError(name);
  }
  validateMembers(pools, name, identities);
  const pool: Pool = { identities: [...identities], ...poolPolicyOf(policy) };
  requireConsistent(name, pool);
  writePools(paths, { ...pools, [name]: pool });
  return pool;
}

/** Applies `change` to an existing pool: the members it names replace the list, a policy field it names is set (or cleared, for `false`), and everything else is kept. Throws `PoolNotFoundError` when the pool is not defined, and `UsageError` for a nested member that names an undefined pool or a cycle. */
export function changePool(paths: LayoutPaths, name: string, change: PoolChange): Pool {
  const existing = requirePool(paths, name);
  const identities = change.identities ?? existing.identities;
  validateMembers(readPools(paths), name, identities);
  const preference = change.preference === undefined ? existing.preference : change.preference === false ? undefined : change.preference;
  const resumeOnLimit = change.resumeOnLimit ?? existing.resumeOnLimit;
  const compactBeforeLimit = change.compactBeforeLimit ?? existing.compactBeforeLimit;
  const compactAtUtilisation = change.compactAtUtilisation === undefined ? existing.compactAtUtilisation : change.compactAtUtilisation === false ? undefined : change.compactAtUtilisation;
  const pool: Pool = { identities: [...identities], ...poolPolicyOf({ preference, resumeOnLimit, compactBeforeLimit, compactAtUtilisation }) };
  requireConsistent(name, pool);
  writePools(paths, { ...readPools(paths), [name]: pool });
  return pool;
}

/** Removes a pool. Throws `PoolNotFoundError` when it is not defined. Anything that selected it (an active-identity file, a directory rule) is left for `doctor` to report, as with a removed identity. */
export function removePool(paths: LayoutPaths, name: string): void {
  requirePool(paths, name);
  const remaining = Object.fromEntries(Object.entries(readPools(paths)).filter(([existing]) => existing !== name));
  writePools(paths, remaining);
}
