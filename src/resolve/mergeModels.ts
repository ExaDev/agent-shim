import type { ModelsConfig, ModelsLayer } from "../config/schema";

const TIERS = ["fable", "opus", "sonnet", "haiku"] as const;

/** A key that names a list of refs exactly: two lists have one key only when they are equal element by element. */
const keyOfRefs = (refs: readonly string[]): string => JSON.stringify(refs);

/**
 * The models block the layers of a cascade add up to, built one layer at a time in the time that layer's own size takes, however many layers came before it: every definition a layer names is set (or, when `null`, removed), `hide` and `show` replace what the shallower layers listed, and identity assertions accumulate. An entry a layer sets again moves to the end of its record, after those it left standing.
 *
 * A pass that rebuilt the whole accumulated block for each layer would cost the product of the layers and the block, which a chain of profiles that each add a definition makes large.
 */
export class ModelsMerge {
  private pickerLabelSpaces: boolean | undefined;
  private readonly virtual = new Map<string, NonNullable<ModelsConfig["virtual"]>[string]>();
  private tiers: NonNullable<ModelsConfig["tiers"]> = {};
  private readonly prices = new Map<string, NonNullable<ModelsConfig["prices"]>[string]>();
  private hide: readonly string[] | undefined;
  private show: readonly string[] | undefined;
  private readonly same: (readonly string[])[] = [];
  private readonly sameKeys = new Set<string>();
  private readonly distinct: (readonly [string, string])[] = [];
  private readonly distinctKeys = new Set<string>();
  private readonly families = new Map<string, NonNullable<ModelsConfig["families"]>[string]>();

  /** Adds one layer's models to the block, deeper layers last. */
  apply(layer: ModelsLayer): void {
    if (layer.pickerLabelSpaces !== undefined) {
      this.pickerLabelSpaces = layer.pickerLabelSpaces;
    }
    for (const [name, definition] of Object.entries(layer.virtual ?? {})) {
      this.virtual.delete(name);
      if (definition !== null) {
        this.virtual.set(name, definition);
      }
    }
    if (layer.tiers !== undefined) {
      const tiers: NonNullable<ModelsConfig["tiers"]> = {};
      for (const tier of TIERS) {
        const ref = layer.tiers[tier];
        const inherited = this.tiers[tier];
        if (ref !== null && ref !== undefined) {
          tiers[tier] = ref;
        } else if (ref === undefined && inherited !== undefined) {
          tiers[tier] = inherited;
        }
      }
      this.tiers = tiers;
    }
    for (const [ref, prices] of Object.entries(layer.prices ?? {})) {
      this.prices.delete(ref);
      if (prices !== null) {
        this.prices.set(ref, prices);
      }
    }
    if (layer.hide !== undefined) {
      this.hide = layer.hide;
    }
    if (layer.show !== undefined) {
      this.show = layer.show;
    }
    // Identity assertions accumulate: a statement made at any depth that two refs are one model, or two models, stands unless a deeper layer states the opposite of the same pair, which would be a contradiction the doctor reports rather than a merge rule. A group a shallower layer already made is not added again; one repeated inside this layer is.
    const knownSame = new Set(this.sameKeys);
    for (const group of layer.same ?? []) {
      if (!knownSame.has(keyOfRefs(group))) {
        this.same.push(group);
        this.sameKeys.add(keyOfRefs(group));
      }
    }
    const knownDistinct = new Set(this.distinctKeys);
    for (const [left, right] of layer.distinct ?? []) {
      if (!knownDistinct.has(keyOfRefs([left, right]))) {
        this.distinct.push([left, right]);
        this.distinctKeys.add(keyOfRefs([left, right]));
      }
    }
    for (const [key, settings] of Object.entries(layer.families ?? {})) {
      this.families.delete(key);
      if (settings !== null) {
        this.families.set(key, settings);
      }
    }
  }

  /** The block the layers added up to, or undefined when they left it empty. */
  result(): ModelsConfig | undefined {
    const merged: ModelsConfig = {
      ...(this.pickerLabelSpaces === undefined ? {} : { pickerLabelSpaces: this.pickerLabelSpaces }),
      ...(this.virtual.size === 0 ? {} : { virtual: Object.fromEntries(this.virtual) }),
      ...(Object.keys(this.tiers).length === 0 ? {} : { tiers: { ...this.tiers } }),
      ...(this.prices.size === 0 ? {} : { prices: Object.fromEntries(this.prices) }),
      ...(this.hide === undefined || this.hide.length === 0 ? {} : { hide: [...this.hide] }),
      ...(this.show === undefined || this.show.length === 0 ? {} : { show: [...this.show] }),
      ...(this.same.length === 0 ? {} : { same: this.same.map((group) => [...group]) }),
      ...(this.distinct.length === 0 ? {} : { distinct: this.distinct.map(([left, right]): [string, string] => [left, right]) }),
      ...(this.families.size === 0 ? {} : { families: Object.fromEntries(this.families) }),
    };
    return Object.keys(merged).length === 0 ? undefined : merged;
  }
}
