import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";

import packageJson from "../package.json";
import { loadClassification } from "./config/classify";
import { cosmiconfigReader } from "./config/load";
import { registerCheckCommand } from "./check";
import { CliError } from "./cliError";
import { realPromptsPort, registerConfigureCommand, runProfileWizard } from "./configure";
import { isInvokedAsClaude, registerShimCommand, resolveOwnInstallDirs } from "./claudeShim";
import { registerDoctorCommand } from "./doctor";
import { registerHeadroomCommand } from "./headroom/commands";
import { registerIdentityCommand, tryRunAtIdentityShortcut } from "./identityManager";
import { profileExists, registerProfileCommand } from "./configProfiles";
import { registerProviderCommand } from "./providers";
import { registerRulesCommand } from "./directoryRules";
import { resolveClaudeHome, resolveLayoutPaths, type LayoutPaths } from "./paths";
import { registerRunCommand } from "./runCommand";
import { runLauncher, type FarmRuntime } from "./launcher";
import { parseLauncherArgv } from "./launcher/argv";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./launcher/identity";
import { loadCascadeInput, readDirectorySelections } from "./launcher/cascade";
import {
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

/**
 * The single entrypoint backing both the `claude` and `claude-use` binaries — one compiled artifact, dispatching on which name it was invoked as (`path.basename(process.argv[1])`), per the SEA packaging proof-of-concept validated in Phase 2.
 *
 * `claude` runs the launcher (`src/launcher.ts`'s `runLauncher`), wired here with real ports (`src/realPorts.ts`) instead of the fakes every test in this project uses. It resolves the identity, loads and assembles the cascade for the current directory, resyncs that identity's symlink farm to match, and spawns the real `claude` binary with `CLAUDE_CONFIG_DIR` pointed at the farm.
 *
 * `claude-use` runs the Commander tree exposing `identity`/`profile`/`rules`/`check`/`configure`/`doctor`/`shim` subcommands, each a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts` — plus `run`, which reaches the exact same launcher pipeline as the `claude` binary above, just fed a different argv source, so a `claude`-named file on `PATH` is never required. `shim enable`/`shim disable` is the one explicit, separate action that creates or removes that `claude`-named file at all — nothing does so automatically.
 */
function buildClaudeUseProgram(): Command {
  const program = new Command();
  program
    .name("claude-use")
    .description("Profile manager for Claude Code identities and configuration profiles.")
    .version(packageJson.version)
    // Required so `-V`/`--version`/`-h`/`--help` are only recognised before the first subcommand token, not scanned for anywhere in argv -- otherwise `claude-use run @name --version` would be silently intercepted by claude-use's own version handling before ever reaching `run`'s forwarded args.
    .enablePositionalOptions();

  const paths = resolveLayoutPaths();
  registerIdentityCommand(program, paths);
  registerProfileCommand(program, paths);
  registerProviderCommand(program, paths);
  registerRulesCommand(program, paths);
  registerCheckCommand(program, paths);
  registerConfigureCommand(program, paths);
  registerDoctorCommand(program, paths);
  registerShimCommand(program, paths);
  registerHeadroomCommand(program, paths);
  registerRunCommand(program, runClaude);

  return program;
}

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

/** Runs the launcher pipeline. `argvOverride`, when given, replaces `realProcPort`'s own `process.argv.slice(2)` -- this is what lets `claude-use run [args...]` reach the identical pipeline the `claude` binary name uses, fed the args Commander collected instead of the real argv. */
async function runClaude(argvOverride?: readonly string[]): Promise<void> {
  const paths = resolveLayoutPaths();
  const farm = buildFarmRuntime(paths);

  // When stdin is a real interactive terminal and a configuration profile was resolved for this launch but doesn't exist on disk yet, offer to create it via the wizard before launching — so the first reference to a new profile name doesn't silently run with no profile applied. A non-interactive context (a script, CI) keeps today's behaviour: the missing profile is a silent no-op for that cascade layer, and the launch proceeds without blocking.
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
    if (
      configProfileDecision.name !== undefined &&
      !profileExists(paths, configProfileDecision.name) &&
      !identityDecision.configDirEscapeHatch
    ) {
      const choice = await realPromptsPort.select({
        message:
          `Configuration profile "${configProfileDecision.name}" was selected for this launch (via ${configProfileDecision.source}) ` +
          `but doesn't exist yet. Create it now?`,
        options: [
          { value: "create", label: "Create it and choose categories" },
          { value: "skip", label: "Launch without it" },
        ],
      });
      if (!realPromptsPort.isCancel(choice) && choice === "create") {
        await runProfileWizard(realPromptsPort, { paths, createName: configProfileDecision.name });
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
    ...(farm.directoryIdentity === undefined ? {} : { directoryPinnedIdentity: farm.directoryIdentity }),
    ...(farm.directoryConfigProfile === undefined ? {} : { directoryRuleConfigProfile: farm.directoryConfigProfile }),
    ...(farm.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: farm.globalDefaultConfigProfile }),
  });
}

/**
 * `parseAsync`, not `parse` -- some Commander actions (e.g. `identity resolve <name>`) are `async` and return a promise Commander never awaits under `parse`, so a rejection there would surface as an unhandled promise rejection rather than reaching the catch below.
 */
async function main(): Promise<void> {
  const invokedName = path.basename(process.argv[1] ?? "claude-use");
  if (isInvokedAsClaude(invokedName)) {
    await runClaude();
    return;
  }
  if (await tryRunAtIdentityShortcut(resolveLayoutPaths(), process.argv.slice(2))) {
    return;
  }
  await buildClaudeUseProgram().parseAsync(process.argv);
}

main().catch((error: unknown) => {
  // A CliError represents an expected, user-facing failure -- bad input, a missing identity/profile/rule -- so it prints as a clean one-line message. Anything else is a genuine bug and is rethrown to crash with its full stack trace, which is more useful for diagnosing it than swallowing it would be.
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
});
