import { CommanderError } from "commander";

import { parseBoolWord } from "./cli/bool";

/** Exit status for every expected failure that is not a usage error: a missing identity, an invalid config file, a refused launch. */
export const EXIT_FAILURE = 1;

/** Exit status for a usage error: an unknown command or option, a malformed flag value, or required input missing with no terminal to prompt on. */
export const EXIT_USAGE = 2;

/**
 * Base class for every error this CLI throws to represent an expected, user-facing failure: bad input, a missing identity/profile/rule, a malformed config file. `reportFatalError` prints this class as `claude-use: <message>` with no stack trace and exits with `exitCode`; anything that does not extend it is an unexpected bug, reported by message alone unless `CLAUDE_USE_DEBUG` asks for the stack.
 */
export abstract class CliError extends Error {
  /** The process exit status this failure maps to. `EXIT_FAILURE` unless a subclass says otherwise. */
  readonly exitCode: number = EXIT_FAILURE;
}

/** A usage error: the command line itself is wrong or incomplete. Exits `EXIT_USAGE`. */
export class UsageError extends CliError {
  override readonly exitCode: number = EXIT_USAGE;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Raised when a command needs input it would prompt for on a terminal, but standard input is not one. Names the option (or argument) that supplies the input non-interactively, so a script's failure says exactly what to add.
 */
export class MissingInputError extends UsageError {
  constructor(readonly option: string, what: string) {
    super(`${what} is required: pass ${option} (standard input is not a terminal, so there is nothing to prompt on).`);
    this.name = "MissingInputError";
  }
}

/** Raised when the user cancels an interactive prompt that a command cannot continue without. */
export class PromptCancelledError extends CliError {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelledError";
  }
}

/** Where `reportFatalError` writes, and the environment it reads `CLAUDE_USE_DEBUG` from. */
export interface FatalErrorIo {
  readonly writeErr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The one place a failure escaping `main()` in `src/cli.ts` is turned into output and an exit status, so every command, the `@name` shortcut and the `claude`-named launcher all report failures the same way.
 *
 * A `CommanderError` has already printed its own message (Commander writes usage errors itself before throwing under `exitOverride`), so it only maps to an exit status: its own `0` for `--help` and `--version`, `EXIT_USAGE` for everything else. A `CliError` prints as `claude-use: <message>` and exits with its own `exitCode`. Anything else is an unexpected bug: it prints as `claude-use: <message>` too, with the stack trace added only when `CLAUDE_USE_DEBUG` is true, and exits `EXIT_FAILURE`.
 * @param error - Whatever `main()` rejected with.
 * @param io - The error stream writer and the environment. Injected so the formatting is unit-testable without capturing the real stream.
 * @returns The process exit status to set.
 */
export function reportFatalError(error: unknown, io: FatalErrorIo): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? 0 : EXIT_USAGE;
  }
  if (error instanceof CliError) {
    io.writeErr(`claude-use: ${error.message}`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.writeErr(`claude-use: ${message}`);
  if (error instanceof Error && error.stack !== undefined && debugEnabled(io.env)) {
    io.writeErr(error.stack);
  }
  return EXIT_FAILURE;
}

/** Whether `CLAUDE_USE_DEBUG` asks for stack traces. A value outside the shared boolean vocabulary reads as off rather than raising, since this runs while already reporting another failure. */
function debugEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CLAUDE_USE_DEBUG !== undefined && parseBoolWord(env.CLAUDE_USE_DEBUG) === true;
}
