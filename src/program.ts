import { Command } from "commander";

import packageJson from "../package.json";
import { registerCheckCommand } from "./check";
import { registerCodexCommand } from "./codex/commands";
import { registerFrontDoorCommand } from "./frontdoor/commands";
import type { CommandDeps } from "./cli/commandDeps";
import { registerCompletionCommand } from "./completion";
import { registerConfigureCommand } from "./configure";
import { registerCredentialCommand, type CredentialCommandPorts } from "./credentialCommand";
import { registerShimCommand } from "./claudeShim";
import { registerDoctorCommand } from "./doctor";
import { registerHeadroomCommand } from "./headroom/commands";
import { registerIdentityCommand } from "./identityManager";
import { registerProfileCommand } from "./configProfiles";
import { registerPoolCommand } from "./pools";
import { registerProviderCommand } from "./providers";
import { registerRuleCommand } from "./directoryRules";
import { registerRunCommand } from "./runCommand";
import { registerUsageCommands } from "./usage/commands";

/** Everything `buildProgram` needs from its caller: the shared command dependencies, and the launcher pipeline `run` forwards to. */
export interface ProgramDeps extends CommandDeps {
  /** Runs the launcher pipeline with `run`'s forwarded arguments. Injected so building the program never wires real ports, and a test can assert what `run` forwards without launching anything. */
  readonly runClaude: (args: readonly string[]) => Promise<void>;
  /** Replaces the real Keychain, secret stores and `ssh` behind the `credential` commands. Omitted outside tests. */
  readonly credentialPorts?: CredentialCommandPorts;
}

/** The root help's closing section: the launch command whose own help belongs to claude, the flags only agent-shim reads, and the exit statuses every command shares. */
const ROOT_HELP_AFTER = `
Grammar:
  agent-shim <noun> <verb> [name] [options], where the nouns are identity, profile,
  provider and rule, and the verbs are add, set, list, show, remove and use.
  credential is the exception: it acts on the credentials identities use (store).

Launching:
  agent-shim run [@<identity>] [launch flags] [claude arguments]
  Everything after run is forwarded to Claude Code, so \`agent-shim run --help\` shows
  claude's own help. agent-shim consumes these launch flags first, and only before a
  \`--\` terminator (everything from \`--\` on is forwarded untouched):
    --identity <name>            the identity (same as a leading @<name>)
    --config-profile <name>      the configuration profile for this launch
    --provider <name>            route through an API provider; --no-provider opts out
    --category <category=bool>   share or hide a category (repeatable)
    --share <path>, --hide <path>  share or hide one <category>/<path> entry (repeatable)
    --[no-]skip-permissions, --[no-]remote-control, --[no-]headroom, --[no-]track-usage
    --claude-version <version>   run exactly this installed Claude Code version (not the highest)
    --[no-]wait                  with @pool:<name>, sleep until the earliest member returns when all are refused
    --native                     run the real claude with nothing from agent-shim applied (no other launch flag allowed)

Environment:
  AGENT_SHIM_IDENTITY, AGENT_SHIM_CONFIG_PROFILE, AGENT_SHIM_SKIP_PERMISSIONS,
  AGENT_SHIM_REMOTE_CONTROL, AGENT_SHIM_HEADROOM, AGENT_SHIM_TRACK_USAGE, AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL,
  AGENT_SHIM_CATEGORY_OVERRIDE, AGENT_SHIM_ENTRY_OVERRIDE, AGENT_SHIM_HOME,
  AGENT_SHIM_DEBUG (print stack traces), NO_COLOR. Booleans are true, false, 1 or 0.

Exit status:
  0 success, 1 failure, 2 usage error, 64 a selected provider's or identity's credential
  yields no token.

Examples:
  $ agent-shim identity add work
  $ agent-shim run @work
  $ agent-shim run --identity work --provider z -p "hello"`;

/**
 * Builds the complete `agent-shim` Commander tree: the `identity`, `profile`, `pool`, `provider` and `rule` nouns (each with the same `add`/`set`/`list`/`show`/`remove`/`use` verbs where they apply), `credential`, `check`, `configure`, `doctor`, `shim`, `headroom`, `codex`, `frontdoor`, `usage`, `account`, `run`, and `completion`, each registered by its own module as a thin adapter over `src/config/store.ts` and the Zod schemas in `src/config/schema.ts`.
 *
 * Construction has no side effects: nothing is parsed, read or launched until the caller invokes `parseAsync` on the result. That is what lets the whole command surface be unit-tested against a throwaway `LayoutPaths`, scripted prompts and a fake `runClaude`, while `src/cli.ts` stays the one module that runs on import.
 *
 * `exitOverride` is set before any subcommand is registered, so every subcommand inherits it: a Commander usage error is thrown as a `CommanderError` (after Commander has printed its own message) instead of exiting from inside Commander, and `reportFatalError` maps it to the documented usage exit status.
 */
export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command();
  program
    .name("agent-shim")
    .description("Run Claude Code under several logins from one machine, controlling what each one shares with ~/.claude.")
    .version(packageJson.version)
    .exitOverride()
    // Required so `-V`/`--version`/`-h`/`--help` are only recognised before the first subcommand token, not scanned for anywhere in argv; otherwise `agent-shim run @name --version` would be silently intercepted by agent-shim's own version handling before ever reaching `run`'s forwarded args.
    .enablePositionalOptions()
    .addHelpText("after", ROOT_HELP_AFTER);

  registerIdentityCommand(program, deps);
  registerProfileCommand(program, deps);
  registerPoolCommand(program, deps);
  registerProviderCommand(program, deps);
  registerRuleCommand(program, deps);
  registerCredentialCommand(program, deps, deps.credentialPorts);
  registerCheckCommand(program, deps);
  registerConfigureCommand(program, deps);
  registerDoctorCommand(program, deps);
  registerShimCommand(program, deps);
  registerHeadroomCommand(program, deps);
  registerCodexCommand(program, deps);
  registerFrontDoorCommand(program, deps);
  registerUsageCommands(program, deps);
  registerRunCommand(program, deps.runClaude);
  registerCompletionCommand(program);

  return program;
}
