import { parseBoolWord } from "./bool";

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
