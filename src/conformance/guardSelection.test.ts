import { describe, expect, it } from "vitest";

import { candidates, guardSelected, relativeSpecifiers, tableModules, type SelectionInputs } from "./guardSelection";

const inputs = (changes: Partial<SelectionInputs> = {}): SelectionInputs => ({
  include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  exclude: ["**/node_modules/**"],
  listingInputs: new Set(["vitest.config.ts", "src/test-setup.ts", "package.json", "pnpm-lock.yaml"]),
  guardDirectories: ["conformance/", "src/conformance/"],
  tableModules: new Set(["src/cases/table.ts"]),
  ...changes,
});

describe("guardSelected", () => {
  it("skips a push that changes nothing the guard reads, and an empty push", () => {
    expect(guardSelected(["src/usage/read.ts", "docs/architecture.md", "scripts/build.mts", "src/conformanceNotes.ts", "docs/conformance/notes.md"], inputs())).toBe(false);
    expect(guardSelected([], inputs())).toBe(false);
  });

  it("runs for a test file of any extension vitest takes, in any directory, deleted or not", () => {
    for (const file of ["src/a.test.ts", "src/a.spec.ts", "src/a.test.mts", "scripts/a.test.tsx", "src/dir/a.spec.cjs"]) {
      expect(guardSelected(["docs/a.md", file], inputs()), file).toBe(true);
    }
  });

  it("does not take a test-looking file the configuration excludes, or a name that only resembles one", () => {
    expect(guardSelected(["node_modules/pkg/a.test.ts", "src/atest.ts", "src/test.ts.bak", "src/a.test.ts.snap"], inputs())).toBe(false);
  });

  it("runs for the configuration, what it runs before the tests, and the files that fix versions", () => {
    for (const file of ["vitest.config.ts", "src/test-setup.ts", "package.json", "pnpm-lock.yaml"]) {
      expect(guardSelected([file], inputs()), file).toBe(true);
    }
  });

  it("runs for a path under a directory the guard reads", () => {
    for (const file of ["conformance/README.md", "conformance/function/a.json", "src/conformance/keptTests.ts"]) {
      expect(guardSelected([file], inputs()), file).toBe(true);
    }
  });

  it("runs for a module a test with an each imports", () => {
    expect(guardSelected(["src/cases/table.ts"], inputs())).toBe(true);
  });
});

describe("candidates and specifiers", () => {
  it("reads the relative imports, re-exports, side-effect imports, dynamic imports and requires of a source", () => {
    const source = 'import a from "./a";\nimport { b } from "../b.js";\nexport * from "./c";\nimport "./d.json";\nconst e = await import("./e");\nconst f = require("./f");\nimport g from "pkg";';
    expect(relativeSpecifiers(source)).toEqual(["./a", "../b.js", "./c", "./d.json", "./e", "./f"]);
  });

  it("names the files an extensionless specifier, a compiled one and a directory can mean", () => {
    expect(candidates("src/x/t.test.ts", "./table")).toEqual(["src/x/table", "src/x/table.ts", "src/x/table.tsx", "src/x/table.mts", "src/x/table/index.ts"]);
    expect(candidates("src/x/t.test.ts", "../y.js")).toContain("src/y.ts");
    expect(candidates("src/x/t.test.ts", "../y.mjs")).toContain("src/y.mts");
  });
});

describe("tableModules", () => {
  const files = new Map([
    ["src/t.test.ts", 'import { rows } from "./rows";\nit.each(rows)("x %s", () => {});'],
    ["src/rows.ts", 'import data from "./data.json";\nexport * from "./more";\nexport const rows = data;'],
    ["src/data.json", "[]"],
    ["src/more/index.ts", "export const more = 1;"],
    ["src/unrelated.ts", "export const u = 1;"],
    ["src/plain.test.ts", 'import { u } from "./unrelated";\nit("y", () => {});'],
  ]);
  const read = (file: string): string | undefined => files.get(file);

  it("finds what a test with an each imports, through other modules, data files and directories", () => {
    const tests = new Map([...files].filter(([file]) => file.endsWith(".test.ts")));
    expect([...tableModules(tests, read)].sort()).toEqual(["src/data.json", "src/more/index.ts", "src/rows.ts"]);
  });

  it("leaves out what only a test without an each imports", () => {
    expect(tableModules(new Map([["src/plain.test.ts", files.get("src/plain.test.ts") ?? ""]]), read).size).toBe(0);
  });

  it("stops at an import cycle", () => {
    const cyclic = new Map([["src/a.ts", 'import "./b";'], ["src/b.ts", 'import "./a";']]);
    const tests = new Map([["src/t.test.ts", 'import "./a"; it.each([1])("n", () => {});']]);
    expect([...tableModules(tests, (file) => cyclic.get(file))].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
