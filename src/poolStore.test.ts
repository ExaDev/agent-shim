import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UsageError } from "./cliError";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { addPool, changePool, isPoolChange, PoolNotFoundError, poolPolicyOf, readPools } from "./poolStore";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-pool-store-"));
  paths = buildLayoutPaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("poolPolicyOf", () => {
  it("keeps the fields a policy sets and leaves out the undefined ones", () => {
    expect(poolPolicyOf({ preference: "listed" })).toEqual({ preference: "listed" });
    expect(poolPolicyOf({ preference: undefined })).toEqual({});
    expect(Object.keys(poolPolicyOf({ preference: undefined }))).toEqual([]);
  });

  it("keeps resumeOnLimit only when it is on, since a switch that is off is the same as an absent one", () => {
    expect(poolPolicyOf({ resumeOnLimit: true })).toEqual({ resumeOnLimit: true });
    expect(poolPolicyOf({ resumeOnLimit: false })).toEqual({});
  });

  it("returns only the policy of a whole pool, without its members", () => {
    expect(poolPolicyOf({ identities: ["a"], preference: "score" } as Parameters<typeof poolPolicyOf>[0])).toEqual({ preference: "score" });
  });
});

describe("isPoolChange", () => {
  it("is true when members or a policy field are named, false when nothing is", () => {
    expect(isPoolChange({})).toBe(false);
    expect(isPoolChange({ identities: undefined, preference: undefined })).toBe(false);
    expect(isPoolChange({ identities: ["a"] })).toBe(true);
    expect(isPoolChange({ preference: "listed" })).toBe(true);
    expect(isPoolChange({ preference: false })).toBe(true);
    expect(isPoolChange({ resumeOnLimit: false })).toBe(true);
  });
});

describe("addPool and changePool", () => {
  it("stores a policy on add and writes only what the pool sets", () => {
    addPool(paths, "subs", ["work"], { preference: "listed" });
    addPool(paths, "plain", ["work"]);
    expect(readPools(paths)).toEqual({ subs: { identities: ["work"], preference: "listed" }, plain: { identities: ["work"] } });
  });

  it("keeps the members when only the policy changes, and the policy when only the members change", () => {
    addPool(paths, "subs", ["work", "personal"], { preference: "listed" });
    expect(changePool(paths, "subs", { preference: "score" })).toEqual({ identities: ["work", "personal"], preference: "score" });
    expect(changePool(paths, "subs", { identities: ["work"] })).toEqual({ identities: ["work"], preference: "score" });
  });

  it("clears a policy field with false and leaves it alone with undefined", () => {
    addPool(paths, "subs", ["work"], { preference: "listed" });
    expect(changePool(paths, "subs", { preference: undefined })).toEqual({ identities: ["work"], preference: "listed" });
    expect(changePool(paths, "subs", { preference: false })).toEqual({ identities: ["work"] });
    expect(readPools(paths).subs).toEqual({ identities: ["work"] });
  });

  it("switches resuming on a spent quota on and off, and keeps it when it is not mentioned", () => {
    addPool(paths, "subs", ["work"], { resumeOnLimit: true });
    expect(readPools(paths).subs).toEqual({ identities: ["work"], resumeOnLimit: true });
    expect(changePool(paths, "subs", { preference: "listed" })).toEqual({ identities: ["work"], preference: "listed", resumeOnLimit: true });
    expect(changePool(paths, "subs", { resumeOnLimit: false })).toEqual({ identities: ["work"], preference: "listed" });
    expect(changePool(paths, "subs", { resumeOnLimit: true })).toEqual({ identities: ["work"], preference: "listed", resumeOnLimit: true });
  });

  it("keeps a member's condition when the members are not restated", () => {
    addPool(paths, "subs", ["work", { identity: "personal", when: { branch: "main" } }]);
    changePool(paths, "subs", { preference: "listed" });
    expect(readPools(paths).subs).toEqual({ identities: ["work", { identity: "personal", when: { branch: "main" } }], preference: "listed" });
  });

  it("refuses an unknown pool, a nested pool that is not defined and a cycle, and writes nothing for them", () => {
    expect(() => changePool(paths, "ghost", { preference: "listed" })).toThrow(PoolNotFoundError);
    addPool(paths, "inner", ["work"]);
    addPool(paths, "outer", ["pool:inner"]);
    expect(() => changePool(paths, "outer", { identities: ["pool:missing"] })).toThrow(UsageError);
    expect(() => changePool(paths, "inner", { identities: ["pool:outer"] })).toThrow(/reach itself/);
    expect(readPools(paths)).toEqual({ inner: { identities: ["work"] }, outer: { identities: ["pool:inner"] } });
  });
});
