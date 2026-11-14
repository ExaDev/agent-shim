import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The suffix of a test that reads the repository's own files from disk (a source tree it walks for a rule, a document it checks a constant against, a workflow it parses). `vitest --changed` selects a test by what it imports, and a file a test reads is not an import, so a change to that file never selects the test; `.husky/pre-push` runs every test with this suffix on every push instead, and this file keeps the suffix on exactly the tests that read the repository.
 */
const SUFFIX = ".repo.test.ts";

/** The `node:fs` functions that read or look at a path, by the name a call uses (`fs.readFileSync(...)` or an imported `readFileSync(...)`). */
const FS_READS: ReadonlySet<string> = new Set(["readFileSync", "readFile", "readdirSync", "readdir", "opendirSync", "opendir", "existsSync", "statSync", "stat", "lstatSync", "lstat", "accessSync", "access", "globSync", "glob", "createReadStream"]);

/** Whether `node` is one of the expressions that name the test file's own place in the repository. */
function isOwnLocation(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "__dirname" || node.text === "__filename";
  }
  return ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.name.text === "meta" && ["dirname", "filename", "url"].includes(node.name.text);
}

/** The name a call is made by: the method of a property access, or a bare function. */
function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

/** Whether `node` or anything under it satisfies `test`. */
function some(node: ts.Node, test: (child: ts.Node) => boolean): boolean {
  if (test(node)) {
    return true;
  }
  return ts.forEachChild(node, (child) => (some(child, test) ? true : undefined)) === true;
}

/**
 * Whether a test's source reads a path in the repository: a `node:fs` read or listing whose path is built from the file's own location (`__dirname`, `import.meta.dirname`, `import.meta.url`), directly, through a variable initialised from one (by name, across the file), or through a function the file declares that reads the filesystem and is handed such a path. A path under a temporary directory is not built from the file's location, so the many tests that read what they wrote there are not counted.
 */
function readsRepository(sourceText: string): boolean {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const initialisers = new Map<string, ts.Expression[]>();
  const functions = new Map<string, ts.Node>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      initialisers.set(node.name.text, [...(initialisers.get(node.name.text) ?? []), node.initializer]);
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        functions.set(node.name.text, node.initializer);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.set(node.name.text, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const rootedNames = new Map<string, boolean>();
  const rooted = (node: ts.Node): boolean =>
    some(node, (child) => {
      if (isOwnLocation(child)) {
        return true;
      }
      if (!ts.isIdentifier(child)) {
        return false;
      }
      const known = rootedNames.get(child.text);
      if (known !== undefined) {
        return known;
      }
      // Marked false before the initialisers are read, so a variable defined in terms of itself ends the walk.
      rootedNames.set(child.text, false);
      const answer = (initialisers.get(child.text) ?? []).some(rooted);
      rootedNames.set(child.text, answer);
      return answer;
    });

  const isFsRead = (node: ts.Node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    const name = calleeName(node);
    return name !== undefined && FS_READS.has(name);
  };
  const readerNames = new Map<string, boolean>();
  const readsFs = (name: string): boolean => {
    const known = readerNames.get(name);
    if (known !== undefined) {
      return known;
    }
    readerNames.set(name, false);
    const body = functions.get(name);
    const answer =
      body !== undefined &&
      some(body, (child) => {
        if (isFsRead(child)) {
          return true;
        }
        if (!ts.isCallExpression(child)) {
          return false;
        }
        const callee = calleeName(child);
        return callee !== undefined && callee !== name && readsFs(callee);
      });
    readerNames.set(name, answer);
    return answer;
  };

  return some(source, (node) => {
    if (!ts.isCallExpression(node) || !node.arguments.some(rooted)) {
      return false;
    }
    if (isFsRead(node)) {
      return true;
    }
    const callee = calleeName(node);
    return callee !== undefined && readsFs(callee);
  });
}

/** Every test module under `directory`, skipping installed dependencies. */
function testsUnder(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : testsUnder(child);
    }
    return /\.test\.m?ts$/.test(entry.name) ? [child] : [];
  });
}

const ROOT = path.join(__dirname, "..");

/** Every test the suite runs: vitest's default include, which this repository's config keeps, finds them under `src` and `scripts`. */
function repositoryTests(): readonly string[] {
  return [...testsUnder(path.join(ROOT, "src")), ...testsUnder(path.join(ROOT, "scripts"))].map((file) => path.relative(ROOT, file)).sort();
}

describe(`a test that reads the repository's own files`, () => {
  const tests = repositoryTests();
  const reading = tests.filter((file) => readsRepository(fs.readFileSync(path.join(ROOT, file), "utf8")));

  it(`is named *${SUFFIX}, so the pre-push hook runs it whatever the push changed`, () => {
    expect(reading.filter((file) => !file.endsWith(SUFFIX)), `rename each to end in ${SUFFIX}`).toEqual([]);
  });

  it(`is the only kind of test named *${SUFFIX}, so the hook's always-run set holds nothing that the changed-files selection would reach`, () => {
    expect(tests.filter((file) => file.endsWith(SUFFIX) && !reading.includes(file)), `drop ${SUFFIX} from each`).toEqual([]);
  });

  it("is found among the tests of both trees", () => {
    expect(reading).toContain(path.join("src", "testPortRelease.repo.test.ts"));
    expect(reading).toContain(path.join("src", "frontdoor", "loggedTextSites.repo.test.ts"));
    expect(tests).toContain(path.join("scripts", "rc-self-host-lab-core.test.ts"));
  });
});

describe("readsRepository", () => {
  it.each([
    ["a read of a path built from __dirname", 'fs.readFileSync(path.join(__dirname, "x.ts"), "utf8");'],
    ["a read of a path built from import.meta.dirname", 'readFileSync(path.join(import.meta.dirname, "x.ts"), "utf8");'],
    ["a read of a path built from import.meta.url", 'fs.readFileSync(new URL("x.ts", import.meta.url));'],
    ["a listing of a variable initialised from the file's location", 'const SRC = path.resolve(__dirname, ".."); const root = path.join(SRC, "a"); fs.readdirSync(root);'],
    ["an existence check on the file's location", 'expect(fs.existsSync(path.join(__dirname, "a"))).toBe(true);'],
    ["a walk through a function the file declares", 'function walk(dir: string): string[] { return fs.readdirSync(dir).flatMap((name) => walk(path.join(dir, name))); } walk(__dirname);'],
    ["a walk through an arrow function that calls a reader", 'const read = (file: string) => fs.readFileSync(file, "utf8"); const count = (file: string) => read(file).length; count(path.join(__dirname, "a.ts"));'],
  ])("finds %s", (_label, text) => {
    expect(readsRepository(text)).toBe(true);
  });

  it.each([
    ["a read of a temporary directory", 'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t-")); fs.readdirSync(dir);'],
    ["a module resolved from the file's location without reading it", "const require = createRequire(import.meta.url); require.resolve('x');"],
    ["a bundle built from the file's location by a function the file does not declare", 'await build({ entryPoints: [path.resolve(__dirname, "cli.ts")] });'],
    ["the file's location in a string", "const banner = 'require(\"node:url\").pathToFileURL(__dirname)'; fs.readFileSync(other);"],
  ])("leaves %s alone", (_label, text) => {
    expect(readsRepository(text)).toBe(false);
  });
});
