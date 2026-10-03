import { parseBool, parseBoolPairList, parsePair } from "../cli/pairs";
import { ENTRY_KEY_RE, expandAllCategoryKey, isOverridableCategory, type CategoryMap, type Entries } from "../config/schema";
import { CliError, UsageError } from "../cliError";

/** Raised when a `--category`/`AGENT_SHIM_CATEGORY_OVERRIDE` key names something other than one of the four overridable categories. */
export class InvalidCliCategoryError extends CliError {
  constructor(readonly categoryName: string) {
    super(`"${categoryName}" is not a category this launch may toggle (runtime, history, knowledge, settings).`);
    this.name = "InvalidCliCategoryError";
  }
}

/** Raised when a `--share`/`--hide`/`AGENT_SHIM_ENTRY_OVERRIDE` path is missing its required `<category>/` prefix. */
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

/** Inputs to `buildCliOverride`: the raw, still-unparsed flag values `parseLauncherArgv` collected (one value per flag occurrence), plus the environment for their `AGENT_SHIM_*_OVERRIDE` alternatives. */
export interface BuildCliOverrideParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerFlag?: string;
  readonly categoryFlags: readonly string[];
  readonly shareFlags: readonly string[];
  readonly hideFlags: readonly string[];
}

/** What a launch's one-off command-line/environment overrides resolve to: the `cliOverride` layer `src/resolve/walk.ts`'s `assembleCascade` composes last, so it beats every other layer. */
export interface CliOverride {
  readonly categories?: CategoryMap;
  readonly entries?: Entries;
  readonly launch?: { readonly provider?: string };
}

/** Runs `parse` over one flag's or environment variable's raw value, re-raising a malformed value as a `UsageError` that names where it came from. */
function parseOverride<T>(source: string, raw: string, parse: (raw: string) => T): T {
  try {
    return parse(raw);
  } catch (error) {
    if (error instanceof Error && !(error instanceof CliError)) {
      throw new UsageError(`Invalid ${source} value "${raw}": ${error.message}.`);
    }
    throw error;
  }
}

/**
 * Builds this launch's one-off category/entry overrides from `--category`/`--share`/`--hide` flags and their `AGENT_SHIM_CATEGORY_OVERRIDE`/`AGENT_SHIM_ENTRY_OVERRIDE` environment-variable alternatives.
 *
 * Each flag occurrence carries exactly one value (`--category history=true`, `--share knowledge/skills/commit`); the flags repeat rather than taking comma lists. The environment variables cannot repeat, so each holds a comma-separated list of `<key>=<bool>` pairs instead.
 *
 * The environment variable provides a base and the flags merge on top, later flag winning on key collision: the same "later occurrence wins" convention `agent-shim profile set --category`/`--entry` use, applied here because the flag and the environment variable are documented as equally-weighted alternatives for the same one-off override, not two different precedence tiers.
 *
 * Returns `undefined` when nothing at all was supplied, so a launch with no overrides adds no `cliOverride` layer rather than an empty no-op one. A malformed flag or environment value throws `UsageError`.
 */
export function buildCliOverride(params: BuildCliOverrideParams): CliOverride | undefined {
  let categoryPairs: Record<string, boolean> = {};
  if (params.env.AGENT_SHIM_CATEGORY_OVERRIDE !== undefined && params.env.AGENT_SHIM_CATEGORY_OVERRIDE !== "") {
    categoryPairs = parseOverride("AGENT_SHIM_CATEGORY_OVERRIDE", params.env.AGENT_SHIM_CATEGORY_OVERRIDE, parseBoolPairList);
  }
  for (const flagValue of params.categoryFlags) {
    const pair = parseOverride("--category", flagValue, (raw) => {
      const { key, value } = parsePair(raw);
      return { key, value: parseBool(value) };
    });
    categoryPairs[pair.key] = pair.value;
  }

  let entryPairs: Record<string, boolean> = {};
  if (params.env.AGENT_SHIM_ENTRY_OVERRIDE !== undefined && params.env.AGENT_SHIM_ENTRY_OVERRIDE !== "") {
    entryPairs = parseOverride("AGENT_SHIM_ENTRY_OVERRIDE", params.env.AGENT_SHIM_ENTRY_OVERRIDE, parseBoolPairList);
  }
  for (const entryPath of params.shareFlags) {
    entryPairs[entryPath] = true;
  }
  for (const entryPath of params.hideFlags) {
    entryPairs[entryPath] = false;
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
