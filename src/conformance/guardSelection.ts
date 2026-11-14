import path from "node:path";

import picomatch from "picomatch";

/**
 * Whether a push can change what the kept-tests guard (`keptTests.repo.test.ts`) concludes, as a pure function of the paths the push changes and of what the guard reads. The guard lists the whole suite and checks the listing against the corpus and the README tables, so it can be wrong about a push only when the push changes the suite's listing or one of the files the guard reads. `scripts/guard-selection.mts` builds the inputs from vitest's own configuration, so the list of what counts is not written down a second time.
 */
export interface SelectionInputs {
  /** The globs vitest takes as test files (`test.include`). */
  readonly include: readonly string[];
  /** The globs vitest leaves out of them (`test.exclude`). */
  readonly exclude: readonly string[];
  /** Files whose change changes the listing without being a test: the configuration, the files it runs before the tests, and the files that fix the version of vitest and of the packages that expand an `each`. */
  readonly listingInputs: ReadonlySet<string>;
  /** Directories the guard reads, as path prefixes ending in a slash: the corpus and README tables, and the guard's own modules. */
  readonly guardDirectories: readonly string[];
  /** Modules that a test with an `each` imports, directly or through other modules: what they hold can become its titles. */
  readonly tableModules: ReadonlySet<string>;
}

/** Whether vitest takes `file` (a path relative to the root, with forward slashes) as a test file. */
export function testFileMatcher(include: readonly string[], exclude: readonly string[]): (file: string) => boolean {
  return picomatch([...include], { dot: true, ignore: [...exclude] });
}

/** Whether a push that changes `changed` can change the guard's verdict. A path counts whether it still exists or not, so a deleted test file, and the old name of a renamed one (list the changes without rename detection), count. */
export function guardSelected(changed: readonly string[], inputs: SelectionInputs): boolean {
  const isTest = testFileMatcher(inputs.include, inputs.exclude);
  return changed.some((file) => isTest(file) || inputs.listingInputs.has(file) || inputs.tableModules.has(file) || inputs.guardDirectories.some((directory) => file.startsWith(directory)));
}

/** The relative module specifiers a source file imports, re-exports or requires, as written. */
export function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/gu)].map((match) => match[1] ?? "");
}

/** The files `specifier` can name from `from`: the path as written, with a TypeScript extension for an extensionless one or one written as its compiled form, and the index of a directory. */
export function candidates(from: string, specifier: string): string[] {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const written = /\.([cm]?)js$/u.exec(target);
  return [target, ...(written === null ? [] : [`${target.slice(0, -written[0].length)}.${written[1] ?? ""}ts`]), `${target}.ts`, `${target}.tsx`, `${target}.mts`, `${target}/index.ts`];
}

/**
 * The modules a test with an `each` imports, directly or through other modules, so a change to one is a change to what a title can be. `tests` holds the source of every test file; `read` gives the source of any other tracked file, or undefined for a path that is not one. Data files (a JSON file a test imports) are included, as the path written.
 */
export function tableModules(tests: ReadonlyMap<string, string>, read: (file: string) => string | undefined): Set<string> {
  const found = new Set<string>();
  const queue: [string, string][] = [...tests].filter(([, source]) => source.includes(".each")).map(([file, source]) => [file, source]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [file, source] = next;
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = candidates(file, specifier).find((candidate) => read(candidate) !== undefined);
      if (resolved !== undefined && !found.has(resolved)) {
        found.add(resolved);
        queue.push([resolved, read(resolved) ?? ""]);
      }
    }
  }
  return found;
}
