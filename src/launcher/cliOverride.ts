import { collectBoolPairs, parseBoolPairList, splitTopLevelCommas } from "../cli/parsers";
import { ENTRY_KEY_RE, expandAllCategoryKey, isOverridableCategory, type CategoryMap, type Entries } from "../config/schema";
import { CliError } from "../cliError";

/** Raised when a `--category`/`CLAUDE_USE_CATEGORY_OVERRIDE` key names something other than one of the four overridable categories. */
export class InvalidCliCategoryError extends CliError {
  constructor(readonly categoryName: string) {
    super(`"${categoryName}" is not a category this launch may toggle (runtime, history, knowledge, settings).`);
    this.name = "InvalidCliCategoryError";
  }
}

/** Raised when a `--share`/`--hide`/`CLAUDE_USE_ENTRY_OVERRIDE` path is missing its required `<category>/` prefix. */
export class InvalidCliEntryKeyError extends CliError {
  constructor(readonly key: string) {
    super(`"${key}" is not a valid entries key — it must start with "<category>/", e.g. "knowledge/skills/commit".`);
    this.name = "InvalidCliEntryKeyError";
  }
}

function toCategoryMap(pairs: Readonly<Record<string, boolean>>): CategoryMap {
  const expanded = expandAllCategoryKey(pairs);
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(expanded)) {
    if (!isOverridableCategory(key)) {
      throw new InvalidCliCategoryError(key);
    }
    result[key] = value;
  }
  return result;
}

function toEntries(pairs: Readonly<Record<string, boolean>>): Entries {
  for (const key of Object.keys(pairs)) {
    if (!ENTRY_KEY_RE.test(key)) {
      throw new InvalidCliEntryKeyError(key);
    }
  }
  return pairs;
}

/** Inputs to `buildCliOverride`: the raw, still-unparsed flag values `parseLauncherArgv` collected, plus the environment for their `CLAUDE_USE_*_OVERRIDE` alternatives. */
export interface BuildCliOverrideParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerFlag?: string;
  readonly categoryFlags: readonly string[];
  readonly shareFlags: readonly string[];
  readonly hideFlags: readonly string[];
}

/** What a launch's one-off command-line/environment overrides resolve to — the `cliOverride` layer `src/resolve/walk.ts`'s `assembleCascade` composes last, so it beats every other layer. */
export interface CliOverride {
  readonly categories?: CategoryMap;
  readonly entries?: Entries;
  readonly launch?: { readonly provider?: string };
}

/**
 * Builds this launch's one-off category/entry overrides from `--category`/`--share`/`--hide` flags and their `CLAUDE_USE_CATEGORY_OVERRIDE`/`CLAUDE_USE_ENTRY_OVERRIDE` environment-variable alternatives.
 *
 * The environment variable provides a base and the flag(s) merge on top, later-flag-wins on key collision — the same "later occurrence wins" convention `claude-use profile set --category`/`--entry` already use for their own repeatable flags, applied here because the flag and the environment variable are documented as equally-weighted alternatives for the same one-off override, not two different precedence tiers.
 *
 * Returns `undefined` when nothing at all was supplied, so a launch with no overrides adds no `cliOverride` layer rather than an empty no-op one.
 */
export function buildCliOverride(params: BuildCliOverrideParams): CliOverride | undefined {
  let categoryPairs: Record<string, boolean> = {};
  if (params.env.CLAUDE_USE_CATEGORY_OVERRIDE !== undefined && params.env.CLAUDE_USE_CATEGORY_OVERRIDE !== "") {
    categoryPairs = { ...categoryPairs, ...parseBoolPairList(params.env.CLAUDE_USE_CATEGORY_OVERRIDE) };
  }
  for (const flagValue of params.categoryFlags) {
    categoryPairs = collectBoolPairs(flagValue, categoryPairs);
  }

  let entryPairs: Record<string, boolean> = {};
  if (params.env.CLAUDE_USE_ENTRY_OVERRIDE !== undefined && params.env.CLAUDE_USE_ENTRY_OVERRIDE !== "") {
    entryPairs = { ...entryPairs, ...parseBoolPairList(params.env.CLAUDE_USE_ENTRY_OVERRIDE) };
  }
  for (const flagValue of params.shareFlags) {
    for (const path of splitTopLevelCommas(flagValue)) {
      entryPairs[path] = true;
    }
  }
  for (const flagValue of params.hideFlags) {
    for (const path of splitTopLevelCommas(flagValue)) {
      entryPairs[path] = false;
    }
  }

  const hasCategories = Object.keys(categoryPairs).length > 0;
  const hasEntries = Object.keys(entryPairs).length > 0;
  const hasProvider = params.providerFlag !== undefined && params.providerFlag !== "";
  if (!hasCategories && !hasEntries && !hasProvider) {
    return undefined;
  }

  return {
    ...(hasCategories ? { categories: toCategoryMap(categoryPairs) } : {}),
    ...(hasEntries ? { entries: toEntries(entryPairs) } : {}),
    ...(hasProvider ? { launch: { provider: params.providerFlag } } : {}),
  };
}
