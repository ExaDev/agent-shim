import { randomUUID } from "node:crypto";
import path from "node:path";

import { parseEnvBool } from "./cli/parsers";
import type { LayoutPaths } from "./paths";
import { parseLauncherArgv } from "./launcher/argv";
import { buildCliOverride, type CliOverride } from "./launcher/cliOverride";
import { recoverFarm, recoveryDiagnostics, resyncFarm } from "./launcher/farm";
import { evaluateAmbientCredentialGuard } from "./launcher/guard";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./launcher/identity";
import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags, type ResolvedProvider, type RoutedProvider } from "./launcher/flags";
import { splitExtraFlags } from "./launcher/extraFlags";
import { IdentityLockBusyError } from "./launcher/lock";
import type { FarmFs, FsPort, FrontDoorPort, HeadroomPort, HeadroomUp, LogPort, ProcPort, SpawnPort } from "./launcher/ports";
import { spawnClaude } from "./launcher/spawn";
import { resolveProvider } from "./providers";
import { flattenLayers } from "./resolve/flatten";
import { assembleCascade } from "./resolve/walk";
import { providerBaseUrl } from "./frontdoor/route";
import { CREDENTIAL_TARGET_VARS, type CategoryClassification, type CategoryClassificationOverlay, type Credential, type LaunchFlags } from "./config/schema";
import { CREDENTIAL_UNAVAILABLE_EXIT, describeSource, resolveCredential, type CredentialPort, type ResolvedCredential } from "./credential";
import type { CascadeInput } from "./resolve/walk";
import { ANTHROPIC_PROVIDER } from "./usage/middleware";
import { quotaWarnings } from "./usage/preflight";
import { readUsageSnapshot, UsageSnapshotError } from "./usage/read";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

/**
 * Everything the farm resync needs that the launcher itself has no way to produce: a real filesystem, a real clock, the working directory, and a way to load the cascade for it.
 *
 * Supplied by `src/cli.ts` in normal operation. A caller that omits it launches with no farm at all, which is the right behaviour in exactly the cases where there is no claude-use-managed farm to resync — and is what the launcher's own pre-farm tests exercise.
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

/** Inputs to `runLauncher`. */
export interface RunLauncherParams {
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  readonly spawn: SpawnPort;
  readonly proc: ProcPort;
  readonly log: LogPort;
  /** Discovers the real `claude` binary to spawn. Injected so `runLauncher` never depends on `src/versionDiscovery.ts`'s own filesystem/PATH inputs directly — the caller (`src/cli.ts`) wires the real discovery, tests wire a fake that returns a fixed path. */
  readonly resolveClaudeBinary: () => DiscoveredClaudeBinary;
  /** An identity pinned to `$PWD` by a directory rule. Accepted as an already-resolved value — the rules-loading code that produces it lands in Phase 4/5. */
  readonly directoryPinnedIdentity?: string;
  /** A directory rule's `configProfile` selection for `$PWD`. Accepted as an already-resolved value for the same reason. */
  readonly directoryRuleConfigProfile?: string;
  /** An explicit `--config-profile` value, when the caller wants to force one regardless of argv — normal operation instead relies on `parseLauncherArgv` finding `--config-profile` in `proc.argv` itself, so this is only needed to override that. */
  readonly cliFlagConfigProfile?: string;
  /** The user-global `~/.claude-use/config.json` default configuration profile, when one is configured. */
  readonly globalDefaultConfigProfile?: string;
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
    return { ok: false, status: 1, message: `claude-use: identity ${identity} needs its credential resolved, but this launcher has no credential port wired` };
  }
  const resolution = resolveCredential({ credential, env, port, subject: `identity ${identity}` });
  return resolution.ok ? resolution : { ok: false, status: CREDENTIAL_UNAVAILABLE_EXIT, message: resolution.message };
}

/**
 * Orchestrates one `claude` launch, in order:
 *
 * `CLAUDE_CONFIG_DIR` escape-hatch check, then the identity/config-profile decision, the provider decision, the identity's own credential, the ambient-credential guard, farm resync, version discovery, flag resolution (and, when headroom resolved on, daemon bring-up), the extra-flags split, and finally spawn.
 *
 * A launch that resolves an identity with no `identity.json`, or a configuration profile with no file, is refused with exit 1 naming the missing name and how it was selected: silently proceeding would create a brand-new login for a mistyped `@name`, or launch with a whole cascade layer missing. On a terminal, `src/runClaude.ts` offers to create either before this runs.
 *
 * The farm resync is skipped when `CLAUDE_CONFIG_DIR` was already set (the escape hatch means the user has named a configuration directory explicitly, and claude-use manages neither its contents nor its lifetime) and when no identity resolved at all (a bare launch against plain `~/.claude`, matching the legacy tool's own behaviour). In both cases there is no claude-use-managed farm for a resync to act on.
 */
export function runLauncher(params: RunLauncherParams): void {
  const { paths, fs, spawn, proc, log } = params;
  const { env, argv } = proc;

  const parsedArgv = parseLauncherArgv(argv);
  const cliOverride = buildCliOverride({
    env,
    categoryFlags: parsedArgv.categoryFlags,
    shareFlags: parsedArgv.shareFlags,
    hideFlags: parsedArgv.hideFlags,
  });
  const configDirEscapeHatchApplies = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== "";

  const identityDecision = decideIdentity({
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

  // There is a farm to manage only when an identity resolved and the caller did not name a configuration directory itself.
  const farmIdentity = configDirEscapeHatchApplies ? undefined : identityDecision.name;
  const farm = farmIdentity === undefined ? undefined : params.farm;

  // Recovery runs before the identity is loaded, not merely before the farm is rebuilt: `identity.json` lives inside the farm root, so a crash between the swap's two renames leaves it in a superseded directory. Reading it first would launch with the identity's own configuration profile silently unset.
  if (farm !== undefined && farmIdentity !== undefined) {
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
      log.warn(`claude-use: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  let loadedIdentity: ReturnType<typeof loadIdentity>;
  if (identityDecision.name !== undefined) {
    loadedIdentity = loadIdentity(paths.identitiesDir, identityDecision.name, fs);
    if (loadedIdentity === undefined) {
      log.error(
        `claude-use: no identity named "${identityDecision.name}" (selected via ${identityDecision.source}). ` +
          `Run \`claude-use identity add ${identityDecision.name}\` first.`,
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
      `claude-use: no configuration profile named "${configProfileDecision.name}" (selected via ${configProfileDecision.source}). ` +
        `Run \`claude-use profile add ${configProfileDecision.name}\` first.`,
    );
    proc.exit(1);
  }

  // The cascade is loaded once here, ahead of both the provider decision below and the farm resync further down. A provider name can be pinned by any cascade layer exactly like a launch flag, so it has to be knowable before the ambient-credential guard runs: a provider launch injects its own credential into the child after the guard, which is exactly what the guard would otherwise refuse over. Loading once and passing the same value into the resync also avoids reading the config files twice.
  const farmContext =
    farm !== undefined && farmIdentity !== undefined
      ? { farm, identity: farmIdentity, cascade: farm.loadCascade(configProfileDecision.name, cliOverride) }
      : undefined;

  // `--no-provider` opts this one launch out of whatever provider the cascade would otherwise select, so resolution is skipped outright rather than asked to ignore its own cascade input.
  const provider =
    parsedArgv.provider === false
      ? undefined
      : resolveProvider({
          paths,
          port: fs,
          env,
          ...(params.credentials === undefined ? {} : { credentials: params.credentials }),
          ...(parsedArgv.provider === undefined ? {} : { cliProvider: parsedArgv.provider }),
          ...(farmContext === undefined ? {} : { cascade: farmContext.cascade }),
        });
  if (provider !== undefined && !provider.ok) {
    log.error(provider.message);
    proc.exit(provider.status);
  }
  const resolvedProvider: ResolvedProvider | undefined = provider?.ok === true ? provider.provider : undefined;
  for (const warning of provider?.ok === true ? provider.warnings : []) {
    log.warn(warning);
  }

  // A launch is never blocked by quota: the warning only says what the front door last saw for the provider this launch will use.
  if (farm !== undefined && farmIdentity !== undefined) {
    try {
      const snapshot = readUsageSnapshot(farm.fs, paths.usageSnapshotsDir, farmIdentity);
      for (const warning of quotaWarnings(snapshot, resolvedProvider?.name ?? ANTHROPIC_PROVIDER, farm.now())) {
        log.warn(warning);
      }
    } catch (error) {
      if (!(error instanceof UsageSnapshotError)) {
        throw error;
      }
      log.warn(`claude-use: ${error.message}`);
    }
  }

  // The identity's own credential applies only when no provider was selected (the provider's credential authenticates against its endpoint instead) and the identity owns this launch's configuration directory (under the CLAUDE_CONFIG_DIR escape hatch, the directory and whatever login it holds are the caller's).
  const identityCredentialBlock = loadedIdentity?.config.credential;
  const identityResolution =
    resolvedProvider === undefined && farmIdentity !== undefined && identityCredentialBlock !== undefined
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
    allowAmbientCredentialOverride: parseEnvBool("CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL", env.CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL) === true,
    identityName: identityDecision.name,
    providerSelected: resolvedProvider !== undefined,
    ...(identityCredential === undefined
      ? {}
      : { injectedCredential: { variable: CREDENTIAL_TARGET_VARS[identityCredential.target], token: identityCredential.token } }),
  });
  if (!guardResult.ok) {
    log.error(guardResult.message);
    proc.exit(1);
  }

  log.info(
    `claude-use: identity ${identityDecision.name ?? "(none)"} (${identityDecision.source}), ` +
      `config profile ${configProfileDecision.name ?? "(none)"} (${configProfileDecision.source})` +
      (resolvedProvider === undefined
        ? ""
        : `, provider ${resolvedProvider.name} (credential ${resolvedProvider.credential.target} from ${describeSource(resolvedProvider.credential.source)})`) +
      (identityCredential === undefined
        ? ""
        : `, identity credential ${identityCredential.target} from ${describeSource(identityCredential.source)}`),
  );

  // The farm resync sits here, between the identity/profile decision above and flag resolution below, because it needs the first and produces an input to the second: the cascade it resolves carries this launch's `launch` flags, which is why `resolveLaunchFlags` is called with them rather than with the environment alone.
  let cascadeLaunch: LaunchFlags | undefined;
  if (farmContext !== undefined) {
    const { farm: resyncFarmRuntime, identity: resyncIdentity, cascade } = farmContext;
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

    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === "error") {
        log.error(`claude-use: ${diagnostic.code}: ${diagnostic.message}`);
      } else if (diagnostic.severity === "warning") {
        log.warn(`claude-use: ${diagnostic.code}: ${diagnostic.message}`);
      }
    }
    log.info(
      result.noOp
        ? `claude-use: farm at ${result.farmRoot} already matches the resolved cascade`
        : `claude-use: farm at ${result.farmRoot} resynced (${String(result.manifest.links.length)} link(s), ` +
          `${String(result.manifest.materialised.length)} built director(ies)${result.adopted.length === 0 ? "" : `, ${String(result.adopted.length)} adopted into ${resyncFarmRuntime.claudeHome}`})`,
    );
    cascadeLaunch = result.resolved.flattened.launch;
  } else if (params.farm !== undefined) {
    // Escape-hatch and bare launches have no farm to resync (the local `farm` is undefined exactly then), but launch flags are claude-use's own behaviour, not the farm's: a global `launch.headroom` (or any other launch setting) must still apply when CLAUDE_CONFIG_DIR was already set or no identity resolved. Provider selection above already read this same cascade; this resolves only its launch block and writes nothing.
    cascadeLaunch = flattenLayers(assembleCascade(params.farm.loadCascade(configProfileDecision.name, cliOverride)).layers, { home: params.farm.home }).launch;
  }

  const discovered = params.resolveClaudeBinary();

  const resolvedFlags = resolveLaunchFlags({
    env,
    ...(cascadeLaunch === undefined ? {} : { cascade: cascadeLaunch }),
    flags: {
      ...(parsedArgv.skipPermissions === undefined ? {} : { skipPermissions: parsedArgv.skipPermissions }),
      ...(parsedArgv.remoteControl === undefined ? {} : { remoteControl: parsedArgv.remoteControl }),
      ...(parsedArgv.headroom === undefined ? {} : { headroom: parsedArgv.headroom }),
      ...(parsedArgv.trackUsage === undefined ? {} : { trackUsage: parsedArgv.trackUsage }),
    },
  });

  // The front door comes up first, before headroom: every routed session (a provider's, or headroom's) enters through it, and headroom's allowlist is fixed when its daemon starts and must already contain the door's origin, which is what a codex session routed through headroom is forwarded back to. `ensure` authenticates the door's listener over TLS before returning anything, so the address the child is handed below (and sends its credential to) belongs to a listener holding a leaf from claude-use's CA.
  const frontDoorPort = params.frontdoor;
  const frontDoorEngaged = resolvedProvider !== undefined || resolvedFlags.headroom || resolvedFlags.trackUsage;
  if (frontDoorEngaged && frontDoorPort === undefined) {
    log.error("claude-use: this launch routes through the front-door daemon, but this launcher has no front-door port wired; refusing to launch without it.");
    proc.exit(1);
  }
  const frontDoor = frontDoorEngaged && frontDoorPort !== undefined ? frontDoorPort.ensure(env.NODE_EXTRA_CA_CERTS) : undefined;
  if (frontDoor?.trustWarning !== undefined) {
    log.warn(frontDoor.trustWarning);
  }
  let routedProvider: RoutedProvider | undefined;
  if (resolvedProvider !== undefined && frontDoor !== undefined) {
    routedProvider = { ...resolvedProvider, baseUrl: providerBaseUrl(frontDoor.port, resolvedProvider.name) };
  }

  let headroom: HeadroomUp | undefined;
  const headroomPort = params.headroom;
  if (resolvedFlags.headroom && headroomPort !== undefined) {
    headroom = headroomPort.ensure();
    const via = resolvedProvider === undefined ? `OAuth via the door's CONNECT surface on 127.0.0.1:${String(frontDoor?.connectPort ?? 0)}` : `provider ${resolvedProvider.name}`;
    log.info(`claude-use: routing through the front door on 127.0.0.1:${String(frontDoor?.port ?? 0)} with headroom on 127.0.0.1:${String(headroom.port)} (${via}, project ${headroom.projectId})`);
  } else if (resolvedFlags.headroom) {
    log.error("claude-use: headroom routing was requested but this launcher has no headroom port wired; refusing to launch without it.");
    proc.exit(1);
  } else if (frontDoor !== undefined) {
    log.info(`claude-use: routing through the front door on 127.0.0.1:${String(frontDoor.port)}${resolvedProvider === undefined ? ` (OAuth via the door's CONNECT surface on 127.0.0.1:${String(frontDoor.connectPort)}, usage recorded)` : ` (provider ${resolvedProvider.name})`}`);
  }
  const frontDoorRelease = frontDoor === undefined ? undefined : frontDoorPort?.release;

  const finalArgv = buildArgv({
    toolFlags: buildFlagArgs(resolvedFlags),
    extraFlags: splitExtraFlags(env.CLAUDE_EXTRA_FLAGS),
    passthrough: parsedArgv.rest,
  });
  const finalEnv = buildEnv({
    baseEnv: env,
    configDirEscapeHatch: configDirEscapeHatchApplies,
    resolvedIdentityName: identityDecision.name,
    identitiesDir: paths.identitiesDir,
    ...(routedProvider === undefined ? {} : { provider: routedProvider }),
    ...(identityCredential === undefined ? {} : { identityCredential }),
    ...(frontDoor === undefined ? {} : { frontdoor: frontDoor }),
    ...(headroom === undefined ? {} : { headroom }),
    sessionId: randomUUID(),
  });

  // Every daemon session registration this launch holds, released when the child exits.
  const releases = [...(headroom === undefined || headroomPort === undefined ? [] : [headroomPort.release]), ...(frontDoorRelease === undefined ? [] : [frontDoorRelease])];
  if (releases.length === 0) {
    spawnClaude({ bin: discovered.path, args: finalArgv, env: finalEnv, spawn, proc });
  }
  const releaseAll = (): void => {
    for (const release of releases) {
      release();
    }
  };
  // The session registrations are released twice by design: `beforeExit` covers the real success path (where `process.exit` never unwinds a `finally`), and the `finally` below covers a thrown spawn error, where it does. Each `release` is idempotent, so the double call in a test fake (whose `exit` throws rather than terminates) is harmless.
  try {
    spawnClaude({
      bin: discovered.path,
      args: finalArgv,
      env: finalEnv,
      spawn,
      proc,
      beforeExit: releaseAll,
    });
  } finally {
    releaseAll();
  }
}
