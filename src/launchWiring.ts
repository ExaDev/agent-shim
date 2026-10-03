import os from "node:os";
import { randomUUID } from "node:crypto";

import { CliError } from "./cliError";
import { resolveOwnInstallDirs } from "./claudeShim";
import { loadClassification } from "./config/classify";
import { cosmiconfigReader } from "./config/load";
import type { Pool } from "./config/schema";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { realFrontDoorPort } from "./frontdoor/realFrontDoorPort";
import { prepareLaunch, type FarmRuntime, type LaunchPlan, type PrepareLaunchParams } from "./launcher";
import { loadCascadeInput, readDirectorySelections } from "./launcher/cascade";
import type { LogPort, ProcPort } from "./launcher/ports";
import { resolveClaudeHome, resolveLayoutPaths, type LayoutPaths } from "./paths";
import {
  realCredentialPort,
  realFarmFs,
  realFsPort,
  realHeadroomPort,
  realIsProcessRunning,
  realOwnExecutablePath,
  realResolveClaudeBinary,
  realRunPort,
  realSleepSync,
  resolveGitBranch,
  spawnDaemonThrough,
  type DaemonSpawner,
} from "./realPorts";

/** Builds the farm runtime the launcher's resync step needs for a launch in `cwd`, wired to real filesystem, clock, git, and process facilities, plus the directory-scoped selections the launcher needs before it can resync anything. */
export function buildFarmRuntime(paths: LayoutPaths, cwd: string): {
  runtime: FarmRuntime;
  directoryIdentity?: string;
  directoryConfigProfile?: string;
  globalDefaultConfigProfile?: string;
  pools?: Readonly<Record<string, Pool>>;
} {
  const home = os.homedir();
  const read = cosmiconfigReader();
  const classification = loadClassification(paths);
  const loaded = loadCascadeInput({ paths, home, cwd, read });
  const selections = readDirectorySelections(loaded);
  const git = resolveGitBranch(realRunPort, cwd);

  return {
    runtime: {
      fs: realFarmFs,
      claudeHome: resolveClaudeHome(),
      home,
      cwd,
      ...(git.branch === undefined ? {} : { branch: git.branch }),
      ...(git.branchDetached === undefined ? {} : { branchDetached: git.branchDetached }),
      classification,
      loadCascade: (baseConfigProfile, cliOverride) =>
        loadCascadeInput({
          paths,
          home,
          cwd,
          read,
          ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }),
          ...(cliOverride === undefined ? {} : { cliOverride }),
        }).input,
      now: () => Date.now(),
      uniqueSuffix: `${String(process.pid)}.${randomUUID()}`,
      // Zombie-aware on purpose: a previous launcher that crashed out of a resync without releasing the lock may sit unreaped, still answering signal 0 as alive, and must read as a dead holder so this launch takes the lock over instead of timing out.
      lock: { pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync },
    },
    ...(selections.identity === undefined ? {} : { directoryIdentity: selections.identity }),
    ...(selections.configProfile === undefined ? {} : { directoryConfigProfile: selections.configProfile }),
    ...(loaded.globalConfig?.defaultConfigProfile === undefined
      ? {}
      : { globalDefaultConfigProfile: loaded.globalConfig.defaultConfigProfile }),
    ...(loaded.globalConfig?.pools === undefined ? {} : { pools: loaded.globalConfig.pools }),
  };
}

/** Everything `realPrepareLaunchParams` takes beyond the state root: the process facts to launch against, the farm runtime for the directory, and whether a missing configuration profile was knowingly chosen. */
export interface RealLaunchOptions {
  readonly proc: ProcPort;
  readonly farm: ReturnType<typeof buildFarmRuntime>;
  readonly log: LogPort;
  /** Starts the front door and headroom daemons when a launch needs them: the command line spawns itself, a library host names the agent-shim executable. */
  readonly spawnDaemon: DaemonSpawner;
  readonly allowMissingConfigProfile?: boolean;
}

/** The launcher's inputs wired to this machine: the real filesystem, daemon ports, credential resolver and `claude` binary discovery. */
export function realPrepareLaunchParams(paths: LayoutPaths, options: RealLaunchOptions): PrepareLaunchParams {
  const { farm } = options;
  return {
    paths,
    fs: realFsPort,
    proc: options.proc,
    log: options.log,
    resolveClaudeBinary: realResolveClaudeBinary(resolveOwnInstallDirs(paths, realOwnExecutablePath())),
    farm: farm.runtime,
    headroom: realHeadroomPort(paths, { spawnDaemon: options.spawnDaemon, cwd: farm.runtime.cwd }),
    frontdoor: realFrontDoorPort(paths, options.spawnDaemon),
    credentials: { ...realCredentialPort, cache: realCredentialCacheEnv(paths) },
    ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
    ...(farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: farm.directoryConfigProfile }),
    ...(farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: farm.globalDefaultConfigProfile }),
    ...(farm.pools === undefined ? {} : { pools: farm.pools }),
    ...(options.allowMissingConfigProfile === undefined ? {} : { allowMissingConfigProfile: options.allowMissingConfigProfile }),
  };
}

/** Raised by `prepareClaudeLaunch` when the launch is refused: no identity, a missing profile, an ambient credential, an unresolvable credential and the like. `message` is what the launcher logged; `exitCode` is the status the command line would have exited with. */
export class LaunchRefusedError extends CliError {
  override readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "LaunchRefusedError";
    this.exitCode = exitCode;
  }
}

/** What `prepareClaudeLaunch` needs from its caller. */
export interface PrepareClaudeLaunchOptions {
  /** The arguments after `agent-shim run`, exactly as the command line takes them: `@name`, launch flags, then the arguments for `claude`. */
  readonly argv: readonly string[];
  /** The directory the launch is for. */
  readonly cwd: string;
  /** The environment the launch inherits; a variable it sets is what the child sees. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The state root; defaults to the one the command line resolves. */
  readonly paths?: LayoutPaths;
  /** The path of the agent-shim executable, used to start the front door and headroom daemons when the launch routes through them. Without it such a launch is refused: this process is not agent-shim, and re-running it would run the host program again. */
  readonly agentShim?: string;
}

/**
 * Resolves a launch for `options.cwd` on this machine and returns what to spawn, so another tool can start `claude` as an identity, through a provider, with the same sharing rules the command line applies, without shelling out. It performs the effects the child depends on: the identity's farm is resynced, and the front door and headroom are brought up and this process registered with them. Call `release` on the plan when the child has exited.
 *
 * A refused launch throws `LaunchRefusedError` carrying the launcher's own message. Interactive offers (creating a missing identity or profile on a terminal) belong to the command line and are not made here.
 */
export function prepareClaudeLaunch(options: PrepareClaudeLaunchOptions): LaunchPlan {
  const paths = options.paths ?? resolveLayoutPaths();
  const refusals: string[] = [];
  const log: LogPort = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      refusals.push(message);
    },
  };
  const proc: ProcPort = {
    env: options.env,
    argv: options.argv,
    exit: (code) => {
      throw new LaunchRefusedError(refusals.join("\n") || `the launch was refused (exit ${String(code)})`, code);
    },
  };
  const spawnDaemon: DaemonSpawner =
    options.agentShim === undefined
      ? () => {
          throw new LaunchRefusedError("this launch routes through the front door or headroom, which need `agentShim`, the path of the agent-shim executable, to start their daemons", 1);
        }
      : spawnDaemonThrough(options.agentShim);
  return prepareLaunch(realPrepareLaunchParams(paths, { proc, log, spawnDaemon, farm: buildFarmRuntime(paths, options.cwd) }));
}
