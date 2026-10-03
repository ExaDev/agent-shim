import { classifyEntries, type ClassifyResult } from "../config/classify";
import type { CategoryClassification, CategoryClassificationOverlay } from "../config/schema";
import { resolveAll, type ResolveAllResult } from "./decide";
import { flattenLayers } from "./flatten";
import { planFarm, type FarmPlan } from "./plan";
import { descendPolicy, type DescendPolicy } from "./walkPolicy";
import { assembleCascade, type AssembledCascade, type CascadeInput } from "./walk";
import type { Diagnostic, EntryFacts, FlattenedCascade } from "./types";

/** Everything one launch needs resolved, in one call. */
export interface ResolveDecisionsInput {
  readonly facts: EntryFacts;
  readonly cascade: CascadeInput;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** The fully resolved state of one launch: the layers that composed it, every entry's decision, the farm layout, and everything worth reporting. */
export interface ResolvedState {
  readonly assembled: AssembledCascade;
  readonly flattened: FlattenedCascade;
  readonly classification: ClassifyResult;
  readonly decisions: ResolveAllResult["decisions"];
  readonly farm: FarmPlan;
  readonly diagnostics: readonly Diagnostic[];
}

/** The top-level `~/.claude` entry names present in a fact manifest, in sorted order. */
export function topLevelNames(facts: EntryFacts): string[] {
  const names = new Set<string>();
  for (const rel of facts.entries.keys()) {
    const head = rel.split("/")[0];
    if (head !== undefined && head !== "") {
      names.add(head);
    }
  }
  return [...names].sort();
}

/** The walk policy `buildEntryFacts` needs for `cascade`: which directories of `~/.claude` the fact walk must enter, derived from the flattened rules (see `descendPolicy`). */
export function descendPolicyFor(cascade: CascadeInput, home: string): DescendPolicy {
  return descendPolicy(flattenLayers(assembleCascade(cascade).layers, { home }).rules.values());
}

/**
 * Runs the whole pipeline for one launch: assemble the ordered layer sequence, flatten it, classify the real `~/.claude` entries, decide every path, and plan the resulting farm.
 */
export function resolveDecisions(input: ResolveDecisionsInput): ResolvedState {
  const assembled = assembleCascade(input.cascade);
  const flattened = flattenLayers(assembled.layers, { home: input.facts.home });
  const classification = classifyEntries(topLevelNames(input.facts), {
    defaults: input.classification.defaults,
    ...(input.classification.overlay === undefined ? {} : { overlay: input.classification.overlay }),
  });
  const resolved = resolveAll({
    flattened,
    facts: input.facts,
    classification: classification.classification,
  });
  const farm = planFarm({ facts: input.facts, decisions: resolved.decisions, flattened });

  return {
    assembled,
    flattened,
    classification,
    decisions: resolved.decisions,
    farm,
    diagnostics: [...assembled.diagnostics, ...resolved.diagnostics],
  };
}
