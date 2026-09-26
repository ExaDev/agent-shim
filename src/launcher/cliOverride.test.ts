import { describe, expect, it } from "vitest";

import { buildCliOverride, InvalidCliCategoryError, InvalidCliEntryKeyError } from "./cliOverride";

const noFlags = { categoryFlags: [], shareFlags: [], hideFlags: [] };

describe("buildCliOverride", () => {
  it("returns undefined when nothing at all was supplied", () => {
    expect(buildCliOverride({ env: {}, ...noFlags })).toBeUndefined();
  });

  it("carries a --provider flag as the cliOverride layer's own launch selection", () => {
    const result = buildCliOverride({ env: {}, ...noFlags, providerFlag: "z" });
    expect(result?.launch).toEqual({ provider: "z" });
    expect(result?.categories).toBeUndefined();
    expect(result?.entries).toBeUndefined();
  });

  it("treats an empty --provider value as not supplied", () => {
    expect(buildCliOverride({ env: {}, ...noFlags, providerFlag: "" })).toBeUndefined();
  });

  it("builds a categories map from a single --category flag", () => {
    const result = buildCliOverride({ env: {}, ...noFlags, categoryFlags: ["history=true,knowledge=false"] });
    expect(result?.categories).toEqual({ history: true, knowledge: false });
    expect(result?.entries).toBeUndefined();
  });

  it("merges CLAUDE_USE_CATEGORY_OVERRIDE as a base with --category flags winning on key collision", () => {
    const result = buildCliOverride({
      env: { CLAUDE_USE_CATEGORY_OVERRIDE: "history=false,knowledge=true" },
      ...noFlags,
      categoryFlags: ["history=true"],
    });
    expect(result?.categories).toEqual({ history: true, knowledge: true });
  });

  it("rejects a category the schema does not allow to be toggled", () => {
    expect(() => buildCliOverride({ env: {}, ...noFlags, categoryFlags: ["secret=true"] })).toThrow(InvalidCliCategoryError);
  });

  it("rejects an unknown category name", () => {
    expect(() => buildCliOverride({ env: {}, ...noFlags, categoryFlags: ["nonsense=true"] })).toThrow(InvalidCliCategoryError);
  });

  it("expands all=true into every overridable category via --category", () => {
    const result = buildCliOverride({ env: {}, ...noFlags, categoryFlags: ["all=true"] });
    expect(result?.categories).toEqual({ runtime: true, history: true, knowledge: true, settings: true });
  });

  it("lets an explicit --category value narrow what all=true opened", () => {
    const result = buildCliOverride({ env: {}, ...noFlags, categoryFlags: ["all=true,runtime=false"] });
    expect(result?.categories).toEqual({ runtime: false, history: true, knowledge: true, settings: true });
  });

  it("expands all=true from CLAUDE_USE_CATEGORY_OVERRIDE the same way as --category", () => {
    const result = buildCliOverride({ env: { CLAUDE_USE_CATEGORY_OVERRIDE: "all=true" }, ...noFlags });
    expect(result?.categories).toEqual({ runtime: true, history: true, knowledge: true, settings: true });
  });

  it("turns --share into true-valued entries and --hide into false-valued entries", () => {
    const result = buildCliOverride({
      env: {},
      ...noFlags,
      shareFlags: ["knowledge/skills/commit"],
      hideFlags: ["history/projects/x"],
    });
    expect(result?.entries).toEqual({ "knowledge/skills/commit": true, "history/projects/x": false });
    expect(result?.categories).toBeUndefined();
  });

  it("splits a comma-separated --share value into multiple entries", () => {
    const result = buildCliOverride({ env: {}, ...noFlags, shareFlags: ["knowledge/skills/a,knowledge/skills/b"] });
    expect(result?.entries).toEqual({ "knowledge/skills/a": true, "knowledge/skills/b": true });
  });

  it("merges CLAUDE_USE_ENTRY_OVERRIDE as a base with --share/--hide winning on key collision", () => {
    const result = buildCliOverride({
      env: { CLAUDE_USE_ENTRY_OVERRIDE: "knowledge/skills/commit=false" },
      ...noFlags,
      shareFlags: ["knowledge/skills/commit"],
    });
    expect(result?.entries).toEqual({ "knowledge/skills/commit": true });
  });

  it("rejects an entry key with no category prefix", () => {
    expect(() => buildCliOverride({ env: {}, ...noFlags, shareFlags: ["skills/commit"] })).toThrow(InvalidCliEntryKeyError);
  });

  it("combines a categories override and an entries override in one result", () => {
    const result = buildCliOverride({
      env: {},
      ...noFlags,
      categoryFlags: ["history=true"],
      shareFlags: ["knowledge/skills/commit"],
    });
    expect(result).toEqual({ categories: { history: true }, entries: { "knowledge/skills/commit": true } });
  });
});
