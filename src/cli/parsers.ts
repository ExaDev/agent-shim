import { InvalidArgumentError } from "commander";
import { parseDuration } from "../resolve/conditions";
import { parsePair, parseBool } from "./pairs";

/**
 * Parsing helpers shared by every agent-shim flag and environment variable.
 *
 * Flags that take a list are repeated, one value per occurrence (`--category history=true --category knowledge=false`); no flag splits its value on commas. Environment variables cannot be repeated, so the two list-valued ones (`AGENT_SHIM_CATEGORY_OVERRIDE`, `AGENT_SHIM_ENTRY_OVERRIDE`) are the one place a comma-separated list is parsed, via `parseBoolPairList`. No escaping syntax is defined for a comma inside one of their values.
 */

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

/** Commander option parser for a duration such as `30m`, `5h` or `7d` (a count followed by ms, s, m, h, d or w), returning milliseconds. A malformed value is a usage error naming the option. */
export function parseDurationOption(value: string): number {
  return asInvalidArgument(() => parseDuration(value));
}
