import { describe, expect, it } from "vitest";

import { caseSources, deletedProblems, guardProblems, listedCounts, parseTable, relativeFile, testId, unstableIds, unstableProblems, type Accounting, type Row } from "./keptTests";

const ROOT = "/repo";
const row = (file: string, test: string): Row => ({ file, test, reason: "not a function of its inputs" });
const listing = (...entries: readonly [string, string][]) => listedCounts(entries.map(([file, name]) => ({ file: `${ROOT}/${file}`, name })), ROOT);
const accounting = (changes: Partial<Accounting> = {}): Accounting => ({ sources: new Set(), sourceFiles: new Set(), kept: [], dropped: [], ...changes });

const README = `# Corpus

## Kept tests

Prose about the table.

| file | test | reason |
| --- | --- | --- |
| paths.test.ts | resolveAgentShimHome > reads the environment | reads the environment |
| config/names.test.ts | a > b \\| c | a pipe in a title |

## Dropped tests

| file | test | reason |
| --- | --- | --- |
`;

describe("parseTable", () => {
  it("reads the rows under a heading, with an escaped pipe in a title, and an empty table", () => {
    expect(parseTable(README, "Kept tests")).toEqual([
      { file: "paths.test.ts", test: "resolveAgentShimHome > reads the environment", reason: "reads the environment" },
      { file: "config/names.test.ts", test: "a > b | c", reason: "a pipe in a title" },
    ]);
    expect(parseTable(README, "Dropped tests")).toEqual([]);
  });

  it("refuses a missing section, a wrong header, a missing separator and a row that is not three cells", () => {
    expect(() => parseTable(README, "Other")).toThrow(/no "## Other" section/u);
    expect(() => parseTable("## T\n\n| file | title | reason |\n| --- | --- | --- |\n", "T")).toThrow(/table header/u);
    expect(() => parseTable("## T\n\n| file | test | reason |\n| a | b | c |\n", "T")).toThrow(/separator/u);
    for (const bad of ["| a | b |", "| a | b | c | d |", "| a |  | c |", "| a | b | |"]) {
      expect(() => parseTable(`## T\n\n| file | test | reason |\n| --- | --- | --- |\n${bad}\n`, "T"), bad).toThrow(/line 5/u);
    }
  });

  it("stops at the next section", () => {
    expect(parseTable(`## A\n| file | test | reason |\n| --- | --- | --- |\n| a | b | c |\n## B\n| x | y | z |\n`, "A")).toHaveLength(1);
  });
});

describe("the identity of a test", () => {
  it("is its file and title path, the file relative to src/ under it and to the root elsewhere", () => {
    expect(relativeFile("/repo/src/config/names.test.ts", ROOT)).toBe("config/names.test.ts");
    expect(relativeFile("/repo/scripts/x.test.ts", ROOT)).toBe("scripts/x.test.ts");
    expect(() => relativeFile("/elsewhere/x.test.ts", ROOT)).toThrow(/not under/u);
    expect(testId("a.test.ts", "d > t")).toBe("a.test.ts: d > t");
  });

  it("is read from a from that names a test, and a recorded from names none", () => {
    const { sources, sourceFiles } = caseSources(["paths.test.ts: a > b", "config/names.test.ts: c: with a colon > d", "recorded: src/pathNorm.ts (what)", "x.test.tsx: y"]);
    expect([...sources].sort()).toEqual(["config/names.test.ts: c: with a colon > d", "paths.test.ts: a > b", "x.test.tsx: y"]);
    expect([...sourceFiles].sort()).toEqual(["config/names.test.ts", "paths.test.ts", "x.test.tsx"]);
  });
});

describe("guardProblems", () => {
  const listed = listing(["src/paths.test.ts", "a > kept"], ["src/paths.test.ts", "a > moved"], ["src/other.test.ts", "o > t"]);

  it("passes when every test in a file in scope is a case's source or a kept row", () => {
    const sources = new Set(["paths.test.ts: a > moved"]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles: new Set(["paths.test.ts"]), kept: [row("paths.test.ts", "a > kept")] }))).toEqual([]);
  });

  it("fails for a test in a file in scope that has no case and no row, and not for one outside scope", () => {
    const problems = guardProblems(listed, accounting({ sourceFiles: new Set(["paths.test.ts"]), sources: new Set(["paths.test.ts: a > moved"]) }));
    expect(problems).toEqual(["test in a file whose tests moved has no case and no row: paths.test.ts: a > kept"]);
  });

  it("puts a file in scope through a kept row alone, so a file whose every case was removed stays guarded", () => {
    const problems = guardProblems(listed, accounting({ kept: [row("paths.test.ts", "a > kept")] }));
    expect(problems).toEqual(["test in a file whose tests moved has no case and no row: paths.test.ts: a > moved"]);
  });

  it("fails for a kept row that names no test, the title differing by one character, and for a repeated row", () => {
    const sourceFiles = new Set(["paths.test.ts"]);
    const sources = new Set(["paths.test.ts: a > moved"]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles, kept: [row("paths.test.ts", "a > kept"), row("paths.test.ts", "a > kept ")] }))).toEqual(["kept row names no test: paths.test.ts: a > kept "]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles, kept: [row("paths.test.ts", "a > kept"), row("paths.test.ts", "a > kept")] }))).toEqual(["kept row repeated: paths.test.ts: a > kept"]);
  });

  it("fails for a rename of a file whose tests are kept: the rows name a file with no test", () => {
    const renamed = listing(["src/renamed.test.ts", "a > kept"]);
    expect(guardProblems(renamed, accounting({ kept: [row("paths.test.ts", "a > kept")] }))).toEqual(["kept row names no test: paths.test.ts: a > kept"]);
  });

  it("fails for a dropped row whose test exists, a test both kept and dropped, and a kept test that is a case's source", () => {
    const kept = [row("paths.test.ts", "a > kept")];
    const sourceFiles = new Set(["paths.test.ts"]);
    const sources = new Set(["paths.test.ts: a > moved"]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles, kept, dropped: [row("paths.test.ts", "a > moved")] }))).toEqual(["dropped row names a test that exists: paths.test.ts: a > moved"]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles, kept, dropped: [row("paths.test.ts", "a > kept")] }))).toEqual(["dropped row names a test that exists: paths.test.ts: a > kept", "row is both kept and dropped: paths.test.ts: a > kept"]);
    expect(guardProblems(listed, accounting({ sources: new Set(["paths.test.ts: a > moved", "paths.test.ts: a > kept"]), sourceFiles, kept }))).toEqual(["kept row is also the source of a case: paths.test.ts: a > kept"]);
  });

  it("accepts a dropped row for a test that is gone", () => {
    const sourceFiles = new Set(["paths.test.ts"]);
    const sources = new Set(["paths.test.ts: a > moved"]);
    expect(guardProblems(listed, accounting({ sources, sourceFiles, kept: [row("paths.test.ts", "a > kept")], dropped: [row("paths.test.ts", "a > removed")] }))).toEqual([]);
  });
});

describe("deletedProblems", () => {
  const base = listing(["src/a.test.ts", "x > one"], ["src/a.test.ts", "x > two"], ["src/b.test.ts", "y > one"]);

  it("passes when nothing is deleted, or only tests are added", () => {
    expect(deletedProblems(base, base, accounting())).toEqual([]);
    expect(deletedProblems(base, listing(["src/a.test.ts", "x > one"], ["src/a.test.ts", "x > two"], ["src/b.test.ts", "y > one"], ["src/c.test.ts", "z > new"]), accounting())).toEqual([]);
  });

  it("fails for a deleted test that is neither a case's source nor a dropped row", () => {
    const head = listing(["src/a.test.ts", "x > one"], ["src/b.test.ts", "y > one"]);
    expect(deletedProblems(base, head, accounting())).toEqual(["deleted test has no case and no dropped row: a.test.ts: x > two"]);
  });

  it("passes when the case that came from the deleted test, or a dropped row, is added with it", () => {
    const head = listing(["src/a.test.ts", "x > one"], ["src/b.test.ts", "y > one"]);
    expect(deletedProblems(base, head, accounting({ sources: new Set(["a.test.ts: x > two"]) }))).toEqual([]);
    expect(deletedProblems(base, head, accounting({ dropped: [row("a.test.ts", "x > two")] }))).toEqual([]);
  });

  it("does not take a kept row as an account of a deletion", () => {
    const head = listing(["src/a.test.ts", "x > one"], ["src/b.test.ts", "y > one"]);
    expect(deletedProblems(base, head, accounting({ kept: [row("a.test.ts", "x > two")] }))).toHaveLength(1);
  });

  it("takes a renamed test, and a test moved to another file, as a deletion of the old identity", () => {
    expect(deletedProblems(base, listing(["src/a.test.ts", "x > one"], ["src/a.test.ts", "x > two renamed"], ["src/b.test.ts", "y > one"]), accounting())).toHaveLength(1);
    expect(deletedProblems(base, listing(["src/a.test.ts", "x > one"], ["src/a.test.ts", "x > two"], ["src/moved.test.ts", "y > one"]), accounting())).toEqual(["deleted test has no case and no dropped row: b.test.ts: y > one"]);
  });

  it("counts two tests with one title, so deleting one of them is a deletion", () => {
    const twice = listing(["src/a.test.ts", "x > same"], ["src/a.test.ts", "x > same"]);
    expect(deletedProblems(twice, listing(["src/a.test.ts", "x > same"]), accounting())).toEqual(["deleted test has no case and no dropped row: a.test.ts: x > same"]);
  });
});

describe("unstable titles", () => {
  it("are the identities two listings of one commit disagree on, in either direction and by count", () => {
    const first = listing(["src/a.test.ts", "x > same"], ["src/a.test.ts", "x > pid 1"], ["src/a.test.ts", "x > twice"], ["src/a.test.ts", "x > twice"]);
    const second = listing(["src/a.test.ts", "x > same"], ["src/a.test.ts", "x > pid 2"], ["src/a.test.ts", "x > twice"]);
    expect([...unstableIds(first, second)].sort()).toEqual(["a.test.ts: x > pid 1", "a.test.ts: x > pid 2", "a.test.ts: x > twice"]);
    expect(unstableIds(first, first).size).toBe(0);
  });

  it("are reported as unstable by name, and are not also reported as deleted", () => {
    const base = listing(["src/a.test.ts", "x > pid 1"]);
    const head = listing(["src/a.test.ts", "x > pid 3"]);
    const unstable = new Set(["a.test.ts: x > pid 1"]);
    expect(unstableProblems(unstable)).toEqual(["unstable title, different in two listings of one commit: a.test.ts: x > pid 1"]);
    expect(deletedProblems(base, head, accounting(), unstable)).toEqual([]);
    expect(deletedProblems(base, head, accounting())).toHaveLength(1);
  });
});
