import os from "node:os";

import { cosmiconfigReader } from "./config/load";
import type { Identity } from "./config/schema";
import { loadCascadeInput, readDirectorySelections, type LoadedCascade } from "./launcher/cascade";
import { decideConfigProfile, decideIdentity, loadIdentity, type ConfigProfileDecision, type IdentityDecision } from "./launcher/identity";
import type { LayoutPaths } from "./paths";
import { collectPoolPick } from "./poolPickReport";
import { PoolNotFoundError } from "./poolStore";
import { realFarmFs, realFsPort } from "./realPorts";
import type { PoolPickReport } from "./usage/pickReportSchema";

/** What `resolveLaunchSelection` needs from its caller. */
export interface ResolveLaunchSelectionParams {
  readonly paths: LayoutPaths;
  /** The directory a launch would run in, already a real path. */
  readonly cwd: string;
  /** The identity or `pool:<name>` selector the launch names on its command line, as `@name` or `--identity` gives it. Absent when the launch names none. */
  readonly identity?: string;
  /** The configuration profile the launch names on its command line, as `--config-profile` gives it. Absent when the launch names none. */
  readonly configProfile?: string;
  /** The environment the launch inherits: `CLAUDE_CONFIG_DIR`, `AGENT_SHIM_IDENTITY` and `AGENT_SHIM_CONFIG_PROFILE` are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The identity and configuration profile a launch in a directory would use, with where each decision came from. */
export interface LaunchSelection {
  /**
   * The identity decision. When the launch selected a pool, `pool` names it and `name` is the member a launch here would run as now (absent when no member can be picked), the same read-only pick `agent-shim pool pick` reports.
   */
  readonly identity: IdentityDecision;
  /** The pool pick behind `identity`, with every member's reasons, when the launch selected a pool. */
  readonly poolPick?: PoolPickReport;
  /** The configuration profile decision, taken with the chosen identity's own default profile. */
  readonly configProfile: ConfigProfileDecision;
}

/** A selection together with the loaded identity file it was taken with, for a caller that goes on to read more of the identity. */
export interface LaunchSelectionDetail {
  readonly selection: LaunchSelection;
  readonly identityConfig?: Identity;
}

/**
 * Decides the identity and configuration profile for `params`, over a cascade the caller has already loaded: the one function the launcher's precedence rules, `check` and `resolveLaunchSelection` share, so they cannot disagree. Reads the active-identity file and the chosen identity's `identity.json` (and, for a pool, the usage snapshots and last-pick record), never a credential.
 */
export function selectLaunch(params: ResolveLaunchSelectionParams, loaded: LoadedCascade): LaunchSelectionDetail {
  const { paths, cwd } = params;
  const selections = readDirectorySelections(loaded);
  const decidedIdentity = decideIdentity({
    env: params.env,
    argv0Identity: params.identity,
    directoryPinnedIdentity: selections.identity,
    readActiveIdentityFile: () => {
      const raw = realFsPort.readFileUtf8(paths.activeIdentityFile);
      if (raw === undefined) {
        return undefined;
      }
      const trimmed = raw.trim();
      return trimmed === "" ? undefined : trimmed;
    },
  });

  let poolPick: PoolPickReport | undefined;
  if (decidedIdentity.pool !== undefined) {
    const pools = loaded.globalConfig?.pools ?? {};
    if (pools[decidedIdentity.pool] === undefined) {
      throw new PoolNotFoundError(decidedIdentity.pool);
    }
    poolPick = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: decidedIdentity.pool, pools, directory: cwd, nowMs: Date.now() });
  }
  const identity = poolPick?.pick === undefined ? decidedIdentity : { ...decidedIdentity, name: poolPick.pick };

  const loadedIdentity = identity.name === undefined ? undefined : loadIdentity(paths.identitiesDir, identity.name, realFsPort);
  const configProfile = decideConfigProfile({
    env: params.env,
    ...(params.configProfile === undefined ? {} : { cliFlagConfigProfile: params.configProfile }),
    directoryRuleConfigProfile: selections.configProfile,
    identityDefaultConfigProfile: loadedIdentity?.config.defaultConfigProfile,
    globalDefaultConfigProfile: loaded.globalConfig?.defaultConfigProfile,
  });
  return {
    selection: { identity, ...(poolPick === undefined ? {} : { poolPick }), configProfile },
    ...(loadedIdentity === undefined ? {} : { identityConfig: loadedIdentity.config }),
  };
}

/**
 * Which identity (or pool member) and configuration profile a launch in `params.cwd` would use on this machine, weighing the sources the launcher weighs, in its order: the command line, `CLAUDE_CONFIG_DIR`, the environment, a directory rule or a committed `.agent-shim.json` or `.agent-shim.local.json` pinning the directory, the active identity, and each profile source below the flag. It answers without launching, resyncing a farm or registering with a daemon, and reads no credential, Keychain item or credential command.
 *
 * A directory rule's `when` guards the rule's sharing decisions; the launcher, `check` and this function all apply the rule's identity and profile selections regardless of it, so there is no undecided condition to report.
 *
 * Throws `PoolNotFoundError` when the launch selects a pool that is not defined.
 */
export function resolveLaunchSelection(params: ResolveLaunchSelectionParams): LaunchSelection {
  const loaded = loadCascadeInput({ paths: params.paths, home: os.homedir(), cwd: params.cwd, read: cosmiconfigReader() });
  return selectLaunch(params, loaded).selection;
}
