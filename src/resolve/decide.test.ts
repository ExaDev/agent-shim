import { describe, expect, it } from "vitest";

import { classifyEntries } from "../config/classify";
import type { CategoryName } from "../config/schema";
import { DAY_MS, FAKE_HOME, FAKE_NOW_MS, makeFacts, shippedClassification } from "../test-helpers";
import { resolveAll, resolveEntry, selectRule } from "./decide";
import { flattenLayers } from "./flatten";
import type { EntryFacts, Layer } from "./types";

function layer(id: number, overrides: Partial<Layer> = {}): Layer {
  return { id, kind: "config-profile", source: `layer-${String(id)}`, ...overrides };
}

function classificationFor(facts: EntryFacts): ReadonlyMap<string, CategoryName | null> {
  const names = new Set<string>();
  for (const rel of facts.entries.keys()) {
    const head = rel.split("/")[0];
    if (head !== undefined) {
      names.add(head);
    }
  }
  return classifyEntries([...names], { defaults: shippedClassification }).classification;
}

function decide(relPath: string, layers: readonly Layer[], facts: EntryFacts) {
  const flattened = flattenLayers(layers, { home: FAKE_HOME });
  return resolveEntry(relPath, { flattened, facts, classification: classificationFor(facts) });
}

describe("the secret floor", () => {
  const facts = makeFacts({
    ".credentials.json": true,
    "backups/2026-01-01.json": true,
    "skills/commit/SKILL.md": true,
  });

  it("refuses a secret path unconditionally, above the entries lookup rather than beneath it", () => {
    const result = decide(".credentials.json", [layer(0, { categories: { runtime: true, knowledge: true } })], facts);
    expect(result.decision.shared).toBe(false);
    expect(result.decision.via).toBe("secret-floor");
  });

  it("neutralises a glob written under a different prefix that happens to reach a secret path", () => {
    // The key is lexically a `runtime/...` key, so no compile-time check would catch it. Only the real classification of the path it matched does.
    const result = decide(".credentials.json", [layer(0, { entries: { "runtime/.credentials.json": true } })], facts);
    expect(result.decision.shared).toBe(false);
    expect(result.decision.via).toBe("secret-floor");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SECRET_PATH_NEUTRALISED");
  });

  it("neutralises a broad wildcard that sweeps up a secret path along with everything else", () => {
    const result = decide(".credentials.json", [layer(0, { entries: { "runtime/*": true } })], facts);
    expect(result.decision.shared).toBe(false);
    expect(result.decision.via).toBe("secret-floor");
  });

  it("never symlinks ~/.claude/backups under any configuration", () => {
    for (const layers of [
      [layer(0, { categories: { runtime: true, history: true, knowledge: true, settings: true } })],
      [layer(0, { entries: { "runtime/backups": true } })],
      [layer(0, { entries: { "knowledge/backups/2026-01-01.json": true } })],
    ]) {
      expect(decide("backups", layers, facts).decision.shared).toBe(false);
      expect(decide("backups/2026-01-01.json", layers, facts).decision.shared).toBe(false);
    }
  });
});

describe("unclassified entries", () => {
  const facts = makeFacts({ "brand-new-thing/file": true });

  it("excludes an entry nothing recognises and reports it rather than guessing", () => {
    const result = decide("brand-new-thing", [layer(0, { categories: { knowledge: true } })], facts);
    expect(result.decision.shared).toBe(false);
    expect(result.decision.via).toBe("unclassified");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UNCLASSIFIED_ENTRY");
  });
});

describe("entries beat categories", () => {
  const facts = makeFacts({ "skills/commit/SKILL.md": true, "skills/other/SKILL.md": true });

  it("lets a shallow layer's specific entry survive a later, deeper layer's blanket category flip", () => {
    const DEEPER_LAYER_ID = 3;
    const layers = [
      layer(0, { entries: { "knowledge/skills/commit": true } }),
      layer(DEEPER_LAYER_ID, { categories: { knowledge: false } }),
    ];
    expect(decide("skills/commit", layers, facts).decision.shared).toBe(true);
    expect(decide("skills/other", layers, facts).decision.shared).toBe(false);
  });

  it("falls back to a category override only when no entries rule matches", () => {
    const result = decide("skills/other", [layer(0, { categories: { knowledge: false } })], facts);
    expect(result.decision.via).toBe("category-override");
    expect(result.decision.shared).toBe(false);
  });

  it("falls back to the shipped default when no layer touched the category at all", () => {
    const result = decide("skills/other", [], facts);
    expect(result.decision.via).toBe("category-default");
    expect(result.decision.shared).toBe(true);
  });
});

describe("the corrected comparator in practice", () => {
  const facts = makeFacts({ "skills/commit/SKILL.md": true });

  it("lets a later personal glob beat an earlier committed exact key, closing the trust hole", () => {
    const layers: Layer[] = [
      { id: 1, kind: "portable" as const, source: "committed .agent-shim.json", entries: { "knowledge/skills/commit": true } },
      { id: 2, kind: "directory-rule" as const, source: "personal rules", entries: { "knowledge/skills/*": false } },
    ];
    const result = decide("skills/commit", layers, facts);
    expect(result.decision.shared).toBe(false);
    expect(result.decision.rule?.layer).toBe(2);
  });

  it("surfaces that interaction as a diagnostic rather than resolving it silently", () => {
    const layers: Layer[] = [
      { id: 1, kind: "portable" as const, source: "committed", entries: { "knowledge/skills/commit": true } },
      { id: 2, kind: "directory-rule" as const, source: "personal", entries: { "knowledge/skills/*": false } },
    ];
    const codes = decide("skills/commit", layers, facts).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("EXACT_ENTRY_OVERRIDDEN_BY_LATER_GLOB");
  });

  it("raises no such diagnostic when the earlier exact key and the later glob agree anyway", () => {
    const layers: Layer[] = [
      { id: 1, kind: "portable" as const, source: "committed", entries: { "knowledge/skills/commit": false } },
      { id: 2, kind: "directory-rule" as const, source: "personal", entries: { "knowledge/skills/*": false } },
    ];
    const codes = decide("skills/commit", layers, facts).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).not.toContain("EXACT_ENTRY_OVERRIDDEN_BY_LATER_GLOB");
  });

  it("still lets an exact key beat a glob within one layer", () => {
    const layers = [layer(0, { entries: { "knowledge/skills/*": false, "knowledge/skills/commit": true } })];
    expect(decide("skills/commit", layers, facts).decision.shared).toBe(true);
  });
});

// Comfortably outside the 90-day-scale windows this describe block's conditions check against.
const STALE_AGE_DAYS = 200;

describe("failing conditions", () => {
  const facts = makeFacts({
    "projects/-home-testuser-work-acme/session.jsonl": { mtimeMs: FAKE_NOW_MS - STALE_AGE_DAYS * DAY_MS, sizeBytes: 10 },
    "projects/-home-testuser-work-fresh/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS, sizeBytes: 10 },
  });

  it("eliminates the more-specific rule and falls through to the next-most-specific matching rule, not to the category", () => {
    // The stale project fails the 90d window on the specific rule; the broader rule (which has no condition) must then decide it — confirmed via `result.decision.via` below, since a wrongful fall-through to the `history` category default wouldn't necessarily disagree with the correct answer by boolean value alone.
    const layers = [
      layer(0, {
        entries: {
          "history/projects/~/work/*": true,
          "history/projects/~/work/acme": { value: false, when: { newerThan: "90d" } },
        },
      }),
    ];
    const result = decide("projects/-home-testuser-work-acme", layers, facts);
    expect(result.decision.via).toBe("entry-rule");
    expect(result.decision.rule?.canonicalPattern).toBe("projects/-home-testuser-work-*");
    expect(result.decision.shared).toBe(true);
    expect(result.decision.eliminated?.[0]?.rule.canonicalPattern).toBe("projects/-home-testuser-work-acme");
  });

  it("never inverts the eliminated rule's own boolean value", () => {
    const layers = [layer(0, { entries: { "history/projects/~/work/acme": { value: true, when: { newerThan: "90d" } } } })];
    const result = decide("projects/-home-testuser-work-acme", layers, facts);
    expect(result.decision.via).toBe("category-default");
    expect(result.decision.shared).toBe(true);
  });

  it("applies the same rule where its condition does hold", () => {
    const layers = [layer(0, { entries: { "history/projects/~/work/*": { value: true, when: { newerThan: "90d" } } } })];
    expect(decide("projects/-home-testuser-work-fresh", layers, facts).decision.shared).toBe(true);
    const eliminated = decide("projects/-home-testuser-work-acme", layers, facts);
    expect(eliminated.decision.via).toBe("category-default");
    expect(eliminated.decision.shared).toBe(true);
  });

  it("evaluates a branch condition against the injected branch, never a real repository", () => {
    const onBranch = makeFacts({ "skills/commit/SKILL.md": true }, { branch: "client/acme" });
    const offBranch = makeFacts({ "skills/commit/SKILL.md": true }, { branch: "main" });
    const layers = [layer(0, { entries: { "knowledge/skills/commit": { value: false, when: { branch: "client/*" } } } })];
    expect(decide("skills/commit", layers, onBranch).decision.shared).toBe(false);
    expect(decide("skills/commit", layers, offBranch).decision.shared).toBe(true);
  });

  it("evaluates an env condition against the injected environment snapshot", () => {
    const withVar = makeFacts({ "skills/commit/SKILL.md": true }, { env: { AGENT_SHIM_TEST: "on" } });
    const withoutVar = makeFacts({ "skills/commit/SKILL.md": true }, { env: {} });
    const layers = [
      layer(0, { entries: { "knowledge/skills/commit": { value: false, when: { env: { AGENT_SHIM_TEST: "on" } } } } }),
    ];
    expect(decide("skills/commit", layers, withVar).decision.shared).toBe(false);
    expect(decide("skills/commit", layers, withoutVar).decision.shared).toBe(true);
  });
});

describe("selectRule", () => {
  it("returns no rule and the full elimination list when every candidate's condition fails", () => {
    const ANCIENT_AGE_DAYS = 400;
    const facts = makeFacts({ "skills/commit/SKILL.md": { mtimeMs: FAKE_NOW_MS - ANCIENT_AGE_DAYS * DAY_MS } });
    const flattened = flattenLayers(
      [layer(0, { entries: { "knowledge/skills/*": { value: true, when: { newerThan: "1d" } } } })],
      { home: FAKE_HOME },
    );
    const selection = selectRule("skills/commit", flattened, {
      nowMs: facts.nowMs,
      env: {},
      ...(facts.entries.get("skills/commit") === undefined ? {} : { fact: facts.entries.get("skills/commit") }),
    });
    expect(selection.rule).toBeUndefined();
    expect(selection.eliminated).toHaveLength(1);
    expect(selection.eliminated[0]?.failed).toEqual(["newerThan"]);
  });
});

describe("category prefix cross-check", () => {
  it("warns when a key's declared category disagrees with the real classification of the path it matched", () => {
    const facts = makeFacts({ "skills/commit/SKILL.md": true });
    const result = decide("skills/commit", [layer(0, { entries: { "runtime/skills/commit": true } })], facts);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("CATEGORY_PREFIX_MISMATCH");
    expect(result.decision.shared).toBe(true);
  });
});

describe("resolveAll", () => {
  it("decides every entry in the fact manifest and carries phase-one diagnostics through", () => {
    const facts = makeFacts({ "skills/commit/SKILL.md": true, ".credentials.json": true });
    const flattened = flattenLayers([layer(0, { entries: { "secret/.credentials.json": true } })], { home: FAKE_HOME });
    const result = resolveAll({ flattened, facts, classification: classificationFor(facts) });
    expect([...result.decisions.keys()].sort()).toEqual([".credentials.json", "skills", "skills/commit", "skills/commit/SKILL.md"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SECRET_ENTRY_KEY");
  });

  it("de-duplicates a diagnostic that would otherwise repeat once per file beneath one unclassified entry", () => {
    const facts = makeFacts({ "mystery/a": true, "mystery/b": true, "mystery/c/d": true });
    const flattened = flattenLayers([], { home: FAKE_HOME });
    const result = resolveAll({ flattened, facts, classification: classificationFor(facts) });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "UNCLASSIFIED_ENTRY")).toHaveLength(1);
  });
});
