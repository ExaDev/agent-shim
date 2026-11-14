import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { collect, decodeText, fileProblems, loadCorpus, manifestProblems, runCase, selectFiles, validatorsFrom, type CaseTable } from "../conformance/runner/run.mjs";
import { canonicalJson } from "./canonicalJson";
import { FileNameSchema, isFileName, isStoredName, profileFilePath, providerFilePath, requireNewProviderName, StoredNameSchema } from "./config/names";
import { holdFrom, within } from "./elapsedWindow";
import { buildLayoutPaths, resolveAgentShimHome } from "./paths";
import { ignoresCase, sameDirectory } from "./sameDirectory";

/** The corpus root: the cases, their schemas and manifest, the runner and the fixtures the runner tests itself with. */
const ROOT = path.join(__dirname, "..", "conformance");
const FIXTURES = path.join(ROOT, "fixtures");

/** The cap on the runner's size, so a runner for a browser or a worker stays small enough to read through. */
const RUNNER_MAX_BYTES = 16_384;

/** UTF-16 code units the runner tests read text from: a letter, and the two halves of one astral character. */
const LETTER_B = 98;
const HIGH_SURROGATE = 55_357;
const LOW_SURROGATE = 56_832;

/** An argument a case gives as plain data and a function takes as another type, narrowed or refused. */
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected text, got ${JSON.stringify(value)}`);
  }
  return value;
}

function numeric(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The environment a case gives: an object of text values. */
function environment(value: unknown): NodeJS.ProcessEnv {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`expected an environment, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, text(entry)]));
}

/** What a case's `resolveAgentShimHome` third argument means: `true` (every directory exists), `false` (none does) or the list of those that do. */
function directoryTest(value: unknown): (candidate: string) => boolean {
  if (typeof value === "boolean") {
    return () => value;
  }
  if (Array.isArray(value)) {
    const existing = new Set(value.map(text));
    return (candidate) => existing.has(candidate);
  }
  throw new TypeError(`expected true, false or a list of paths, got ${JSON.stringify(value)}`);
}

/** The optional argument that says where a name came from. */
function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

/** The functions the `function` cases call, by the name the case gives. */
const TABLE: CaseTable = {
  resolveAgentShimHome: (env, home, exists) => resolveAgentShimHome(environment(env), text(home), directoryTest(exists)),
  buildLayoutPaths: (root) => buildLayoutPaths(text(root)),
  canonicalJson: (value) => canonicalJson(value),
  within: (since, now, window) => within(numeric(since), numeric(now), numeric(window)),
  holdFrom: (since, now, window) => holdFrom(numeric(since), numeric(now), numeric(window)),
  sameDirectory: (first, second) => sameDirectory(text(first), text(second)),
  ignoresCase: (directory) => ignoresCase(text(directory)),
  isFileName: (name) => isFileName(text(name)),
  isStoredName: (name) => isStoredName(text(name)),
  "FileNameSchema.accepts": (name) => FileNameSchema.safeParse(name).success,
  "StoredNameSchema.accepts": (name) => StoredNameSchema.safeParse(name).success,
  profileFilePath: (directory, name, from) => profileFilePath(text(directory), text(name), optionalText(from)),
  providerFilePath: (directory, name, from) => providerFilePath(text(directory), text(name), optionalText(from)),
  requireNewProviderName: (name) => {
    requireNewProviderName(text(name));
  },
};

const ManifestSchema = z.object({ files: z.record(z.string(), z.object({ cases: z.number(), skip: z.object({ ts: z.array(z.string()), rust: z.array(z.string()) }) })) });

describe("the conformance corpus", () => {
  const { cases, problems } = collect(ROOT);
  const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))).files;

  it("is well formed, and holds exactly what its manifest lists", () => {
    expect(problems).toEqual([]);
  });

  // Registered here, at collection, so the count below does not depend on what the run later does with the tests (a filter, a bail, a retry, a shuffled order).
  for (const entry of cases) {
    (entry.skip === "ts" ? it.skip : it)(`${entry.file}: ${entry.id}`, () => {
      entry.run(TABLE);
    });
  }

  it("registers every case the manifest counts, and skips exactly the ones it lists for TypeScript", () => {
    expect(cases.length).toBe(Object.values(manifest).reduce((total, file) => total + file.cases, 0));
    expect(cases.filter((entry) => entry.skip === "ts").map((entry) => entry.id).sort()).toEqual(Object.values(manifest).flatMap((file) => file.skip.ts).sort());
  });
});

describe("the runner", () => {
  /** A case whose step calls `echo` with `args` and expects `expect`, through a table of one function. */
  const table: CaseTable = {
    echo: (...args) => args[0],
    keys: (value) => (typeof value === "object" && value !== null ? Object.keys(value) : []),
    fail: () => {
      throw new RangeError("first part, then second part");
    },
  };
  const run = (steps: readonly unknown[], files?: Record<string, unknown>): void => {
    runCase({ id: "x", from: "x.test.ts: x > y", kind: "function", steps, ...(files === undefined ? {} : { files }) }, table);
  };

  it("passes a step whose result equals the expected value", () => {
    expect(() => {
      run([{ fn: "echo", args: [{ a: [1, "b", null] }], expect: { value: { a: [1, "b", null] } } }]);
    }).not.toThrow();
  });

  it("fails a step whose result differs, however small the difference", () => {
    for (const [given, expected] of [
      [1, 2],
      [0, { $number: "-0" }],
      [{ a: 1 }, { a: 1, b: { $undefined: true } }],
      ["a", { codeUnits: [LETTER_B] }],
    ]) {
      expect(() => {
        run([{ fn: "echo", args: [given], expect: { value: expected } }]);
      }, JSON.stringify([given, expected])).toThrow();
    }
  });

  it("reads the encodings of numbers, undefined and code units", () => {
    expect(() => {
      run([
        { fn: "echo", args: [{ $number: "-0" }], expect: { value: { $number: "-0" } } },
        { fn: "echo", args: [{ $number: "NaN" }], expect: { value: { $number: "NaN" } } },
        { fn: "echo", args: [{ $undefined: true }], expect: { value: { $undefined: true } } },
        { fn: "echo", args: [{ codeUnits: [HIGH_SURROGATE, LOW_SURROGATE] }], expect: { value: "\u{1F600}" } },
      ]);
    }).not.toThrow();
  });

  it("keeps the order of the members of an $object, which a canonical file's sorted keys cannot", () => {
    expect(() => {
      run([{ fn: "keys", args: [{ $object: [["b", 1], ["a", 2], ["c", { $object: [["z", 1], ["y", 2]] }]] }], expect: { value: ["b", "a", "c"] } }]);
    }).not.toThrow();
    expect(() => {
      run([{ fn: "keys", args: [{ $object: [["b", 1], ["a", 2]] }], expect: { value: ["a", "b"] } }]);
    }).toThrow();
  });

  it("follows `select` into the result before comparing", () => {
    expect(() => {
      run([{ fn: "echo", args: [{ a: { b: 7 } }], select: ["a", "b"], expect: { value: 7 } }]);
    }).not.toThrow();
    expect(() => {
      run([{ fn: "echo", args: [{ a: { b: 7 } }], select: ["a", "b"], expect: { value: 8 } }]);
    }).toThrow();
  });

  it("checks the name and the message of a thrown error, the fragments in order", () => {
    const throws = (name: string, message: unknown): void => {
      run([{ fn: "fail", args: [], expect: { throws: { name, message } } }]);
    };
    expect(() => {
      throws("RangeError", { startsWith: "first", contains: ["part", "second part"] });
    }).not.toThrow();
    expect(() => {
      throws("TypeError", { contains: ["part"] });
    }).toThrow();
    expect(() => {
      throws("RangeError", { startsWith: "second" });
    }).toThrow();
    expect(() => {
      throws("RangeError", { contains: ["second", "first"] });
    }).toThrow();
    expect(() => {
      run([{ fn: "echo", args: [1], expect: { throws: { name: "RangeError" } } }]);
    }).toThrow();
  });

  it("makes the file tree, expands $TMP in arguments and link targets and writes it back in results, and removes the tree", () => {
    let tree = "";
    const probing: CaseTable = {
      isLink: (target) => {
        tree = path.dirname(String(target));
        return fs.lstatSync(String(target)).isSymbolicLink();
      },
      same: (target) => target,
    };
    runCase(
      {
        id: "x",
        from: "x.test.ts: x > y",
        kind: "function",
        files: { "dir/file": "text", link: { symlink: "$TMP/dir" }, empty: { directory: true }, raw: { base64: "AAEC" } },
        steps: [
          { fn: "isLink", args: ["$TMP/link"], expect: { value: true } },
          { fn: "same", args: ["$TMP/dir/file"], expect: { value: "$TMP/dir/file" } },
        ],
      },
      probing,
    );
    expect(tree).not.toBe("");
    expect(fs.existsSync(tree)).toBe(false);
  });

  it("refuses a step that names a function the table lacks", () => {
    expect(() => {
      run([{ fn: "absent", args: [], expect: { value: 1 } }]);
    }).toThrow(/absent/u);
  });

  it("fails a wrong expectation of the real functions and passes a right one", () => {
    expect(() => {
      runCase({ id: "x", from: "x.test.ts: x > y", kind: "function", steps: [{ fn: "isFileName", args: ["client-base"], expect: { value: false } }] }, TABLE);
    }).toThrow();
    expect(() => {
      runCase({ id: "x", from: "x.test.ts: x > y", kind: "function", steps: [{ fn: "requireNewProviderName", args: [".hidden"], expect: { throws: { name: "InvalidProviderNameError" } } }] }, TABLE);
    }).not.toThrow();
  });
});

describe("the runner's size", () => {
  it("stays within the cap on every runner file together", () => {
    const runners = fs.readdirSync(path.join(ROOT, "runner")).filter((name) => name.endsWith(".mjs"));
    expect(runners).toContain("run.mjs");
    const bytes = runners.reduce((total, name) => total + fs.statSync(path.join(ROOT, "runner", name)).size, 0);
    expect(bytes).toBeLessThanOrEqual(RUNNER_MAX_BYTES);
  });
});

describe("the format's fixtures", () => {
  const { caseFile, manifest } = validatorsFrom(ROOT);
  const list = (relative: string): string[] => fs.readdirSync(path.join(FIXTURES, relative)).sort();
  const read = (relative: string, name: string): Buffer => fs.readFileSync(path.join(FIXTURES, relative, name));

  it("has a repaired twin for every invalid file, and no repaired file without one", () => {
    expect(list("repaired-cases")).toEqual(list("invalid-cases"));
    expect(list("manifests/repaired")).toEqual(list("manifests/invalid"));
    expect(list("corpora/repaired")).toEqual(list("corpora/invalid"));
  });

  it.each(list("invalid-cases"))("refuses invalid-cases/%s and accepts its repaired twin", (name) => {
    expect(fileProblems(read("invalid-cases", name), caseFile)).not.toEqual([]);
    expect(fileProblems(read("repaired-cases", name), caseFile)).toEqual([]);
  });

  it.each(list("valid-cases"))("accepts valid-cases/%s", (name) => {
    expect(fileProblems(read("valid-cases", name), caseFile)).toEqual([]);
  });

  it.each(list("manifests/invalid"))("refuses manifests/invalid/%s and accepts its repaired twin", (name) => {
    expect(manifestProblems(read("manifests/invalid", name), manifest)).not.toEqual([]);
    expect(manifestProblems(read("manifests/repaired", name), manifest)).toEqual([]);
  });

  it.each(list("manifests/valid"))("accepts manifests/valid/%s", (name) => {
    expect(manifestProblems(read("manifests/valid", name), manifest)).toEqual([]);
  });

  it.each(list("corpora/invalid"))("refuses the whole corpus in corpora/invalid/%s and accepts its repaired twin", (name) => {
    expect(loadCorpus(path.join(FIXTURES, "corpora", "invalid", name), ROOT).problems).not.toEqual([]);
    expect(loadCorpus(path.join(FIXTURES, "corpora", "repaired", name), ROOT).problems).toEqual([]);
  });

  it("selects the corpus files the one rule selects, and refuses the entries it refuses", () => {
    const expected = z.object({ selected: z.array(z.string()), problems: z.array(z.string()) }).parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, "loader-selection", "expected.json"), "utf8")));
    expect(selectFiles(path.join(FIXTURES, "loader-selection", "tree"))).toEqual(expected);
  });

  it("reads both forms of text into the same code units", () => {
    const { pairs } = z.object({ pairs: z.array(z.object({ codeUnits: z.array(z.number()), text: z.string() })) }).parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, "text-forms", "pairs.json"), "utf8")));
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(decodeText({ codeUnits: pair.codeUnits }), JSON.stringify(pair)).toBe(pair.text);
      expect(decodeText(pair.text), JSON.stringify(pair)).toBe(pair.text);
    }
  });
});
