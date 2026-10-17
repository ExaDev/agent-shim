import { isOverridableCategory, type EntryValue, type ModelsConfig, type ModelsLayer, type OverridableCategory } from "../config/schema";
import { isVacuousWhen } from "./conditions";
import { canonicaliseEntryKey, compareSpecificity, compileMatcher, EntryKeyError, isExactPattern, literalPrefixOf } from "./match";
import type { CompiledRule, Diagnostic, FlattenedCascade, Layer } from "./types";

function unpackEntryValue(value: EntryValue): { value: boolean; when?: CompiledRule["when"] } {
  if (typeof value === "boolean") {
    return { value };
  }
  return { value: value.value, when: value.when };
}

/**
 * Cascade phase one: walk the ordered layer sequence once, spreading each layer's `categories` and `entries` over an accumulator. A later layer's value for the exact same category name, or the exact same key, replaces an earlier layer's value for that identical key. No path-specificity reasoning happens here — that is phase two's job.
 *
 * The entries accumulator is keyed by the **canonical** pattern, not the raw written key, so two differently-spelled but equivalent keys (`history/projects/~/work/x` and `history/projects/$HOME/work/x` after expansion) collapse into one rule here instead of racing as two separate candidates in phase two. Every surviving rule carries its own `{ layer, ordinal }`, which is what lets phase two tell a same-layer conflict from a cross-layer one without a separate provenance side-table.
 *
 * A key written under the `secret/` prefix is rejected outright with its own diagnostic and contributes no rule at all: `secret` is the one category no layer may open, and a deliberate attempt to name a secret path deserves a clearer error than the silent neutralisation the resolve-time floor check applies to a glob that reaches one incidentally.
 */
export function flattenLayers(layers: readonly Layer[], options: Readonly<{ home: string }>): FlattenedCascade {
  const categories = new Map<OverridableCategory, boolean>();
  const rules = new Map<string, CompiledRule>();
  const launch: { skipPermissions?: boolean; remoteControl?: boolean; provider?: string; headroom?: boolean; trackUsage?: boolean; claudeVersion?: string; delay?: string; pause?: boolean; explain?: boolean } = {};
  const diagnostics: Diagnostic[] = [];
  let models: ModelsConfig | undefined;

  for (const layer of layers) {
    if (layer.categories !== undefined) {
      for (const [name, value] of Object.entries(layer.categories)) {
        if (!isOverridableCategory(name)) {
          continue;
        }
        categories.set(name, value);
      }
    }

    if (layer.launch !== undefined) {
      if (layer.launch.skipPermissions !== undefined) {
        launch.skipPermissions = layer.launch.skipPermissions;
      }
      if (layer.launch.remoteControl !== undefined) {
        launch.remoteControl = layer.launch.remoteControl;
      }
      if (layer.launch.provider !== undefined) {
        launch.provider = layer.launch.provider;
      }
      if (layer.launch.headroom !== undefined) {
        launch.headroom = layer.launch.headroom;
      }
      if (layer.launch.trackUsage !== undefined) {
        launch.trackUsage = layer.launch.trackUsage;
      }
      if (layer.launch.claudeVersion !== undefined) {
        launch.claudeVersion = layer.launch.claudeVersion;
      }
      if (layer.launch.delay !== undefined) {
        launch.delay = layer.launch.delay;
      }
      if (layer.launch.pause !== undefined) {
        launch.pause = layer.launch.pause;
      }
      if (layer.launch.explain !== undefined) {
        launch.explain = layer.launch.explain;
      }
    }

    if (layer.models !== undefined) {
      models = mergeModels(models, layer.models);
    }

    if (layer.entries === undefined) {
      continue;
    }

    const order = orderedKeys(layer);
    for (const [ordinal, rawKey] of order.entries()) {
      const value = layer.entries[rawKey];
      if (value === undefined) {
        continue;
      }

      let canonical;
      try {
        canonical = canonicaliseEntryKey(rawKey, { home: options.home });
      } catch (error) {
        if (error instanceof EntryKeyError) {
          diagnostics.push({
            code: error.reason === "unrooted-project-path" ? "UNROOTED_PROJECT_PATH" : "MALFORMED_ENTRY_KEY",
            severity: "error",
            message: error.message,
            subject: rawKey,
            layer: layer.id,
          });
          continue;
        }
        throw error;
      }

      if (canonical.declaredCategory === "secret") {
        diagnostics.push({
          code: "SECRET_ENTRY_KEY",
          severity: "error",
          message:
            `Entry key "${rawKey}" targets the secret category, which no configuration layer may override. ` +
            `Credentials and config backups are never shared with any identity, and this key is ignored entirely.`,
          subject: rawKey,
          layer: layer.id,
        });
        continue;
      }

      const unpacked = unpackEntryValue(value);
      if (isVacuousWhen(unpacked.when)) {
        diagnostics.push({
          code: "EMPTY_WHEN",
          severity: "warning",
          message: `Entry key "${rawKey}" carries an empty "when" object, which is vacuously true and has no effect.`,
          subject: rawKey,
          layer: layer.id,
        });
      }

      const pattern = canonical.canonicalPattern;
      const rule: CompiledRule = {
        rawKey,
        declaredCategory: canonical.declaredCategory,
        canonicalPattern: pattern,
        value: unpacked.value,
        ...(unpacked.when === undefined ? {} : { when: unpacked.when }),
        layer: layer.id,
        ordinal,
        isExact: isExactPattern(pattern),
        literalPrefix: literalPrefixOf(pattern),
        segmentCount: pattern.split("/").filter((segment) => segment !== "").length,
        matches: compileMatcher(pattern),
      };
      rules.set(pattern, rule);
    }
  }

  return { categories, rules, launch: launch, ...(models === undefined ? {} : { models }), diagnostics };
}

/**
 * The keys of a layer's entries object, in the order they were written in the source file.
 *
 * `entryOrder` is captured explicitly at load time rather than read back off the validated object, because Zod's parse returns a fresh deep clone and the comparator's same-layer tie-break must not depend on key order implicitly surviving that. Any key present in `entries` but missing from `entryOrder` (a layer built in code rather than loaded from a file) is appended in `Object.keys` order so nothing is ever silently dropped.
 */
function orderedKeys(layer: Layer): string[] {
  const present = new Set(Object.keys(layer.entries ?? {}));
  const ordered: string[] = [];
  for (const key of layer.entryOrder ?? []) {
    if (present.has(key)) {
      ordered.push(key);
      present.delete(key);
    }
  }
  for (const key of present) {
    ordered.push(key);
  }
  return ordered;
}

/** Every compiled rule that matches `relPath`, ranked most-specific first. */
export function matchingRules(flattened: FlattenedCascade, relPath: string): CompiledRule[] {
  const matches: CompiledRule[] = [];
  for (const rule of flattened.rules.values()) {
    if (rule.matches(relPath)) {
      matches.push(rule);
    }
  }
  return matches.sort((a, b) => compareSpecificity(b, a));
}

/** Merges one layer's models into the accumulated block: every definition the layer names is set (or, when `null`, removed), and `hide`/`show` replace what the shallower layers listed. */
function mergeModels(current: ModelsConfig | undefined, layer: ModelsLayer): ModelsConfig | undefined {
  const pieces = { ...(current ?? {}) };
  if (layer.virtual !== undefined) {
    const virtual: NonNullable<ModelsConfig["virtual"]> = {};
    for (const [name, definition] of Object.entries(current?.virtual ?? {})) {
      // A null in this layer removes the inherited definition; an absent name leaves it standing.
      if (layer.virtual[name] === undefined) {
        virtual[name] = definition;
      }
    }
    for (const [name, definition] of Object.entries(layer.virtual)) {
      if (definition !== null) {
        virtual[name] = definition;
      }
    }
    pieces.virtual = virtual;
  }
  if (layer.tiers !== undefined) {
    const tiers: NonNullable<ModelsConfig["tiers"]> = {};
    for (const tier of ["fable", "opus", "sonnet", "haiku"] as const) {
      const ref = layer.tiers[tier];
      const inherited = current?.tiers?.[tier];
      if (ref !== null && ref !== undefined) {
        tiers[tier] = ref;
      } else if (ref === undefined && inherited !== undefined) {
        tiers[tier] = inherited;
      }
    }
    pieces.tiers = tiers;
  }
  if (layer.prices !== undefined) {
    const priced: NonNullable<ModelsConfig["prices"]> = {};
    for (const [ref, prices] of Object.entries(current?.prices ?? {})) {
      if (layer.prices[ref] === undefined) {
        priced[ref] = prices;
      }
    }
    for (const [ref, prices] of Object.entries(layer.prices)) {
      if (prices !== null) {
        priced[ref] = prices;
      }
    }
    pieces.prices = priced;
  }
  if (layer.hide !== undefined) {
    pieces.hide = layer.hide;
  }
  if (layer.show !== undefined) {
    pieces.show = layer.show;
  }
  const merged = modelsOf(pieces);
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** Builds the merged block's sub-objects into a fresh `ModelsConfig`, dropping the pieces nothing filled. */
function modelsOf(pieces: { virtual?: NonNullable<ModelsConfig["virtual"]>; tiers?: NonNullable<ModelsConfig["tiers"]>; prices?: NonNullable<ModelsConfig["prices"]>; hide?: readonly string[]; show?: readonly string[] }): ModelsConfig {
  return {
    ...(pieces.virtual === undefined || Object.keys(pieces.virtual).length === 0 ? {} : { virtual: pieces.virtual }),
    ...(pieces.tiers === undefined || Object.keys(pieces.tiers).length === 0 ? {} : { tiers: pieces.tiers }),
    ...(pieces.prices === undefined || Object.keys(pieces.prices).length === 0 ? {} : { prices: pieces.prices }),
    ...(pieces.hide === undefined || pieces.hide.length === 0 ? {} : { hide: [...pieces.hide] }),
    ...(pieces.show === undefined || pieces.show.length === 0 ? {} : { show: [...pieces.show] }),
  };
}
