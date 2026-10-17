import { describe, expect, it } from "vitest";

import { modelIdentity, relateModels, relateWithAssertions, type ModelIdentity } from "./identity";

const identityOf = (name: string): Pick<ModelIdentity, "vendor" | "family" | "version" | "variant"> => {
  const { vendor, family, version, variant } = modelIdentity(name);
  return { vendor, family, version, variant };
};

describe("modelIdentity", () => {
  it.each([
    ["glm-5.1", { vendor: "zai", family: "glm", version: "5.1", variant: "" }],
    ["hf:zai-org/GLM-5.1", { vendor: "zai", family: "glm", version: "5.1", variant: "" }],
    ["claude-opus-5-5", { vendor: "anthropic", family: "claude-opus", version: "5.5", variant: "" }],
    ["Claude Opus 5.5", { vendor: "anthropic", family: "claude-opus", version: "5.5", variant: "" }],
    ["claude-opus-5.5[1m]", { vendor: "anthropic", family: "claude-opus", version: "5.5", variant: "" }],
  ])("reads %s as one identity whatever its spelling", (name, expected) => {
    expect(identityOf(name)).toEqual(expected);
  });

  it.each([
    ["claude-opus-5-5-high", "high"],
    ["claude-opus-4-6-thinking", "thinking"],
    ["MiniMax-M2.7-highspeed", "highspeed"],
    ["gpt-5.6-sol", "sol"],
    ["gemini-3.8-flash-high", "high"],
  ])("splits the behaviour-changing variant off %s", (name, variant) => {
    expect(modelIdentity(name).variant).toBe(variant);
  });

  it.each([
    ["anthropic/xingchen-agi/xing4.0-29b-a4b", "xing-29b-a4b"],
    ["qwen/qwen3-coder:free", "qwen3-coder"],
    ["z-ai/glm-5.3", "glm"],
    ["claude-haiku-4-5-20251001", "claude-haiku"],
  ])("strips what is not identity from %s", (name, family) => {
    expect(modelIdentity(name).family).toBe(family);
  });

  it("keeps a speed-tier word inside the family when no known variant follows it", () => {
    expect(modelIdentity("gemini-3.8-flash")).toMatchObject({ family: "gemini-flash", version: "3.8", variant: "" });
  });

  it("leaves the vendor empty for a name whose words name none", () => {
    expect(modelIdentity("openrouter/free").vendor).toBe("");
  });
});

describe("relateModels", () => {
  it("calls the same model same across vendors, namespaces, markers and case", () => {
    expect(relateModels("glm-5.1", "hf:zai-org/GLM-5.1")).toBe("same");
    expect(relateModels("claude-opus-5-5", "claude-opus-5.5[1m]")).toBe("same");
    expect(relateModels("claude-opus-5-5-high", "claude-opus-5.5-high")).toBe("same");
  });

  it("calls a variant apart similar, never merging two behaviours as one model", () => {
    expect(relateModels("claude-opus-5-5", "claude-opus-5-5-high")).toBe("similar");
    expect(relateModels("gpt-5.6-sol", "gpt-5.6-terra")).toBe("similar");
  });

  it("calls a version apart within one family similar", () => {
    expect(relateModels("glm-5.1", "glm-5.3")).toBe("similar");
    expect(relateModels("claude-opus-4-6", "claude-opus-5-5")).toBe("similar");
  });

  it("calls different families distinct, however their versions line up", () => {
    expect(relateModels("glm-5.1", "claude-opus-5-5")).toBe("distinct");
    expect(relateModels("gemini-3.8-flash", "gemini-4-argon")).toBe("distinct");
  });

  it("treats one family two vendors claim as similar rather than same", () => {
    // The family word says one thing and each vendor namespace says another: proposed, not merged.
    expect(relateModels("anthropic/claude-opus-5-5", "google/claude-opus-5-5")).toBe("similar");
    expect(modelIdentity("google/claude-opus-5-5").vendorConflict).toBe(true);
  });
});

describe("relateWithAssertions", () => {
  const none = { same: [], distinct: [] };

  it("merges two names a same group holds together, over the heuristic's verdict", () => {
    expect(relateWithAssertions("glm-5.1", "glm-5.3", { ...none, same: [["glm-5.1", "glm-5.3"]] })).toBe("same");
  });

  it("splits two names a distinct pair holds apart, over the heuristic's verdict", () => {
    expect(relateWithAssertions("glm-5.1", "hf:zai-org/GLM-5.1", { ...none, distinct: [["glm-5.1", "hf:zai-org/GLM-5.1"]] })).toBe("distinct");
  });

  it("demotes a heuristic match to similar when one side is pinned to another group", () => {
    expect(relateWithAssertions("glm-5.1", "hf:zai-org/GLM-5.1", { ...none, same: [["glm-5.1", "glm-5.3"]] })).toBe("similar");
  });

  it("leaves the heuristic's verdict when no assertion touches the pair", () => {
    expect(relateWithAssertions("glm-5.1", "glm-5.2", none)).toBe("similar");
    expect(relateWithAssertions("glm-5.1", "glm-5.1", none)).toBe("same");
  });
});
