import { CommanderError } from "commander";

import { parseBoolWord } from "./cli/bool";
import { CliError, EXIT_FAILURE, EXIT_USAGE } from "./cliError";

/** Where `reportFatalError` writes, and the environment it reads `AGENT_SHIM_DEBUG` from. */
export interface FatalErrorIo {
  readonly writeErr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The one place a failure escaping `main()` in `src/cli.ts` is turned into output and an exit status, so every command, the `@name` shortcut and the `claude`-named launcher all report failures the same way.
 *
 * A `CommanderError` has already printed its own message (Commander writes usage errors itself before throwing under `exitOverride`), so it only maps to an exit status: its own `0` for `--help` and `--version`, `EXIT_USAGE` for everything else. A `CliError` prints as `agent-shim: <message>` and exits with its own `exitCode`. Anything else is an unexpected bug: it prints as `agent-shim: <message>` too, with the stack trace added only when `AGENT_SHIM_DEBUG` is true, and exits `EXIT_FAILURE`.
 * @param error - Whatever `main()` rejected with.
 * @param io - The error stream writer and the environment. Injected so the formatting is unit-testable without capturing the real stream.
 * @returns The process exit status to set.
 */
export function reportFatalError(error: unknown, io: FatalErrorIo): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? 0 : EXIT_USAGE;
  }
  if (error instanceof CliError) {
    io.writeErr(`agent-shim: ${error.message}`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.writeErr(`agent-shim: ${message}`);
  if (error instanceof Error && error.stack !== undefined && debugEnabled(io.env)) {
    io.writeErr(error.stack);
  }
  return EXIT_FAILURE;
}

/** Whether `AGENT_SHIM_DEBUG` asks for stack traces. A value outside the shared boolean vocabulary reads as off rather than raising, since this runs while already reporting another failure. */
function debugEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.AGENT_SHIM_DEBUG !== undefined && parseBoolWord(env.AGENT_SHIM_DEBUG) === true;
}
