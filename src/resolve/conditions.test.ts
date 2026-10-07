import { describe, expect, it } from "vitest";
import type { PredicateNode } from "trilean";

import { DAY_MS, FAKE_NOW_MS, makeFacts } from "../test-helpers";
import { evaluateWhen, isDuration, matchBranch, parseDuration, type ConditionContext, type WhenEvaluation } from "./conditions";
import type { EntryFact } from "./types";

const baseContext: ConditionContext = { nowMs: FAKE_NOW_MS, env: {} };

/** Asserts the evaluation was definite and returns whether it passed, the read every pre-trilean case made. */
function definite(evaluation: WhenEvaluation): boolean {
  expect(evaluation.status).toBe("definite");
  return evaluation.status === "definite" && evaluation.passed;
}

const HALF_SECOND_MS = 500;
const FORTY_FIVE_SECONDS_MS = 45_000;
const THIRTY_MINUTES_MS = 1_800_000;
const TWELVE_HOURS_MS = 43_200_000;
const DAYS_PER_WEEK = 7;
const NINETY = 90;
const STALE_AGE = 200;

function fact(overrides: Partial<EntryFact>): EntryFact {
  return {
    relPath: "projects/-a-b",
    isDirectory: false,
    isSymlink: false,
    mtimeMs: FAKE_NOW_MS,
    latestMtimeMs: FAKE_NOW_MS,
    sizeBytes: 1,
    totalSizeBytes: 1,
    ...overrides,
  };
}

describe("parseDuration", () => {
  it.each([
    ["500ms", HALF_SECOND_MS],
    ["45s", FORTY_FIVE_SECONDS_MS],
    ["30m", THIRTY_MINUTES_MS],
    ["12h", TWELVE_HOURS_MS],
    ["90d", NINETY * DAY_MS],
    ["2w", 2 * DAYS_PER_WEEK * DAY_MS],
    ["0d", 0],
  ])("parses %s as %d ms", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it.each(["90", "d", "1.5d", "-1d", "90 d", "90days", ""])("throws on the malformed duration %s", (value) => {
    expect(() => parseDuration(value)).toThrow();
    expect(isDuration(value)).toBe(false);
  });
});

describe("matchBranch", () => {
  it("matches a glob pattern against the checked-out branch", () => {
    expect(matchBranch("client/*", "client/acme")).toBe(true);
    expect(matchBranch("client/*", "main")).toBe(false);
    expect(matchBranch("main", "main")).toBe(true);
  });

  it("never matches when the directory is not a repository", () => {
    expect(matchBranch("*", undefined)).toBe(false);
    expect(matchBranch("*", "")).toBe(false);
  });

  it("never matches on a detached HEAD, where there is no branch to compare", () => {
    expect(matchBranch("*", "main", true)).toBe(false);
  });
});

describe("evaluateWhen", () => {
  it("passes when there is no condition at all", () => {
    expect(definite(evaluateWhen(undefined, baseContext))).toBe(true);
  });

  it("passes vacuously on an empty condition object", () => {
    const result = evaluateWhen({}, baseContext);
    expect(result.status === "definite" && result.passed).toBe(true);
    expect(result.status === "definite" && result.checked).toEqual([]);
  });

  it("ANDs every present field within one object", () => {
    const context = { ...baseContext, branch: "client/acme", fact: fact({}) };
    expect(definite(evaluateWhen({ branch: "client/*", newerThan: "1d" }, context))).toBe(true);
    expect(definite(evaluateWhen({ branch: "other/*", newerThan: "1d" }, context))).toBe(false);
  });

  it("requires every named environment variable to equal its given value", () => {
    const context = { ...baseContext, env: { CI: "1", STAGE: "prod" } };
    expect(definite(evaluateWhen({ env: { CI: "1" } }, context))).toBe(true);
    expect(definite(evaluateWhen({ env: { CI: "1", STAGE: "prod" } }, context))).toBe(true);
    expect(definite(evaluateWhen({ env: { CI: "1", STAGE: "dev" } }, context))).toBe(false);
  });

  it("reports which fields it checked and which of those failed", () => {
    const result = evaluateWhen({ branch: "nope", env: { CI: "1" } }, { ...baseContext, branch: "main", env: { CI: "1" } });
    expect(result.status === "definite" && result.checked).toEqual(["branch", "env"]);
    expect(result.status === "definite" && result.failed).toEqual(["branch"]);
  });

  it("leaves a size or age condition indeterminate when there is no entry fact to read, naming what was missing", () => {
    const noFact = evaluateWhen({ newerThan: "1d" }, baseContext);
    expect(noFact.status).toBe("indeterminate");
    expect(noFact.status === "indeterminate" && noFact.reason).toContain("entry.latestMtimeMs");
    const noSize = evaluateWhen({ maxSizeBytes: 10 }, baseContext);
    expect(noSize.status).toBe("indeterminate");
  });

  it("leaves a named-but-unset environment variable indeterminate rather than failed", () => {
    const missing = evaluateWhen({ env: { MISSING: "x" } }, baseContext);
    expect(missing.status).toBe("indeterminate");
    expect(missing.status === "indeterminate" && missing.reason).toContain("env.MISSING");
  });

  it("evaluates the predicate form through the same facts: OR, NOT and a reference the context cannot answer", () => {
    // OR, which the object form could never express: a stale entry passes because its size is small.
    const either: PredicateNode = { kind: "anyOf", operands: [{ kind: "compare", op: "gte", left: { kind: "reference", key: "entry.latestMtimeMs" }, right: { kind: "numberLiteral", value: FAKE_NOW_MS - NINETY * DAY_MS } }, { kind: "compare", op: "lte", left: { kind: "reference", key: "entry.totalSizeBytes" }, right: { kind: "numberLiteral", value: 10 } }] };
    const staleTiny = { ...baseContext, fact: fact({ latestMtimeMs: FAKE_NOW_MS - STALE_AGE * DAY_MS, totalSizeBytes: 5 }) };
    const passed = evaluateWhen(either, staleTiny);
    expect(passed.status).toBe("definite");
    expect(passed.status === "definite" && passed.passed).toBe(true);
    expect(passed.status === "definite" && passed.checked).toEqual(["predicate"]);
    // NOT: the same entry fails under negation.
    const negated = { kind: "not", operand: either } satisfies PredicateNode;
    expect(definite(evaluateWhen(negated, staleTiny))).toBe(false);
    // A reference the context cannot answer is indeterminate, the tree's own missing-fact semantics (an `exists` node would instead answer definite false, which is its own contract).
    const missing = evaluateWhen({ kind: "textCompare", op: "equals", left: { kind: "reference", key: "env.NOWHERE" }, right: { kind: "textLiteral", value: "x" } }, baseContext);
    expect(missing.status).toBe("indeterminate");
  });
});

// Comfortably outside the 90-day window every newerThan/olderThan test below checks against.
const STALE_AGE_DAYS = 200;

describe("newerThan and olderThan", () => {
  const fresh = fact({ latestMtimeMs: FAKE_NOW_MS - 1 * DAY_MS });
  const stale = fact({ latestMtimeMs: FAKE_NOW_MS - STALE_AGE_DAYS * DAY_MS });

  it("includes a fresh entry and excludes a stale one under the same window", () => {
    expect(definite(evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: fresh }))).toBe(true);
    expect(definite(evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: stale }))).toBe(false);
  });

  it("inverts exactly, so olderThan and newerThan never both hold for the same entry and window", () => {
    for (const entry of [fresh, stale]) {
      const newer = definite(evaluateWhen({ newerThan: "90d" }, { ...baseContext, fact: entry }));
      const older = definite(evaluateWhen({ olderThan: "90d" }, { ...baseContext, fact: entry }));
      expect(newer).not.toBe(older);
    }
  });
});

// Well outside the 90-day newerThan window the "reads the subtree" tests check against -- the whole point of the test is that this ancient directory-own mtime must not be what evaluateWhen sees.
const ANCIENT_DIR_MTIME_AGE_DAYS = 400;

describe("directory-scoped conditions read the subtree, not the directory's own inode", () => {
  it("uses the subtree's most recent mtime for newerThan", () => {
    // The directory's own mtime is ancient; a file three levels down was written today. A naive stat of the directory itself would wrongly conclude the whole subtree is stale.
    const facts = makeFacts({
      "projects/-a-b": { dir: true, mtimeMs: FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS },
      "projects/-a-b/nested/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS, sizeBytes: 10 },
    });
    const directory = facts.entries.get("projects/-a-b");
    expect(directory?.mtimeMs).toBe(FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS);
    expect(directory?.latestMtimeMs).toBe(FAKE_NOW_MS - 1 * DAY_MS);
    expect(definite(evaluateWhen({ newerThan: "90d" }, { ...baseContext, ...(directory === undefined ? {} : { fact: directory }) }))).toBe(
      true,
    );
  });

  it("uses the subtree's recursive total size for maxSizeBytes", () => {
    const dirOwnSizeBytes = 4_096;
    const fileOneSizeBytes = 5_000;
    const fileTwoSizeBytes = 6_000;
    const facts = makeFacts({
      "projects/-a-b": { dir: true, sizeBytes: dirOwnSizeBytes },
      "projects/-a-b/one.jsonl": { sizeBytes: fileOneSizeBytes },
      "projects/-a-b/two.jsonl": { sizeBytes: fileTwoSizeBytes },
    });
    const directory = facts.entries.get("projects/-a-b");
    expect(directory?.sizeBytes).toBe(dirOwnSizeBytes);
    expect(directory?.totalSizeBytes).toBe(dirOwnSizeBytes + fileOneSizeBytes + fileTwoSizeBytes);
    const context = { ...baseContext, ...(directory === undefined ? {} : { fact: directory }) };
    expect(definite(evaluateWhen({ maxSizeBytes: 10_000 }, context))).toBe(false);
    expect(definite(evaluateWhen({ maxSizeBytes: 20_000 }, context))).toBe(true);
  });
});
