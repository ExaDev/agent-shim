import { describe, expect, it } from "vitest";

import { buildEntryFacts } from "../launcher/farm";
import { FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, createFakeFarmFs, shippedClassification } from "../test-helpers";
import { descendPolicyFor, resolveDecisions } from "./pipeline";
import type { CascadeInput } from "./walk";
import type { DescendPolicy } from "./walkPolicy";

/** A canonical tree deep enough for every case: nested skills, per-project history, a deep unrelated tree, a secret and a settings file. */
const TREE = {
  [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit",
  [`${FAKE_CLAUDE_HOME}/skills/commit/scripts/run.sh`]: "run",
  [`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md`]: "review",
  [`${FAKE_CLAUDE_HOME}/projects/-home-testuser-work/a.jsonl`]: "a",
  [`${FAKE_CLAUDE_HOME}/projects/-home-testuser-work/sub/b.jsonl`]: "b",
  [`${FAKE_CLAUDE_HOME}/projects/-home-testuser-other/c.jsonl`]: "c",
  [`${FAKE_CLAUDE_HOME}/plugins/cache/x/y/z/file.txt`]: "deep",
  [`${FAKE_CLAUDE_HOME}/jobs/one/two.json`]: "job",
  [`${FAKE_CLAUDE_HOME}/settings.json`]: "{}",
  [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "token",
} as const;

function cascade(entries: Record<string, boolean | { readonly value: boolean; readonly when: Record<string, unknown> }> = {}, categories: Readonly<Record<string, boolean>> = {}): CascadeInput {
  return { home: FAKE_HOME, loadProfile: () => undefined, levels: [], cliOverride: { categories, entries } };
}

function factsWith(input: CascadeInput, descend: DescendPolicy): ReturnType<typeof buildEntryFacts> {
  return buildEntryFacts({ fs: createFakeFarmFs(TREE), claudeHome: FAKE_CLAUDE_HOME, home: FAKE_HOME, cwd: `${FAKE_HOME}/work`, nowMs: FAKE_NOW_MS, env: {}, descend });
}

const CASES: readonly (readonly [string, CascadeInput])[] = [
  ["no rules", cascade()],
  ["a category toggle only", cascade({}, { history: false })],
  ["an exact rule two levels down", cascade({ "knowledge/skills/commit": false })],
  ["an exact rule three levels down", cascade({ "knowledge/skills/commit/scripts": true }, { knowledge: false })],
  ["a rule on a top-level directory", cascade({ "knowledge/skills": false })],
  ["a glob under projects", cascade({ "history/projects/-home-testuser-w*": false })],
  ["a glob with a wildcard segment in the middle", cascade({ "knowledge/skills/*/SKILL.md": false })],
  ["a leading wildcard", cascade({ "knowledge/**/SKILL.md": false })],
  ["a brace group containing a slash", cascade({ "knowledge/{skills/commit,skills/review}": false })],
  ["a rule beneath a rule", cascade({ "knowledge/skills": false, "knowledge/skills/commit": true })],
  ["a size condition", cascade({ "knowledge/skills/commit": { value: false, when: { maxSizeBytes: 1_000_000 } } })],
  ["an environment condition on a nested directory", cascade({ "knowledge/skills/commit": { value: false, when: { env: { SOME: "x" } } } })],
  ["an environment condition on a top-level directory", cascade({ "knowledge/skills": { value: false, when: { env: { SOME: "x" } } } })],
  ["a branch condition beside an unconditional rule", cascade({ "knowledge/skills": { value: false, when: { branch: "main" } }, "knowledge/skills/review": true })],
];

/**
 * A guard against a hang, not a bound on the work: the enumeration below resolves every combination of the rule pool twice and is CPU-bound, taking about a second on a quiet machine, but vitest's default five seconds is exceeded when the machine has far more runnable processes than cores, which a shared development machine routinely does.
 */
const EXHAUSTIVE_TIMEOUT_MS = 120_000;

describe("descendPolicy", () => {
  it.each(CASES)("resolves the same farm and the same decisions for top-level entries as the full walk: %s", (_name, input) => {
    const full = resolveDecisions({ facts: factsWith(input, () => true), cascade: input, classification: { defaults: shippedClassification } });
    const lazy = resolveDecisions({ facts: factsWith(input, descendPolicyFor(input, FAKE_HOME)), cascade: input, classification: { defaults: shippedClassification } });
    expect(lazy.farm).toEqual(full.farm);
    for (const name of ["skills", "projects", "plugins", "jobs", "settings.json", ".credentials.json"]) {
      // Compared through JSON: a decision carries its compiled rule, whose matcher function is a new instance on every run.
      expect(JSON.parse(JSON.stringify(lazy.decisions.get(name) ?? null))).toEqual(JSON.parse(JSON.stringify(full.decisions.get(name) ?? null)));
    }
  });

  it("resolves the same farm as the full walk for every combination of a pool of rules, conditional and glob forms included", () => {
    const pool: readonly (readonly [string, boolean | { readonly value: boolean; readonly when: Record<string, unknown> }])[] = [
      ["knowledge/skills", false],
      ["knowledge/skills/commit", true],
      ["knowledge/skills/commit/scripts", false],
      ["knowledge/skills/*/SKILL.md", false],
      ["history/projects/*", false],
      ["knowledge/**/run.sh", false],
      ["knowledge/skills/review", { value: false, when: { env: { SOME: "x" } } }],
      ["knowledge/skills/commit/scripts", { value: true, when: { branch: "main" } }],
    ];
    let compared = 0;
    for (let mask = 0; mask < 1 << pool.length; mask += 1) {
      const entries: Record<string, boolean | { readonly value: boolean; readonly when: Record<string, unknown> }> = {};
      pool.forEach(([key, value], index) => {
        if ((mask & (1 << index)) !== 0) {
          entries[key] = value;
        }
      });
      for (const categories of [{}, { knowledge: false }] as readonly Record<string, boolean>[]) {
        const input = cascade(entries, categories);
        const full = resolveDecisions({ facts: factsWith(input, () => true), cascade: input, classification: { defaults: shippedClassification } });
        const lazy = resolveDecisions({ facts: factsWith(input, descendPolicyFor(input, FAKE_HOME)), cascade: input, classification: { defaults: shippedClassification } });
        expect(lazy.farm, JSON.stringify({ entries, categories })).toEqual(full.farm);
        compared += 1;
      }
    }
    expect(compared).toBe(1 << (pool.length + 1));
  }, EXHAUSTIVE_TIMEOUT_MS);

  it("records only top-level entries when no rule reaches inside a directory", () => {
    const input = cascade();
    const facts = factsWith(input, descendPolicyFor(input, FAKE_HOME));
    expect([...facts.entries.keys()].sort()).toEqual([".credentials.json", "jobs", "plugins", "projects", "settings.json", "skills"]);
  });

  it("enters only the directories on the way to a rule's target", () => {
    const input = cascade({ "knowledge/skills/commit": false });
    const keys = [...factsWith(input, descendPolicyFor(input, FAKE_HOME)).entries.keys()];
    expect(keys).toContain("skills/commit");
    expect(keys).not.toContain("skills/commit/SKILL.md");
    expect(keys).not.toContain("plugins/cache");
    expect(keys).not.toContain("projects/-home-testuser-work");
  });

  it("enters every directory when a rule reads subtree aggregates, so the aggregates are complete", () => {
    const input = cascade({ "knowledge/skills/commit": { value: false, when: { maxSizeBytes: 1_000_000 } } });
    const facts = factsWith(input, descendPolicyFor(input, FAKE_HOME));
    expect(facts.entries.has("plugins/cache/x/y/z/file.txt")).toBe(true);
    expect(facts.entries.get("skills/commit")?.totalSizeBytes).toBeGreaterThan(facts.entries.get("skills/commit")?.sizeBytes ?? 0);
  });

  it("records the whole subtree of a conditional rule's directory, which the farm plans entry by entry, and nothing of unrelated directories", () => {
    const input = cascade({ "knowledge/skills/commit": { value: false, when: { env: { SOME: "x" } } } });
    const keys = [...factsWith(input, descendPolicyFor(input, FAKE_HOME)).entries.keys()];
    expect(keys).toContain("skills/commit/scripts/run.sh");
    expect(keys).not.toContain("plugins/cache");
  });

  it("does not walk below a directory a rule already covers whole", () => {
    const input = cascade({ "knowledge/skills": false });
    const keys = [...factsWith(input, descendPolicyFor(input, FAKE_HOME)).entries.keys()];
    expect(keys).not.toContain("skills/commit");
  });
});
