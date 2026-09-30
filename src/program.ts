import { Command } from "commander";

import packageJson from "../package.json";
import { registerCheckCommand } from "./check";
import type { CommandDeps } from "./cli/commandDeps";
import { registerCompletionCommand } from "./completion";
import { registerConfigureCommand } from "./configure";
import { registerShimCommand } from "./claudeShim";
import { registerDoctorCommand } from "./doctor";
import { registerHeadroomCommand } from "./headroom/commands";
import { registerIdentityCommand } from "./identityManager";
import { registerProfileCommand } from "./configProfiles";
import { registerProviderCommand } from "./providers";
import { registerRuleCommand } from "./directoryRules";
import { registerRunCommand } from "./runCommand";

/** Everything `buildProgram` needs from its caller: the shared command dependencies, and the launcher pipeline `run` forwards to. */
export interface ProgramDeps extends CommandDeps {
  /** Runs the launcher pipeline with `run`'s forwarded arguments. Injected so building the program never wires real ports, and a test can assert what `run` forwards without launching anything. */
  readonly runClaude: (args: readonly string[]) => Promise<void>;
}

/** The root help's closing section: the launch command whose own help belongs to claude, the flags only claude-use reads, and the exit statuses every command shares. */
const ROOT_HELP_AFTER = `
Grammar:
  claude-use <noun> <verb> [name] [options], where the nouns are identity, profile,
  provider and rule, and the verbs are add, set, list, show, remove and use.

Launching:
  claude-use run [@<identity>] [launch flags] [claude arguments]
  Everything after run is forwarded to Claude Code, so \`claude-use run --help\` shows
  claude's own help. claude-use consumes these launch flags first, and only before a
  \`--\` terminator (everything from \`--\` on is forwarded untouched):
    --identity <name>            the identity (same as a leading @<name>)
    --config-profile <name>      the configuration profile for this launch
    --provider <name>            route through an API provider; --no-provider opts out
    --category <category=bool>   share or hide a category (repeatable)
    --share <path>, --hide <path>  share or hide one <category>/<path> entry (repeatable)
    --[no-]skip-permissions, --[no-]remote-control, --[no-]headroom

Environment:
  CLAUDE_USE_IDENTITY, CLAUDE_USE_CONFIG_PROFILE, CLAUDE_USE_SKIP_PERMISSIONS,
  CLAUDE_USE_REMOTE_CONTROL, CLAUDE_USE_HEADROOM, CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL,
  CLAUDE_USE_CATEGORY_OVERRIDE, CLAUDE_USE_ENTRY_OVERRIDE, CLAUDE_USE_HOME,
  CLAUDE_USE_DEBUG (print stack traces), NO_COLOR. Booleans are true, false, 1 or 0.

Exit status:
  0 success, 1 failure, 2 usage error, 64 a selected provider's or identity's credential
  yields no token.

Examples:
  $ claude-use identity add work
  $ claude-use run @work
  $ claude-use run --identity work --provider z -p "hello"`;

/**
 * Builds the complete `claude-use` Commander tree: the `identity`, `profile`, `provider` and `rule` nouns (each with the same `add`/`set`/`list`/`show`/`remove`/`use` verbs where they apply), `check`, `configure`, `doctor`, `shim`, `headroom`, `run`, and `completion`, each registered by its own module as a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts`.
 *
 * Construction has no side effects: nothing is parsed, read or launched until the caller invokes `parseAsync` on the result. That is what lets the whole command surface be unit-tested against a throwaway `LayoutPaths`, scripted prompts and a fake `runClaude`, while `src/cli.ts` stays the one module that runs on import.
 *
 * `exitOverride` is set before any subcommand is registered, so every subcommand inherits it: a Commander usage error is thrown as a `CommanderError` (after Commander has printed its own message) instead of exiting from inside Commander, and `reportFatalError` maps it to the documented usage exit status.
 */
export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command();
  program
    .name("claude-use")
    .description("Run Claude Code under several logins from one machine, controlling what each one shares with ~/.claude.")
    .version(packageJson.version)
    .exitOverride()
    // Required so `-V`/`--version`/`-h`/`--help` are only recognised before the first subcommand token, not scanned for anywhere in argv; otherwise `claude-use run @name --version` would be silently intercepted by claude-use's own version handling before ever reaching `run`'s forwarded args.
    .enablePositionalOptions()
    .addHelpText("after", ROOT_HELP_AFTER);

  registerIdentityCommand(program, deps);
  registerProfileCommand(program, deps);
  registerProviderCommand(program, deps);
  registerRuleCommand(program, deps);
  registerCheckCommand(program, deps);
  registerConfigureCommand(program, deps);
  registerDoctorCommand(program, deps);
  registerShimCommand(program, deps);
  registerHeadroomCommand(program, deps);
  registerRunCommand(program, deps.runClaude);
  registerCompletionCommand(program);

  return program;
}
