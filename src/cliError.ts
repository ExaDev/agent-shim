/**
 * Base class for every error this CLI throws to represent an expected, user-facing failure: bad input, a missing identity/profile/rule, a malformed config file. `reportFatalError` prints this class as `error.message` alone, with no stack trace; anything that does not extend it is printed with its full stack trace, since that represents a genuine, unexpected bug worth seeing in full.
 */
export abstract class CliError extends Error {}

/**
 * The one place a failure escaping `main()` in `src/cli.ts` is turned into output and an exit status, so every command, the `@name` shortcut and the `claude`-named launcher all report failures the same way.
 * @param error - Whatever `main()` rejected with.
 * @param writeErr - Writes one line to standard error. Injected so the formatting is unit-testable without capturing the real stream.
 * @returns The process exit status to set: `1` for every failure.
 */
export function reportFatalError(error: unknown, writeErr: (line: string) => void): number {
  if (error instanceof CliError) {
    writeErr(error.message);
    return 1;
  }
  writeErr(error instanceof Error ? (error.stack ?? error.message) : String(error));
  return 1;
}
