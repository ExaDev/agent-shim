import { InvalidArgumentError } from "commander";

import { UsageError } from "../cliError";
import { parseBoolWord } from "./bool";

/**
 * Parsing helpers shared by every claude-use flag and environment variable.
 *
 * Flags that take a list are repeated, one value per occurrence (`--category history=true --category knowledge=false`); no flag splits its value on commas. Environment variables cannot be repeated, so the two list-valued ones (`CLAUDE_USE_CATEGORY_OVERRIDE`, `CLAUDE_USE_ENTRY_OVERRIDE`) are the one place a comma-separated list is parsed, via `parseBoolPairList`. No escaping syntax is defined for a comma inside one of their values.
 */

/** Splits `input` on commas. An empty string yields an empty array, not `[""]`. */
function splitCommas(input: string): readonly string[] {
  if (input === "") {
    return [];
  }
  return input.split(",");
}

/** One `<key>=<value>` pair, as parsed by `parsePair`. */
export interface ParsedPair {
  readonly key: string;
  readonly value: string;
}

/**
 * Splits `input` on its *first* `=` into a key and a value. The value may itself contain further `=` characters (they stay part of the value); only the first `=` is treated as the separator.
 *
 * Throws when there is no `=` at all, or when the key half is empty (`=true`, or a leading `=`).
 */
export function parsePair(input: string): ParsedPair {
  const eqIndex = input.indexOf("=");
  if (eqIndex === -1) {
    throw new Error(`Expected "<key>=<value>", got "${input}" (no "=" found)`);
  }
  const key = input.slice(0, eqIndex);
  const value = input.slice(eqIndex + 1);
  if (key === "") {
    throw new Error(`Expected a non-empty key before "=" in "${input}"`);
  }
  return { key, value };
}

/** Parses `input` as a boolean in the shared vocabulary (`true`/`1`, `false`/`0`); throws on anything else. */
export function parseBool(input: string): boolean {
  const parsed = parseBoolWord(input);
  if (parsed === undefined) {
    throw new Error(`Expected "true", "false", "1" or "0", got "${input}"`);
  }
  return parsed;
}

/** Raised when a boolean environment variable holds something outside the shared vocabulary. */
export class InvalidEnvBoolError extends UsageError {
  constructor(readonly variable: string, readonly value: string) {
    super(`${variable} must be one of true, false, 1 or 0, got "${value}".`);
    this.name = "InvalidEnvBoolError";
  }
}

/**
 * Reads a boolean environment variable with the same vocabulary a CLI flag value uses. Unset and the empty string both mean "not given" (undefined), consistent with how every other claude-use environment variable treats the empty string; anything outside the vocabulary throws `InvalidEnvBoolError` rather than silently reading as false.
 */
export function parseEnvBool(variable: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = parseBoolWord(value);
  if (parsed === undefined) {
    throw new InvalidEnvBoolError(variable, value);
  }
  return parsed;
}

/**
 * Parses a comma-separated list of `<key>=<bool>` pairs into a plain object, e.g. `"history=true,knowledge=false"` becomes `{ history: true, knowledge: false }`. Used only for the list-valued environment variables; flags repeat instead.
 *
 * An empty string parses to `{}`. A key repeated within the same list is not an error: the later occurrence wins, matching how a plain object literal with a repeated key behaves.
 */
export function parseBoolPairList(input: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const piece of splitCommas(input)) {
    const { key, value } = parsePair(piece);
    result[key] = parseBool(value);
  }
  return result;
}

/** Re-raises a plain parse failure as Commander's `InvalidArgumentError`, so Commander reports it as a usage error naming the offending option instead of it escaping as a crash. */
function asInvalidArgument<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Error && !(error instanceof InvalidArgumentError)) {
      throw new InvalidArgumentError(error.message);
    }
    throw error;
  }
}

/**
 * Commander repeatable-option collector for one `--flag <key>=<bool>` occurrence: parses `value` and merges it over `previous`, so `--category history=true --category knowledge=false` accumulates into one object, the later occurrence winning on key collision.
 */
export function collectBoolPair(value: string, previous: Readonly<Record<string, boolean>> = {}): Record<string, boolean> {
  return asInvalidArgument(() => {
    const { key, value: raw } = parsePair(value);
    return { ...previous, [key]: parseBool(raw) };
  });
}

/** Commander repeatable-option collector for one `--flag <KEY>=<VALUE>` occurrence with a free-text value, merged over `previous` the same way `collectBoolPair` merges. */
export function collectStringPair(value: string, previous: Readonly<Record<string, string>> = {}): Record<string, string> {
  return asInvalidArgument(() => {
    const { key, value: raw } = parsePair(value);
    return { ...previous, [key]: raw };
  });
}

/** Commander repeatable-option collector for a plain repeated value (`--extends a --extends b`), preserving the order given. */
export function collectRepeated(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value];
}
