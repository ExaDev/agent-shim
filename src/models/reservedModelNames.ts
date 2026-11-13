import { InvalidProviderNameError } from "../config/names";
import { withoutContextMarker } from "./identity";
import { claudeNameTier } from "./tiers";

/** The model name that means "whichever model the provider's server serves right now". */
export const AUTO_MODEL = "auto";

/** What every model name of the selector grammar starts with (`auto/<selector>[/<class>]`): a name with this prefix is the door's to expand, never a virtual model's or a provider's. */
export const SELECTOR_PREFIX = `${AUTO_MODEL}/`;

/** The model aliases Claude Code resolves itself that name no tier: `default` (the session's default model), `best` (the most capable model) and `opusplan` (Opus in plan mode, Sonnet otherwise). Read from the strings of Claude Code 2.1.309's build, which holds each as a bare alias beside the tier names. */
const CLAUDE_CODE_ALIASES: ReadonlySet<string> = new Set(["default", "best", "opusplan"]);

/**
 * Why a provider may not be called `name`, or undefined when it may: a bare model name is Claude Code's own (a tier alias such as `opus`, an alias such as `default`, `best` or `opusplan`, a full Claude name) or the `auto` tier entry, and a provider of that name would claim it ahead of the session's route context, so a session's tier aliases and `auto` entry would stop following the context. The provider stays reachable by a qualified name (`opus/<model>`).
 */
export function reservedProviderNameReason(name: string): string | undefined {
  // A trailing context-window marker is no part of a model name (the door reads `auto[1m]` as `auto`), so the same names are reserved with it.
  const bare = withoutContextMarker(name);
  if (bare === AUTO_MODEL) {
    return `"${AUTO_MODEL}" is the model name that follows the server's live model`;
  }
  if (CLAUDE_CODE_ALIASES.has(bare.toLowerCase())) {
    return `"${name}" is a model alias Claude Code resolves itself`;
  }
  const tier = claudeNameTier(name);
  return tier === undefined ? undefined : `"${name}" is a Claude model name (the ${tier} tier)`;
}

/** Throws `InvalidProviderNameError` when a new provider may not be called `name` because it is a bare model name (see `reservedProviderNameReason`). */
export function requireUnreservedProviderName(name: string): void {
  const reason = reservedProviderNameReason(name);
  if (reason !== undefined) {
    throw new InvalidProviderNameError(name, `must not be a bare model name, because ${reason}`);
  }
}

/**
 * Why a virtual model may not be called `name`, or undefined when it may: `auto` is the model name that follows a provider's live served model, and a name starting `auto/` is the selector grammar's (`auto/<selector>[/<class>]`), which the door expands before any virtual model is looked up, so a virtual model of either name would never be reached by it. A trailing context marker is no part of a name, as for a provider.
 */
export function reservedVirtualModelNameReason(name: string): string | undefined {
  const bare = withoutContextMarker(name);
  if (bare === AUTO_MODEL) {
    return `"${AUTO_MODEL}" is the model name that follows the server's live model`;
  }
  return bare.startsWith(SELECTOR_PREFIX) ? `a name starting "${SELECTOR_PREFIX}" is a selector (${SELECTOR_PREFIX}<selector>[/<class>]), which the door expands before any virtual model is looked up` : undefined;
}
