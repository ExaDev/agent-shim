// The TypeScript runner of the conformance corpus: loads and checks every file against the format in ../README.md, then executes cases through a table of functions the caller supplies. Plain Node and Ajv only, so a later runner for a browser or a worker can share the checks that need no filesystem.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

/** What a string starts with where a case means its temporary directory. */
const TMP_MARKER = "$TMP";

/** The largest integer every runner holds exactly. */
export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

/** Directories that hold data cases refer to or the runners themselves, never cases, wherever they appear. */
const NON_CASE_DIRECTORIES = new Set(["fixtures", "schema", "runner"]);

/** The files the corpus root itself holds. */
const ROOT_FILES = new Set(["README.md", "case.schema.json", "manifest.json", "manifest.schema.json", "scrub-allow.json"]);

/** The characters a name outside the root's own files may use, so every loader orders names the same way. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/u;

const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
const ascending = (list) => list.every((item, index) => index === 0 || list[index - 1] < item);

/**
 * Which files under `root` are corpus files, by the one rule `README.md` states: `<kind>/<name>.json`, dot-names and the non-case directories skipped, anything else a problem. Paths are `/`-separated and relative, in UTF-16 code unit order directory by directory.
 */
export function selectFiles(root) {
  const selected = [];
  const problems = [];
  const walk = (relative, depth) => {
    const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).sort(byName);
    for (const entry of entries) {
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (NON_CASE_DIRECTORIES.has(entry.name)) continue;
        if (depth === 0 && NAME.test(entry.name)) walk(name, depth + 1);
        else problems.push(name);
      } else if (depth === 0 && ROOT_FILES.has(entry.name)) continue;
      else if (depth === 1 && entry.isFile() && NAME.test(entry.name) && entry.name.endsWith(".json")) selected.push(name);
      else problems.push(name);
    }
  };
  walk("", 0);
  return { selected, problems };
}

/**
 * The checkers of the two formats, built from the schemas in `root` with Ajv in strict mode, so a schema that is itself ambiguous fails here and not silently.
 */
export function validatorsFrom(root) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const compile = (file) => ajv.compile(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  return { caseFile: compile("case.schema.json"), manifest: compile("manifest.schema.json") };
}

/** Text as a JSON string or a `{ codeUnits }` object reads: the UTF-16 code unit sequence as a JS string. */
export const decodeText = (text) => (typeof text === "string" ? text : String.fromCharCode(...text.codeUnits));

/** Canonical JSON text: keys sorted, two-space indent, one element per line, a final newline. */
export function canonical(value) {
  const sorted = (node) => (Array.isArray(node) ? node.map(sorted) : node !== null && typeof node === "object" ? Object.fromEntries(Object.keys(node).sort().map((key) => [key, sorted(node[key])])) : node);
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

/** What breaks the rules beside the schema in one parsed document: an integer above the cap, a negative zero, a string no loader can read. */
function valueProblems(node, where, problems) {
  if (typeof node === "number" && Number.isInteger(node) && Math.abs(node) > MAX_INTEGER) problems.push(`${where}: an integer above 2^53-1`);
  else if (Object.is(node, -0)) problems.push(`${where}: negative zero, which is written as { "$number": "-0" }`);
  else if (typeof node === "string" && !node.isWellFormed()) problems.push(`${where}: a string holding an unpaired surrogate, which is written as { "codeUnits": [...] }`);
  else if (Array.isArray(node)) node.forEach((item, index) => valueProblems(item, `${where}[${String(index)}]`, problems));
  else if (node !== null && typeof node === "object") for (const [key, item] of Object.entries(node)) valueProblems(item, `${where}.${key}`, problems);
}

/**
 * Everything wrong with one file's bytes: not UTF-8, not JSON, not valid by `validate`, not canonical, or breaking a rule the schema cannot express. Empty when the file is acceptable.
 */
export function fileProblems(bytes, validate) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return ["not UTF-8"];
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return [`not JSON: ${String(error)}`];
  }
  const problems = [];
  if (!validate(document)) problems.push(...(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`));
  valueProblems(document, "", problems);
  if (text !== canonical(document)) problems.push("not in canonical form");
  const ids = Array.isArray(document?.cases) ? document.cases.map((entry) => entry?.id) : [];
  if (new Set(ids).size !== ids.length) problems.push("an id is used twice in the file");
  return problems;
}

/** What is wrong with a manifest: the schema, and the lists of skipped ids being ascending. */
export function manifestProblems(bytes, validate) {
  const problems = fileProblems(bytes, validate);
  const document = problems.length === 0 ? JSON.parse(new TextDecoder().decode(bytes)) : { files: {} };
  for (const [file, entry] of Object.entries(document.files)) {
    for (const side of ["ts", "rust"]) if (!ascending(entry.skip[side])) problems.push(`${file}: skip.${side} is not in ascending order`);
  }
  return problems;
}

/**
 * Loads the corpus under `root` and checks it: every file, the ids across files, each file's kind against its directory, and the manifest against the cases. The schemas are read from `schemas`, which is `root` for the real corpus and the real corpus for a fixture root.
 */
export function loadCorpus(root, schemas = root) {
  const { caseFile, manifest } = validatorsFrom(schemas);
  const { selected, problems: selection } = selectFiles(root);
  const problems = selection.map((entry) => `${entry}: not a corpus file or directory`);
  const files = [];
  const seen = new Map();
  for (const file of selected) {
    const bytes = fs.readFileSync(path.join(root, file));
    const own = fileProblems(bytes, caseFile);
    problems.push(...own.map((problem) => `${file}: ${problem}`));
    if (own.length > 0) continue;
    const { cases } = JSON.parse(bytes.toString("utf8"));
    files.push({ file, cases });
    for (const entry of cases) {
      if (entry.kind !== file.split("/")[0]) problems.push(`${file}: ${entry.id} has kind ${entry.kind}, not its directory's`);
      if (seen.has(entry.id)) problems.push(`${file}: ${entry.id} is also in ${String(seen.get(entry.id))}`);
      seen.set(entry.id, file);
    }
  }
  const manifestBytes = fs.readFileSync(path.join(root, "manifest.json"));
  const own = manifestProblems(manifestBytes, manifest);
  problems.push(...own.map((problem) => `manifest.json: ${problem}`));
  if (own.length === 0) {
    const listed = JSON.parse(manifestBytes.toString("utf8")).files;
    for (const { file, cases } of files) {
      const entry = listed[file];
      if (entry === undefined) problems.push(`manifest.json: omits ${file}`);
      else {
        if (entry.cases !== cases.length) problems.push(`manifest.json: ${file} lists ${String(entry.cases)} cases, the file holds ${String(cases.length)}`);
        for (const side of ["ts", "rust"]) {
          const marked = cases.filter((other) => other.skip === side).map((other) => other.id).sort();
          if (JSON.stringify(entry.skip[side]) !== JSON.stringify(marked)) problems.push(`manifest.json: ${file} lists different ${side} skips from the file`);
        }
      }
    }
    for (const file of Object.keys(listed)) if (!selected.includes(file)) problems.push(`manifest.json: lists ${file}, which is not in the corpus`);
  }
  return { files, problems };
}

/** A decoded value: the JSON value with the encodings of `README.md` read back, `$TMP` expanded when the case has a tree. */
function decode(value, tmp) {
  if (typeof value === "string") return tmp !== undefined && value.startsWith(TMP_MARKER) ? tmp + value.slice(TMP_MARKER.length) : value;
  if (Array.isArray(value)) return value.map((item) => decode(item, tmp));
  if (value === null || typeof value !== "object") return value;
  if ("$number" in value) return Number(value.$number);
  if ("$undefined" in value) return undefined;
  if ("$object" in value) return Object.fromEntries(value.$object.map(([key, item]) => [key, decode(item, tmp)]));
  if ("codeUnits" in value) return decodeText(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, tmp)]));
}

/** Writes a case's file tree under a fresh directory and returns it, as a real path so a link through the temporary directory's own link still compares equal. */
function materialise(files) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-corpus-")));
  const entries = Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1));
  for (const [name, entry] of entries) {
    const target = path.join(tmp, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof entry === "string") fs.writeFileSync(target, entry);
    else if ("base64" in entry) fs.writeFileSync(target, Buffer.from(entry.base64, "base64"));
    else if ("directory" in entry) fs.mkdirSync(target, { recursive: true });
  }
  for (const [name, entry] of entries) if (typeof entry === "object" && "symlink" in entry) fs.symlinkSync(decode(entry.symlink, tmp), path.join(tmp, name));
  return tmp;
}

/** Runs one `function` case: each step calls the table's function with the decoded arguments and compares the result, or the error it throws. */
export function runCase(entry, table) {
  const tmp = entry.files === undefined ? undefined : materialise(entry.files);
  try {
    for (const step of entry.steps) {
      const fn = table[step.fn];
      assert.ok(fn !== undefined, `the table has no function ${step.fn}`);
      const args = step.args.map((arg) => decode(arg, tmp));
      if ("throws" in step.expect) {
        const { name, message } = step.expect.throws;
        let thrown;
        try {
          fn(...args);
        } catch (caught) {
          thrown = caught;
        }
        assert.ok(thrown instanceof Error, `${step.fn} should throw ${name}`);
        assert.equal(thrown.name, name, `${step.fn} threw ${thrown.name}`);
        const text = thrown.message;
        if (message?.startsWith !== undefined) assert.ok(text.startsWith(decodeText(message.startsWith)), `message ${JSON.stringify(text)} should start with ${JSON.stringify(message.startsWith)}`);
        let from = 0;
        for (const fragment of message?.contains ?? []) {
          const at = text.indexOf(decodeText(fragment), from);
          assert.ok(at >= 0, `message ${JSON.stringify(text)} should contain ${JSON.stringify(fragment)} after offset ${String(from)}`);
          from = at + decodeText(fragment).length;
        }
      } else {
        let actual = fn(...args);
        for (const key of step.select ?? []) actual = actual[key];
        assert.deepStrictEqual(actual, decode(step.expect.value, tmp), `${step.fn}(${JSON.stringify(step.args)})`);
      }
    }
  } finally {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The cases of the corpus as registrable tests: each with its file, id, original title and `skip`. Counting what was registered, executed or skipped, against the manifest is the caller's check, made when it collects and so whatever the run later does with the tests.
 */
export function collect(root) {
  const { files, problems } = loadCorpus(root);
  const cases = files.flatMap(({ file, cases: list }) => list.map((entry) => ({ file, id: entry.id, from: entry.from, skip: entry.skip, run: (table) => runCase(entry, table) })));
  return { cases, problems };
}
