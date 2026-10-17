import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import type { ModelsConfig } from "./config/schema";
import { addDistinctPair, addSameGroup, expandMembers, memberKindOf, removeAssertionsNaming, removeVirtualModel, setFamily, setTier, setVirtualModel, setPrice, VirtualModelNotFoundError } from "./modelsStore";

describe("the models store", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "models-store-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The parsed models block of the config file as written. */
  const blockOf = (): unknown => (JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8")) as { models?: unknown }).models;

  it("keeps identity assertions as transitive groups and unrepeated pairs, and removes everything naming a ref", () => {
    addSameGroup(paths, ["a/x", "b/y"]);
    addSameGroup(paths, ["b/y", "c/z"]);
    addSameGroup(paths, ["d/p", "e/q"]);
    addDistinctPair(paths, "a/x", "f/m");
    addDistinctPair(paths, "f/m", "a/x");
    expect(blockOf()).toEqual({ same: [["a/x", "b/y", "c/z"], ["d/p", "e/q"]], distinct: [["a/x", "f/m"]] });
    expect(removeAssertionsNaming(paths, "a/x")).toBe(2);
    expect(blockOf()).toEqual({ same: [["d/p", "e/q"]] });
    expect(removeAssertionsNaming(paths, "nothing/here")).toBe(0);
  });

  it("sets and removes one family's settings, leaving an empty block no key", () => {
    setFamily(paths, "glm-5-1", { mode: "cheapest", vision: false });
    setFamily(paths, "other", { names: ["o/odd"] });
    setFamily(paths, "other", undefined);
    expect(blockOf()).toEqual({ families: { "glm-5-1": { mode: "cheapest", vision: false } } });
    setFamily(paths, "glm-5-1", undefined);
    expect(blockOf()).toBeUndefined();
  });

  it("writes a virtual model into the global config's models block and reads it back", () => {
    setVirtualModel(paths, "fast", { mode: "soonest-reset", members: ["z/glm-5.3", "m/MiniMax-M3"] });
    expect(blockOf()).toEqual({
      virtual: { fast: { mode: "soonest-reset", members: ["z/glm-5.3", "m/MiniMax-M3"] } },
    });
  });

  it("replaces one virtual model and removes another without touching the rest of the block", () => {
    setVirtualModel(paths, "a", { mode: "ordered", members: ["z/1"] });
    setTier(paths, "opus", "a");
    setVirtualModel(paths, "b", { mode: "spread", members: ["z/2"] });
    setVirtualModel(paths, "a", { mode: "cheapest", members: ["z/3"] });
    removeVirtualModel(paths, "b");

    expect(blockOf()).toEqual({
      virtual: { a: { mode: "cheapest", members: ["z/3"] } },
      tiers: { opus: "a" },
    });
  });

  it("drops an emptied block's pieces rather than writing empty maps", () => {
    setVirtualModel(paths, "only", { mode: "ordered", members: ["z/1"] });
    removeVirtualModel(paths, "only");
    expect(blockOf()).toBeUndefined();
    expect(() => {
      removeVirtualModel(paths, "only");
    }).toThrow(VirtualModelNotFoundError);
  });

  it("sets and clears a price, dropping the map when the last price goes", () => {
    setPrice(paths, "z/glm-5.3", { input: 0.6, output: 2.2 });
    setPrice(paths, "m/MiniMax-M3", { input: 0.2, output: 0.8 });
    setPrice(paths, "z/glm-5.3", undefined);

    expect(blockOf()).toEqual({ prices: { "m/MiniMax-M3": { input: 0.2, output: 0.8 } } });

    setPrice(paths, "m/MiniMax-M3", undefined);
    expect(blockOf()).toBeUndefined();
  });

  it("resets a tier pointer to nothing", () => {
    setTier(paths, "sonnet", "fast");
    setTier(paths, "sonnet", undefined);
    expect(blockOf()).toBeUndefined();
  });
});

describe("memberKindOf", () => {
  it("tells an account member, a family member, a virtual member and a provider model apart", () => {
    expect(memberKindOf("acct:work/opus", undefined)).toBe("account");
    expect(memberKindOf("family:glm-5.1", undefined)).toBe("family");
    expect(memberKindOf("auto", { virtual: { auto: { mode: "ordered", members: ["z/1"] } } })).toBe("virtual");
    expect(memberKindOf("z/glm-5.3", undefined)).toBe("provider");
  });
});

describe("expandMembers", () => {
  it("follows nested virtual models and keeps each concrete member once", () => {
    const models: ModelsConfig = { virtual: { outer: { mode: "ordered", members: ["inner", "z/1"] }, inner: { mode: "ordered", members: ["z/1", "m/2"] } } };
    expect(expandMembers("outer", models)).toEqual(["z/1", "m/2"]);
  });

  it("throws naming the chain on a cycle", () => {
    const models: ModelsConfig = { virtual: { a: { mode: "ordered", members: ["b"] }, b: { mode: "ordered", members: ["a"] } } };
    expect(() => expandMembers("a", models)).toThrow("cycle");
  });

  it("throws naming the model when the top name is not a virtual model", () => {
    expect(() => expandMembers("missing", undefined)).toThrow(VirtualModelNotFoundError);
  });
});
