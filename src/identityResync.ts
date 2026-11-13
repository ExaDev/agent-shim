import path from "node:path";

import { UsageError } from "./cliError";
import { profileFilePath } from "./config/names";
import { withIdentityNamesLock, type IdentityNamesLockPorts } from "./identityNamesLock";
import { IDENTITY_FILE } from "./identityRecords";
import { identityNotFound } from "./identityStore";
import type { FarmRuntime } from "./launcher";
import { buildCliOverride } from "./launcher/cliOverride";
import { diagnosticLines } from "./launcher/diagnostics";
import { recoverFarmWarning, resyncFarm } from "./launcher/farm";
import { decideConfigProfile, loadIdentity, resolveIdentityId } from "./launcher/identity";
import { withoutInjected } from "./launcher/injected";
import type { FsPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";

/** Everything `resyncIdentityFarm` needs: the farm runtime for the directory the farm is brought up to date for (`buildFarmRuntime`), and the selections a launch there would read. */
export interface ResyncIdentityFarmParams {
  readonly paths: LayoutPaths;
  /** Reads identity and profile files, as a launch reads them. */
  readonly fs: FsPort;
  readonly farm: FarmRuntime;
  /** The identity, by name. */
  readonly name: string;
  /** The environment a launch would inherit; what a parent launcher injected into it is dropped, as a launch drops it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A `--config-profile` given for this resync, which outranks every other selection as it does on a launch. */
  readonly cliFlagConfigProfile?: string;
  /** A directory rule's `configProfile` for the farm runtime's directory. */
  readonly directoryConfigProfile?: string;
  /** The global default configuration profile. */
  readonly globalDefaultConfigProfile?: string;
  readonly namesLock: IdentityNamesLockPorts;
  /** Receives each line the recovery and the resync raise, as a launch prints them. */
  readonly warn: (line: string) => void;
}

/** What one resync of an identity's farm did, as `identity resync` reports it. */
export interface IdentityResyncReport {
  readonly identity: string;
  readonly id: string;
  readonly farmRoot: string;
  /** The directory the cascade was resolved for. */
  readonly cwd: string;
  readonly configProfile?: string;
  /** False when the farm already matched, so nothing was written. */
  readonly changed: boolean;
  /** Every entry the farm now links, in plan order. */
  readonly linked: readonly string[];
  /** Entries the farm's previous manifest linked that this resync did not link: no longer shared here, or no longer held by `~/.claude`. */
  readonly unlinked: readonly string[];
  /** Shared entries left out because their `~/.claude` path is a symlink that leads nowhere (`SHARED_ENTRY_DANGLING`). */
  readonly leftOut: readonly string[];
  /** The directories the farm builds rather than links. */
  readonly materialised: readonly string[];
  /** Paths copied from the farm into `~/.claude` before the farm was rebuilt. */
  readonly adopted: readonly string[];
  /** Set when the superseded farm still holds data the new one has its own entry for, for `identity resolve-conflicts`. */
  readonly retainedPrevious?: string;
}

/**
 * Brings the named identity's farm up to date for the farm runtime's directory without launching anything: the resync a launch there runs, with the same steps in the same order. The identity names lock is held throughout, so a rename cannot move the identity part way; an interrupted swap is recovered before `identity.json` is read; the configuration profile is decided as a launch decides it (flag, `AGENT_SHIM_CONFIG_PROFILE`, directory rule, the identity's default, the global default), and the cascade is loaded with the environment's sharing overrides; the resync itself takes the identity's own lock and swaps the new farm in atomically, so it is serialised with every launch and every other resync of the identity.
 *
 * Throws `IdentityNotFoundError` for a name no identity has, `UsageError` for a Codex identity (whose farm a Codex launch resyncs from `~/.codex`) and for a configuration profile that does not exist, and whatever the locks and `resyncFarm` throw (`IdentityLockBusyError`, `IdentityGoneError` among them).
 */
export function resyncIdentityFarm(params: ResyncIdentityFarmParams): IdentityResyncReport {
  const { paths, fs, farm, name } = params;
  const env = withoutInjected(params.env);
  return withIdentityNamesLock(paths, params.namesLock, () => {
    const id = resolveIdentityId(paths.identitiesDir, name, fs);
    if (id === undefined) {
      throw identityNotFound(paths, name);
    }
    // Refused before recovery, which would otherwise carry a Codex farm's state across with Claude Code's classification.
    if (loadIdentity(paths.identitiesDir, name, fs)?.config.agent === "codex") {
      throw new UsageError(`Identity "${name}" belongs to Codex; a Codex launch resyncs its farm: agent-shim run --agent codex @${name}`);
    }
    recoverFarmWarning({ fs: farm.fs, identitiesDir: paths.identitiesDir, identity: id, now: farm.now, lock: farm.lock, classification: farm.classification }, params.warn);
    const loaded = loadIdentity(paths.identitiesDir, name, fs);
    if (loaded === undefined) {
      throw identityNotFound(paths, name);
    }
    const profile = decideConfigProfile({
      env,
      ...(params.cliFlagConfigProfile === undefined ? {} : { cliFlagConfigProfile: params.cliFlagConfigProfile }),
      ...(params.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: params.directoryConfigProfile }),
      ...(loaded.config.defaultConfigProfile === undefined ? {} : { identityDefaultConfigProfile: loaded.config.defaultConfigProfile }),
      ...(params.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: params.globalDefaultConfigProfile }),
    });
    if (profile.name !== undefined && fs.readConfigFile(profileFilePath(paths.configProfilesDir, profile.name, `the configuration profile selected via ${profile.source}`)) === undefined) {
      throw new UsageError(`No configuration profile named "${profile.name}" (selected via ${profile.source}). Run \`agent-shim profile add ${profile.name}\` first.`);
    }
    const cliOverride = buildCliOverride({ env, categoryFlags: [], shareFlags: [], hideFlags: [] });
    const result = resyncFarm({
      fs: farm.fs,
      identitiesDir: paths.identitiesDir,
      identity: id,
      ...(profile.name === undefined ? {} : { configProfile: profile.name }),
      claudeHome: farm.claudeHome,
      home: farm.home,
      cwd: farm.cwd,
      env,
      ...(farm.branch === undefined ? {} : { branch: farm.branch }),
      ...(farm.branchDetached === undefined ? {} : { branchDetached: farm.branchDetached }),
      cascade: farm.loadCascade(profile.name, cliOverride),
      classification: farm.classification,
      now: farm.now,
      uniqueSuffix: farm.uniqueSuffix,
      identityExists: () => fs.readConfigFile(path.join(paths.identitiesDir, id, IDENTITY_FILE)) !== undefined,
      lock: farm.lock,
    });
    for (const line of diagnosticLines(result.diagnostics)) {
      params.warn(line.text);
    }
    const linked = result.manifest.links.map((link) => link.rel);
    return {
      identity: name,
      id,
      farmRoot: result.farmRoot,
      cwd: farm.cwd,
      ...(profile.name === undefined ? {} : { configProfile: profile.name }),
      changed: !result.noOp,
      linked,
      unlinked: (result.previousManifest?.links ?? []).map((link) => link.rel).filter((rel) => !linked.includes(rel)),
      leftOut: result.diagnostics.flatMap((diagnostic) => (diagnostic.code === "SHARED_ENTRY_DANGLING" && diagnostic.subject !== undefined ? [diagnostic.subject] : [])),
      materialised: result.manifest.materialised,
      adopted: result.adopted,
      ...(result.retainedPrevious === undefined ? {} : { retainedPrevious: result.retainedPrevious }),
    };
  });
}

/** The lines `identity resync` prints for `report`. */
export function formatIdentityResync(report: IdentityResyncReport): string[] {
  const counted = (count: number, singular: string, plural: string): string => `${String(count)} ${count === 1 ? singular : plural}`;
  const shape = `${counted(report.linked.length, "link", "links")}, ${counted(report.materialised.length, "built directory", "built directories")}`;
  const lines = [
    report.changed
      ? `Resynced the farm of identity "${report.identity}" for ${report.cwd}: ${shape}.`
      : `The farm of identity "${report.identity}" already matches what a launch in ${report.cwd} builds (${shape}); nothing was written.`,
  ];
  if (report.unlinked.length > 0) {
    lines.push(`  No longer linked: ${report.unlinked.join(", ")}.`);
  }
  if (report.leftOut.length > 0) {
    lines.push(`  Left out, since its ~/.claude entry is a symlink that leads nowhere: ${report.leftOut.join(", ")}.`);
  }
  if (report.adopted.length > 0) {
    lines.push(`  Copied into ~/.claude: ${report.adopted.join(", ")}.`);
  }
  if (report.retainedPrevious !== undefined) {
    lines.push(`  The superseded farm was kept at ${report.retainedPrevious}; run \`agent-shim identity resolve-conflicts ${report.identity}\`.`);
  }
  return lines;
}
