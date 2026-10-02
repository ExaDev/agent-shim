import { CliError } from "./cliError";
import { readGlobalConfig } from "./configProfiles";
import { applyPatch } from "./config/store";
import { GlobalConfigSchema, PoolNameSchema, type Pool } from "./config/schema";
import type { LayoutPaths } from "./paths";

/** Raised when a command names a pool that is not defined in the global config. */
export class PoolNotFoundError extends CliError {
  constructor(readonly poolName: string) {
    super(`No pool named "${poolName}". Run \`claude-use pool add ${poolName} --identity <name>...\` first.`);
    this.name = "PoolNotFoundError";
  }
}

/** Raised by `addPool` when a pool with the given name is already defined. */
export class PoolAlreadyExistsError extends CliError {
  constructor(readonly poolName: string) {
    super(`A pool named "${poolName}" already exists. Use \`claude-use pool set ${poolName}\` to change its members.`);
    this.name = "PoolAlreadyExistsError";
  }
}

/** Raised when a pool name fails `PoolNameSchema`. */
export class InvalidPoolNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(`"${attemptedName}" is not a valid pool name: it must start with a letter or number and may then contain letters, numbers, dots, hyphens and underscores.`);
    this.name = "InvalidPoolNameError";
  }
}

/** The pools defined in `~/.claude-use/config.json`, by name. */
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
 * Writes the whole `pools` map back, because `applyPatch` replaces top-level keys wholesale. Whether the members are identities that exist is the caller's concern: the `pool` command checks it, and `doctor` re-checks it later, since removing an identity does not rewrite the pools that list it.
 */
function writePools(paths: LayoutPaths, pools: Readonly<Record<string, Pool>>): void {
  applyPatch(paths.globalConfigFile, GlobalConfigSchema, { pools }, { defaults: {} });
}

/** Defines a new pool. Throws `InvalidPoolNameError` for a name `PoolNameSchema` rejects and `PoolAlreadyExistsError` for one already defined. */
export function addPool(paths: LayoutPaths, name: string, identities: readonly string[]): Pool {
  if (!PoolNameSchema.safeParse(name).success) {
    throw new InvalidPoolNameError(name);
  }
  const pools = readPools(paths);
  if (pools[name] !== undefined) {
    throw new PoolAlreadyExistsError(name);
  }
  const pool: Pool = { identities: [...identities] };
  writePools(paths, { ...pools, [name]: pool });
  return pool;
}

/** Replaces an existing pool's members. Throws `PoolNotFoundError` when it is not defined. */
export function setPool(paths: LayoutPaths, name: string, identities: readonly string[]): Pool {
  requirePool(paths, name);
  const pool: Pool = { identities: [...identities] };
  writePools(paths, { ...readPools(paths), [name]: pool });
  return pool;
}

/** Removes a pool. Throws `PoolNotFoundError` when it is not defined. Anything that selected it (an active-identity file, a directory rule) is left for `doctor` to report, as with a removed identity. */
export function removePool(paths: LayoutPaths, name: string): void {
  requirePool(paths, name);
  const remaining = Object.fromEntries(Object.entries(readPools(paths)).filter(([existing]) => existing !== name));
  writePools(paths, remaining);
}
