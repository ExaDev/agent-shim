import { AUTO_ALIAS, resolveAntigravityConfig } from "../antigravity/translate";
import { resolveCodexConfig } from "../codex/translate";
import { filterCatalogue, type CatalogueModel } from "../providerCatalogue";
import { CLAUDE_TIERS, type ClaudeTier, type PickerModel, type Provider } from "../config/schema";

type Tier = ClaudeTier;

/** The marker Claude Code parses out of a model name to size its context window at one million tokens instead of assuming a smaller one. It stays in the name a row sends, and is shown as the row's description instead of its title. */
const CONTEXT_MARKER_1M = "[1m]";

/** The title a row shows for `model`: its name without the context marker, which says nothing about which model it is. */
function labelOf(model: string): string {
  return model.toLowerCase().endsWith(CONTEXT_MARKER_1M) ? model.slice(0, -CONTEXT_MARKER_1M.length) : model;
}

/** `description` with a note of the one-million-token window when `model` carries the marker that asks for it. */
function describedAs(model: string, description: string): string {
  return model.toLowerCase().endsWith(CONTEXT_MARKER_1M) ? `${description}; 1M context` : description;
}

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
  return { model, label: labelOf(model), description: describedAs(model, [...serves, ...falls].join("; ")), behavesAs: TIER_BEHAVES_AS[lead.tier] };
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

/** The rows an `antigravity` provider offers: the virtual `auto` model, its backend models across every tier's candidates, then each other alias a person can select by name. */
function antigravityRows(provider: Extract<Provider, { kind: "antigravity" }>): readonly ModelPickerRow[] {
  const config = resolveAntigravityConfig(provider.antigravity);
  const tiers = rowsOfTable(CLAUDE_TIERS.map((tier) => [tier, config.models[tier]] as const));
  const behavesAsOf = new Map(tiers.map((row) => [row.model, row.behavesAs]));
  const aliases = [...config.aliases].flatMap(([alias, candidates]): readonly ModelPickerRow[] => {
    const [first] = candidates;
    const behavesAs = first === undefined ? undefined : behavesAsOf.get(first);
    const description = alias === AUTO_ALIAS ? `Routes each request to a backend model with quota left, best first (${String(candidates.length)} models)` : `Alias for ${candidates.join(", then ")}`;
    return behavesAs === undefined ? [] : [{ model: alias, label: labelOf(alias), description, behavesAs }];
  });
  // The virtual `auto` model leads, since it is the one a person who does not want to choose a model picks.
  return [...aliases.filter((row) => row.model === AUTO_ALIAS), ...tiers, ...aliases.filter((row) => row.model !== AUTO_ALIAS)];
}

/** The rows a `codex` provider offers: the distinct codex models its tiers map to. */
function codexRows(provider: Extract<Provider, { kind: "codex" }>): readonly ModelPickerRow[] {
  const config = resolveCodexConfig(provider.codex);
  return rowsOfTable(CLAUDE_TIERS.map((tier) => [tier, [config.models[tier]]] as const));
}

/** The rows an `http` provider offers: the distinct models its own `env` block names for the tiers, since the tier names Claude Code shows would otherwise hide that the provider serves something else under them. */
function httpRows(provider: Extract<Provider, { kind?: "http" }>): readonly ModelPickerRow[] {
  const env = provider.env ?? {};
  const table = CLAUDE_TIERS.flatMap((tier): readonly (readonly [Tier, readonly string[]])[] => {
    const model = env[TIER_ENV_VARIABLES[tier]];
    return model === undefined || model === "" ? [] : [[tier, [model]]];
  });
  return rowsOfTable(table);
}

/** The row for a model the provider's own file declares: its label and description when it gives them, and the handling of the tier it names. */
function declaredRow(entry: Readonly<PickerModel>): ModelPickerRow {
  return {
    model: entry.model,
    label: entry.label ?? labelOf(entry.model),
    description: entry.description ?? describedAs(entry.model, `Declared by the provider for the ${entry.tier} tier`),
    behavesAs: TIER_BEHAVES_AS[entry.tier],
  };
}

/** The rows for the models an `http` provider's catalogue last listed, after its `include` and `exclude` patterns: each borrows the handling of the catalogue's tier, and shows the display name the endpoint gave, when it gave one, in its description. */
function catalogueRows(provider: Provider, models: readonly CatalogueModel[]): readonly ModelPickerRow[] {
  if ((provider.kind !== undefined && provider.kind !== "http") || provider.catalogue === undefined) {
    return [];
  }
  const { tier } = provider.catalogue;
  return filterCatalogue(models, provider.catalogue)
    .map((model) => ({ model: model.id, label: labelOf(model.id), description: describedAs(model.id, model.name === undefined ? "Listed by the provider" : `Listed by the provider as ${model.name}`), behavesAs: TIER_BEHAVES_AS[tier] }))
    .sort((left, right) => left.model.localeCompare(right.model));
}

/**
 * The real models a provider serves, as `/model` rows: the ones its tier settings reach, then the ones its file declares in `pickerModels`, which replace a derived row for the same model, then the ones its catalogue last listed (an `http` provider that opted into one), each only where an earlier part has not already named it. Empty when the provider names none, in which case the picker keeps its built-in lineup.
 */
export function providerModelRows(provider: Provider, catalogue: readonly CatalogueModel[] = []): readonly ModelPickerRow[] {
  const derived = provider.kind === "codex" ? codexRows(provider) : provider.kind === "antigravity" ? antigravityRows(provider) : provider.kind === "router" ? [] : httpRows(provider);
  const declared = (provider.kind === "router" ? [] : (provider.pickerModels ?? []).map(declaredRow));
  const declaredModels = new Set(declared.map((row) => row.model));
  const named = [...derived.filter((row) => !declaredModels.has(row.model)), ...declared];
  // A model the provider's own settings name with the context marker is the same model its catalogue lists without it, so the marker is ignored when asking whether a row repeats one.
  const taken = new Set(named.map((row) => labelOf(row.model)));
  return [...named, ...catalogueRows(provider, catalogue).filter((row) => !taken.has(labelOf(row.model)))];
}

/**
 * The Claude Code settings, as the JSON `--settings` takes, that make `/model` list `provider`'s real models in place of Claude Code's own names, or `undefined` when the provider names none. The built-in lineup is replaced because it would show a Claude name for a model the provider serves under another. Choosing a row sends that model's name verbatim, which every translator passes through, so a person can pick a backend model directly instead of going through a tier.
 */
export function modelPickerSettings(provider: Provider, catalogue: readonly CatalogueModel[] = []): string | undefined {
  const options = providerModelRows(provider, catalogue);
  return options.length === 0 ? undefined : JSON.stringify({ modelPicker: { options, replaceBuiltInOptions: true } });
}
