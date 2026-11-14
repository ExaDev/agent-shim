import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { guardedNameRead } from "./identityRecords";
import { errorWithCode } from "./test-helpers";

/** The sets of system error codes `src` may hold besides the one in `fileFaults.ts`, by module and constant, each with why it is no copy of the file-fault set. */
const ALLOWED: Readonly<Record<string, string>> = {
  "realPorts.ts DIRECTORY_FLUSH_UNSUPPORTED_CODES": "the codes a directory fsync gives on a file system that cannot flush one, which is no read failure",
  "realIdentityRename.ts GONE_PROCESS_CODES": "the codes signalling a process gives when it has gone, which is no file",
  "realIdentityRename.ts WITHHELD_PROCESS_CODES": "the codes signalling a process gives when it is another user's, which is no file",
  "frontdoor/headroomHop.ts HOP_RESET_CODES": "the codes a socket gives when its peer reset it, which is no file",
};

/** Each `new Set([...])` of string literals that look like system error codes (`E` and capitals) in `source`, as `<module> <constant>`. */
function errorCodeSets(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(file) === "Set" && node.arguments?.[0] !== undefined && ts.isArrayLiteralExpression(node.arguments[0])) {
      const elements = node.arguments[0].elements;
      if (elements.length > 0 && elements.every((element) => ts.isStringLiteral(element) && /^E[A-Z]+$/u.test(element.text))) {
        const holder = node.parent;
        found.push(`${module} ${ts.isVariableDeclaration(holder) ? holder.name.getText(file) : "(inline)"}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every non-test module under `src`, relative to it. */
function modules(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return modules(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path.relative(__dirname, full)] : [];
  });
}

describe("which read failures are a file's own", () => {
  const found = modules(__dirname).flatMap((module) => errorCodeSets(module, fs.readFileSync(path.join(__dirname, module), "utf8")));

  it("are said in one place, so every reader of local files classifies a failure alike", () => {
    expect(found.filter((key) => key !== "fileFaults.ts FILE_FAULT_CODES" && ALLOWED[key] === undefined)).toEqual([]);
  });

  it("names in each allowance a set the module still has, and the one set itself", () => {
    expect(found).toContain("fileFaults.ts FILE_FAULT_CODES");
    expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("finds a copy of a code set in a module", () => {
    expect(errorCodeSets("x.ts", 'const MINE: ReadonlySet<string> = new Set(["EACCES", "ELOOP"]);')).toEqual(["x.ts MINE"]);
  });

  it.each(["EPERM", "ENAMETOOLONG", "EACCES", "ELOOP", "EISDIR"])("has an identity.json read that fails with %s, a fault of the file's own, read as unreadable by every identity reader", (code) => {
    expect(guardedNameRead(() => { throw errorWithCode(`${code}: failed`, code); })).toBe("unreadable");
  });

  it("has an identity.json read that fails for the moment thrown by every identity reader", () => {
    expect(() => guardedNameRead(() => { throw errorWithCode("EMFILE: too many open files", "EMFILE"); })).toThrow(/EMFILE/u);
  });
});
