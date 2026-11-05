import { realPromptsPort, runProfileWizard } from "./configure";
import { PromptCancelledError } from "./cliError";
import { profileExists } from "./configProfilesStore";
import { runIdentityWizard } from "./identityManager";
import { pickLaunchIdentity } from "./launchPicker";
import { buildFarmRuntime, realClaudeBinaryResolver, realPrepareLaunchParams } from "./launchWiring";
import { resolveLayoutPaths } from "./paths";
import { readyTerminalIdentity } from "./terminalIdentity";
import { refreshPools } from "./poolUsageRefresh";
import { runSupervised, supervisesLaunch } from "./supervise/launch";
import { prepareLaunch, runLauncher } from "./launcher";
import { parseLauncherArgv } from "./launcher/argv";
import { IdentityPickerCancelledError } from "./launcher/runPicker";
import { runNativeLaunch } from "./launcher/native";
import { decideConfigProfile, decideIdentity, loadIdentity, readActiveIdentity } from "./launcher/identity";
import { realFsPort, realLogPort, realProcPort, realRunPort, realSpawnPort, spawnDetachedSupervisor } from "./realPorts";
import { realLaunchUpdatePort } from "./update/commands";

/** Runs the launcher pipeline. `argvOverride`, when given, replaces `realProcPort`'s own `process.argv.slice(2)`; this is what lets `agent-shim run [args...]` reach the identical pipeline the `claude` binary name uses, fed the args Commander collected instead of the real argv. */
export async function runClaude(argvOverride?: readonly string[]): Promise<void> {
  const paths = resolveLayoutPaths();
  const launchProc = argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride };
  const nativeArgv = parseLauncherArgv(launchProc.argv);
  if (nativeArgv.native === true) {
    runNativeLaunch({ parsed: nativeArgv, proc: launchProc, spawn: realSpawnPort, resolveClaudeBinary: realClaudeBinaryResolver(paths) });
  }
  const farm = buildFarmRuntime(paths, process.cwd());

  // On a real terminal, a launch that selects an identity or configuration profile that doesn't exist yet is offered the matching wizard before launching, so the first reference to a new name sets it up instead of failing. With no terminal (a script, CI) there is nothing to prompt on, and runLauncher refuses the missing name itself.
  let allowMissingConfigProfile = false;
  const procForDecision = argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride };
  const identityDecision = decideIdentity({
    env: procForDecision.env,
    argv0Identity: nativeArgv.identity,
    ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
    readActiveIdentityFile: () => readActiveIdentity(realFsPort, paths.activeIdentityFile),
  });
  if (process.stdin.isTTY) {
    // An identity an interrupted resync displaced is put back here, as a launch with no terminal puts it back, so only a name no identity claims is offered the wizard. Under the CLAUDE_CONFIG_DIR escape hatch no identity is selected, so there is nothing to put back or offer.
    if (
      identityDecision.name !== undefined &&
      !(await readyTerminalIdentity({
        identitiesDir: paths.identitiesDir,
        name: identityDecision.name,
        fs: realFsPort,
        farm: farm.runtime,
        warn: realLogPort.warn,
        runWizard: async (name) => runIdentityWizard(realPromptsPort, paths, name, { run: realRunPort, platform: process.platform }, { activate: false }),
      }))
    ) {
      throw new PromptCancelledError();
    }
    const loadedIdentity =
      identityDecision.name !== undefined
        ? loadIdentity(paths.identitiesDir, identityDecision.name, realFsPort)
        : undefined;
    const configProfileDecision = decideConfigProfile({
      env: procForDecision.env,
      cliFlagConfigProfile: nativeArgv.configProfile,
      ...(farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: farm.directoryConfigProfile }),
      ...(loadedIdentity?.config.defaultConfigProfile === undefined
        ? {}
        : { identityDefaultConfigProfile: loadedIdentity.config.defaultConfigProfile }),
      ...(farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: farm.globalDefaultConfigProfile }),
    });
    if (configProfileDecision.name !== undefined && !profileExists(paths, configProfileDecision.name)) {
      const choice = await realPromptsPort.select({
        message:
          `Configuration profile "${configProfileDecision.name}" was selected for this launch (via ${configProfileDecision.source}) ` +
          `but doesn't exist yet. Create it now?`,
        options: [
          { value: "create", label: "Create it and choose categories" },
          { value: "skip", label: "Launch without it" },
        ],
      });
      if (realPromptsPort.isCancel(choice)) {
        throw new PromptCancelledError();
      }
      if (choice === "create") {
        if ((await runProfileWizard(realPromptsPort, { paths, createName: configProfileDecision.name })) === undefined) {
          throw new PromptCancelledError();
        }
      } else {
        allowMissingConfigProfile = true;
      }
    }
  }

  // A pool pick ranks on recorded usage, which only moves when a request passes the front door; members whose record has gone stale are asked for current figures first.
  const refreshUsage = async (poolName: string | undefined): Promise<void> => {
    await refreshPools({ paths, cwd: process.cwd(), poolNames: poolName === undefined ? [] : [poolName], spawnDaemon: spawnDetachedSupervisor, log: realLogPort.warn });
  };
  await refreshUsage(identityDecision.pool);

  // On a terminal, a launch with no identity, a pool pick that would change account, or an identity that is refused right now asks which identity to run as (and `--pick` always does), after the usage it ranks on is current.
  const picked = await pickLaunchIdentity({ paths, farm, parsed: nativeArgv, decision: identityDecision });
  if (picked.kind === "cancelled") {
    throw new IdentityPickerCancelledError();
  }
  const pickedIdentity = picked.kind === "selected" ? picked.selector : undefined;
  const launchDecision =
    pickedIdentity === undefined
      ? identityDecision
      : decideIdentity({ env: procForDecision.env, argv0Identity: pickedIdentity, readActiveIdentityFile: () => undefined });
  if (launchDecision.pool !== identityDecision.pool) {
    await refreshUsage(launchDecision.pool);
  }

  const prepareParams = {
    ...realPrepareLaunchParams(paths, {
      proc: argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride },
      log: realLogPort,
      spawnDaemon: spawnDetachedSupervisor,
      farm,
      allowMissingConfigProfile,
    }),
    ...(pickedIdentity === undefined ? {} : { pickedIdentity }),
    // Wired here rather than in realPrepareLaunchParams because the port re-invokes this very binary: correct for the agent-shim command line, wrong for a library host whose own executable is not agent-shim.
    update: realLaunchUpdatePort(paths),
  };

  // A pool that resumes on a spent quota runs its interactive session launches under the supervisor, which moves the session to another member when its identity runs out. A launch it cannot supervise falls through to the ordinary one below.
  const poolName = launchDecision.pool;
  if (poolName !== undefined && farm.pools !== undefined && supervisesLaunch(farm.pools[poolName], nativeArgv.rest)) {
    const code = await runSupervised({
      paths,
      pool: poolName,
      pools: farm.pools,
      farm: farm.runtime,
      passthrough: nativeArgv.rest,
      // The launch-time update check runs for the first launch only: its notice must not land on the terminal between a stopped child and its relaunch.
      prepare: (launch) => prepareLaunch(launch.member === undefined ? { ...prepareParams, supervised: launch } : { ...prepareParams, update: undefined, supervised: launch }),
      spawnDaemon: spawnDetachedSupervisor,
      log: realLogPort,
    });
    if (code !== undefined) {
      process.exit(code);
    }
  }

  runLauncher({ ...prepareParams, spawn: realSpawnPort });
}