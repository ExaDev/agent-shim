import { describe, expect, it } from "vitest";

import type { ModelsConfig } from "../config/schema";
import { expandMembers } from "../modelsStore";
import { buildFamilies, expandFamilyMembers, familyKeyOf, type Family } from "./families";
import { modelsFindings } from "./doctor";
import { relateModels } from "./identity";
import { countSteps, growsLinearly, seededGenerator as generator } from "../test-helpers";

/** The grouping as it was written before it was indexed: each target compared with every group in turn, and the user's assertions searched for each comparison. The indexed `buildFamilies` must give exactly its result. */
function naiveFamilies(refs: readonly string[], models: ModelsConfig | undefined): readonly { readonly key: string; readonly refs: readonly string[] }[] {
  const modelOf = (ref: string): string => (ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref);
  const same = models?.same ?? [];
  const distinct = models?.distinct ?? [];
  const settingsByKey = models?.families ?? {};
  const sameModel = (left: string, right: string): boolean => {
    if (distinct.some(([a, b]) => (a === left && b === right) || (a === right && b === left))) {
      return false;
    }
    const leftGroup = same.find((group) => group.includes(left));
    const rightGroup = same.find((group) => group.includes(right));
    if (leftGroup !== undefined && leftGroup === rightGroup) {
      return true;
    }
    if ((leftGroup !== undefined && !leftGroup.includes(right)) || (rightGroup !== undefined && !rightGroup.includes(left))) {
      return false;
    }
    return relateModels(modelOf(left), modelOf(right)) === "same";
  };
  const groups: { key: string; refs: string[] }[] = [];
  for (const ref of refs) {
    const pinnedKey = Object.entries(settingsByKey).find(([, settings]) => settings.names?.some((name) => name === ref || name === modelOf(ref)) === true)?.[0];
    const joined = groups.find((group) => (pinnedKey === undefined ? group.refs.some((first) => sameModel(first, ref)) : group.key === pinnedKey));
    if (joined !== undefined) {
      joined.refs.push(ref);
    } else {
      groups.push({ key: pinnedKey ?? familyKeyOf(modelOf(ref)), refs: [ref] });
    }
  }
  return groups;
}

/** How likely each optional part of a random models block is, and how many entries the parts hold at most. */
const SAME_CHANCE = 0.6;
const DISTINCT_CHANCE = 0.5;
const FAMILIES_CHANCE = 0.4;
const MOST_SAME_GROUPS = 3;
const MOST_DISTINCT_PAIRS = 4;
const SAME_GROUP_SIZE = 3;

const MODELS = ["glm-5.3", "glm-5.1", "claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-5-low", "gpt-5.6", "gpt-5.6-mini", "minimax-m3", "hf:zai-org/GLM-5.1", "glm-5.3-20260101", "claude-opus-5-5[1m]"];
const PROVIDERS = ["z", "s", "m", "antigravity", "acct:work", "codex"];

describe("buildFamilies, indexed", () => {
  const SEEDS = 400;
  const REFS_PER_SEED = 24;

  it("gives the result the comparison against every group gives, for many random catalogues, assertions and pins", () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = generator(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] ?? items[0] as T;
      const refs = Array.from({ length: REFS_PER_SEED }, () => `${pick(PROVIDERS)}/${pick(MODELS)}`);
      const some = (): string => pick(refs);
      const models: ModelsConfig = {
        ...(next() < SAME_CHANCE ? { same: Array.from({ length: 1 + Math.floor(next() * MOST_SAME_GROUPS) }, () => Array.from({ length: SAME_GROUP_SIZE }, some)) } : {}),
        ...(next() < DISTINCT_CHANCE ? { distinct: Array.from({ length: 1 + Math.floor(next() * MOST_DISTINCT_PAIRS) }, () => [some(), some()] as [string, string]) } : {}),
        ...(next() < FAMILIES_CHANCE ? { families: { pinned: { names: [some(), pick(MODELS)] }, other: { names: [pick(MODELS)], mode: "ordered" } } } : {}),
      };
      const indexed = buildFamilies(refs, models).map((family) => ({ key: family.key, refs: family.refs }));
      expect(indexed, `seed ${String(seed)}`).toEqual(naiveFamilies(refs, models));
    }
  });

  it("gives the same result with no models block at all", () => {
    const refs = ["z/glm-5.1", "s/hf:zai-org/GLM-5.1", "z/glm-5.3[1m]", "antigravity/claude-opus-5-5-high", "m/MiniMax-M3"];
    expect(buildFamilies(refs, undefined).map((family) => ({ key: family.key, refs: family.refs }))).toEqual(naiveFamilies(refs, undefined));
  });

  it("makes a number of steps that grows linearly with the targets, with a large `same` assertion and many distinct models", () => {
    const FIRST = 100;
    const SECOND = 200;
    const THIRD = 400;
    const sizes = [FIRST, SECOND, THIRD] as const;
    const counts = sizes.map((size) => {
      const refs = Array.from({ length: size }, (_, index) => `p${String(index)}/model-${String(index)}`);
      return countSteps(() => { buildFamilies(refs, { same: [refs], families: {} }); });
    });
    expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
  });
});

describe("buildFamilies, with many assertions sharing a model name", () => {
  const FIRST = 100;
  const SECOND = 200;
  const THIRD = 400;
  const sizes = [FIRST, SECOND, THIRD] as const;
  const SMALL_SCENARIO = 10;

  /** Each of `providers` providers offers the same model name and asserts it is one model with an alias of its own, so every provider's target is in a different `same` group and all of them share one identity bucket; each also has a target in no assertion. */
  const scenario = (providers: number) => {
    const asserted = Array.from({ length: providers }, (_, index) => [`p${String(index)}/claude-opus-4`, `p${String(index)}/opus-alias`]);
    const plain = Array.from({ length: providers }, (_, index) => `u${String(index)}/claude-opus-4`);
    return { refs: [...asserted.flat(), ...plain], models: { same: asserted, families: {} } satisfies ModelsConfig };
  };

  it("makes steps that grow linearly with the providers, as the groups an assertion excludes are not compared", () => {
    const counts = sizes.map((size) => {
      const { refs, models } = scenario(size);
      return countSteps(() => { buildFamilies(refs, models); });
    });
    expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
  });

  it("gives the families the comparison against every group gives for that scenario", () => {
    const { refs, models } = scenario(SMALL_SCENARIO);
    expect(buildFamilies(refs, models).map((family) => ({ key: family.key, refs: family.refs }))).toEqual(naiveFamilies(refs, models));
  });
});

describe("buildFamilies, with targets in several `same` groups", () => {
  it("gives the families the comparison against every group gives when groups overlap", () => {
    const refs = ["a/glm-5.1", "b/glm-5.1", "c/hf:zai-org/GLM-5.1", "d/glm-5.3", "e/other", "f/other"];
    const overlapping: ModelsConfig[] = [
      { same: [["a/glm-5.1", "d/glm-5.3"], ["d/glm-5.3", "e/other"], ["e/other", "f/other"]] },
      { same: [["b/glm-5.1", "e/other"], ["a/glm-5.1", "b/glm-5.1"], ["c/hf:zai-org/GLM-5.1", "a/glm-5.1"]] },
      { same: [["a/glm-5.1", "b/glm-5.1", "c/hf:zai-org/GLM-5.1"], ["b/glm-5.1", "d/glm-5.3"]], distinct: [["a/glm-5.1", "c/hf:zai-org/GLM-5.1"]] },
    ];
    for (const models of overlapping) {
      expect(buildFamilies(refs, models).map((family) => ({ key: family.key, refs: family.refs }))).toEqual(naiveFamilies(refs, models));
    }
  });
});

describe("modelsFindings, with each identity worked out once", () => {
  const SEEDS = 80;
  const MEMBERS = 14;
  const GROUP_SIZE = 4;

  it("reports the pairs that look alike, and the asserted pairs that differ, exactly as the comparison of every pair does", () => {
    const modelOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);
    let alikeTotal = 0;
    let differTotal = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = generator(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] ?? items[0] as T;
      const members = Array.from({ length: MEMBERS }, () => `z/${pick(MODELS)}`);
      const group = Array.from({ length: GROUP_SIZE }, () => pick(members));
      const models: ModelsConfig = { virtual: { v: { mode: "ordered", members } }, same: [group] };
      const messages = modelsFindings({ models, providers: ["z"], identities: [] }).map((finding) => finding.message);
      const expectedAlike = members.flatMap((left, index) => members.slice(index + 1).filter((right) => relateModels(modelOf(left), modelOf(right)) === "same").map((right) => `Virtual model "v" lists "${left}" and "${right}"`));
      const expectedDistinct = group.flatMap((left, index) => group.slice(index + 1).filter((right) => relateModels(modelOf(left), modelOf(right)) === "distinct").map((right) => `"${left}" and "${right}" are asserted to be one model, but`));
      const alike = messages.filter((message) => message.includes("which look like one model"));
      const differ = messages.filter((message) => message.includes("asserted to be one model, but"));
      alikeTotal += alike.length;
      differTotal += differ.length;
      expect(alike.map((message) => message.slice(0, message.indexOf(", which")))).toEqual(expectedAlike);
      expect(differ.map((message) => message.slice(0, message.indexOf(" their names")))).toEqual(expectedDistinct);
    }
    // The comparison is not vacuous: both kinds of finding were produced across the seeds.
    expect(alikeTotal).toBeGreaterThan(0);
    expect(differTotal).toBeGreaterThan(0);
  });
});

describe("expanding members at the size of a large models block", () => {
  const FIRST = 100;
  const SECOND = 200;
  const THIRD = 400;
  const sizes = [FIRST, SECOND, THIRD] as const;

  it("expands a virtual model of many members in steps that grow linearly, keeping first occurrences in order", () => {
    const counts = sizes.map((size) => {
      const members = Array.from({ length: size }, (_, index) => `p/model-${String(index % (size - 1))}`);
      return countSteps(() => { expandMembers("wide", { virtual: { wide: { mode: "ordered", members } } }); });
    });
    expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
    expect(expandMembers("v", { virtual: { v: { mode: "ordered", members: ["a/x", "b/y", "a/x", "n"] }, n: { mode: "ordered", members: ["b/y", "c/z"] } } })).toEqual(["a/x", "b/y", "c/z"]);
  });

  it("expands family members in steps that grow linearly, keeping first occurrences and the first family of a key", () => {
    const counts = sizes.map((size) => {
      const families: Family[] = Array.from({ length: size }, (_, index) => ({ key: `f${String(index)}`, refs: [`p/f${String(index)}`], settings: {} }));
      const members = families.map((family) => `family:${family.key}`);
      return countSteps(() => { expandFamilyMembers(members, families); });
    });
    expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
    const twins: Family[] = [{ key: "k", refs: ["a/1"], settings: {} }, { key: "k", refs: ["b/2"], settings: {} }];
    expect(expandFamilyMembers(["family:k", "a/1", "family:none"], twins)).toEqual(["a/1"]);
  });
});
