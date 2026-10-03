/** Exit status for every expected failure that is not a usage error: a missing identity, an invalid config file, a refused launch. */
export const EXIT_FAILURE = 1;

/** Exit status for a usage error: an unknown command or option, a malformed flag value, or required input missing with no terminal to prompt on. */
export const EXIT_USAGE = 2;

/**
 * Base class for every error this CLI throws to represent an expected, user-facing failure: bad input, a missing identity/profile/rule, a malformed config file. `reportFatalError` prints this class as `agent-shim: <message>` with no stack trace and exits with `exitCode`; anything that does not extend it is an unexpected bug, reported by message alone unless `AGENT_SHIM_DEBUG` asks for the stack.
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
