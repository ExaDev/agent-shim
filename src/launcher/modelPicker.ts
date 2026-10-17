import { resolveAntigravityConfig } from "../antigravity/translate";
import { resolveCodexConfig } from "../codex/translate";
import { ANTIGRAVITY_TIERS, CODEX_TIERS, type Provider } from "../config/schema";

/** The Claude tiers a provider maps onto its own models, highest first. Every provider kind names the same four. */
type Tier = (typeof CODEX_TIERS)[number];

/**
 * The Claude model each tier's picker row borrows its client-side handling from (prompt profile, capability and effort defaults). Claude Code accepts only a model ID it knows here, never the tier alias, and a name it does not know gets the unrecognised-model notice and a 200k window instead, so an ID a later release drops degrades a row to that generic handling without breaking it: the row still names and selects the provider's own model.
 */
const TIER_BEHAVES_AS: Readonly<Record<Tier, string>> = Object.freeze({
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
});

/** The environment variable a provider's own `env` block uses to name the model a tier reaches. */
const TIER_ENV_VARIABLES: Readonly<Record<Tier, string>> = Object.freeze({
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
});

/** One `/model` row, in the shape Claude Code's `modelPicker` setting takes. `model` is sent verbatim; `label` and `description` are what the row shows. */
export interface ModelPickerRow {
  readonly model: string;
  readonly label: string;
  readonly description: string;
  readonly behavesAs: string;
}

/** Where a model sits in one tier's ordered candidates: `first` is the model a request for the tier is served by when it has quota, `fallback` one it falls to. */
type Standing = "first" | "fallback";

/** What the tiers say about one model, in tier order: each tier that reaches it and whether as its first choice. */
interface Reach {
  readonly tier: Tier;
  readonly standing: Standing;
}

/** Joins `parts` as prose: `a`, `a and b`, `a, b and c`. */
function joined(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  return last === undefined || parts.length === 1 ? (last ?? "") : `${parts.slice(0, -1).join(", ")} and ${last}`;
}

/** The row for `model` given every tier that reaches it, which must not be empty. It borrows the handling of the highest tier whose first choice it is, else of the highest tier that reaches it. */
function rowOf(model: string, reaches: readonly Reach[]): ModelPickerRow {
  const lead = reaches.find((reach) => reach.standing === "first") ?? reaches[0];
  if (lead === undefined) {
    throw new Error(`model ${model} is reached by no tier`);
  }
  const firsts = reaches.filter((reach) => reach.standing === "first").map((reach) => reach.tier);
  const fallbacks = reaches.filter((reach) => reach.standing === "fallback").map((reach) => reach.tier);
  const serves = firsts.length === 0 ? [] : [`Serves the ${joined(firsts)} tier${firsts.length === 1 ? "" : "s"}`];
  const falls = fallbacks.length === 0 ? [] : [`${serves.length === 0 ? "Fallback" : "fallback"} for ${joined(fallbacks)}`];
  return { model, label: model, description: [...serves, ...falls].join("; "), behavesAs: TIER_BEHAVES_AS[lead.tier] };
}

/** One row per distinct model across `table`, in the order the tiers first reach them, each with the tiers that reach it. */
function rowsOfTable(table: readonly (readonly [Tier, readonly string[]])[]): readonly ModelPickerRow[] {
  const reachesByModel = new Map<string, Reach[]>();
  for (const [tier, candidates] of table) {
    candidates.forEach((model, index) => {
      const reaches = reachesByModel.get(model) ?? [];
      if (!reaches.some((reach) => reach.tier === tier)) {
        reaches.push({ tier, standing: index === 0 ? "first" : "fallback" });
      }
      reachesByModel.set(model, reaches);
    });
  }
  return [...reachesByModel].map(([model, reaches]) => rowOf(model, reaches));
}

/** The rows an `antigravity` provider offers: its backend models across every tier's candidates, then each alias a person can select by name. */
function antigravityRows(provider: Extract<Provider, { kind: "antigravity" }>): readonly ModelPickerRow[] {
  const config = resolveAntigravityConfig(provider.antigravity);
  const tiers = rowsOfTable(ANTIGRAVITY_TIERS.map((tier) => [tier, config.models[tier]] as const));
  const behavesAsOf = new Map(tiers.map((row) => [row.model, row.behavesAs]));
  const aliases = [...config.aliases].flatMap(([alias, candidates]): readonly ModelPickerRow[] => {
    const [first] = candidates;
    const behavesAs = first === undefined ? undefined : behavesAsOf.get(first);
    return behavesAs === undefined ? [] : [{ model: alias, label: alias, description: `Alias for ${candidates.join(", then ")}`, behavesAs }];
  });
  return [...tiers, ...aliases];
}

/** The rows a `codex` provider offers: the distinct codex models its tiers map to. */
function codexRows(provider: Extract<Provider, { kind: "codex" }>): readonly ModelPickerRow[] {
  const config = resolveCodexConfig(provider.codex);
  return rowsOfTable(CODEX_TIERS.map((tier) => [tier, [config.models[tier]]] as const));
}

/** The rows an `http` provider offers: the distinct models its own `env` block names for the tiers, since the tier names Claude Code shows would otherwise hide that the provider serves something else under them. */
function httpRows(provider: Extract<Provider, { kind?: "http" }>): readonly ModelPickerRow[] {
  const env = provider.env ?? {};
  const table = CODEX_TIERS.flatMap((tier): readonly (readonly [Tier, readonly string[]])[] => {
    const model = env[TIER_ENV_VARIABLES[tier]];
    return model === undefined || model === "" ? [] : [[tier, [model]]];
  });
  return rowsOfTable(table);
}

/**
 * The real models a provider serves, as `/model` rows. Empty when the provider names none (an `http` provider that leaves every tier to Claude Code's own names), in which case the picker keeps its built-in lineup.
 */
export function providerModelRows(provider: Provider): readonly ModelPickerRow[] {
  if (provider.kind === "codex") {
    return codexRows(provider);
  }
  if (provider.kind === "antigravity") {
    return antigravityRows(provider);
  }
  return httpRows(provider);
}

/**
 * The Claude Code settings, as the JSON `--settings` takes, that make `/model` list `provider`'s real models in place of Claude Code's own names, or `undefined` when the provider names none. The built-in lineup is replaced because it would show a Claude name for a model the provider serves under another. Choosing a row sends that model's name verbatim, which every translator passes through, so a person can pick a backend model directly instead of going through a tier.
 */
export function modelPickerSettings(provider: Provider): string | undefined {
  const options = providerModelRows(provider);
  return options.length === 0 ? undefined : JSON.stringify({ modelPicker: { options, replaceBuiltInOptions: true } });
}
