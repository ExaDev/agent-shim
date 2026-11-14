import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CodexProvider } from "./config/schema";
import { buildLayoutPaths } from "./paths";
import { StoredCatalogue } from "./storedCatalogue";
import { savedCatalogueFingerprint } from "./codex/catalogueCredential";
import { realFsPort } from "./realPorts";

/**
 * What names where a provider's stored catalogue state is kept: the path builders and the layout's directory. A raw read of such a file needs one of them, however the read is spelt (an alias, a ternary, a join, an array of paths mapped over, a stream, a template, a destructured binding, a `require`, a dynamic import), so the guard does not look at the read: it holds the origin of the path. Only the files below may name any of them; every other module reads these files through `StoredCatalogue`, whose one reader is a `TolerantReader`.
 */
const PATH_NAMES: ReadonlySet<string> = new Set(["catalogueCachePath", "catalogueSettingsPath", "catalogueBindingPath", "catalogueGenerationDir", "catalogueStatusFile", "catalogueFailureFile", "catalogueDir"]);

/** The modules whose exports or members give a path: importing one as a namespace, `require`ing it or importing it dynamically reaches the names without writing them. */
const PATH_MODULES: ReadonlySet<string> = new Set(["providerCatalogue", "storedCatalogue", "paths"]);

/** The calls that read the content of a file. */
const CONTENT_READS: ReadonlySet<string> = new Set(["readFileUtf8", "readFileSync", "readFile", "createReadStream", "openSync", "open", "readText"]);

/** How many bare reads the type test below hands a `TolerantReader`'s place. */
const NON_READERS = 3;

/** Why each file may name the paths of the stored state, and so must never read the content of a file: the files that define the names, and the ones that write, move, remove or list the state. */
const MAY_NAME_PATHS: Readonly<Record<string, string>> = {
  "providerCatalogue.ts": "defines the catalogue, digest, binding and generation paths",
  "paths.ts": "defines the catalogue directory of the layout",
  "storedCatalogue.ts": "defines the status and failure paths and reads every file through its `TolerantReader`",
  "catalogueRefresh.ts": "writes a catalogue and its digest",
  "realCatalogueRefresh.ts": "writes a catalogue and its binding to the files the refresh stores them in",
  "providerRename.ts": "moves a provider's stored files with its name",
  "frontdoor/catalogueState.ts": "writes the refresh status and failure records and parses what the store reads",
  "frontdoor/supervisor.ts": "removes the generation directory a stopping door owns",
  "frontdoor/catalogueCleanup.ts": "lists and removes the generation directories of doors that are gone",
  "identityNameLocations.ts": "names the catalogue directory as data, among the places an identity's name is not kept",
};

/**
 * The directory names of the stored state: a path that holds one of them as a segment is a path into the state, however it was joined or computed. `settings` (the digest directory) is never alone: it lies under the catalogue directory, which is named through one of the others or through the layout.
 */
const STATE_SEGMENTS: ReadonlySet<string> = new Set(["catalogues", "supervisors", "failures"]);

/** Which of the state's directory names each file may spell as a literal, and why: the layout and the modules that define, move or remove the files, and the two that spell the same word as a URL route, which names no file. */
const MAY_SPELL_SEGMENT: Readonly<Record<string, { readonly segments: readonly string[]; readonly why: string }>> = {
  "paths.ts": { segments: ["catalogues"], why: "the layout's catalogue directory" },
  "providerCatalogue.ts": { segments: ["supervisors"], why: "the generation directories under the catalogue directory" },
  "storedCatalogue.ts": { segments: ["failures"], why: "the directory of the failure records" },
  "providerRename.ts": { segments: ["supervisors"], why: "moves a provider's files in every generation directory" },
  "frontdoor/catalogueCleanup.ts": { segments: ["supervisors"], why: "lists and removes the generation directories of doors that are gone" },
  "frontdoor/probe.ts": { segments: ["catalogues"], why: "the URL of the door's catalogue refresh route, which names no file" },
  "frontdoor/lifecycleApi.ts": { segments: ["catalogues"], why: "the door's catalogue refresh route, which names no file" },
};

/** The one module that may use a layout value other than by naming a member of it: it builds the layout. */
const MAY_COMPUTE_ON_LAYOUT: Readonly<Record<string, string>> = {
  "paths.ts": "builds the layout",
};

/** Calls that make a new path from an old one, which a path into the state can be made with from its parent or from the layout's root. */
const PATH_DERIVATIONS: ReadonlySet<string> = new Set(["dirname", "relative", "resolve", "normalize"]);

/** The calls that list or copy the members of an object, which a filter over the layout's members goes through. */
/** The calls that list a directory, which the ancestors of the catalogue directory are never given to (a listing of the layout's root would find the state without naming it). */
const LISTINGS: ReadonlySet<string> = new Set(["readdirSync", "readdir", "opendirSync", "opendir", "glob", "globSync", "scandir", "walk"]);

const ENUMERATIONS: ReadonlySet<string> = new Set(["values", "entries", "keys", "assign", "fromEntries", "getOwnPropertyNames", "getOwnPropertyDescriptors", "ownKeys"]);

/**
 * The members of a layout whose path lies on the way to the catalogue directory (its ancestors, and what shares their parent: a path derived from one of them can be the catalogue directory or what lies beside it), computed from the layout itself so the set follows it.
 */
function layoutMembersNearTheState(): ReadonlySet<string> {
  const layout = buildLayoutPaths(path.join(path.sep, "layout-root"));
  const catalogues = layout.catalogueDir;
  const near = (member: string): boolean => catalogues === member || catalogues.startsWith(`${member}${path.sep}`) || path.dirname(member) === path.dirname(catalogues) || catalogues.startsWith(`${path.dirname(member)}${path.sep}`);
  return new Set(Object.entries(layout).flatMap(([key, value]) => (typeof value === "string" && near(value) ? [key] : [])));
}

/** What a source may derive display text from without making a path into the state: it takes a relative form of a path for a message. */
const MAY_DERIVE_FROM_LAYOUT: Readonly<Record<string, string>> = {
  "identityRename.ts": "shows paths relative to the root in the steps it plans and in its errors",
  "identityRenameSteps.ts": "shows paths relative to the root in the steps it plans",
};

/** The source of the callee of a call, and the module an import or a `require` names. */
function moduleOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) return node.arguments[0].text;
  return undefined;
}

/** The last path segment of a module specifier: `../providerCatalogue` is `providerCatalogue`. */
const baseName = (specifier: string): string => specifier.split("/").pop() ?? specifier;

/** The string methods the folding of a constant expression applies: pure, with no effect, and the ones a name spelt in pieces is put together or disguised with. */
const FOLDING_METHODS: ReadonlySet<string> = new Set(["join", "replace", "replaceAll", "toLowerCase", "toUpperCase", "concat", "slice", "substring", "split", "reverse", "trim", "padStart", "padEnd", "repeat", "at", "charAt", "normalize"]);

/** The deepest chain of constants (`const d = "cat"; const e = d + "alogue"`) the folding follows. */
const FOLDING_DEPTH = 6;

/** What a constant expression folds to, or `undefined` when any part of it is not constant. */
type Folded = string | number | readonly Folded[] | undefined;

interface Checked {
  readonly checker: ts.TypeChecker;
  readonly source: ts.SourceFile;
}

/** Whether `type` is the layout, however it was reached: the type itself, an alias or wrapper of it (`Readonly<LayoutPaths>`, `Pick<LayoutPaths, ...>`), or a member of a union or intersection of them. */
function isLayoutType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.getSymbol()?.name === "LayoutPaths" || type.aliasSymbol?.name === "LayoutPaths") return true;
  if (type.aliasTypeArguments?.some((argument) => isLayoutType(argument, seen)) === true) return true;
  return type.isUnionOrIntersection() && type.types.some((member) => isLayoutType(member, seen));
}

/** The declaration a name was introduced by when it is a `const` with an initialiser, which is the constant it stands for. */
function constantInitialiser(node: ts.Identifier, { checker }: Checked): ts.Expression | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined;
}

/** What `node` folds to, evaluated by this function's own reading of it and never by running it: literals, templates and `+` of constants, array literals, constants a `const` names, and the pure string methods, `String.fromCharCode`, `atob` and a base64 or hex `Buffer` decoded to text. */
function fold(node: ts.Node, checked: Checked, depth = 0): Folded {
  if (depth > FOLDING_DEPTH) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return fold(node.expression, checked, depth);
  if (ts.isIdentifier(node)) {
    const initialiser = constantInitialiser(node, checked);
    return initialiser === undefined ? undefined : fold(initialiser, checked, depth + 1);
  }
  if (ts.isTemplateExpression(node)) {
    const parts: Folded[] = [node.head.text, ...node.templateSpans.flatMap((span) => [fold(span.expression, checked, depth), span.literal.text])];
    return parts.some((part) => part === undefined) ? undefined : parts.map(String).join("");
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = fold(node.left, checked, depth);
    const right = fold(node.right, checked, depth);
    if (typeof left === "string" && (typeof right === "string" || typeof right === "number")) return left + String(right);
    return typeof left === "number" && typeof right === "string" ? String(left) + right : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const members = node.elements.map((element) => fold(element, checked, depth));
    return members.some((member) => member === undefined) ? undefined : members;
  }
  if (ts.isCallExpression(node)) return foldCall(node, checked, depth);
  return undefined;
}

/** The fold of a call: a pure method of a folded string or array, `String.fromCharCode`, `atob`, or a base64 or hex `Buffer` turned into text. */
function foldCall(node: ts.CallExpression, checked: Checked, depth: number): Folded {
  const callee = node.expression;
  const args = node.arguments.map((argument) => fold(argument, checked, depth));
  if (args.some((argument) => argument === undefined)) return undefined;
  const calleeText = callee.getText(checked.source);
  if (calleeText === "String.fromCharCode") return String.fromCharCode(...args.map(Number));
  if (calleeText === "atob" && typeof args[0] === "string") return atob(args[0]);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toString" && ts.isCallExpression(callee.expression) && callee.expression.expression.getText(checked.source) === "Buffer.from") {
    const [data, encoding] = callee.expression.arguments.map((argument) => fold(argument, checked, depth));
    return typeof data === "string" && (encoding === "base64" || encoding === "hex") ? Buffer.from(data, encoding).toString("utf8") : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee) || !FOLDING_METHODS.has(callee.name.text)) return undefined;
  const target = fold(callee.expression, checked, depth);
  if (typeof target !== "string" && !Array.isArray(target)) return undefined;
  const method: unknown = Reflect.get(Object(target), callee.name.text);
  if (typeof method !== "function") return undefined;
  const applied: unknown = Reflect.apply(method, target, args);
  return typeof applied === "string" || typeof applied === "number" || Array.isArray(applied) ? (applied as Folded) : undefined;
}

/** The operands of a chain of `+`, left to right. */
function plusOperands(node: ts.Expression): readonly ts.Expression[] {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken ? [...plusOperands(node.left), ...plusOperands(node.right)] : [node];
}

/** Whether `node` is the module a `import`, `export ... from`, `require` or `import()` names, which is a module path and no file path. */
function isModuleSpecifier(node: ts.Node): boolean {
  return moduleOf(node.parent) !== undefined || (ts.isExportDeclaration(node.parent) && node.parent.moduleSpecifier === node);
}

/** What a source says that reaches a stored catalogue file's path, however it is spelt, and the content-read calls it makes. */
interface Scanned {
  /** The path builders and the layout's directory it names, and the module routes to them. */
  readonly names: readonly string[];
  /** The content-read calls it makes. */
  readonly reads: readonly string[];
  /** The directory names of the state it spells as a path segment, in a string, a template, or any constant expression that folds to one (`"cata" + "logues"`, a joined array, a constant, a decoded base64). */
  readonly segments: readonly string[];
  /** What it does with a layout value besides naming a member of it: a computed member, an enumeration or spread of its members, a path derived from the members near the state, a listing of an ancestor of the catalogue directory, a path segment built by string operations next to a member. */
  readonly layoutUses: readonly string[];
}

/** The members of the layout that lie on the way to the catalogue directory, as the path of each: `members` is as `layoutMembersNearTheState` found them, `ancestors` those whose path holds the catalogue directory. */
function layoutMembers(): { readonly near: ReadonlySet<string>; readonly ancestors: ReadonlySet<string> } {
  const layout = buildLayoutPaths(path.join(path.sep, "layout-root"));
  const catalogues = layout.catalogueDir;
  const ancestors = new Set(Object.entries(layout).flatMap(([key, value]) => (typeof value === "string" && catalogues.startsWith(`${value}${path.sep}`) ? [key] : [])));
  return { near: layoutMembersNearTheState(), ancestors };
}

/** Whether `node` names a member of a layout value (typed `LayoutPaths`, wherever it came from), or a constant that does, and which member. */
function layoutMemberOf(node: ts.Node, checked: Checked, depth = 0): string | undefined {
  if (depth > FOLDING_DEPTH) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return layoutMemberOf(node.expression, checked, depth);
  if (ts.isPropertyAccessExpression(node) && isLayoutType(checked.checker.getTypeAtLocation(node.expression))) return node.name.text;
  if (ts.isElementAccessExpression(node) && isLayoutType(checked.checker.getTypeAtLocation(node.expression))) {
    const key = fold(node.argumentExpression, checked);
    return typeof key === "string" ? key : "(computed)";
  }
  if (ts.isIdentifier(node)) {
    const initialiser = constantInitialiser(node, checked);
    return initialiser === undefined ? undefined : layoutMemberOf(initialiser, checked, depth + 1);
  }
  return undefined;
}

function scanSource(checked: Checked): Scanned {
  const { checker, source } = checked;
  const names = new Set<string>();
  const reads = new Set<string>();
  const segments = new Set<string>();
  const layoutUses = new Set<string>();
  const { near, ancestors } = layoutMembers();
  const isLayout = (node: ts.Node): boolean => isLayoutType(checker.getTypeAtLocation(node));
  const addSegments = (value: string): void => {
    for (const segment of value.split(/[\\/]/u)) if (STATE_SEGMENTS.has(segment)) segments.add(segment);
  };
  /** The path text a run of constants spells, and the names among them: every maximal run of constant operands of a `+` chain or of a template is folded as one text. */
  const addFolded = (node: ts.Node): void => {
    const folded = fold(node, checked);
    if (typeof folded === "string") {
      addSegments(folded);
      if (PATH_NAMES.has(folded)) names.add(folded);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      let run = "";
      for (const operand of plusOperands(node)) {
        const value = fold(operand, checked);
        if (typeof value === "string" || typeof value === "number") run += String(value);
        else {
          addSegments(run);
          run = "";
        }
      }
      addSegments(run);
    }
    if (ts.isTemplateExpression(node)) {
      let run = node.head.text;
      for (const span of node.templateSpans) {
        const value = fold(span.expression, checked);
        if (typeof value === "string" || typeof value === "number") run += String(value) + span.literal.text;
        else {
          addSegments(run);
          run = span.literal.text;
        }
      }
      addSegments(run);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && PATH_NAMES.has(node.text)) names.add(node.text);
    if (ts.isStringLiteralLike(node) && PATH_NAMES.has(node.text)) names.add(node.text);
    if (ts.isStringLiteralLike(node) && !isModuleSpecifier(node)) addSegments(node.text);
    if (ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isCallExpression(node) || ts.isIdentifier(node)) addFolded(node);
    const specifier = moduleOf(node);
    if (specifier !== undefined && PATH_MODULES.has(baseName(specifier)) && (ts.isCallExpression(node) || (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined && ts.isNamespaceImport(node.importClause.namedBindings)))) {
      names.add(`${ts.isCallExpression(node) ? "dynamic route to" : "namespace import of"} ${baseName(specifier)}`);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && node.exportClause === undefined && PATH_MODULES.has(baseName(node.moduleSpecifier.text))) {
      names.add(`star re-export of ${baseName(node.moduleSpecifier.text)}`);
    }
    if (ts.isElementAccessExpression(node) && isLayout(node.expression)) {
      const key = fold(node.argumentExpression, checked);
      if (typeof key !== "string") layoutUses.add("computed member of a layout value");
      else if (PATH_NAMES.has(key)) names.add(key);
    }
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isLayout(node.expression)) layoutUses.add("spread of a layout value");
    if (ts.isForInStatement(node) && isLayout(node.expression)) layoutUses.add("enumeration of a layout value");
    if (ts.isObjectBindingPattern(node) && ts.isVariableDeclaration(node.parent) && node.parent.initializer !== undefined && isLayout(node.parent.initializer) && node.elements.some((element) => element.dotDotDotToken !== undefined)) layoutUses.add("rest of a layout value");
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
      if (callee !== undefined && CONTENT_READS.has(callee)) reads.add(callee);
      if (callee !== undefined && ENUMERATIONS.has(callee) && node.arguments.some(isLayout)) layoutUses.add("enumeration of a layout value");
      if (callee !== undefined && PATH_DERIVATIONS.has(callee)) {
        for (const argument of node.arguments) {
          const member = layoutMemberOf(argument, checked);
          if (member !== undefined && (near.has(member) || member === "(computed)")) layoutUses.add(`derivation from layout member ${member}`);
        }
      }
      if (callee !== undefined && LISTINGS.has(callee)) {
        for (const argument of node.arguments) {
          const member = layoutMemberOf(argument, checked);
          if (member !== undefined && (ancestors.has(member) || member === "(computed)")) layoutUses.add(`listing of layout member ${member}`);
        }
      }
      if (callee !== undefined && (callee === "join" || callee === "resolve") && node.arguments.some((argument) => layoutMemberOf(argument, checked) !== undefined)) {
        for (const argument of node.arguments) {
          if (layoutMemberOf(argument, checked) !== undefined || fold(argument, checked) !== undefined) continue;
          if (isBuiltSegment(argument)) layoutUses.add("a path segment built by string operations next to a layout member");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names: [...names].sort(), reads: [...reads].sort(), segments: [...segments].sort(), layoutUses: [...layoutUses].sort() };
}

/** Whether `node` is a path segment assembled from text by string operations rather than named or passed in: a `+` chain with a constant piece in it, or a call of a string method on a constant (what a name spelt in pieces looks like when one piece is not constant). */
function isBuiltSegment(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isBuiltSegment(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return plusOperands(node).some((operand) => ts.isStringLiteralLike(operand));
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && FOLDING_METHODS.has(node.expression.name.text) && (ts.isStringLiteralLike(node.expression.expression) || ts.isArrayLiteralExpression(node.expression.expression));
}

/** The declarations every fixture is checked against: the layout type the guard follows by its name, and the names the fixtures use. */
const FIXTURE_PREAMBLE = `
interface LayoutPaths { readonly root: string; readonly providersDir: string; readonly catalogueDir: string; readonly frontdoorLogPath: string; readonly headroomAllowlistFile: string; readonly activeIdentityFile: string }
declare const paths: LayoutPaths;
declare const layout: LayoutPaths;
declare const deps: { readonly paths: LayoutPaths };
declare const params: { readonly paths: LayoutPaths };
declare const path: { join(...parts: string[]): string; dirname(value: string): string; resolve(...parts: string[]): string; relative(from: string, to: string): string; normalize(value: string): string };
declare const fs: { readFileSync(file: string, encoding?: string): string; readdirSync(directory: string): string[]; createReadStream(file: string): unknown; mkdirSync(directory: string): void };
declare const port: { readFileUtf8(file: string): string | undefined };
declare const Buffer: { from(data: string, encoding?: string): { toString(encoding?: string): string } };
declare function atob(data: string): string;
declare function require(module: string): any;
declare function glob(pattern: string): string[];
declare const name: string;
declare const which: string;
declare const wanted: string;
declare const prefix: string;
declare const root: string;
declare const base: string;
declare const directory: string;
declare const owned: boolean;
declare const pid: number;
declare const generation: string;
declare const owner: { readonly pid: number; readonly generation: string };
declare const file: string;
declare const a: string;
declare const names: string[];
declare const other: { [key: string]: string };
declare const mod: unknown;
`;

/** The scan of a fixture: a program of the preamble and the fixture, checked as the production sources are. */
function scan(text: string): Scanned {
  const files = new Map<string, string>([["/fixture/preamble.d.ts", FIXTURE_PREAMBLE], ["/fixture/fixture.ts", `${text}\nexport {};\n`]]);
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, lib: ["lib.es2023.d.ts"], strict: true, noEmit: true, skipLibCheck: true, types: [], noResolve: true };
  const host = ts.createCompilerHost(options);
  const original = { getSourceFile: host.getSourceFile.bind(host), fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host) };
  host.getSourceFile = (name, languageVersion, ...rest) => (files.has(name) ? ts.createSourceFile(name, files.get(name) ?? "", languageVersion, true) : original.getSourceFile(name, languageVersion, ...rest));
  host.fileExists = (name) => files.has(name) || original.fileExists(name);
  host.readFile = (name) => files.get(name) ?? original.readFile(name);
  const program = ts.createProgram({ rootNames: [...files.keys()], options, host });
  const source = program.getSourceFile("/fixture/fixture.ts");
  if (source === undefined) throw new Error("the fixture was not parsed");
  return scanSource({ checker: program.getTypeChecker(), source });
}

/** Every production source: `src` without tests. */
function productionSources(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const SRC = path.resolve(__dirname);

/** Every production source scanned with the types of the repository's own program (its tsconfig), so a layout value is found by its type wherever it came from. */
function scanProduction(): readonly (Scanned & { readonly file: string })[] {
  const configPath = path.resolve(SRC, "..", "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); } });
  if (parsed === undefined) throw new Error("tsconfig.json was not parsed");
  const production = new Set(productionSources(SRC).map((file) => path.resolve(file)));
  const program = ts.createProgram({ rootNames: parsed.fileNames.filter((file) => production.has(path.resolve(file))), options: { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined } });
  const checker = program.getTypeChecker();
  return program.getSourceFiles().filter((source) => production.has(path.resolve(source.fileName))).map((source) => ({ file: path.relative(SRC, source.fileName).split(path.sep).join("/"), ...scanSource({ checker, source }) }));
}

/** The scans of the production sources are made once: reading a whole program's types takes a few seconds. */
const sources = scanProduction();
describe("where a provider's stored catalogue state is named", () => {
  it("is in the files that define, write, move or remove it, and in no file that could read it raw", () => {
    expect(sources.filter((entry) => entry.names.length > 0 && !(entry.file in MAY_NAME_PATHS)).map((entry) => `${entry.file}: ${entry.names.join(", ")}`)).toEqual([]);
  });

  it("is in no file that reads the content of a file, so the files that may name it never read it", () => {
    expect(sources.filter((entry) => entry.file in MAY_NAME_PATHS && entry.reads.length > 0).map((entry) => `${entry.file}: ${entry.reads.join(", ")}`)).toEqual([]);
  });

  it("is in files that all still name one, so an allowance that stopped being needed is removed", () => {
    expect(Object.keys(MAY_NAME_PATHS).filter((file) => sources.find((entry) => entry.file === file)?.names.length === 0)).toEqual([]);
  });
});

describe("where a directory name of the stored state is spelt", () => {
  it("is in the files that define, move or remove the state, and each spells only the names it is allowed", () => {
    const spelt = sources.flatMap((entry) => entry.segments.filter((segment) => !(MAY_SPELL_SEGMENT[entry.file]?.segments.includes(segment) ?? false)).map((segment) => `${entry.file}: ${segment}`));
    expect(spelt).toEqual([]);
  });

  it("is in files that all still spell what they are allowed, so an allowance that stopped being needed is removed", () => {
    const unused = Object.entries(MAY_SPELL_SEGMENT).flatMap(([file, allowed]) => allowed.segments.filter((segment) => !(sources.find((entry) => entry.file === file)?.segments.includes(segment) ?? false)).map((segment) => `${file}: ${segment}`));
    expect(unused).toEqual([]);
  });
});

describe("what is done with the layout's members", () => {
  it("is never computed, enumerated or spread outside the module that builds the layout, and no path is derived from the members near the state outside the modules that only show one", () => {
    const found = sources.flatMap((entry) => entry.layoutUses.filter((use) => !(entry.file in MAY_COMPUTE_ON_LAYOUT) && !(entry.file in MAY_DERIVE_FROM_LAYOUT && use.startsWith("derivation from"))).map((use) => `${entry.file}: ${use}`));
    expect(found).toEqual([]);
  });

  it("is derived from only in files that still do it, so an allowance that stopped being needed is removed", () => {
    const unused = Object.keys(MAY_DERIVE_FROM_LAYOUT).filter((file) => !(sources.find((entry) => entry.file === file)?.layoutUses.some((use) => use.startsWith("derivation from")) ?? false));
    expect(unused).toEqual([]);
  });
});

/** Every way a source can reach a stored catalogue file's path, which the scan must see: each one fails the guard in a module that is not allowed to name one. */
describe("the scan for a name that reaches a stored catalogue file's path", () => {
  const SLIPPING: readonly (readonly [string, string])[] = [
    ["a direct call", 'fs.readFileSync(catalogueCachePath(paths, name), "utf8");'],
    ["an aliased import", 'import { catalogueCachePath as where } from "./providerCatalogue";\nfs.readFileSync(where(paths, name));'],
    ["a ternary argument", "fs.readFileSync(owned ? catalogueCachePath(paths, name, pid, generation) : catalogueSettingsPath(paths, name));"],
    ["a ternary local", "const file = owned ? catalogueCachePath(paths, name, pid, generation) : catalogueSettingsPath(paths, name);\nfs.readFileSync(file);"],
    ["a join over the directory of one", 'fs.readFileSync(path.join(path.dirname(catalogueCachePath(paths, name)), "other.json"));'],
    ["an array of paths mapped over a read", "[catalogueCachePath(paths, a), catalogueSettingsPath(paths, a)].map((file) => port.readFileUtf8(file));"],
    ["a read stream", "fs.createReadStream(catalogueBindingPath(paths, name));"],
    ["a property of an object", "const stored = { where: catalogueFailureFile(paths, owner, name) };\nport.readFileUtf8(stored.where);"],
    ["a template literal", "port.readFileUtf8(`${catalogueStatusFile(paths, owner, name)}`);"],
    ["a destructured binding", 'const { catalogueCachePath: locate } = require("./providerCatalogue");\nport.readFileUtf8(locate(paths, name));'],
    ["the layout's directory joined by hand", 'fs.readFileSync(path.join(paths.catalogueDir, "spark.json"));'],
    ["the layout's directory by a string key", 'fs.readFileSync(path.join(paths["catalogueDir"], "spark.json"));'],
    ["a require of the module", 'const where = require("./providerCatalogue").catalogueGenerationDir;'],
    ["a require whose member is chosen at run time", 'const builders = require("../providerCatalogue");\nbuilders[which](paths, name);'],
    ["a dynamic import", 'const builders = await import("./providerCatalogue");\nbuilders[which](paths, name);'],
    ["a namespace import", 'import * as builders from "./providerCatalogue";\nbuilders[which](paths, name);'],
    ["a star re-export of the module", 'export * from "./providerCatalogue";'],
    ["a star re-export of the layout module", 'export * from "../paths";'],
    ["a member of a layout reached through a property, by the builder's name", 'fs.readFileSync(path.join(deps.paths["catalogueDir"], name));'],
  ];

  it.each(SLIPPING)("sees %s", (_label, text) => {
    expect(scan(text).names).not.toEqual([]);
  });

  /** Spellings that name no builder and no member of the layout, found by what they say of the state's directory names and of the layout: each fails the guard through the rule beside it. */
  const SEGMENTS: readonly (readonly [string, string])[] = [
    ["a join from the layout's root with the directory's name", 'fs.readFileSync(path.join(paths.root, "catalogues", `${name}.json`));'],
    ["a join from the parent of a sibling directory", 'fs.readFileSync(path.join(path.dirname(paths.providersDir), "catalogues", `${name}.json`));'],
    ["a path in a template literal", "fs.readFileSync(`${root}/catalogues/${name}.json`);"],
    ["the name of the generation directories", 'path.join(base, "supervisors", String(pid));'],
    ["the name of the failure records' directory", 'path.join(directory, "failures", `${name}.json`);'],
    ["a name spelt in two parts", 'path.join(base, "catalog" + "ues", name);'],
    ["a name with a backslash separator", String.raw`path.join(base, "x\\catalogues\\y");`],
    ["a chain of + with a part that is not constant", 'const target = root + "/cata" + "logues/" + n;'],
    ["a name joined from an array", 'path.join(base, ["cata", "logues"].join(""));'],
    ["a name put through replace", 'path.join(base, "catalXogues".replace("X", ""));'],
    ["a name put through replaceAll and case", 'path.join(base, "CATALOGUES".toLowerCase());'],
    ["a name reversed", 'path.join(base, "seugolatac".split("").reverse().join(""));'],
    ["a name decoded from base64", 'path.join(base, atob("Y2F0YWxvZ3Vlcw=="));'],
    ["a name decoded from base64 through a buffer", 'path.join(base, Buffer.from("Y2F0YWxvZ3Vlcw==", "base64").toString());'],
    ["a name decoded from hex", 'path.join(base, Buffer.from("636174616c6f67756573", "hex").toString());'],
    ["a name from character codes", "path.join(base, String.fromCharCode(115, 117, 112, 101, 114, 118, 105, 115, 111, 114, 115));"],
    ["a name from a template put through a string method", 'path.join(base, `CATA${"LOGUES"}`.toLowerCase());'],
    ["a name in a template over a constant", 'const d = "catalogue";\npath.join(base, `${d}s`);'],
    ["a name put together over a chain of constants", 'const a1 = "cata";\nconst a2 = a1 + "log";\npath.join(base, a2 + "ues");'],
    ["a template with a part that is not constant", "const target = `${root}/cata${'logues'}/${name}`;"],
  ];

  it.each(SEGMENTS)("sees %s", (_label, text) => {
    expect(scan(text).segments).not.toEqual([]);
  });

  /** What no fold can see: a name made from text the scan does not hold (read from a file, taken from an environment variable, returned by a helper, a parameter). The rule is honest about it: these pass, and the type of the readers is what stops a read of such a file. */
  const OUT_OF_REACH: readonly (readonly [string, string])[] = [
    ["text read from a file", 'path.join(base, fs.readFileSync(file, "utf8"));'],
    ["a name passed in as a parameter", "function f(segment: string) {\n  return path.join(base, segment);\n}"],
    ["a name from a record", "path.join(base, other[which]);"],
  ];

  it.each(OUT_OF_REACH)("does not see %s, and says so", (_label, text) => {
    expect(scan(text).segments).toEqual([]);
  });

  const LAYOUT_USES: readonly (readonly [string, string])[] = [
    ["a member chosen by a variable", "fs.readFileSync(path.join(paths[which], `${name}.json`));"],
    ["the layout's members filtered and joined", "Object.values(paths).filter((member) => member.includes(wanted)).map((member) => path.join(member, name));"],
    ["the layout's entries", "Object.entries(paths).find(([key]) => key.startsWith(prefix));"],
    ["the layout's keys", "Object.keys(paths).map((key) => key);"],
    ["the layout spread into another object", "const copy = { ...paths, root: elsewhere };"],
    ["the layout enumerated with for in", "for (const key in paths) names.push(key);"],
    ["a layout held by a typed parameter, which is not called paths", "function f(layout: LayoutPaths, other: LayoutPaths) {\n  return Object.values(other);\n}"],
    ["a layout held by a property this source declares", "class Holder {\n  readonly paths: LayoutPaths;\n  list() {\n    return Object.values(this.paths);\n  }\n}"],
    ["the directory of a sibling directory", "path.dirname(paths.providersDir);"],
    ["the root resolved against a name", 'path.resolve(paths.root, "..", name);'],
    ["the layout's root made relative", "path.relative(paths.root, file);"],
    ["a layout reached through a property that is not called paths", "Object.values(deps.paths);"],
    ["a member of such a layout chosen by a variable", "fs.readFileSync(path.join(deps.paths[which], name));"],
    ["such a layout spread", "const copy = { ...deps.paths };"],
    ["a layout held by another property", "Object.keys(params.paths);"],
    ["a layout passed as an alias", "const q = paths;\nObject.values(q);"],
    ["a layout held as a read-only wrapper of its type", "function f(held: Readonly<LayoutPaths>) {\n  return Object.values(held);\n}"],
    ["a layout held as a picked part of its type", "function f(held: Pick<LayoutPaths, 'root' | 'providersDir'>) {\n  return Object.values(held);\n}"],
    ["a layout held as a member of a union", "function f(held: LayoutPaths | undefined) {\n  return held === undefined ? [] : Object.values(held);\n}"],
    ["a layout held as part of an intersection", "function f(held: LayoutPaths & { readonly extra: string }) {\n  return Object.values(held);\n}"],
    ["a layout destructured in a parameter under another name", "function f({ paths: p }: { paths: LayoutPaths }) {\n  return Object.values(p);\n}"],
    ["a layout with its rest taken", "const { root: r, ...others } = paths;"],
    ["a path derived from a member of such a layout", "path.dirname(deps.paths.providersDir);"],
    ["a path derived from a member held in a constant", 'const base2 = paths.providersDir;\npath.resolve(base2, "..");'],
    ["a path derived from a member held through two constants", 'const first = paths.providersDir;\nconst second = first;\npath.resolve(second, "..", name);'],
    ["a listing of the layout's root", "fs.readdirSync(paths.root);"],
    ["a listing of the root of a layout held by a property", "fs.readdirSync(deps.paths.root);"],
    ["a glob over the root", "glob(paths.root);"],
    ["a path segment built next to a member by +", 'path.join(paths.root, "cata" + which);'],
    ["a path segment built next to a member by a string method", 'path.join(paths.root, ["cata", which].join(""));'],
  ];

  it.each(LAYOUT_USES)("sees %s", (_label, text) => {
    expect(scan(text).layoutUses).not.toEqual([]);
  });

  it("sees a member of the layout whose name is spelt in two parts, as the name it makes", () => {
    expect(scan('fs.readFileSync(path.join(paths["catalogue" + "Dir"], `${name}.json`));').names).toEqual(["catalogueDir"]);
  });

  it("passes the uses of a layout that make no path into the state, and a module path that spells a directory's name", () => {
    const text = [
      "path.join(deps.paths.providersDir, `${name}.json`);",
      "fs.readdirSync(deps.paths.providersDir);",
      "const here = paths.frontdoorLogPath;\nfs.mkdirSync(path.dirname(here));",
      'path.join(paths.root, "providers", `${name}.json`);',
      'path.join(paths.providersDir, "x" + "y");',
      'import { translatorFor } from "./messages/catalogues";',
      'const settings = path.join(directory, "settings", "x.json");',
      "fs.mkdirSync(path.dirname(paths.frontdoorLogPath));",
      "const file = paths.providersDir;",
      "const mine = Object.values(other);",
      "const { root: onlyRoot } = paths;",
      'path.join(paths.root, "providers", name);',
      'const route = { settings: "settings" };',
    ].join("\n");
    expect(scan(text)).toEqual({ names: [], reads: [], segments: [], layoutUses: [] });
  });

  it("passes a source that reads through the store, and a read of a file that is no stored state", () => {
    const text = [
      'import { StoredCatalogue } from "./storedCatalogue";',
      "const text = stored.cacheText(name, owner);",
      "fs.readFileSync(paths.activeIdentityFile);",
      'import { parseCatalogueCache } from "./providerCatalogue";',
    ].join("\n");
    expect(scan(text).names).toEqual([]);
  });

  it("finds a content read in a module that may name a path", () => {
    expect(scan("fs.readFileSync(file);\nport.readFileUtf8(other);\nfs.createReadStream(third);").reads).toEqual(["createReadStream", "readFileSync", "readFileUtf8"]);
  });
});

/** The read of a file the stored state's modules take is a `TolerantReader`, a nominal type: a bare reader does not type-check, which `tsc` (and so the typecheck of this repository) proves with the lines below, each of which would fail to compile without its `@ts-expect-error`. */
describe("the readers a stored file is read through", () => {
  const codex: CodexProvider = { kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } };
  const paths = buildLayoutPaths("/nonexistent/agent-shim");

  it("are a TolerantReader, never a bare read function", () => {
    // @ts-expect-error a bare read of the login file is not a TolerantReader
    const bareLogin = (): unknown => savedCatalogueFingerprint(codex, paths, {}, "/nonexistent", realFsPort.readFileUtf8);
    // @ts-expect-error an object that merely has a `read` method is not a TolerantReader either (its state is private)
    const lookalike = (): unknown => savedCatalogueFingerprint(codex, paths, {}, "/nonexistent", { read: realFsPort.readFileUtf8 });
    // @ts-expect-error a store is made over a TolerantReader, not a bare read
    const bareStore = (): unknown => new StoredCatalogue(paths, realFsPort.readFileUtf8);
    expect([bareLogin, lookalike, bareStore]).toHaveLength(NON_READERS);
  });
});
