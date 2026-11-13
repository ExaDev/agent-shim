import { describe, expect, it } from "vitest";

import { classifyEntries } from "../config/classify";
import type { CategoryName } from "../config/schema";
import { DAY_MS, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, makeFacts, shippedClassification } from "../test-helpers";
import { resolveAll } from "./decide";
import { flattenLayers } from "./flatten";
import { buildChildIndex, planFarm, type FarmPlan } from "./plan";
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

function plan(layers: readonly Layer[], facts: EntryFacts): FarmPlan {
  const flattened = flattenLayers(layers, { home: FAKE_HOME });
  const { decisions } = resolveAll({ flattened, facts, classification: classificationFor(facts) });
  return planFarm({ facts, decisions, flattened });
}

function kindOf(farmPlan: FarmPlan, rel: string): string | undefined {
  return farmPlan.entries.find((entry) => entry.rel === rel)?.kind;
}

describe("uniform subtrees", () => {
  const facts = makeFacts({
    "skills/commit/SKILL.md": true,
    "skills/other/SKILL.md": true,
    "shell-snapshots/snap.sh": true,
  });

  it("collapses a wholly-shared directory into one symlink rather than exploding it", () => {
    const farmPlan = plan([], facts);
    expect(kindOf(farmPlan, "skills")).toBe("link");
    expect(farmPlan.entries.some((entry) => entry.rel.startsWith("skills/"))).toBe(false);
  });

  it("omits a wholly-unshared directory entirely", () => {
    const farmPlan = plan([], facts);
    expect(kindOf(farmPlan, "shell-snapshots")).toBe("omit");
  });

  it("points every symlink at the canonical path under claudeHome", () => {
    const farmPlan = plan([], facts);
    expect(farmPlan.links).toContainEqual({ rel: "skills", target: `${FAKE_CLAUDE_HOME}/skills` });
  });
});

describe("symlinked entries", () => {
  it("leaves out a shared entry whose symlink reaches nothing and names it, but links one that leads somewhere", () => {
    const facts = makeFacts({
      sessions: { symlink: true, dangling: true },
      "history.jsonl": { symlink: true },
      "skills/commit/SKILL.md": true,
    });
    const farmPlan = plan([], facts);
    expect(kindOf(farmPlan, "sessions")).toBe("omit");
    expect(farmPlan.dangling).toEqual(["sessions"]);
    expect(farmPlan.links.map((link) => link.rel)).toEqual(["history.jsonl", "skills"]);
  });

  it("does not name a dangling entry that is not shared", () => {
    const farmPlan = plan([layer(1, { categories: { history: false } })], makeFacts({ sessions: { symlink: true, dangling: true } }));
    expect(kindOf(farmPlan, "sessions")).toBe("omit");
    expect(farmPlan.dangling).toEqual([]);
  });
});

describe("split subtrees", () => {
  const facts = makeFacts({ "skills/commit/SKILL.md": true, "skills/other/SKILL.md": true });

  it("materialises only the directories whose decision genuinely splits, and recurses into them", () => {
    const farmPlan = plan([layer(0, { categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } })], facts);
    expect(kindOf(farmPlan, "skills")).toBe("materialise");
    expect(kindOf(farmPlan, "skills/commit")).toBe("link");
    expect(kindOf(farmPlan, "skills/other")).toBe("omit");
    expect(farmPlan.materialised).toEqual(["skills"]);
  });

  it("records split-decision as the reason, distinct from a conditional rule", () => {
    const farmPlan = plan([layer(0, { categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } })], facts);
    const entry = farmPlan.entries.find((candidate) => candidate.rel === "skills");
    expect(entry?.kind === "materialise" ? entry.reason : undefined).toBe("split-decision");
  });

  it("does not explode a directory whose subtree agrees, even when a sibling splits", () => {
    const richer = makeFacts({
      "skills/commit/SKILL.md": true,
      "skills/other/SKILL.md": true,
      "agents/a.md": true,
    });
    const farmPlan = plan([layer(0, { categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } })], richer);
    expect(kindOf(farmPlan, "agents")).toBe("omit");
    expect(farmPlan.entries.some((entry) => entry.rel.startsWith("agents/"))).toBe(false);
  });
});

describe("conditional rules force materialisation", () => {
  it("materialises a directory a conditional rule could reach even when today's decision is uniform", () => {
    // Every project directory currently satisfies the 90d window, so a naive "is the decision uniform right now" check would happily collapse `projects` to one symlink. That symlink would then freeze the decision for every session file Claude Code writes after this resync, so the condition would never apply to genuinely new data — the bug only ever shows up for files that do not exist yet.
    const facts = makeFacts({
      "projects/-home-testuser-work-a/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS },
      "projects/-home-testuser-work-b/session.jsonl": { mtimeMs: FAKE_NOW_MS - 2 * DAY_MS },
    });
    const layers = [layer(0, { entries: { "history/projects/~/work/*": { value: true, when: { newerThan: "90d" } } } })];
    const farmPlan = plan(layers, facts);

    const uniform = [...facts.entries.keys()]
      .filter((rel) => rel.startsWith("projects/"))
      .every((rel) => farmPlan.entries.find((entry) => entry.rel === rel)?.kind !== "omit");
    expect(uniform).toBe(true);

    const entry = farmPlan.entries.find((candidate) => candidate.rel === "projects");
    expect(entry?.kind).toBe("materialise");
    expect(entry?.kind === "materialise" ? entry.reason : undefined).toBe("conditional-rule");
  });

  it("collapses the same directory back into a plain symlink once the condition that split it is removed", () => {
    // The reverse direction matters as much as the forward one: a directory materialised because of a condition must not be left behind as permanent local scaffolding once that condition is edited away.
    const facts = makeFacts({
      "projects/-home-testuser-work-a/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS },
      "projects/-home-testuser-work-b/session.jsonl": { mtimeMs: FAKE_NOW_MS - 2 * DAY_MS },
    });
    const conditional = plan([layer(0, { entries: { "history/projects": { value: true, when: { newerThan: "90d" } } } })], facts);
    expect(kindOf(conditional, "projects")).toBe("materialise");

    const unconditional = plan([layer(0, { entries: { "history/projects": true } })], facts);
    expect(kindOf(unconditional, "projects")).toBe("link");
    expect(unconditional.materialised).toEqual([]);
  });

  it("materialises a directory whose own decision differs from its children's, since one symlink cannot express both", () => {
    // `projects` itself is shared (the `history` default), while two project directories under it are explicitly closed. Linking the whole directory would share every project directory it will ever contain, including ones written after this resync, so those two exclusions could never take effect.
    const facts = makeFacts({
      "projects/-home-testuser-work-a/session.jsonl": true,
      "projects/-home-testuser-work-b/session.jsonl": true,
    });
    const farmPlan = plan([layer(0, { entries: { "history/projects/~/work/*": false } })], facts);
    expect(kindOf(farmPlan, "projects")).toBe("materialise");
    expect(kindOf(farmPlan, "projects/-home-testuser-work-a")).toBe("omit");
  });

  it("materialises even when the conditional rule's condition currently fails everywhere", () => {
    // Well outside the 90-day newerThan window the rule checks against.
    const ancientAgeDays = 400;
    const facts = makeFacts({
      "projects/-home-testuser-work-a/session.jsonl": { mtimeMs: FAKE_NOW_MS - ancientAgeDays * DAY_MS },
    });
    const layers = [layer(0, { entries: { "history/projects/~/work/*": { value: true, when: { newerThan: "90d" } } } })];
    expect(kindOf(plan(layers, facts), "projects")).toBe("materialise");
  });
});

describe("symlink targets", () => {
  it("links a materialised directory's child that is itself a relative symlink escaping ~/.claude at its canonical path", () => {
    // `skills/act -> ../../.agents/skills/act` is a real shape inside a real ~/.claude. Copying that relative target verbatim would resolve somewhere else entirely from the farm's own depth, and copying the resolved absolute target would pin the farm to wherever the link happened to point at resync time.
    const facts = makeFacts({
      "skills/act": { dir: true, symlink: true },
      "skills/commit/SKILL.md": true,
    });
    const layers = [layer(0, { categories: { knowledge: false }, entries: { "knowledge/skills/act": true } })];
    const farmPlan = plan(layers, facts);
    expect(kindOf(farmPlan, "skills")).toBe("materialise");
    expect(farmPlan.links).toContainEqual({ rel: "skills/act", target: `${FAKE_CLAUDE_HOME}/skills/act` });
    expect(farmPlan.links.every((link) => link.target.startsWith(FAKE_CLAUDE_HOME))).toBe(true);
    expect(farmPlan.links.every((link) => !link.target.includes(".."))).toBe(true);
  });

  it("treats a top-level symlinked directory no differently from a real one", () => {
    const facts = makeFacts({ rules: { dir: true, symlink: true } });
    expect(plan([], facts).links).toContainEqual({ rel: "rules", target: `${FAKE_CLAUDE_HOME}/rules` });
  });
});

describe("buildChildIndex", () => {
  it("indexes every entry under its parent, with top-level entries under the empty key", () => {
    const facts = makeFacts({ "skills/commit/SKILL.md": true, "todos/a.json": true });
    const index = buildChildIndex(facts);
    expect(index.get("")).toEqual(["skills", "todos"]);
    expect(index.get("skills")).toEqual(["skills/commit"]);
    expect(index.get("skills/commit")).toEqual(["skills/commit/SKILL.md"]);
  });
});

describe("plan ordering", () => {
  it("emits parents before their children so a builder can create directories in order", () => {
    const facts = makeFacts({ "skills/commit/SKILL.md": true, "skills/other/SKILL.md": true });
    const farmPlan = plan([layer(0, { categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } })], facts);
    const positions = farmPlan.entries.map((entry) => entry.rel);
    expect(positions.indexOf("skills")).toBeLessThan(positions.indexOf("skills/commit"));
  });
});
