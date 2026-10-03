import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import categoriesDefaultJson from "./categories.default.json";
import { classifyEntries, compileClassificationPatterns, isExactPattern, loadClassification } from "./classify";
import { CategoryClassificationSchema } from "./schema";
import { buildLayoutPaths, type LayoutPaths } from "../paths";

const defaults = CategoryClassificationSchema.parse(categoriesDefaultJson);

describe("classifyEntries against the shipped map", () => {
  it.each([
    [".credentials.json", "secret"],
    ["backups", "secret"],
    ["projects", "history"],
    ["todos", "history"],
    ["skills", "knowledge"],
    ["CLAUDE.md", "knowledge"],
    ["settings.json", "settings"],
    ["settings.local.json", "settings"],
    ["shell-snapshots", "runtime"],
    ["ide", "runtime"],
    ["codex-quota.json", "runtime"],
    ["file-transfers", "runtime"],
    ["settings.json.bak-20260930103659", "secret"],
    ["settings.json.bak.20260529-214321", "secret"],
  ])("classifies %s as %s", (name, category) => {
    expect(classifyEntries([name], { defaults }).classification.get(name)).toBe(category);
  });

  it("matches a glob pattern such as daemon* and .git*", () => {
    const result = classifyEntries(["daemon.log", "daemon", ".gitignore"], { defaults });
    expect(result.classification.get("daemon.log")).toBe("runtime");
    expect(result.classification.get("daemon")).toBe("runtime");
    expect(result.classification.get(".gitignore")).toBe("runtime");
  });

  it("reports an unrecognised entry as null rather than guessing a category", () => {
    const result = classifyEntries(["some-brand-new-thing"], { defaults });
    expect(result.classification.get("some-brand-new-thing")).toBeNull();
    expect(result.unclassified).toEqual(["some-brand-new-thing"]);
  });

  it("matches case-sensitively regardless of the host filesystem's own case behaviour", () => {
    const result = classifyEntries(["Skills", "skills"], { defaults });
    expect(result.classification.get("skills")).toBe("knowledge");
    expect(result.classification.get("Skills")).toBeNull();
  });
});

describe("classification precedence", () => {
  it("lets an exact literal beat a glob", () => {
    const result = classifyEntries(["daemon-notes"], {
      defaults: { ...defaults, knowledge: [...defaults.knowledge, "daemon-notes"] },
    });
    expect(result.classification.get("daemon-notes")).toBe("knowledge");
    expect(result.decidedBy.get("daemon-notes")?.pattern).toBe("daemon-notes");
  });

  it("lets a local overlay entry beat a shipped default of equal exactness", () => {
    const result = classifyEntries(["projects"], { defaults, overlay: { knowledge: ["projects"] } });
    expect(result.classification.get("projects")).toBe("knowledge");
    expect(result.decidedBy.get("projects")?.source).toBe("local");
  });

  it("never lets a broad local glob reclassify a path the shipped map names exactly", () => {
    // The safe direction: a local `*` answer must not be able to pull `.credentials.json` out of `secret`.
    const result = classifyEntries([".credentials.json"], { defaults, overlay: { knowledge: ["*"] } });
    expect(result.classification.get(".credentials.json")).toBe("secret");
  });

  it("still lets a local exact answer win over a shipped glob", () => {
    const result = classifyEntries(["daemon-archive"], { defaults, overlay: { history: ["daemon-archive"] } });
    expect(result.classification.get("daemon-archive")).toBe("history");
  });

  it("is deterministic when two equally-ranked patterns both match", () => {
    const overlay = { history: ["ambiguous"], knowledge: ["ambiguous"] };
    const first = classifyEntries(["ambiguous"], { defaults, overlay });
    const second = classifyEntries(["ambiguous"], { defaults, overlay });
    expect(first.classification.get("ambiguous")).toBe(second.classification.get("ambiguous"));
    // Later ordinal wins, and `knowledge` is compiled after `history`.
    expect(first.classification.get("ambiguous")).toBe("knowledge");
  });
});

describe("isExactPattern", () => {
  it.each(["skills", "settings.json", ".credentials.json"])("treats %s as exact", (pattern) => {
    expect(isExactPattern(pattern)).toBe(true);
  });

  it.each(["daemon*", ".git*", "a?b", "a[bc]", "{a,b}"])("treats %s as a glob", (pattern) => {
    expect(isExactPattern(pattern)).toBe(false);
  });
});

describe("compileClassificationPatterns", () => {
  it("compiles every shipped pattern plus every overlay pattern with distinct ordinals", () => {
    const compiled = compileClassificationPatterns(defaults, { knowledge: ["extra"] });
    const ordinals = compiled.map((pattern) => pattern.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(compiled.some((pattern) => pattern.pattern === "extra" && pattern.source === "local")).toBe(true);
  });
});

describe("loadClassification", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the shipped defaults with no overlay when categories.local.json does not exist", () => {
    const loaded = loadClassification(paths);
    expect(loaded.defaults).toEqual(defaults);
    expect(loaded.overlay).toBeUndefined();
  });

  it("includes the local overlay once one has been written", () => {
    fs.mkdirSync(path.dirname(paths.categoriesLocalFile), { recursive: true });
    fs.writeFileSync(paths.categoriesLocalFile, JSON.stringify({ knowledge: ["a-user-answered-this"] }), "utf8");

    const loaded = loadClassification(paths);
    expect(loaded.overlay).toEqual({ knowledge: ["a-user-answered-this"] });
    expect(classifyEntries(["a-user-answered-this"], loaded).classification.get("a-user-answered-this")).toBe("knowledge");
  });
});
