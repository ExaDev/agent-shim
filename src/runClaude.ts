import { realPromptsPort, runProfileWizard } from "./configure";
import { PromptCancelledError } from "./cliError";
import { profileExists } from "./configProfilesStore";
import { runIdentityWizard } from "./identityManager";
import { buildFarmRuntime, realPrepareLaunchParams } from "./launchWiring";
import { resolveLayoutPaths } from "./paths";
import { runLauncher } from "./launcher";
import { parseLauncherArgv } from "./launcher/argv";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./launcher/identity";
import { realFsPort, realLogPort, realProcPort, realSpawnPort, spawnDetachedSupervisor } from "./realPorts";

/** Runs the launcher pipeline. `argvOverride`, when given, replaces `realProcPort`'s own `process.argv.slice(2)`; this is what lets `agent-shim run [args...]` reach the identical pipeline the `claude` binary name uses, fed the args Commander collected instead of the real argv. */
export async function runClaude(argvOverride?: readonly string[]): Promise<void> {
  const paths = resolveLayoutPaths();
  const farm = buildFarmRuntime(paths, process.cwd());

  // On a real terminal, a launch that selects an identity or configuration profile that doesn't exist yet is offered the matching wizard before launching, so the first reference to a new name sets it up instead of failing. With no terminal (a script, CI) there is nothing to prompt on, and runLauncher refuses the missing name itself.
  let allowMissingConfigProfile = false;
  if (process.stdin.isTTY) {
    const procForDecision = argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride };
    const parsedArgv = parseLauncherArgv(procForDecision.argv);
    const identityDecision = decideIdentity({
      env: procForDecision.env,
      argv0Identity: parsedArgv.identity,
      ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
      readActiveIdentityFile: () => {
        const raw = realFsPort.readFileUtf8(paths.activeIdentityFile);
        if (raw === undefined) {
          return undefined;
        }
        const trimmed = raw.trim();
        return trimmed === "" ? undefined : trimmed;
      },
    });
    if (
      identityDecision.name !== undefined &&
      loadIdentity(paths.identitiesDir, identityDecision.name, realFsPort) === undefined &&
      !(await runIdentityWizard(realPromptsPort, paths, identityDecision.name, { activate: false }))
    ) {
      throw new PromptCancelledError();
    }
    const loadedIdentity =
      identityDecision.name !== undefined
        ? loadIdentity(paths.identitiesDir, identityDecision.name, realFsPort)
        : undefined;
    const configProfileDecision = decideConfigProfile({
      env: procForDecision.env,
      cliFlagConfigProfile: parsedArgv.configProfile,
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

  runLauncher({
    ...realPrepareLaunchParams(paths, {
      proc: argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride },
      log: realLogPort,
      spawnDaemon: spawnDetachedSupervisor,
      farm,
      allowMissingConfigProfile,
    }),
    spawn: realSpawnPort,
  });
}