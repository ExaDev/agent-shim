import { z } from "zod";

/**
 * What the corpus accounts for in the test suite, as pure functions of a suite listing, the two README tables and the `from` of every case. The guard test (`keptTests.repo.test.ts`) and the deleted-test check (`scripts/deleted-tests.mts`) both run them, so there is one definition of each rule.
 *
 * A test is identified by its file and its title path as the suite's own listing resolves them: `<file>: <describe> > <test>`, the form a case's `from` uses. The file is relative to `src/` for a file under it and to the repository root otherwise. A listing holds titles after the suite has run its `each` expansions and evaluated any computed title, so there is no literal and non-literal title here: a title either equals what a `from` or a row says, character for character, or it is unaccounted for.
 */

/** What `vitest list --json` prints: one entry per test, with its title path and the absolute path of its file. */
export const ListingSchema = z.array(z.object({ name: z.string(), file: z.string() }));

export type Listing = z.infer<typeof ListingSchema>;

/** One row of a README table. */
export interface Row {
  readonly file: string;
  readonly test: string;
  readonly reason: string;
}

/** What the corpus and the README tables say about the suite's tests. */
export interface Accounting {
  /** The identities some case's `from` names as the test it came from. */
  readonly sources: ReadonlySet<string>;
  /** The files some case's `from` names. */
  readonly sourceFiles: ReadonlySet<string>;
  /** The `## Kept tests` rows: tests that stay in a file whose tests moved. */
  readonly kept: readonly Row[];
  /** The `## Dropped tests` rows: tests removed without a case. */
  readonly dropped: readonly Row[];
}

/** The identity of a test. */
export function testId(file: string, test: string): string {
  return `${file}: ${test}`;
}

/** The file of an absolute listing path, as `from` and the tables write it: relative to `src/` under it, else to the root. */
export function relativeFile(absolute: string, root: string): string {
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  if (!absolute.startsWith(prefix)) {
    throw new Error(`${absolute} is not under ${root}`);
  }
  const relative = absolute.slice(prefix.length);
  return relative.startsWith("src/") ? relative.slice("src/".length) : relative;
}

/** How many tests of each identity a listing holds. Two tests with one title in one file count twice, so deleting one of them is a deletion. */
export function listedCounts(listing: Listing, root: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of listing) {
    const id = testId(relativeFile(entry.file, root), entry.name);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The pattern of a `from` that names a test: `<file>.test.ts: <title path>` (or `.tsx`). A `recorded:` one names no test. */
const FROM_TEST = /^([A-Za-z0-9_./-]+\.test\.tsx?): (.+)$/u;

/** The accounting of the cases' `from` values: the tests they came from and the files those are in. */
export function caseSources(froms: readonly string[]): Pick<Accounting, "sources" | "sourceFiles"> {
  const sources = new Set<string>();
  const sourceFiles = new Set<string>();
  for (const from of froms) {
    const match = FROM_TEST.exec(from);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sources.add(testId(match[1], match[2]));
      sourceFiles.add(match[1]);
    }
  }
  return { sources, sourceFiles };
}

/** The cells of a table line, with the outer pipes removed and an escaped pipe (`\|`) read as a pipe in the text. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * The rows of the table under the `## <heading>` section of a README: the section's lines that start with `|`, the first the header `file | test | reason`, the second the separator. Throws, naming the line, for a missing section, a header that is not exactly that, or a row that is not three non-empty cells.
 */
export function parseTable(markdown: string, heading: string): Row[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) {
    throw new Error(`the README has no "## ${heading}" section`);
  }
  const section: { text: string; number: number }[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      break;
    }
    if (line.startsWith("|")) {
      section.push({ text: line, number: index + 1 });
    }
  }
  const [header, separator, ...body] = section;
  if (header === undefined || cells(header.text).join("|") !== "file|test|reason") {
    throw new Error(`"## ${heading}" must start with the table header | file | test | reason |`);
  }
  if (separator === undefined || !cells(separator.text).every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    throw new Error(`"## ${heading}" has no separator line under its table header`);
  }
  return body.map(({ text, number }) => {
    const [file, test, reason, ...extra] = cells(text);
    if (file === undefined || test === undefined || reason === undefined || extra.length > 0 || file === "" || test === "" || reason === "") {
      throw new Error(`"## ${heading}" line ${String(number)} is not three non-empty cells (write a pipe in a title as \\|)`);
    }
    return { file, test, reason };
  });
}

/** The accounting of a README and the `from` of every case. */
export function accountingFrom(readme: string, froms: readonly string[]): Accounting {
  return { ...caseSources(froms), kept: parseTable(readme, "Kept tests"), dropped: parseTable(readme, "Dropped tests") };
}

function ids(rows: readonly Row[]): string[] {
  return rows.map((row) => testId(row.file, row.test));
}

/**
 * What is wrong with the suite as it stands, in a stable order. A file is in scope when some case's `from` names it or a kept row does, and stays in scope as long as either does, so a rename that leaves the rows alone fails the first rule and one that changes them puts the new name in scope. The rules:
 *
 * - every kept row names a test that exists, once;
 * - every dropped row names a test that does not exist, so the table cannot hold a test that is back;
 * - no test is a kept row and a dropped row, or a kept row and the source of a case;
 * - every test in a file in scope is the source of a case or a kept row.
 */
export function guardProblems(listed: ReadonlyMap<string, number>, accounting: Accounting): string[] {
  const problems: string[] = [];
  const keptIds = ids(accounting.kept);
  const droppedIds = new Set(ids(accounting.dropped));
  const keptSet = new Set(keptIds);
  for (const id of keptSet) {
    if (!listed.has(id)) {
      problems.push(`kept row names no test: ${id}`);
    }
    if (keptIds.filter((other) => other === id).length > 1) {
      problems.push(`kept row repeated: ${id}`);
    }
    if (droppedIds.has(id)) {
      problems.push(`row is both kept and dropped: ${id}`);
    }
    if (accounting.sources.has(id)) {
      problems.push(`kept row is also the source of a case: ${id}`);
    }
  }
  for (const id of droppedIds) {
    if (listed.has(id)) {
      problems.push(`dropped row names a test that exists: ${id}`);
    }
  }
  const scope = new Set([...accounting.sourceFiles, ...accounting.kept.map((row) => row.file)]);
  for (const id of listed.keys()) {
    const file = id.slice(0, id.indexOf(": "));
    if (scope.has(file) && !accounting.sources.has(id) && !keptSet.has(id)) {
      problems.push(`test in a file whose tests moved has no case and no row: ${id}`);
    }
  }
  return [...new Set(problems)].sort();
}

/**
 * The tests a change deleted that nothing accounts for: an identity the base holds more often than the head, that is neither the source of a case nor a dropped row. A renamed test or file is a deletion of the old identity, so it needs the same accounting; a kept row does not account for a deletion, since a kept row for a missing test is a problem of its own.
 */
export function deletedProblems(base: ReadonlyMap<string, number>, head: ReadonlyMap<string, number>, accounting: Accounting): string[] {
  const dropped = new Set(ids(accounting.dropped));
  const problems: string[] = [];
  for (const [id, count] of base) {
    const accounted = accounting.sources.has(id) || dropped.has(id);
    if (count > (head.get(id) ?? 0) && !accounted) {
      problems.push(`deleted test has no case and no dropped row: ${id}`);
    }
  }
  return problems.sort();
}
