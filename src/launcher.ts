import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import packageJson from "../package.json";
import { parseEnvBool } from "./cli/envBool";
import type { LayoutPaths } from "./paths";
import { parseLauncherArgv, type ParsedLauncherArgv } from "./launcher/argv";
import { buildCliOverride, type CliOverride } from "./launcher/cliOverride";
import { recoverFarm, recoveryDiagnostics, resyncFarm } from "./launcher/farm";
import { evaluateAmbientCredentialGuard } from "./launcher/guard";
import { decideConfigProfile, decideIdentity, loadIdentity, type ConfigProfileDecisionSource, type IdentityDecision, type IdentityDecisionSource } from "./launcher/identity";
import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags, type ResolvedLaunchFlags, type ResolvedProvider } from "./launcher/flags";
import { splitExtraFlags } from "./launcher/extraFlags";
import { hasSettingsArgument, mergeSettings, withLauncherSettings, withSupervision, type SupervisedLaunch } from "./launcher/claudeSession";
import { diagnosticLines, printDiagnosticLines, reportDiagnostics, type DiagnosticLine } from "./launcher/diagnostics";
import { holdBeforeLaunch, LAUNCH_CANCELLED_EXIT, type HoldOutcome, type HoldPort } from "./launcher/hold";
import type { Candidate } from "./usage/pick";
import { decisionRows, farmRow, noteRow, pinnedVersionRow, routingRows } from "./launcher/launchReport";
import { modelPickerSettings, modelPickerSettingsFromRows, routedModelRows } from "./launcher/modelPicker";
import { catalogueCachePath, parseCatalogueCache } from "./providerCatalogue";
import { listProviders } from "./providersStore";
import type { ModelsConfig, Provider } from "./config/schema";
import { resolvePoolLaunch } from "./launcher/pool";
import { resumedContextTokens } from "./usage/resumeContext";
import { IdentityLockBusyError } from "./launcher/lock";
import type { FarmFs, FsPort, FrontDoorPort, HeadroomPort, HeadroomUp, LogPort, ProcPort, ReportRow, SpawnPort } from "./launcher/ports";
import { childExitCode } from "./launcher/spawn";
import { resolveProvider, resolveRoutedProviderCredentials, selectProvider, type SelectedProvider } from "./providersStore";
import { loadConfigFile } from "./config/load";
import { flattenLayers } from "./resolve/flatten";
import { assembleCascade } from "./resolve/walk";
import { CREDENTIAL_TARGET_VARS, type CategoryClassification, type CategoryClassificationOverlay, type Credential, type LaunchFlags, type Pool, type UpdateMode, isRouterProvider } from "./config/schema";
import { GlobalConfigSchema } from "./config/schema";
import { CREDENTIAL_UNAVAILABLE_EXIT, credentialVariables, describeSource, resolveCredential, summariseCredential, type CredentialPort, type CredentialSummary, type ResolvedCredential } from "./credential";
import type { CascadeInput } from "./resolve/walk";
import { ANTHROPIC_PROVIDER } from "./usage/middleware";
import { quotaWarnings } from "./usage/preflight";
import { readUsageSnapshot, UsageSnapshotError } from "./usage/read";
import type { ClaudeBinaryResolver } from "./versionDiscovery";
import { resolveClaudeVersion, type PinnedClaudeVersion } from "./launcher/claudeVersion";
import { runLaunchUpdateCheck, type UpdateLaunchPort } from "./update/launchHook";
import { targetRefs } from "./models/targets";

/**
 * Everything the farm resync needs that the launcher itself has no way to produce: a real filesystem, a real clock, the working directory, and a way to load the cascade for it.
 *
 * Supplied by `src/cli.ts` in normal operation. A caller that omits it launches with no farm at all, which is the right behaviour in exactly the cases where there is no agent-shim-managed farm to resync — and is what the launcher's own pre-farm tests exercise.
 */
export interface FarmRuntime {
  readonly fs: FarmFs;
  /** The canonical `~/.claude` every farm symlink points back into. */
  readonly claudeHome: string;
  readonly home: string;
  readonly cwd: string;
  /** The git branch at `cwd`, for `when: { branch }` conditions. Undefined when `cwd` is not in a repository. */
  readonly branch?: string;
  readonly branchDetached?: boolean;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
  /** Loads and assembles the cascade for `cwd` under the given configuration profile and one-off command-line/environment overrides. Injected so the launcher never reads a config file itself. */
  readonly loadCascade: (baseConfigProfile: string | undefined, cliOverride: CliOverride | undefined) => CascadeInput;
  readonly now: () => number;
  /** Distinguishes this process's scratch and superseded farm directories from any other's. */
  readonly uniqueSuffix: string;
  readonly lock: {
    readonly pid: number;
    readonly isRunning: (pid: number) => boolean;
    readonly sleep: (ms: number) => void;
    readonly staleAfterMs?: number;
    readonly retryDelayMs?: number;
    readonly maxAttempts?: number;
  };
}

/** Inputs to `prepareLaunch`: everything a launch needs except the means of spawning the child. */
export interface PrepareLaunchParams {
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  readonly proc: ProcPort;
  readonly log: LogPort;
  /** Discovers the real `claude` binary to spawn. Injected so `runLauncher` never depends on `src/versionDiscovery.ts`'s own filesystem/PATH inputs directly — the caller (`src/cli.ts`) wires the real discovery, tests wire a fake that returns a fixed path. */
  readonly resolveClaudeBinary: ClaudeBinaryResolver;
  /** An identity pinned to `$PWD` by a directory rule. Accepted as an already-resolved value — the rules-loading code that produces it lands in Phase 4/5. */
  readonly directoryPinnedIdentity?: string;
  /** A directory rule's `configProfile` selection for `$PWD`. Accepted as an already-resolved value for the same reason. */
  readonly directoryRuleConfigProfile?: string;
  /** An explicit `--config-profile` value, when the caller wants to force one regardless of argv — normal operation instead relies on `parseLauncherArgv` finding `--config-profile` in `proc.argv` itself, so this is only needed to override that. */
  readonly cliFlagConfigProfile?: string;
  /** The user-global `~/.agent-shim/config.json` default configuration profile, when one is configured. */
  readonly globalDefaultConfigProfile?: string;
  /** The user-global `pools`, which a `pool:<name>` selector picks a member of. */
  readonly pools?: Readonly<Record<string, Pool>>;
  /** Wires the farm resync. Omitted only by a caller that has no farm to manage. */
  readonly farm?: FarmRuntime;
  /** Wires headroom routing. Omitted by a caller that cannot route through the daemon; a launch that resolves `headroom` on with no port wired is refused loudly rather than silently bypassing it. */
  readonly headroom?: HeadroomPort;
  /** Wires the front-door daemon. Omitted by a caller that cannot run it; a launch that routes anything (a provider, or headroom) with no port wired is refused rather than started against an address nothing serves. */
  readonly frontdoor?: FrontDoorPort;
  /** Resolves credential blocks (a provider's, or the launching identity's own). Omitted by a caller that cannot read secret files or run commands; a launch that needs a credential is then refused rather than started without it. */
  readonly credentials?: CredentialPort;
  /** True when the user was asked on a terminal whether to create the selected configuration profile and chose to launch without it. Without that explicit choice, a selected profile with no file is refused rather than silently skipped. */
  readonly allowMissingConfigProfile?: boolean;
  /** The user-global `update.mode`, resolved from the same global config the launcher already loads. Absent means `off`, and `off` runs no launch-time update check at all. */
  readonly updateMode?: UpdateMode;
  /** Set by a supervising launcher (see `src/supervise/supervise.ts`): the session id this launch carries, how claude is told it, and, for a relaunch, the pool member to run as. Absent for an ordinary launch, which draws a fresh session id and leaves claude's arguments as the person typed them. */
  readonly supervised?: SupervisedLaunch;
  /** Wires the launch-time update check behind `update.mode`. Omitted by a caller that cannot resolve releases, re-invoke this binary, or write to the terminal; a mode of `notify` or `auto` with no port wired simply checks nothing. */
  readonly update?: UpdateLaunchPort;
  /** Waits for the person where the launch's `delay` and `pause` settings ask. Omitted by a caller that has no terminal to wait on, and then the launch is never held. */
  readonly hold?: HoldPort;
  /** Whether an identity has a stored login Claude Code can use (a Keychain item or a credentials file). Absent when the caller cannot ask, in which case a launch assumes it does. */
  readonly hasStoredLogin?: (identity: string) => boolean;
}

/** Inputs to `runLauncher`: a launch's inputs plus the port that spawns the child. */
export interface RunLauncherParams extends PrepareLaunchParams {
  readonly spawn: SpawnPort;
}

/** The pick a pool made for a launch: the pool, why the ranking chose the member it did, and, for a resumed conversation, the member it left. */
export interface LaunchPoolDecision {
  /** The pool the launch selected with `pool:<name>`. */
  readonly name: string;
  /** Every reason the ranking gave for the chosen member, in the ranking's order. */
  readonly reasons: readonly string[];
  /** The member a resumed conversation left, and why the ranking could not keep it. */
  readonly movedOff?: { readonly identity: string; readonly reason: string };
}

/**
 * What a launch resolved to, and where each decision came from. Everything here is a name or a path, never a credential.
 */
export interface LaunchDecision {
  /** The identity the launch runs as. Absent when the escape hatch applied or nothing resolved one. */
  readonly identity?: string;
  /** Which precedence rule selected the identity (or the pool the identity was picked from). */
  readonly identitySource: IdentityDecisionSource;
  /** The pool pick behind `identity`, when the launch selected a pool. */
  readonly pool?: LaunchPoolDecision;
  /** True when `CLAUDE_CONFIG_DIR` was already set, so no identity was resolved and no farm was managed. */
  readonly configDirEscapeHatch: boolean;
  /** The configuration directory the child runs with: the identity's own, or the one the caller named. Absent when none is set. */
  readonly configDir?: string;
  /** The configuration profile that applied, when one did. */
  readonly configProfile?: string;
  /** Which precedence rule selected the configuration profile. */
  readonly configProfileSource: ConfigProfileDecisionSource;
  /** The provider the launch routes through, when it selected one. */
  readonly provider?: string;
}

/**
 * What one launch resolved to, once every effect its child depends on is in place (the identity's farm resynced, the front door and headroom up and this launch registered with them): the real binary, its arguments and its environment.
 */
export interface LaunchPlan {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The id this launch's session carries: the front door's session header, and, for a supervised launch, claude's own conversation id. */
  readonly sessionId: string;
  /** Releases the daemon session registrations this launch holds. Call it when the child has exited; it is safe to call more than once. */
  readonly release: () => void;
  /** What the launch resolved to, as data: the facts the launcher's report states. */
  readonly decision: LaunchDecision;
  /** Marks the moment this plan's child is spawned: the launch-time update check suppresses its notify line from then on, since a line printed after the child took over the terminal would land mid-session. Call it immediately before spawning; it is safe to call more than once. */
  readonly markChildStarted: () => void;
  /** Holds the launch as its `delay` and `pause` settings say, once the launcher has printed everything it will: call it just before spawning the child. `cancelled` means the person pressed Ctrl-C at the pause, and the child must not start. A launch with no hold port, or nobody watching, goes at once. */
  readonly hold: () => HoldOutcome;
}

/** The outcome of resolving the launching identity's own credential block: the credential, or a refusal with its exit status. */
type IdentityCredentialResolution =
  | { readonly ok: true; readonly credential: ResolvedCredential }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Resolves an identity's credential block, refusing with exit 1 when no credential port is wired and with `CREDENTIAL_UNAVAILABLE_EXIT` when no source yields a token. */
function resolveIdentityCredential(
  identity: string,
  credential: Credential,
  env: Readonly<Record<string, string | undefined>>,
  port: CredentialPort | undefined,
): IdentityCredentialResolution {
  if (port === undefined) {
    return { ok: false, status: 1, message: `agent-shim: identity ${identity} needs its credential resolved, but this launcher has no credential port wired` };
  }
  const resolution = resolveCredential({ credential, env, port, subject: `identity ${identity}` });
  return resolution.ok ? resolution : { ok: false, status: CREDENTIAL_UNAVAILABLE_EXIT, message: resolution.message };
}

/** The identity decision after any pool selector has been resolved to one of the pool's members, and the pick's explanation for the decision log line. Exits the launch when no member can be picked. */
function pickFromPool(
  decided: IdentityDecision,
  params: PrepareLaunchParams,
  parsedArgv: ParsedLauncherArgv,
  readOnly: boolean,
): { readonly identityDecision: IdentityDecision; readonly poolPick?: LaunchPoolDecision; readonly poolRanking?: readonly Candidate[] } {
  const { paths, fs, proc, log } = params;
  if (decided.pool === undefined) {
    return { identityDecision: decided };
  }
  // A supervising launcher has already chosen the member this relaunch runs as, under its own lock and with the other moving sessions counted, so no pick is made here.
  if (params.supervised?.member !== undefined) {
    const reasons = ["resumed here by the supervising launcher after the previous member ran out of quota"];
    return { identityDecision: { ...decided, name: params.supervised.member }, poolPick: { name: decided.pool, reasons } };
  }
  const farmRuntime = params.farm;
  if (farmRuntime === undefined) {
    log.error(`agent-shim: pool "${decided.pool}" was selected, but this launcher has no farm wired to read usage and pick a member with.`);
    return proc.exit(1);
  }
  const resumeContextTokens = resumedContextTokens(farmRuntime.fs, { claudeHome: farmRuntime.claudeHome, cwd: farmRuntime.cwd, passthrough: parsedArgv.rest });
  const resolution = resolvePoolLaunch({
    poolName: decided.pool,
    selectedVia: decided.source,
    pools: params.pools,
    paths,
    fs,
    usageFs: farmRuntime.fs,
    cwd: farmRuntime.cwd,
    now: farmRuntime.now,
    sleep: farmRuntime.lock.sleep,
    passthrough: parsedArgv.rest,
    ...(resumeContextTokens === undefined ? {} : { resumeContextTokens }),
    // A read-only decision never sleeps for a refused pool and never records its pick, so asking what a launch would pick leaves the next real launch's keep-warm preference as it was.
    wait: !readOnly && parsedArgv.wait === true,
    recordPick: !readOnly,
    log,
  });
  if (!resolution.ok) {
    log.error(resolution.message);
    return proc.exit(1);
  }
  return {
    identityDecision: { ...decided, name: resolution.identity },
    poolPick: { name: decided.pool, reasons: resolution.reasons, ...(resolution.movedOff === undefined ? {} : { movedOff: resolution.movedOff }) },
    poolRanking: resolution.candidates,
  };
}

/**
 * Everything a launch decides before any daemon is started or registered and before the farm is written: the identity (and the pool pick behind it), the configuration profile, the provider, the identity's own credential, the resolved launch flags, the pinned Claude Code version, the real binary and the argument list.
 */
interface DecidedLaunch {
  readonly parsedArgv: ParsedLauncherArgv;
  readonly identityDecision: IdentityDecision;
  readonly poolPick: LaunchPoolDecision | undefined;
  /** Every member the pool pick ranked, best first. Absent when the launch picked no member itself (no pool, or a supervisor already chose the member). */
  readonly poolRanking: readonly Candidate[] | undefined;
  readonly configDirEscapeHatch: boolean;
  /** The identity whose farm this launch manages: absent when the caller named a configuration directory or no identity resolved. */
  readonly farmIdentity: string | undefined;
  readonly farmContext: { readonly farm: FarmRuntime; readonly identity: string; readonly cascade: CascadeInput } | undefined;
  readonly configProfileDecision: ReturnType<typeof decideConfigProfile>;
  /** The provider the launch routes through, by name and definition. */
  readonly provider: SelectedProvider | undefined;
  /** The same provider with its credential resolved; absent from a read-only decision, which resolves none. */
  readonly resolvedProvider: ResolvedProvider | undefined;
  /** The identity's credential block when it applies to this launch (no provider selected, and the identity owns the configuration directory). */
  readonly identityCredentialBlock: Credential | undefined;
  /** That block resolved to a token; absent from a read-only decision, which resolves none. */
  readonly identityCredential: ResolvedCredential | undefined;
  readonly pinnedVersion: PinnedClaudeVersion | undefined;
  /** What a person should know about this launch that is not one of its decisions: a setting that did not apply, and why. */
  readonly notes: readonly string[];
  readonly flags: ResolvedLaunchFlags;
  /** The models block this launch resolves: the global block with every deeper layer (profile, directory rule, committed file) applied, which is what the picker rows, the credential check and the door's resolution for this session are taken from. */
  readonly models: ModelsConfig | undefined;
  /** The global models block alone, which a session that adds no definitions of its own leaves the door to follow live. */
  readonly globalModels: ModelsConfig | undefined;
  readonly bin: string;
  readonly args: readonly string[];
  readonly decision: LaunchDecision;
}

/**
 * Decides one launch, in order: the `CLAUDE_CONFIG_DIR` escape-hatch check, the identity and configuration-profile decision, the provider decision, the identity's own credential, the ambient-credential guard, the resolved launch flags, the pinned Claude Code version, binary discovery and the argument list.
 *
 * With `readOnly` false this is the launch's own first half: a crashed farm swap is recovered before the identity is read, a pool pick is recorded and may wait for a refused pool, and the provider's and the identity's credentials are resolved, which may run a credential command or ask a keychain. With `readOnly` true nothing is written, started or resolved: the farm is left as it is, the pick is not recorded and never waits, and credentials are reported by their block only, so a caller asking what a launch would do changes nothing on the machine.
 *
 * A refusal is logged through `params.log` and ends in `params.proc.exit`, exactly as a launch is refused.
 */
function decideLaunch(params: PrepareLaunchParams, readOnly: boolean): DecidedLaunch {
  const { paths, fs, proc, log } = params;
  const { env, argv } = proc;

  const parsedArgv = parseLauncherArgv(argv);
  const cliOverride = buildCliOverride({
    env,
    categoryFlags: parsedArgv.categoryFlags,
    shareFlags: parsedArgv.shareFlags,
    hideFlags: parsedArgv.hideFlags,
  });
  const configDirEscapeHatchApplies = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== "";

  const decidedIdentity = decideIdentity({
    env,
    argv0Identity: parsedArgv.identity,
    directoryPinnedIdentity: params.directoryPinnedIdentity,
    readActiveIdentityFile: () => {
      const raw = fs.readFileUtf8(paths.activeIdentityFile);
      if (raw === undefined) {
        return undefined;
      }
      const trimmed = raw.trim();
      return trimmed === "" ? undefined : trimmed;
    },
  });

  // A pool selector is resolved to one member here, ahead of everything that reads the identity: farm recovery, loading, the credential and the resync all work on the chosen name exactly as if it had been typed.
  const { identityDecision, poolPick, poolRanking } = pickFromPool(decidedIdentity, params, parsedArgv, readOnly);

  // There is a farm to manage only when an identity resolved and the caller did not name a configuration directory itself.
  const farmIdentity = configDirEscapeHatchApplies ? undefined : identityDecision.name;
  const farm = farmIdentity === undefined ? undefined : params.farm;

  // Recovery runs before the identity is loaded, not merely before the farm is rebuilt: `identity.json` lives inside the farm root, so a crash between the swap's two renames leaves it in a superseded directory. Reading it first would launch with the identity's own configuration profile silently unset.
  if (!readOnly && farm !== undefined && farmIdentity !== undefined) {
    let recovery;
    try {
      recovery = recoverFarm({
        fs: farm.fs,
        identitiesDir: paths.identitiesDir,
        identity: farmIdentity,
        now: farm.now,
        lock: farm.lock,
        classification: farm.classification,
      });
    } catch (error) {
      if (error instanceof IdentityLockBusyError) {
        log.error(error.message);
        proc.exit(1);
      }
      throw error;
    }
    for (const diagnostic of recoveryDiagnostics(recovery, farmIdentity)) {
      log.warn(`agent-shim: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  let loadedIdentity: ReturnType<typeof loadIdentity>;
  if (identityDecision.name !== undefined) {
    loadedIdentity = loadIdentity(paths.identitiesDir, identityDecision.name, fs);
    if (loadedIdentity === undefined) {
      log.error(
        `agent-shim: no identity named "${identityDecision.name}" (selected via ${identityDecision.source}). ` +
          `Run \`agent-shim identity add ${identityDecision.name}\` first.`,
      );
      proc.exit(1);
    }
  }

  const configProfileDecision = decideConfigProfile({
    env,
    cliFlagConfigProfile: params.cliFlagConfigProfile ?? parsedArgv.configProfile,
    directoryRuleConfigProfile: params.directoryRuleConfigProfile,
    identityDefaultConfigProfile: loadedIdentity?.config.defaultConfigProfile,
    globalDefaultConfigProfile: params.globalDefaultConfigProfile,
  });
  if (
    configProfileDecision.name !== undefined &&
    params.allowMissingConfigProfile !== true &&
    fs.readConfigFile(path.join(paths.configProfilesDir, `${configProfileDecision.name}.json`)) === undefined
  ) {
    log.error(
      `agent-shim: no configuration profile named "${configProfileDecision.name}" (selected via ${configProfileDecision.source}). ` +
        `Run \`agent-shim profile add ${configProfileDecision.name}\` first.`,
    );
    proc.exit(1);
  }

  // The cascade is loaded once here, ahead of both the provider decision below and the farm resync further down. A provider name can be pinned by any cascade layer exactly like a launch flag, so it has to be knowable before the ambient-credential guard runs: a provider launch injects its own credential into the child after the guard, which is exactly what the guard would otherwise refuse over. Loading once and passing the same value into the resync also avoids reading the config files twice.
  const farmContext =
    farm !== undefined && farmIdentity !== undefined
      ? { farm, identity: farmIdentity, cascade: farm.loadCascade(configProfileDecision.name, cliOverride) }
      : undefined;

  // `--no-provider` opts this one launch out of whatever provider the cascade would otherwise select, so selection is skipped outright rather than asked to ignore its own cascade input. A read-only decision names the provider from its definition alone and resolves no credential.
  const providerParams = {
    paths,
    port: fs,
    ...(parsedArgv.provider === undefined || parsedArgv.provider === false ? {} : { cliProvider: parsedArgv.provider }),
    ...(farmContext === undefined ? {} : { cascade: farmContext.cascade }),
  };
  let selectedProvider: SelectedProvider | undefined;
  let resolvedProvider: ResolvedProvider | undefined;
  if (parsedArgv.provider !== false && readOnly) {
    const selection = selectProvider(providerParams);
    if (selection !== undefined && !selection.ok) {
      log.error(selection.message);
      proc.exit(selection.status);
    }
    selectedProvider = selection?.ok === true ? selection.provider : undefined;
  } else if (parsedArgv.provider !== false) {
    const provider = resolveProvider({ ...providerParams, env, ...(params.credentials === undefined ? {} : { credentials: params.credentials }) });
    if (provider !== undefined && !provider.ok) {
      log.error(provider.message);
      proc.exit(provider.status);
    }
    resolvedProvider = provider?.ok === true ? provider.provider : undefined;
    selectedProvider = resolvedProvider;
    for (const warning of provider?.ok === true ? provider.warnings : []) {
      log.warn(warning);
    }
  }

  // A launch is never blocked by quota: the warning only says what the front door last saw for the provider this launch will use.
  if (farm !== undefined && farmIdentity !== undefined) {
    try {
      const snapshot = readUsageSnapshot(farm.fs, paths.usageSnapshotsDir, farmIdentity);
      for (const warning of quotaWarnings(snapshot, selectedProvider?.name ?? ANTHROPIC_PROVIDER, farm.now())) {
        log.warn(warning);
      }
    } catch (error) {
      if (!(error instanceof UsageSnapshotError)) {
        throw error;
      }
      log.warn(`agent-shim: ${error.message}`);
    }
  }

  // The identity's own credential applies only when no provider was selected (the provider's credential authenticates against its endpoint instead) and the identity owns this launch's configuration directory (under the CLAUDE_CONFIG_DIR escape hatch, the directory and whatever login it holds are the caller's). A read-only decision reports the block and resolves nothing.
  const identityCredentialBlock = selectedProvider === undefined && farmIdentity !== undefined ? loadedIdentity?.config.credential : undefined;
  const identityResolution =
    !readOnly && identityCredentialBlock !== undefined && farmIdentity !== undefined
      ? resolveIdentityCredential(farmIdentity, identityCredentialBlock, env, params.credentials)
      : undefined;
  if (identityResolution !== undefined && !identityResolution.ok) {
    log.error(identityResolution.message);
    proc.exit(identityResolution.status);
  }
  const identityCredential = identityResolution?.ok === true ? identityResolution.credential : undefined;
  for (const warning of identityCredential?.warnings ?? []) {
    log.warn(warning);
  }

  const guardResult = evaluateAmbientCredentialGuard({
    env,
    allowAmbientCredential: loadedIdentity?.config.allowAmbientCredential ?? false,
    allowAmbientCredentialOverride: parseEnvBool("AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL", env.AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL) === true,
    identityName: identityDecision.name,
    providerSelected: selectedProvider !== undefined,
    ...(identityCredential === undefined
      ? {}
      : { injectedCredential: { variable: CREDENTIAL_TARGET_VARS[identityCredential.target], token: identityCredential.token } }),
  });
  if (!guardResult.ok) {
    // A read-only decision resolves no credential, so it cannot tell an ambient variable that merely equals the identity's own injected token (a nested launch inheriting its parent's environment, which the real launch exempts) from a foreign one. With a credential block that could be the case, the outcome is indeterminate and is reported as a warning instead of a refusal.
    if (readOnly && identityCredentialBlock !== undefined) {
      log.warn(`${guardResult.message} (not resolved here: the launch proceeds only if that value is the identity's own injected credential)`);
    } else {
      log.error(guardResult.message);
      proc.exit(1);
    }
  }

  // Launch flags come from the cascade's `launch` block: the same flattening of the same assembled cascade the farm resync computes, so a decision made before the resync reports what the resync will carry. Escape-hatch and bare launches have no farm to resync, but launch flags are agent-shim's own behaviour, not the farm's: a global `launch.headroom` (or any other launch setting) must still apply when CLAUDE_CONFIG_DIR was already set or no identity resolved. This reads and flattens the cascade and writes nothing.
  const launchCascade = farmContext?.cascade ?? (params.farm === undefined ? undefined : params.farm.loadCascade(configProfileDecision.name, cliOverride));
  let cascadeLaunch: LaunchFlags | undefined;
  let cascadeModels: ModelsConfig | undefined;
  if (launchCascade !== undefined && params.farm !== undefined) {
    const assembled = assembleCascade(launchCascade);
    const flattened = flattenLayers(assembled.layers, { home: params.farm.home });
    cascadeLaunch = flattened.launch;
    cascadeModels = flattened.models;
    // A launch that resyncs a farm reports these through the resync. One with no farm (the escape hatch, or no identity resolved) and a read-only decision resync nothing, so they are reported here rather than leaving a layer partly ignored without a word. A read-only decision has no way to refuse, so it reports an error as a warning.
    if (readOnly || farmContext === undefined) {
      reportDiagnostics(log, [...assembled.diagnostics, ...flattened.diagnostics], { errorsAsWarnings: readOnly });
    }
  }

  // A pinned Claude Code version comes from the same three forms as every launch setting, and is resolved before discovery because discovery has to run that exact version or fail.
  const pinnedVersion = resolveClaudeVersion({ env, ...(parsedArgv.claudeVersion === undefined ? {} : { flag: parsedArgv.claudeVersion }), ...(cascadeLaunch?.claudeVersion === undefined ? {} : { cascade: cascadeLaunch.claudeVersion }) });
  const discovered = params.resolveClaudeBinary(pinnedVersion === undefined ? undefined : { version: pinnedVersion.version });

  const requestedFlags = resolveLaunchFlags({
    env,
    ...(cascadeLaunch === undefined ? {} : { cascade: cascadeLaunch }),
    flags: {
      ...(parsedArgv.skipPermissions === undefined ? {} : { skipPermissions: parsedArgv.skipPermissions }),
      ...(parsedArgv.remoteControl === undefined ? {} : { remoteControl: parsedArgv.remoteControl }),
      ...(parsedArgv.headroom === undefined ? {} : { headroom: parsedArgv.headroom }),
      ...(parsedArgv.trackUsage === undefined ? {} : { trackUsage: parsedArgv.trackUsage }),
      ...(parsedArgv.pause === undefined ? {} : { pause: parsedArgv.pause }),
      ...(parsedArgv.explain === undefined ? {} : { explain: parsedArgv.explain }),
      ...(parsedArgv.routeByName === undefined ? {} : { routeByName: parsedArgv.routeByName }),
      ...(parsedArgv.delay === undefined ? {} : { delay: parsedArgv.delay }),
    },
  });
  // Remote Control is a claude.ai feature and needs the identity's own login. A provider session does not: the door attaches the provider's credential. So a provider launch on an identity with no stored login runs without Remote Control instead of failing at its first turn with "Not logged in".
  const loginlessProvider =
    requestedFlags.remoteControl && selectedProvider !== undefined && farmIdentity !== undefined && params.hasStoredLogin?.(farmIdentity) === false ? { identity: farmIdentity, provider: selectedProvider.name } : undefined;
  const notes: string[] = [];
  if (loginlessProvider !== undefined) {
    notes.push(`${loginlessProvider.identity} has no stored login, so Remote Control is off; provider ${loginlessProvider.provider} runs without it`);
  }
  const flags = loginlessProvider === undefined ? requestedFlags : { ...requestedFlags, remoteControl: false };

  // `/model` lists the provider's real models, which needs claude's `--settings`; a launch that passes its own keeps claude's names, since claude takes one value and a second replaces the first.
  const catalogue = selectedProvider === undefined ? undefined : parseCatalogueCache(params.fs.readFileUtf8(catalogueCachePath(paths, selectedProvider.name)));
  // A session that routes by model name (the flag, or a router provider) lists the whole catalogue instead: its virtual models first, then every provider's models qualified.
  const routesByName = flags.routeByName || (selectedProvider !== undefined && isRouterProvider(selectedProvider.definition));
  // The cascade's block when a cascade was read (a launch with a farm), else the global block alone; read through the launcher's own config port so a test sees its own filesystem.
  const globalModels = loadConfigFile(paths.globalConfigFile, GlobalConfigSchema, params.fs.readConfigFile)?.config.models;
  const models = launchCascade !== undefined && params.farm !== undefined ? cascadeModels : globalModels;
  const pickerSettings = routesByName
    ? modelPickerSettingsFromRows(routedModelRows(models ?? {}, listProviders(paths).map((entry): readonly [string, Provider] => [entry.name, entry.provider])), selectedProvider !== undefined)
    : selectedProvider === undefined
      ? undefined
      : modelPickerSettings(selectedProvider.definition, catalogue?.models);
  const callerSettings = hasSettingsArgument(parsedArgv.rest);
  if (pickerSettings !== undefined && callerSettings) {
    notes.push("--settings was passed, so /model keeps Claude Code's own model names");
  }
  const launcherSettings = mergeSettings([params.supervised?.settings, callerSettings ? undefined : pickerSettings]);

  const args = buildArgv({
    toolFlags: buildFlagArgs(flags),
    extraFlags: splitExtraFlags(env.CLAUDE_EXTRA_FLAGS),
    passthrough: withLauncherSettings(params.supervised === undefined ? parsedArgv.rest : withSupervision(parsedArgv.rest, params.supervised), launcherSettings),
  });

  // The configuration directory the child runs with, as `buildEnv` will set it: the identity's own directory unless the caller named one.
  const configDir = configDirEscapeHatchApplies || identityDecision.name === undefined ? env.CLAUDE_CONFIG_DIR : path.join(paths.identitiesDir, identityDecision.name);
  const decision: LaunchDecision = {
    identitySource: identityDecision.source,
    configDirEscapeHatch: identityDecision.configDirEscapeHatch,
    configProfileSource: configProfileDecision.source,
    ...(identityDecision.name === undefined ? {} : { identity: identityDecision.name }),
    ...(poolPick === undefined ? {} : { pool: poolPick }),
    ...(configDir === undefined || configDir === "" ? {} : { configDir }),
    ...(configProfileDecision.name === undefined ? {} : { configProfile: configProfileDecision.name }),
    ...(selectedProvider === undefined ? {} : { provider: selectedProvider.name }),
  };
  return {
    parsedArgv,
    identityDecision,
    poolPick,
    poolRanking,
    notes,
    configDirEscapeHatch: configDirEscapeHatchApplies,
    farmIdentity,
    farmContext,
    configProfileDecision,
    provider: selectedProvider,
    resolvedProvider,
    identityCredentialBlock,
    identityCredential,
    pinnedVersion,
    flags,
    models,
    globalModels,
    bin: discovered.path,
    args,
    decision,
  };
}

/**
 * Prepares one `claude` launch, in order:
 *
 * `CLAUDE_CONFIG_DIR` escape-hatch check, then the identity/config-profile decision, the provider decision, the identity's own credential, the ambient-credential guard, the config-gated launch-time update check (fired after the decision line and never awaited; see `runLaunchUpdateCheck`), farm resync, version discovery, flag resolution (and, when headroom resolved on, daemon bring-up), the extra-flags split, and the final argument list and environment, returned as a `LaunchPlan` for the caller to spawn. It refuses through `params.proc.exit`, so a caller that is not a command line process passes a `proc` whose `exit` throws.
 *
 * A launch that resolves an identity with no `identity.json`, or a configuration profile with no file, is refused with exit 1 naming the missing name and how it was selected: silently proceeding would create a brand-new login for a mistyped `@name`, or launch with a whole cascade layer missing. On a terminal, `src/runClaude.ts` offers to create either before this runs.
 *
 * The farm resync is skipped when `CLAUDE_CONFIG_DIR` was already set (the escape hatch means the user has named a configuration directory explicitly, and agent-shim manages neither its contents nor its lifetime) and when no identity resolved at all (a bare launch against plain `~/.claude`, matching the legacy tool's own behaviour). In both cases there is no agent-shim-managed farm for a resync to act on.
 */
export function prepareLaunch(params: PrepareLaunchParams): LaunchPlan {
  const { paths, proc, log } = params;
  const { env } = proc;
  const decided = decideLaunch(params, false);
  const { identityDecision, configProfileDecision, resolvedProvider, identityCredential, poolPick, poolRanking, notes, flags: resolvedFlags, args: finalArgv, configDirEscapeHatch: configDirEscapeHatchApplies, decision } = decided;

  // Everything the launch has to say about itself is collected as it is decided and printed as one block once the launch is ready to start, so what a person reads is a single table of facts and not lines scattered between the steps. Warnings follow it.
  const rows: ReportRow[] = [
    ...decisionRows({
      identity: identityDecision.name,
      identitySource: identityDecision.source,
      pool: poolPick,
      ranking: resolvedFlags.explain ? poolRanking : undefined,
      profile: configProfileDecision.name === undefined ? undefined : { name: configProfileDecision.name, source: configProfileDecision.source },
      provider: resolvedProvider === undefined ? undefined : { name: resolvedProvider.name, credential: `${resolvedProvider.credential.target} from ${describeSource(resolvedProvider.credential.source)}` },
      identityCredential: identityCredential === undefined ? undefined : `${identityCredential.target} from ${describeSource(identityCredential.source)}`,
    }),
  ];
  let warnings: readonly DiagnosticLine[] = [];

  // The launch-time update check sits directly after the launch's decisions are made: it is the last thing that may write to the terminal before the child owns it, it never awaits anything (its answer arrives, if at all, while the child runs), and it is wrapped so a network or filesystem failure never delays, blocks or fails the launch.
  const updateCheck = runLaunchUpdateCheck({
    mode: params.updateMode ?? "off",
    checkPath: path.join(paths.root, "update.check"),
    currentVersion: packageJson.version,
    port: params.update,
  });

  // The farm resync sits here, between the identity/profile decision above and the daemons below, because it needs the first: the launch flags it would otherwise have produced are already in `decided`, computed from the same assembled cascade it consumes.
  if (decided.farmContext !== undefined) {
    const { farm: resyncFarmRuntime, identity: resyncIdentity, cascade } = decided.farmContext;
    let result;
    try {
      result = resyncFarm({
        fs: resyncFarmRuntime.fs,
        identitiesDir: paths.identitiesDir,
        identity: resyncIdentity,
        ...(configProfileDecision.name === undefined ? {} : { configProfile: configProfileDecision.name }),
        claudeHome: resyncFarmRuntime.claudeHome,
        home: resyncFarmRuntime.home,
        cwd: resyncFarmRuntime.cwd,
        env,
        ...(resyncFarmRuntime.branch === undefined ? {} : { branch: resyncFarmRuntime.branch }),
        ...(resyncFarmRuntime.branchDetached === undefined ? {} : { branchDetached: resyncFarmRuntime.branchDetached }),
        cascade,
        classification: resyncFarmRuntime.classification,
        now: resyncFarmRuntime.now,
        uniqueSuffix: resyncFarmRuntime.uniqueSuffix,
        lock: resyncFarmRuntime.lock,
      });
    } catch (error) {
      if (error instanceof IdentityLockBusyError) {
        log.error(error.message);
        proc.exit(1);
      }
      throw error;
    }

    warnings = diagnosticLines(result.diagnostics);
    // A farm that already matched has nothing to report: the row would say the same on every launch.
    if (!result.noOp) {
      rows.push(farmRow(result.manifest.links.length, result.manifest.materialised.length, result.adopted.length));
    }
  }

  if (decided.pinnedVersion !== undefined) {
    rows.push(pinnedVersionRow(decided.pinnedVersion.version, decided.pinnedVersion.source));
  }

  // A router or routeByName session sends provider-qualified model names the door resolves through the models block, so every provider a definition names is about to carry this session's requests: its credential is resolved now, so a missing one fails the launch naming the provider instead of surfacing as a bare 502 on the first request that names it. A family member is checked through every provider that offers a target of the family, and an account member is the door's to resolve (it relaunches rather than dialling out). A read-only resolution never reaches this code, so it still resolves no credential.
  const routesByName = resolvedFlags.routeByName || (resolvedProvider !== undefined && isRouterProvider(resolvedProvider.definition));
  if (routesByName) {
    const check = resolveRoutedProviderCredentials({ paths, port: params.fs, env, ...(params.credentials === undefined ? {} : { credentials: params.credentials }), models: decided.models, targets: () => targetRefs(paths) });
    if (!check.ok) {
      log.error(check.message);
      proc.exit(check.status);
    }
  }

  // The front door comes up first, before headroom: every routed session (a provider's, or headroom's) enters through it, and headroom's allowlist must hold the door's direct origin, which is what every provider session routed through headroom (a codex session's included) is forwarded back to, and the headroom supervisor lists the origin of a door that has served. `ensure` authenticates the door's listener over TLS before returning anything, so the address the child is handed below (and sends its credential to) belongs to a listener holding a leaf from agent-shim's CA.
  const frontDoorPort = params.frontdoor;
  const frontDoorEngaged = resolvedProvider !== undefined || resolvedFlags.headroom || resolvedFlags.trackUsage;
  if (frontDoorEngaged && frontDoorPort === undefined) {
    log.error("agent-shim: this launch routes through the front-door daemon, but this launcher has no front-door port wired; refusing to launch without it.");
    proc.exit(1);
  }
  // The id this launch's requests carry in their session header, and the models block the door resolves them against: the global block live when this launch adds nothing to it, else the block this launch resolved (a deeper layer's definitions the door cannot read from the global file). An absent resolved block against a present global one means a deeper layer removed everything, which the door is told as an empty block.
  const sessionId = params.supervised?.sessionId ?? randomUUID();
  const resolvedModels = decided.models ?? (decided.globalModels === undefined ? undefined : {});
  const sessionModels = isDeepStrictEqual(resolvedModels, decided.globalModels) ? undefined : resolvedModels;
  const frontDoor = frontDoorEngaged && frontDoorPort !== undefined ? frontDoorPort.ensure(env.NODE_EXTRA_CA_CERTS, { sessionId, ...(sessionModels === undefined ? {} : { models: sessionModels }) }) : undefined;
  if (frontDoor?.trustWarning !== undefined) {
    log.warn(frontDoor.trustWarning);
  }

  let headroom: HeadroomUp | undefined;
  const headroomPort = params.headroom;
  if (resolvedFlags.headroom && headroomPort !== undefined) {
    headroom = headroomPort.ensure({ routesProvider: resolvedProvider !== undefined });
  } else if (resolvedFlags.headroom) {
    log.error("agent-shim: headroom routing was requested but this launcher has no headroom port wired; refusing to launch without it.");
    proc.exit(1);
  }
  rows.push(...routingRows({ frontDoor, headroom, provider: resolvedProvider !== undefined }));
  const frontDoorRelease = frontDoor === undefined ? undefined : frontDoorPort?.release;

  const finalEnv = buildEnv({
    baseEnv: env,
    configDirEscapeHatch: configDirEscapeHatchApplies,
    resolvedIdentityName: identityDecision.name,
    identitiesDir: paths.identitiesDir,
    ...(resolvedProvider === undefined ? {} : { provider: resolvedProvider }),
    ...(identityCredential === undefined ? {} : { identityCredential }),
    ...(frontDoor === undefined ? {} : { frontdoor: frontDoor }),
    ...(headroom === undefined ? {} : { headroom }),
    sessionId,
    remoteControl: resolvedFlags.remoteControl,
    routeByName: routesByName,
    ...(decided.models?.tiers === undefined ? {} : { tierModels: decided.models.tiers }),
  });

  // Every daemon session registration this launch holds, released when the child exits.
  const releases = [...(headroom === undefined || headroomPort === undefined ? [] : [headroomPort.release]), ...(frontDoorRelease === undefined ? [] : [frontDoorRelease])];
  const release = (): void => {
    for (const registered of releases) {
      registered();
    }
  };
  rows.push(...notes.map(noteRow));
  log.report(rows);
  printDiagnosticLines(log, warnings, { errorsAsWarnings: false });
  const hold = (): HoldOutcome => holdBeforeLaunch({ delayMs: resolvedFlags.delayMs, pause: resolvedFlags.pause }, params.hold, log);
  return { bin: decided.bin, args: finalArgv, env: finalEnv, sessionId, release, markChildStarted: updateCheck.markChildStarted, hold, decision };
}

/**
 * What one launch would resolve to, reported without performing it: the decision, the resolved launch flags, the binary and argument list, the credential that would apply (by its block, never a token) and the names of the environment variables the launch would set.
 */
export interface LaunchResolution {
  /** What the launch resolved to, as data: the same decision a real launch reports. */
  readonly decision: LaunchDecision;
  /** The launch flags after the command line, the environment and the cascade have each had their say. */
  readonly flags: ResolvedLaunchFlags;
  /** The Claude Code version the launch pins, and what pinned it, when it pins one. */
  readonly claudeVersion?: PinnedClaudeVersion;
  /** The real `claude` binary the launch would spawn. */
  readonly bin: string;
  /** The arguments the launch would pass it. */
  readonly args: readonly string[];
  /** The credential the launch would authenticate with, summarised by target and source kinds. Absent when none applies. */
  readonly credential?: { readonly subject: "provider" | "identity"; readonly name: string; readonly summary: CredentialSummary };
  /** Which daemons the launch would route through, and whether it routes provider-qualified model names through the models block. */
  readonly routing: { readonly frontDoor: boolean; readonly headroom: boolean; readonly routeByName: boolean };
  /** The names of the environment variables the launch would set or unset, sorted. Values are never reported: the launcher's environment carries tokens and per-launch capabilities that mean nothing outside it. */
  readonly environment: readonly string[];
}

/**
 * Resolves one launch exactly as `prepareLaunch` decides it and reports the result, changing nothing: no farm recovery or resync, no daemon started or session registered, no pool pick recorded or waited for, no credential command run or token read.
 *
 * Refusals surface as `prepareLaunch` surfaces them: logged through `params.log` and ended in `params.proc.exit`.
 */
export function resolveLaunch(params: PrepareLaunchParams): LaunchResolution {
  const decided = decideLaunch(params, true);
  const { env } = params.proc;
  const frontDoor = decided.provider !== undefined || decided.flags.headroom || decided.flags.trackUsage;
  // The environment the launch would build, with placeholders for what a daemon would supply: only which names it sets is reported, and the placeholders never leave this function.
  const built = buildEnv({
    baseEnv: env,
    configDirEscapeHatch: decided.configDirEscapeHatch,
    resolvedIdentityName: decided.identityDecision.name,
    identitiesDir: params.paths.identitiesDir,
    ...(decided.provider === undefined ? {} : { provider: decided.provider }),
    ...(frontDoor ? { frontdoor: { port: 0, connectPort: 0, trustBundlePath: "", sessionToken: "" } } : {}),
    ...(decided.flags.headroom ? { headroom: { socketPath: "", projectId: "" } } : {}),
    sessionId: "",
    remoteControl: decided.flags.remoteControl,
    routeByName: decided.flags.routeByName,
  });
  const credentialNames = decided.identityCredentialBlock === undefined ? [] : Object.keys(credentialVariables(decided.identityCredentialBlock.target ?? "bearer", ""));
  const environment = [...new Set([...Object.keys(built).filter((name) => built[name] !== env[name]), ...credentialNames])].sort();
  const credential =
    decided.provider !== undefined
      ? isRouterProvider(decided.provider.definition)
        ? undefined
        : { subject: "provider" as const, name: decided.provider.name, summary: summariseCredential(decided.provider.definition.credential) }
      : decided.identityCredentialBlock !== undefined && decided.farmIdentity !== undefined
        ? { subject: "identity" as const, name: decided.farmIdentity, summary: summariseCredential(decided.identityCredentialBlock) }
        : undefined;
  return {
    decision: decided.decision,
    flags: decided.flags,
    ...(decided.pinnedVersion === undefined ? {} : { claudeVersion: decided.pinnedVersion }),
    bin: decided.bin,
    args: decided.args,
    ...(credential === undefined ? {} : { credential }),
    routing: { frontDoor, headroom: decided.flags.headroom, routeByName: decided.flags.routeByName },
    environment,
  };
}

/**
 * Runs the child a `plan` describes under `spawn` and returns its exit code, in the order every launch observes: the update check's notice is suppressed from the moment the child takes the terminal, the child runs to completion, and the plan's session registrations are released whether it exited, was signalled or could not be spawned. A spawn failure is thrown after the release rather than turned into an exit code.
 */
export function runLaunchPlan(plan: LaunchPlan, spawn: SpawnPort): number {
  try {
    if (plan.hold() === "cancelled") {
      return LAUNCH_CANCELLED_EXIT;
    }
    // Marked before the spawn, not after it: the synchronous spawn blocks the event loop for the whole session, so a check answer arriving from here on is late by definition and must print nothing.
    plan.markChildStarted();
    const result = spawn.spawnSync(plan.bin, plan.args, { stdio: "inherit", env: plan.env });
    if (result.error !== undefined) {
      throw result.error;
    }
    return childExitCode(result);
  } finally {
    plan.release();
  }
}

/**
 * Runs one `claude` launch: `prepareLaunch`, then the child under `params.spawn`, whose exit code becomes this process's.
 *
 * The session registrations are released by `runLaunchPlan` before `proc.exit` runs, because the real `process.exit` never unwinds a `finally` block.
 */
export function runLauncher(params: RunLauncherParams): void {
  params.proc.exit(runLaunchPlan(prepareLaunch(params), params.spawn));
}
