import { Command } from "commander";

import packageJson from "../package.json";
import { registerCheckCommand } from "./check";
import { registerConfigureCommand } from "./configure";
import { registerShimCommand } from "./claudeShim";
import { registerDoctorCommand } from "./doctor";
import { registerHeadroomCommand } from "./headroom/commands";
import { registerIdentityCommand } from "./identityManager";
import { registerProfileCommand } from "./configProfiles";
import { registerProviderCommand } from "./providers";
import { registerRulesCommand } from "./directoryRules";
import type { LayoutPaths } from "./paths";
import { registerRunCommand } from "./runCommand";

/** Everything `buildProgram` needs from its caller: where the config tree lives, and the launcher pipeline `run` forwards to. */
export interface ProgramDeps {
  readonly paths: LayoutPaths;
  /** Runs the launcher pipeline with `run`'s forwarded arguments. Injected so building the program never wires real ports, and a test can assert what `run` forwards without launching anything. */
  readonly runClaude: (args: readonly string[]) => Promise<void>;
}

/**
 * Builds the complete `claude-use` Commander tree: `identity`, `profile`, `provider`, `rules`, `check`, `configure`, `doctor`, `shim`, `headroom`, and `run`, each registered by its own module as a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts`.
 *
 * Construction has no side effects: nothing is parsed, read or launched until the caller invokes `parseAsync` on the result. That is what lets the whole command surface be unit-tested against a throwaway `LayoutPaths` and a fake `runClaude`, while `src/cli.ts` stays the one module that runs on import.
 */
export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command();
  program
    .name("claude-use")
    .description("Profile manager for Claude Code identities and configuration profiles.")
    .version(packageJson.version)
    // Required so `-V`/`--version`/`-h`/`--help` are only recognised before the first subcommand token, not scanned for anywhere in argv; otherwise `claude-use run @name --version` would be silently intercepted by claude-use's own version handling before ever reaching `run`'s forwarded args.
    .enablePositionalOptions();

  const { paths } = deps;
  registerIdentityCommand(program, paths);
  registerProfileCommand(program, paths);
  registerProviderCommand(program, paths);
  registerRulesCommand(program, paths);
  registerCheckCommand(program, paths);
  registerConfigureCommand(program, paths);
  registerDoctorCommand(program, paths);
  registerShimCommand(program, paths);
  registerHeadroomCommand(program, paths);
  registerRunCommand(program, deps.runClaude);

  return program;
}
