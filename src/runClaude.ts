import os from "node:os";
import { randomUUID } from "node:crypto";

import { loadClassification } from "./config/classify";
import { cosmiconfigReader } from "./config/load";
import { realPromptsPort, runProfileWizard } from "./configure";
import { PromptCancelledError } from "./cliError";
import { resolveOwnInstallDirs } from "./claudeShim";
import { realFrontDoorPort } from "./frontdoor/commands";
import { profileExists } from "./configProfiles";
import { runIdentityWizard } from "./identityManager";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { resolveClaudeHome, resolveLayoutPaths, type LayoutPaths } from "./paths";
import { runLauncher, type FarmRuntime } from "./launcher";
import { parseLauncherArgv } from "./launcher/argv";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./launcher/identity";
import { loadCascadeInput, readDirectorySelections } from "./launcher/cascade";
import {
  realCredentialPort,
  realFarmFs,
  realFsPort,
  realHeadroomPort,
  realIsProcessRunning,
  realLogPort,
  realOwnExecutablePath,
  realProcPort,
  realResolveClaudeBinary,
  realRunPort,
  realSleepSync,
  realSpawnPort,
  resolveGitBranch,
} from "./realPorts";

/** Builds the farm runtime the launcher's resync step needs, wired to real filesystem, clock, git, and process facilities, plus the directory-scoped selections the launcher needs before it can resync anything. */
function buildFarmRuntime(paths: LayoutPaths): {
  runtime: FarmRuntime;
  directoryIdentity?: string;
  directoryConfigProfile?: string;
  globalDefaultConfigProfile?: string;
} {
  const home = os.homedir();
  const cwd = process.cwd();
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
  };
}

/** Runs the launcher pipeline. `argvOverride`, when given, replaces `realProcPort`'s own `process.argv.slice(2)`; this is what lets `claude-use run [args...]` reach the identical pipeline the `claude` binary name uses, fed the args Commander collected instead of the real argv. */
export async function runClaude(argvOverride?: readonly string[]): Promise<void> {
  const paths = resolveLayoutPaths();
  const farm = buildFarmRuntime(paths);

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
    paths,
    fs: realFsPort,
    spawn: realSpawnPort,
    proc: argvOverride === undefined ? realProcPort : { ...realProcPort, argv: argvOverride },
    log: realLogPort,
    resolveClaudeBinary: realResolveClaudeBinary(resolveOwnInstallDirs(paths, realOwnExecutablePath())),
    farm: farm.runtime,
    headroom: realHeadroomPort(paths),
    frontdoor: realFrontDoorPort(paths),
    credentials: { ...realCredentialPort, cache: realCredentialCacheEnv(paths) },
    ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
    ...(farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: farm.directoryConfigProfile }),
    ...(farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: farm.globalDefaultConfigProfile }),
    allowMissingConfigProfile,
  });
}
