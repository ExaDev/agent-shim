import { InvalidProviderNameError } from "../config/names";
import { withoutContextMarker } from "./identity";
import { claudeNameTier } from "./tiers";

/** The model name `auto`, which a provider may not be called by (see `reservedProviderNameReason`). */
const AUTO_MODEL = "auto";

/** The model aliases Claude Code resolves itself that name no tier: `default` (the session's default model), `best` (the most capable model) and `opusplan` (Opus in plan mode, Sonnet otherwise). Read from the strings of Claude Code 2.1.309's build, which holds each as a bare alias beside the tier names. */
const CLAUDE_CODE_ALIASES: ReadonlySet<string> = new Set(["default", "best", "opusplan"]);

/**
 * Why a provider may not be called `name`, or undefined when it may: a bare model name is Claude Code's own (a tier alias such as `opus`, an alias such as `default`, `best` or `opusplan`, a full Claude name) or the `auto` tier entry, and a provider of that name would claim it ahead of the session's route context, so a session's tier aliases and `auto` entry would stop following the context. The provider stays reachable by a qualified name (`opus/<model>`).
 */
export function reservedProviderNameReason(name: string): string | undefined {
  // A trailing context-window marker is no part of a model name (the door reads `auto[1m]` as `auto`), so the same names are reserved with it.
  const bare = withoutContextMarker(name);
  if (bare === AUTO_MODEL) {
    return `"${AUTO_MODEL}" is a model name that follows the session's route`;
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
