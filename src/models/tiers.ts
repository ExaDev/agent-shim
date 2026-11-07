import { CLAUDE_TIERS, type ClaudeTier } from "../config/schema";

/**
 * The Claude tier a model name selects: the first tier in `CLAUDE_TIERS` order whose name appears in it, case-insensitively, so `claude-haiku-5-5` selects `haiku` and a name naming no tier selects none. `fable` precedes `opus` in that order because a fable name is the more specific match. Every provider kind that maps a Claude name onto its own models (the codex and antigravity translators, an `http` provider's tier environment, a router's `models.tiers`) decides the tier here.
 */
export function claudeTierOf(model: string): ClaudeTier | undefined {
  const lower = model.toLowerCase();
  return CLAUDE_TIERS.find((tier) => lower.includes(tier));
}

/** The environment variable an `http` provider's own `env` block uses to name the model a tier reaches: the variable Claude Code itself reads for that tier's model. */
export const TIER_ENV_VARIABLES: Readonly<Record<ClaudeTier, string>> = Object.freeze({
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
});
