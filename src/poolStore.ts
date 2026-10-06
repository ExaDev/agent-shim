import { CliError, UsageError } from "./cliError";
import { readGlobalConfig } from "./configProfilesStore";
import { applyPatch } from "./config/store";
import { GlobalConfigSchema, PoolNameSchema, type Pool, type PoolPreference } from "./config/schema";
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
class PoolAlreadyExistsError extends CliError {
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
      const nested = poolNameOf(entry);
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
function validateMembers(pools: Readonly<Record<string, Pool>>, name: string, members: readonly string[]): void {
  for (const entry of members) {
    const nested = poolNameOf(entry);
    if (nested !== undefined && nested !== name && pools[nested] === undefined) {
      throw new UsageError(`Member "${entry}" of pool "${name}" names a pool that is not defined. Run \`agent-shim pool add ${nested} --identity <name>...\` first.`);
    }
  }
  const cycle = poolCycleOf({ ...pools, [name]: { identities: [...members] } }, name);
  if (cycle !== undefined) {
    throw new UsageError(`Member "pool:${cycle[1] ?? name}" would make pool "${name}" reach itself: ${cycle.join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
  }
}

/** Defines a new pool. Throws `InvalidPoolNameError` for a name `PoolNameSchema` rejects, `PoolAlreadyExistsError` for one already defined, and `UsageError` for a nested member that names an undefined pool or a cycle. */
export function addPool(paths: LayoutPaths, name: string, identities: readonly string[], preference?: PoolPreference): Pool {
  if (!PoolNameSchema.safeParse(name).success) {
    throw new InvalidPoolNameError(name);
  }
  const pools = readPools(paths);
  if (pools[name] !== undefined) {
    throw new PoolAlreadyExistsError(name);
  }
  validateMembers(pools, name, identities);
  const pool: Pool = { identities: [...identities], ...(preference === undefined ? {} : { preference }) };
  writePools(paths, { ...pools, [name]: pool });
  return pool;
}

/** Replaces an existing pool's members and preference. Throws `PoolNotFoundError` when it is not defined, and `UsageError` for a nested member that names an undefined pool or a cycle. */
export function setPool(paths: LayoutPaths, name: string, identities: readonly string[], preference?: PoolPreference): Pool {
  requirePool(paths, name);
  validateMembers(readPools(paths), name, identities);
  const pool: Pool = { identities: [...identities], ...(preference === undefined ? {} : { preference }) };
  writePools(paths, { ...readPools(paths), [name]: pool });
  return pool;
}

/** Removes a pool. Throws `PoolNotFoundError` when it is not defined. Anything that selected it (an active-identity file, a directory rule) is left for `doctor` to report, as with a removed identity. */
export function removePool(paths: LayoutPaths, name: string): void {
  requirePool(paths, name);
  const remaining = Object.fromEntries(Object.entries(readPools(paths)).filter(([existing]) => existing !== name));
  writePools(paths, remaining);
}
