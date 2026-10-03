/**
 * The one boolean vocabulary every agent-shim input shares, CLI flag values and environment variables alike: `true` and `1` mean true, `false` and `0` mean false, and nothing else is a boolean (no case folding, no `yes`/`no`).
 *
 * Lives in a module with no imports so both `src/cli/parsers.ts` (which raises on anything else) and `src/cliError.ts` (which must never raise while reporting another failure) can share it without an import cycle.
 * @param input - The raw text.
 * @returns The boolean it spells, or undefined when it spells none.
 */
export function parseBoolWord(input: string): boolean | undefined {
  switch (input) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}
