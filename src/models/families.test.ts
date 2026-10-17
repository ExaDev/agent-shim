import { describe, expect, it } from "vitest";

import { buildFamilies, expandFamilyMembers, familyCapabilities, familyKeyOf, familyMode, familyNamed, familyOfRef, sharedFamilies } from "./families";

describe("familyKeyOf", () => {
  it("gives equal keys to one model under different spellings, and the variant a separate suffix", () => {
    expect(familyKeyOf("glm-5.1")).toBe(familyKeyOf("hf:zai-org/GLM-5.1"));
    expect(familyKeyOf("claude-opus-5-5")).toBe(familyKeyOf("claude-opus-5-5[1m]"));
    expect(familyKeyOf("claude-opus-5-5-high")).toBe(`${familyKeyOf("claude-opus-5-5")}+high`);
  });
});

describe("buildFamilies", () => {
  const refs = ["z/glm-5.1", "s/hf:zai-org/GLM-5.1", "z/glm-5.3[1m]", "antigravity/claude-opus-5-5-high", "m/MiniMax-M3"];

  it("groups targets that are one model across providers and keeps different models apart", () => {
    const families = buildFamilies(refs, undefined);
    expect(families.find((family) => family.refs.includes("z/glm-5.1"))?.refs).toEqual(["z/glm-5.1", "s/hf:zai-org/GLM-5.1"]);
    expect(families.find((family) => family.refs.includes("z/glm-5.3[1m]"))?.refs).toEqual(["z/glm-5.3[1m]"]);
  });

  it("keeps the variants of one family apart, because a mode picks the variant explicitly", () => {
    const families = buildFamilies(["a/claude-opus-5-5-high", "b/claude-opus-5-5-low", "c/claude-opus-5-5-high"], undefined);
    expect(families.map((family) => family.refs)).toEqual([
      ["a/claude-opus-5-5-high", "c/claude-opus-5-5-high"],
      ["b/claude-opus-5-5-low"],
    ]);
  });

  it("joins targets the user asserted are one model, and splits ones the user asserted are two", () => {
    expect(buildFamilies(["z/glm-5.1", "o/some-other-name"], { same: [["z/glm-5.1", "o/some-other-name"]] }).map((family) => family.refs)).toEqual([["z/glm-5.1", "o/some-other-name"]]);
    expect(buildFamilies(["z/glm-5.1", "s/hf:zai-org/GLM-5.1"], { distinct: [["z/glm-5.1", "s/hf:zai-org/GLM-5.1"]] }).map((family) => family.refs)).toEqual([["z/glm-5.1"], ["s/hf:zai-org/GLM-5.1"]]);
  });

  it("pins a name the normaliser cannot know into the family the settings name", () => {
    const families = buildFamilies(["z/glm-5.1", "o/oddly-named"], { families: { "glm-5-1": { names: ["o/oddly-named"] } } });
    expect(families.find((family) => family.key === "glm-5-1")?.refs).toEqual(["z/glm-5.1", "o/oddly-named"]);
  });

  it("puts an account ref into a family only when the user said it belongs", () => {
    const families = buildFamilies(["z/glm-5.1", "acct:work/opus"], { same: [["z/glm-5.1", "acct:work/opus"]] });
    expect(families[0]?.refs).toEqual(["z/glm-5.1", "acct:work/opus"]);
  });
});

describe("the family helpers", () => {
  const families = buildFamilies(["z/glm-5.1", "s/hf:zai-org/GLM-5.1", "m/MiniMax-M3"], { families: { "glm-5-1": { mode: "cheapest", vision: false } } });

  it("finds a family by its member name and reports only the families more than one target offers as shared", () => {
    expect(familyNamed(families, "family:glm-5-1")?.refs).toHaveLength(2);
    expect(familyNamed(families, "family:nope")).toBeUndefined();
    expect(familyNamed(families, "z/glm-5.1")).toBeUndefined();
    expect(sharedFamilies(families).map((family) => family.key)).toEqual(["glm-5-1"]);
  });

  it("takes a capability as supported unless the settings say otherwise, and a mode as ordered", () => {
    const glm = familyNamed(families, "family:glm-5-1");
    expect(familyCapabilities(glm?.settings ?? {})).toEqual({ vision: false, tools: true, thinking: true });
    expect(familyMode(glm?.settings ?? {})).toBe("cheapest");
    expect(familyMode({})).toBe("ordered");
  });
});

describe("expandFamilyMembers", () => {
  const families = buildFamilies(["z/glm-5.1", "s/hf:zai-org/GLM-5.1", "m/MiniMax-M3"], undefined);

  it("replaces a family member with its targets in place, without repeating one the list already holds", () => {
    expect(expandFamilyMembers(["m/MiniMax-M3", "family:glm-5-1", "z/glm-5.1"], families)).toEqual(["m/MiniMax-M3", "z/glm-5.1", "s/hf:zai-org/GLM-5.1"]);
  });

  it("expands a family no target belongs to to nothing, and leaves plain members alone", () => {
    expect(expandFamilyMembers(["family:ghost-9", "m/MiniMax-M3"], families)).toEqual(["m/MiniMax-M3"]);
  });

  it("finds the family a target belongs to", () => {
    expect(familyOfRef(families, "s/hf:zai-org/GLM-5.1")?.key).toBe("glm-5-1");
    expect(familyOfRef(families, "nowhere/x")).toBeUndefined();
  });
});
