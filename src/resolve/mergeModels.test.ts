import { describe, expect, it } from "vitest";

import type { ModelsConfig, ModelsLayer } from "../config/schema";
import { countSteps, growsLinearly, seededGenerator } from "../test-helpers";
import { ModelsMerge } from "./mergeModels";

/** The merge as it was written when each layer rebuilt the whole accumulated block. `ModelsMerge` must give exactly its result, key order included. */
function naiveMergeModels(current: ModelsConfig | undefined, layer: ModelsLayer): ModelsConfig | undefined {
  const pieces = { ...(current ?? {}) };
  if (layer.pickerLabelSpaces !== undefined) pieces.pickerLabelSpaces = layer.pickerLabelSpaces;
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
  // Identity assertions accumulate: a statement made at any depth that two refs are one model, or two models, stands unless a deeper layer states the opposite of the same pair, which would be a contradiction the doctor reports rather than a merge rule.
  if (layer.same !== undefined) {
    pieces.same = [...(current?.same ?? []), ...layer.same.filter((group) => !(current?.same ?? []).some((known) => known.length === group.length && known.every((ref, index) => ref === group[index])))];
  }
  if (layer.distinct !== undefined) {
    pieces.distinct = [...(current?.distinct ?? []), ...layer.distinct.filter(([left, right]) => !(current?.distinct ?? []).some(([a, b]) => a === left && b === right))];
  }
  if (layer.families !== undefined) {
    const families: NonNullable<ModelsConfig["families"]> = {};
    for (const [key, settings] of Object.entries(current?.families ?? {})) {
      // A null in this layer removes the inherited settings; an absent key leaves them standing.
      if (layer.families[key] === undefined) {
        families[key] = settings;
      }
    }
    for (const [key, settings] of Object.entries(layer.families)) {
      if (settings !== null) {
        families[key] = settings;
      }
    }
    pieces.families = families;
  }
  const merged = naiveModelsOf(pieces);
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** Builds the merged block's sub-objects into a fresh `ModelsConfig`, dropping the pieces nothing filled. */
function naiveModelsOf(pieces: { pickerLabelSpaces?: boolean; virtual?: NonNullable<ModelsConfig["virtual"]>; tiers?: NonNullable<ModelsConfig["tiers"]>; prices?: NonNullable<ModelsConfig["prices"]>; hide?: readonly string[]; show?: readonly string[]; same?: NonNullable<ModelsConfig["same"]>; distinct?: NonNullable<ModelsConfig["distinct"]>; families?: NonNullable<ModelsConfig["families"]> }): ModelsConfig {
  return {
    ...(pieces.pickerLabelSpaces === undefined ? {} : { pickerLabelSpaces: pieces.pickerLabelSpaces }),
    ...(pieces.virtual === undefined || Object.keys(pieces.virtual).length === 0 ? {} : { virtual: pieces.virtual }),
    ...(pieces.tiers === undefined || Object.keys(pieces.tiers).length === 0 ? {} : { tiers: pieces.tiers }),
    ...(pieces.prices === undefined || Object.keys(pieces.prices).length === 0 ? {} : { prices: pieces.prices }),
    ...(pieces.hide === undefined || pieces.hide.length === 0 ? {} : { hide: [...pieces.hide] }),
    ...(pieces.show === undefined || pieces.show.length === 0 ? {} : { show: [...pieces.show] }),
    ...(pieces.same === undefined || pieces.same.length === 0 ? {} : { same: pieces.same.map((group) => [...group]) }),
    ...(pieces.distinct === undefined || pieces.distinct.length === 0 ? {} : { distinct: pieces.distinct.map(([left, right]): [string, string] => [left, right]) }),
    ...(pieces.families === undefined || Object.keys(pieces.families).length === 0 ? {} : { families: pieces.families }),
  };
}


const SEEDS = 300;
const MOST_LAYERS = 6;
const MOST_ENTRIES = 4;
const NAMES = 5;
const NULL_CHANCE = 0.25;
const PRESENT_CHANCE = 0.5;

describe("ModelsMerge", () => {
  it("gives the block the merge that rebuilt the whole block for each layer gives, for many random layers", () => {
    let nonEmpty = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = seededGenerator(seed);
      const name = (prefix: string): string => `${prefix}${String(Math.floor(next() * NAMES))}`;
      const some = <T,>(make: () => T): T[] => Array.from({ length: 1 + Math.floor(next() * MOST_ENTRIES) }, make);
      const record = <T,>(prefix: string, make: () => T): Record<string, T | null> => Object.fromEntries(some(() => [name(prefix), next() < NULL_CHANCE ? null : make()]));
      const layers: ModelsLayer[] = Array.from({ length: 1 + Math.floor(next() * MOST_LAYERS) }, () => ({
        ...(next() < PRESENT_CHANCE ? { pickerLabelSpaces: next() < PRESENT_CHANCE } : {}),
        ...(next() < PRESENT_CHANCE ? { virtual: record("v", () => ({ mode: "ordered" as const, members: some(() => name("p/m")) })) } : {}),
        ...(next() < PRESENT_CHANCE ? { tiers: { ...(next() < PRESENT_CHANCE ? { opus: next() < NULL_CHANCE ? null : name("p/m") } : {}), ...(next() < PRESENT_CHANCE ? { haiku: name("p/m") } : {}) } } : {}),
        ...(next() < PRESENT_CHANCE ? { prices: record("p/m", () => ({ input: 1, output: 2 })) } : {}),
        ...(next() < PRESENT_CHANCE ? { hide: some(() => name("p/m")) } : {}),
        ...(next() < PRESENT_CHANCE ? { show: next() < NULL_CHANCE ? [] : some(() => name("p/m")) } : {}),
        ...(next() < PRESENT_CHANCE ? { same: some(() => [name("p/m"), name("p/m")]) } : {}),
        ...(next() < PRESENT_CHANCE ? { distinct: some((): [string, string] => [name("p/m"), name("p/m")]) } : {}),
        ...(next() < PRESENT_CHANCE ? { families: record("f", () => ({ names: some(() => name("p/m")) })) } : {}),
      }));
      let expected: ModelsConfig | undefined;
      const merge = new ModelsMerge();
      for (const layer of layers) {
        expected = naiveMergeModels(expected, layer);
        merge.apply(layer);
      }
      nonEmpty += expected === undefined ? 0 : 1;
      expect(JSON.stringify(merge.result()), `seed ${String(seed)}`).toBe(JSON.stringify(expected));
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });

  const FIRST = 100;
  const DOUBLE = 2;
  const QUADRUPLE = 4;
  const sizes = [FIRST, FIRST * DOUBLE, FIRST * QUADRUPLE] as const;

  it("makes steps that grow linearly with the layers when each adds definitions of every kind", () => {
    const counts = sizes.map((size) => countSteps(() => {
      const merge = new ModelsMerge();
      for (let index = 0; index < size; index += 1) {
        merge.apply({
          virtual: { [`v${String(index)}`]: { mode: "ordered", members: [`p/m${String(index)}`] } },
          prices: { [`p/m${String(index)}`]: { input: 1, output: 2 } },
          same: [[`p/a${String(index)}`, `p/b${String(index)}`]],
          distinct: [[`p/a${String(index)}`, `p/c${String(index)}`]],
          families: { [`f${String(index)}`]: { names: [`p/m${String(index)}`] } },
        });
      }
      merge.result();
    }));
    expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
  });
});
