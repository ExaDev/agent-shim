import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isSourceModule } from "./sourceModules";

import { FILE_FAULT_CODE_LIST } from "./fileFaults";
import { guardedNameRead } from "./identityRecords";
import { errorWithCode } from "./test-helpers";

/** The source modules of `src` (`isSourceModule`), as paths relative to it. */
function sourceModules(): readonly string[] {
  return fs.readdirSync(__dirname, { recursive: true, encoding: "utf8" }).filter(isSourceModule).sort();
}

/** The text of `module` under `src`, or an empty text for one that is gone by the time it is read: another test writes and removes a probe module in `src` while the suite runs, and a module that is no longer there holds nothing. */
function sourceOf(module: string): string {
  try {
    return fs.readFileSync(path.join(__dirname, module), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** The sets of system error codes `src` may hold besides the one in `fileFaults.ts`, by module and constant, each with why it is no copy of the file-fault set. */
const ALLOWED: Readonly<Record<string, string>> = {
  "realPorts.ts DIRECTORY_FLUSH_UNSUPPORTED_CODES": "the codes a directory fsync gives on a file system that cannot flush one, which is no read failure",
  "realIdentityRename.ts GONE_PROCESS_CODES": "the codes signalling a process gives when it has gone, which is no file",
  "realIdentityRename.ts WITHHELD_PROCESS_CODES": "the codes signalling a process gives when it is another user's, which is no file",
  "frontdoor/headroomHop.ts HOP_RESET_CODES": "the codes a socket gives when its peer reset it, which is no file",
};

/** Each array of string literals that look like system error codes (`E` and capitals) in `source`, a `Set` built from one included, as `<module> <constant>`. */
function errorCodeSets(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // An array of codes, whether a `Set` is built from it or not: a list of codes is a set of them however it is held.
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0 && node.elements.every((element) => ts.isStringLiteral(element) && /^E[A-Z]+$/u.test(element.text))) {
      let holder: ts.Node = node.parent;
      while (ts.isNewExpression(holder) || ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent;
      found.push(`${module} ${ts.isVariableDeclaration(holder) ? holder.name.getText(file) : "(inline)"}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The file-fault codes, from `fileFaults.ts` itself, whose naming outside it would classify a failure by hand: all but absence (`ENOENT`), which a reader that asks only whether a file is there compares itself. */
const FILE_FAULT_LITERALS: ReadonlySet<string> = new Set(FILE_FAULT_CODE_LIST.filter((code) => code !== "ENOENT"));

/** The places `src` may name one of those codes by hand, by module, enclosing function and code, each with why it asks another question than whether a read failure is the file's own. */
const INLINE_ALLOWED: Readonly<Record<string, string>> = {
  "realPorts.ts readdir ENOTDIR": "absence: a path through a file lists as an empty directory",
  "realPorts.ts hashFile EISDIR": "absence: a directory where a file was looked for hashes as no file",
  "realPorts.ts realIsProcessAlive EPERM": "process liveness: a signal another user's process refuses",
  "update/commands.ts isProcessAlive EPERM": "process liveness: a signal another user's process refuses",
  "frontdoor/doorDial.ts classify EACCES": "a refused bind on Windows' excluded port ranges, which is no file",
  "frontdoor/doorDial.ts attemptFrom EACCES": "the refusal a dial reports when every port refused it, which is no file",
  "identityRecords.ts guardedNameRead ENOTDIR": "chooses among the codes fileFaultCodeOf already gave, telling a plain file under the identities directory from an identity",
  "realIdentityRename.ts (module) EACCES": "process liveness: the codes a signal gives for another user's process",
  "realIdentityRename.ts (module) EPERM": "process liveness: the codes a signal gives for another user's process",
};

/** Each string literal of `FILE_FAULT_LITERALS` in `source`, as `<module> <enclosing function> <code>`. */
function inlineFaultCodes(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const enclosing = (node: ts.Node): string => {
    for (let current: ts.Node = node.parent; !ts.isSourceFile(current); current = current.parent) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) return current.name.getText(file);
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && (ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent))) return current.parent.name.getText(file);
    }
    return "(module)";
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FILE_FAULT_LITERALS.has(node.text)) found.push(`${module} ${enclosing(node)} ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)];
}

describe("which read failures are a file's own", () => {
  const found = sourceModules().flatMap((module) => errorCodeSets(module, sourceOf(module)));

  it("are listed as a set in fileFaults.ts alone, but where an allowance names another question a set of codes answers", () => {
    expect(found.filter((key) => key !== "fileFaults.ts FILE_FAULT_CODE_LIST" && ALLOWED[key] === undefined)).toEqual([]);
  });

  it("names in each allowance a set the module still has, and the one set itself", () => {
    expect(found).toContain("fileFaults.ts FILE_FAULT_CODE_LIST");
    expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("are named by hand outside fileFaults.ts, all but ENOENT, only where an allowance names another question", () => {
    const inline = sourceModules().filter((module) => module !== "fileFaults.ts").flatMap((module) => inlineFaultCodes(module, sourceOf(module)));
    expect(inline.filter((key) => INLINE_ALLOWED[key] === undefined)).toEqual([]);
    expect(Object.keys(INLINE_ALLOWED).filter((key) => !inline.includes(key))).toEqual([]);
  });

  it("finds a code compared by hand", () => {
    expect(inlineFaultCodes("x.ts", 'function read() { if (error.code === "EACCES" || error.code === "EISDIR") return false; }')).toEqual(["x.ts read EACCES", "x.ts read EISDIR"]);
  });

  it("finds a copy of a code set in a module", () => {
    expect(errorCodeSets("x.ts", 'const MINE: ReadonlySet<string> = new Set(["EACCES", "ELOOP"]);')).toEqual(["x.ts MINE"]);
  });

  it.each(["EPERM", "ENAMETOOLONG", "EACCES", "ELOOP", "EISDIR"])("has guardedNameRead read an identity.json that fails with %s, a fault of the file's own, as unreadable", (code) => {
    expect(guardedNameRead(() => { throw errorWithCode(`${code}: failed`, code); })).toBe("unreadable");
  });

  it("has guardedNameRead throw an identity.json read that fails for the moment", () => {
    expect(() => guardedNameRead(() => { throw errorWithCode("EMFILE: too many open files", "EMFILE"); })).toThrow(/EMFILE/u);
  });
});
