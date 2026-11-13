import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ownEntry } from "./ownEntry";

/** Building the whole program's types takes a few seconds on an idle machine; the bound leaves room for a loaded one. */
const PROGRAM_TIMEOUT_MS = 300_000;

/**
 * The reads of a record by a plain string the guard allows, each as `<module>: <expression>` with its reason: a read that is itself the own-key check, or that the expression around it guards with `Object.hasOwn`.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["src/ownEntry.ts: record[key]", "the one helper, behind its own Object.hasOwn"],
  ["src/antigravity/recursiveSchema.ts: value[key]", "guarded by Object.hasOwn(value, key) in the same expression"],
]);

/** A source of `text` alone, for proving the rule finds each spelling. */
function programOver(text: string): { readonly program: ts.Program; readonly file: string } {
  const file = path.join(__dirname, "__guard-fixture__.ts");
  const host = ts.createCompilerHost({ strict: true, noUncheckedIndexedAccess: true });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => (name === file ? ts.createSourceFile(name, text, version, true) : original(name, version));
  return { program: ts.createProgram([file], { strict: true, noUncheckedIndexedAccess: true, noLib: false }, host), file };
}

/**
 * Every read, in `files`, of a record with a string index signature by a key typed as a plain string (or a template string), and every `key in record` over one: the spellings that answer a name a person or a client chose with what `Object.prototype` holds (`constructor`, `toString`, `__proto__`). Arrays, tuples, maps of a closed set of keys and keys of a literal type are none of these, so they are not listed. A write (`record[key] = value`, `delete`, `++`) never reads an inherited member.
 */
function rawNamedReads(program: ts.Program, files: ReadonlySet<string>, root: string): readonly string[] {
  const checker = program.getTypeChecker();
  const stringIndexed = (type: ts.Type): boolean => {
    const apparent = checker.getApparentType(type);
    return (apparent.isUnion() ? apparent.types : [apparent]).some((member) => checker.getIndexInfoOfType(member, ts.IndexKind.String) !== undefined && !checker.isArrayLikeType(member));
  };
  const plainString = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).some((member) => (member.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) !== 0);
  const found: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!files.has(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) {
        const parent = node.parent;
        const written = (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isDeleteExpression(parent) || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
        if (!written && stringIndexed(checker.getTypeAtLocation(node.expression)) && plainString(checker.getTypeAtLocation(node.argumentExpression))) {
          found.push(`${path.relative(root, source.fileName)}: ${node.getText(source)}`);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && stringIndexed(checker.getTypeAtLocation(node.right)) && plainString(checker.getTypeAtLocation(node.left))) {
        found.push(`${path.relative(root, source.fileName)}: ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("a lookup by a chosen name reads only the record's own keys", () => {
  it("returns nothing for a name every object inherits", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(ownEntry({ a: 1 }, name)).toBeUndefined();
    }
    expect(ownEntry({ constructor: 2 }, "constructor")).toBe(2);
  });

  it("is how every module under src reads a record by a plain string, past the allowances, each of which is still a real site", () => {
    const root = path.join(__dirname, "..");
    const config = ts.readConfigFile(path.join(root, "tsconfig.json"), (file) => ts.sys.readFile(file));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const modules = parsed.fileNames.filter((file) => file.startsWith(path.join(root, "src") + path.sep) && !/\.test\.ts$|TestWorld\.ts$|test-helpers\.ts$/u.test(file));
    const found = rawNamedReads(ts.createProgram(modules, parsed.options), new Set(modules), root);
    expect(found.filter((read) => !ALLOWED.has(read))).toEqual([]);
    expect([...ALLOWED.keys()].filter((allowed) => !found.includes(allowed))).toEqual([]);
  }, PROGRAM_TIMEOUT_MS);

  it.each([
    ["an optional read", "declare const r: Record<string, number> | undefined; declare const k: string; export const v = r?.[k];"],
    ["a plain read", "declare const r: Record<string, number>; declare const k: string; export const v = r[k];"],
    ["a read off a call", "declare function f(): Record<string, number>; declare const k: string; export const v = f()[k];"],
    ["a template key", "declare const r: Record<string, number>; declare const k: string; export const v = r[`p-${k}`];"],
    ["an in test", "declare const r: Record<string, number>; declare const k: string; export const v = k in r;"],
    ["a partial record", "declare const r: Partial<Record<string, number>>; declare const k: string; export const v = r[k];"],
  ])("finds %s", (_label, text) => {
    const { program, file } = programOver(text);
    expect(rawNamedReads(program, new Set([file]), __dirname)).toHaveLength(1);
  });

  it.each([
    ["an array index", "declare const a: number[]; declare const i: number; export const v = a[i];"],
    ["a closed key", "declare const r: Record<\"a\" | \"b\", number>; declare const k: \"a\" | \"b\"; export const v = r[k];"],
    ["a write", "declare const r: Record<string, number>; declare const k: string; r[k] = 1;"],
    ["a literal key", "declare const r: Record<string, number>; export const v = r[\"a\"];"],
  ])("leaves %s alone", (_label, text) => {
    const { program, file } = programOver(text);
    expect(rawNamedReads(program, new Set([file]), __dirname)).toEqual([]);
  });
});
