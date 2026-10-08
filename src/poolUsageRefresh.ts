import os from "node:os";

import { cosmiconfigReader } from "./config/load";
import { daemonSpawnerFor, type PrepareClaudeLaunchOptions } from "./launchWiring";
import { parseLauncherArgv } from "./launcher/argv";
import { loadCascadeInput, readDirectorySelections } from "./launcher/cascade";
import { decideIdentity, readActiveIdentity } from "./launcher/identity";
import { refreshStalePoolMembers } from "./launcher/poolRefresh";
import { resolveLayoutPaths, type LayoutPaths } from "./paths";
import { readPools } from "./poolStore";
import { realFarmFs, realFsPort, type DaemonSpawner } from "./realPorts";
import { createAccountReader } from "./usage/account";
import type { AnthropicUsageRefresher } from "./usage/anthropicUsageRefresh";
import { loadPoolMembers } from "./usage/poolPick";
import { createUsageStore } from "./usage/store";

/** What `refreshPools` needs: the pools, the directory launches are planned for, how daemons start, and where refresh failures are reported. */
export interface RefreshPoolsParams {
  readonly paths: LayoutPaths;
  /** The directory launches are planned for: each probe plans one for the identity it asks. */
  readonly cwd: string;
  /** The pools to refresh the members of, each with the pools it nests. None refreshes nothing. */
  readonly poolNames: readonly string[];
  /** Starts the front door and headroom daemons an identity's probe routes through. */
  readonly spawnDaemon: DaemonSpawner;
  /** Receives one line per failed or skipped refresh. */
  readonly log: (line: string) => void;
  /** Refreshes by other means than Claude Code's usage report; the real one when absent. */
  readonly refresher?: AnthropicUsageRefresher;
}

/**
 * Refreshes the Anthropic usage of every stale member of the named pools, against this machine: the one function the command line and the library run before a pool pick, so both fetch and record identically. The real refresher is loaded only when a pool is named, so a launch that selects none never loads the Agent SDK it asks through.
 */
export async function refreshPools(params: RefreshPoolsParams): Promise<void> {
  if (params.poolNames.length === 0) {
    return;
  }
  const { paths } = params;
  const refresher = params.refresher ?? (await realRefresher(params));
  await refreshStalePoolMembers({
    poolNames: params.poolNames,
    pools: readPools(paths),
    loadMembers: (identities) => loadPoolMembers(realFarmFs, paths, identities, Date.now()),
    refresher,
  });
}

async function realRefresher(params: RefreshPoolsParams): Promise<AnthropicUsageRefresher> {
  const { createRealAnthropicUsageRefresher } = await import("./usage/realAnthropicUsageProbe");
  const { paths } = params;
  return createRealAnthropicUsageRefresher({
    paths,
    store: createUsageStore({ fs: realFarmFs, paths, pid: process.pid, now: () => Date.now(), readAccount: createAccountReader(realFarmFs, paths.identitiesDir), log: params.log }),
    cwd: params.cwd,
    spawnDaemon: params.spawnDaemon,
    log: params.log,
  });
}

/** What `refreshPoolUsage` needs from its caller. */
export interface RefreshPoolUsageParams {
  /** The state root; defaults to the one the command line resolves. */
  readonly paths?: LayoutPaths;
  /** The directory launches are planned for. */
  readonly cwd: string;
  /** The pools to refresh the members of, each with the pools it nests. */
  readonly poolNames: readonly string[];
  /** The agent-shim executable the daemons a probe routes through start with; the package's own command line bundle when absent, as for `prepareClaudeLaunch`. */
  readonly agentShim?: string;
  /** Receives one line per failed or skipped refresh; ignored when absent. */
  readonly log?: (line: string) => void;
  /** Refreshes by other means than Claude Code's usage report; the real one when absent. */
  readonly refresher?: AnthropicUsageRefresher;
}

/**
 * Refreshes, on demand, the recorded Anthropic usage of every member of the named pools (and of the pools they nest) whose record has gone stale, so a quota display or a launch the caller plans itself reads current figures. A member is stale once its record is older than one percent of the five-hour window; each is asked for its plan windows through Claude Code's usage report, which makes no model request. A failed fetch is logged and the member keeps its recorded state; this never throws for one.
 *
 * Needs the Agent SDK package (a dependency of this one), loaded only when a pool is named. The command line bundle carries the SDK inside it and gives it a stand-in for `import.meta.url`, which the SDK, an ES module, hands to `createRequire` and a CommonJS bundle leaves undefined; the library files leave the SDK external, so a consumer that bundles them into CommonJS output of its own must supply the same stand-in.
 */
export async function refreshPoolUsage(params: RefreshPoolUsageParams): Promise<void> {
  await refreshPools({
    paths: params.paths ?? resolveLayoutPaths(),
    cwd: params.cwd,
    poolNames: params.poolNames,
    spawnDaemon: daemonSpawnerFor(params.agentShim),
    log: params.log ?? (() => undefined),
    ...(params.refresher === undefined ? {} : { refresher: params.refresher }),
  });
}

/** What `refreshLaunchPoolUsage` needs: the launch to be planned, and the refresh's own options. */
export interface RefreshLaunchPoolUsageOptions extends PrepareClaudeLaunchOptions {
  /** Receives one line per failed or skipped refresh; ignored when absent. */
  readonly log?: (line: string) => void;
  /** Refreshes by other means than Claude Code's usage report; the real one when absent. */
  readonly refresher?: AnthropicUsageRefresher;
}

/**
 * The pool a launch with these arguments, environment and directory would select, by the launcher's own precedence (the command line, `AGENT_SHIM_IDENTITY`, a directory rule or portable file, the active identity), or undefined when it selects an identity or none. It reads configuration only, never usage.
 */
export function poolSelectedByLaunch(options: Pick<PrepareClaudeLaunchOptions, "argv" | "env" | "cwd" | "paths">): string | undefined {
  const paths = options.paths ?? resolveLayoutPaths();
  const loaded = loadCascadeInput({ paths, home: os.homedir(), cwd: options.cwd, read: cosmiconfigReader() });
  return decideIdentity({
    env: options.env,
    argv0Identity: parseLauncherArgv(options.argv).identity,
    directoryPinnedIdentity: readDirectorySelections(loaded).identity,
    readActiveIdentityFile: () => readActiveIdentity(realFsPort, paths.activeIdentityFile),
  }).pool;
}

/**
 * Refreshes the stale usage of the pool a launch would select (`poolSelectedByLaunch`), so the pick that launch makes ranks on current figures. Run it before `prepareClaudeLaunch`, which stays synchronous and ranks on whatever is recorded; `runClaudeLaunch` does. Does nothing when the launch selects no pool. See `refreshPoolUsage` for what a refresh asks, and for the Agent SDK requirement.
 */
export async function refreshLaunchPoolUsage(options: RefreshLaunchPoolUsageOptions): Promise<void> {
  const pool = poolSelectedByLaunch(options);
  await refreshPoolUsage({
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    cwd: options.cwd,
    poolNames: pool === undefined ? [] : [pool],
    ...(options.agentShim === undefined ? {} : { agentShim: options.agentShim }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.refresher === undefined ? {} : { refresher: options.refresher }),
  });
}
