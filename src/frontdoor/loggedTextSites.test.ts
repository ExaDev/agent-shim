import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The modules of this feature that put text into a log line or an error message. A text a provider supplies (a model id, a tool name, a catalogue entry) is quoted and cut by `quotedForLog` before it reaches a message, so a hostile one cannot start a line of its own or fill one. The guard follows every text that reaches a message: a template or a concatenation passed to a logging or error-building call, a `message` property, an error constructor, and a name that was bound to such a text first.
 */
const SCANNED = ["frontdoor/httpRequestEdits.ts", "frontdoor/servedModel.ts", "catalogueKeeper.ts", "frontdoor/providerRoute.ts", "providerCatalogue.ts"];

/** The calls whose arguments are log lines or error messages, and which of their arguments carry the text (the others are status codes and responses); no index means every argument. */
const MESSAGE_CALLS: ReadonlyMap<string, number | undefined> = new Map([["log", 0], ["refuse", 2], ["failed", 1], ["error", undefined], ["warn", undefined]]);

/** The calls that make a text safe to write into a message. */
const QUOTING_CALLS = new Set(["quotedForLog", "droppedRecord"]);

/** An expression a scanned module may write raw into a message, with why it is safe. `declaredBy`, when present, must match the text of the statement that binds the expression's first identifier, which ties an allowance to one binding and not to a spelling. */
interface RawAllowance {
  readonly file: string;
  readonly expression: string;
  readonly why: string;
  /** How many times the module writes this expression raw into a message. The count is exact: a new site that spells it the same way is one more than allowed and fails, and a site that goes leaves an entry that counts nothing and fails too, so each allowance is a statement about the sites that exist. */
  readonly sites: number;
  readonly declaredBy?: RegExp;
}

const RAW_OK: readonly RawAllowance[] = [
  { file: "frontdoor/httpRequestEdits.ts", expression: "deps.provider", sites: 6, why: "the provider's name, from the person's own configuration" },
  { file: "frontdoor/httpRequestEdits.ts", expression: "removal.key", sites: 1, why: "one of two keys the door looks for" },
  { file: "frontdoor/httpRequestEdits.ts", expression: "AUTO_MODEL", sites: 3, why: "the model name the door itself reserves" },
  { file: "frontdoor/httpRequestEdits.ts", expression: "tooLarge", sites: 2, why: "the limit message the door builds from its own limit and the provider's name", declaredBy: /bodyTooLargeMessage\(/ },
  { file: "frontdoor/httpRequestEdits.ts", expression: "served.message", sites: 1, why: "the message the served-model lookup built from its own texts (this module's own scan covers servedModel.ts)" },
  { file: "frontdoor/httpRequestEdits.ts", expression: "encoded", sites: 1, why: "the message the encoding check built from its own text and a quoted header value", declaredBy: /encodedRequestMessage\(/ },
  { file: "frontdoor/providerRoute.ts", expression: "encoded", sites: 1, why: "the message the encoding check built from its own text and a quoted header value", declaredBy: /encodedRequestMessage\(/ },
  { file: "frontdoor/servedModel.ts", expression: "source.name", sites: 3, why: "the provider's name, from the person's own configuration" },
  { file: "frontdoor/servedModel.ts", expression: "credential.message", sites: 1, why: "the door's own credential resolution message" },
  { file: "frontdoor/servedModel.ts", expression: "error.message", sites: 1, why: "an error the door's own fetch raised, which names status codes and redacted addresses and no text a server chose" },
  { file: "frontdoor/servedModel.ts", expression: "String(error)", sites: 1, why: "an error the door's own fetch raised" },
  { file: "frontdoor/servedModel.ts", expression: "message", sites: 1, why: "the parameter of the failure builder, whose every call is itself scanned", declaredBy: /^message: string$/ },
  { file: "catalogueKeeper.ts", expression: "name", sites: 3, why: "the provider's name, from the person's own configuration, as the keeper's loop binds it", declaredBy: /cataloguedProviders\(/ },
  { file: "frontdoor/providerRoute.ts", expression: "line", sites: 1, why: "a log line a subsystem of the door built, scanned where it is built", declaredBy: /^line: string$/ },
  { file: "frontdoor/providerRoute.ts", expression: "bodyTooLargeMessage(limitBytes, provider)", sites: 1, why: "the limit message the door builds from its own limit and the provider named in the request path, which is the client's own text and goes back to it in a JSON error body" },
  { file: "frontdoor/providerRoute.ts", expression: "path", sites: 1, why: "the request path the client sent, echoed back to that client in a JSON error body" },
  { file: "frontdoor/providerRoute.ts", expression: "JSON.stringify(provider)", sites: 1, why: "the provider name from the request path, quoted with JSON escapes, in a JSON error body to the client that sent it" },
  { file: "frontdoor/providerRoute.ts", expression: "provider", sites: 3, why: "a provider name: from the person's own configuration or, in a refusal, the request path the client sent, in a JSON error body to that client" },
  { file: "frontdoor/providerRoute.ts", expression: "error.message", sites: 1, why: "the message of a configuration error naming the person's own provider file and the keys it got wrong" },
  { file: "frontdoor/providerRoute.ts", expression: "String(error)", sites: 1, why: "a configuration error on the person's own provider file" },
  { file: "frontdoor/providerRoute.ts", expression: "res.message", sites: 1, why: "the door's own credential resolution message" },
  { file: "frontdoor/providerRoute.ts", expression: "resolution.message", sites: 1, why: "the door's own credential resolution message" },
  { file: "frontdoor/providerRoute.ts", expression: '[...visited, providerName].join(" -> ")', sites: 1, why: "provider names from the person's own routes lists" },
  { file: "frontdoor/providerRoute.ts", expression: "account.model", sites: 2, why: "a model name from the person's own models block" },
  { file: "frontdoor/providerRoute.ts", expression: "account.identity", sites: 3, why: "an identity name from the person's own models block, validated as a file name" },
  { file: "frontdoor/providerRoute.ts", expression: "routed.refusal", sites: 1, why: "a refusal the resolver built from the person's own configuration" },
  { file: "frontdoor/providerRoute.ts", expression: "AMBIGUOUS_MODEL_MESSAGE", sites: 2, why: "a fixed message" },
  { file: "frontdoor/providerRoute.ts", expression: "claudeNameTier(requested)", sites: 3, why: "one of the fixed tier names" },
  { file: "providerCatalogue.ts", expression: "{ redirected, unauthorised: refusedCandidates === failedCandidates }", sites: 1, why: "the error constructor's flags, two booleans the fetch tracked and no text" },
  { file: "providerCatalogue.ts", expression: 'outcomes.join("; ")', sites: 1, why: "outcomes the fetch built from redacted addresses, status codes and the door's own error text, never a body a server sent" },
  { file: "catalogueKeeper.ts", expression: "catalogueReadFault(error)", sites: 1, why: "the class or code of a login file's read failure, which names no path" },
  { file: "catalogueKeeper.ts", expression: "fault", sites: 1, why: "the class or code of a stored file's read failure, which names no path", declaredBy: /catalogueReadFault\(/ },
  { file: "catalogueKeeper.ts", expression: "error.message", sites: 2, why: "the message of an error the door's own refresh raised" },
  { file: "catalogueKeeper.ts", expression: "String(error)", sites: 2, why: "an error the door's own refresh raised" },
];

/** A text that reaches a message and is neither quoted nor allowed. */
interface RawText {
  readonly expression: string;
}

/** The names a binding pattern or identifier declares. */
function boundNames(name: ts.BindingName): readonly string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

/** The initialiser (when the declaration has one on its own name) and the text that identifies how `identifier` is bound, found by walking out from the use through each enclosing scope: a parameter, a `for ... of` binding (identified by the iterated expression) or a variable declared in an enclosing block. */
function declarationOf(source: ts.SourceFile, identifier: ts.Identifier): { readonly initialiser: ts.Expression | undefined; readonly statement: string } | undefined {
  let scope: ts.Node = identifier.parent;
  for (;;) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((candidate) => boundNames(candidate.name).includes(identifier.text));
      if (parameter !== undefined) {
        return { initialiser: undefined, statement: parameter.getText(source) };
      }
    }
    if (ts.isForOfStatement(scope) && ts.isVariableDeclarationList(scope.initializer) && scope.initializer.declarations.some((declaration) => boundNames(declaration.name).includes(identifier.text))) {
      return { initialiser: undefined, statement: scope.expression.getText(source) };
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations.find((candidate) => boundNames(candidate.name).includes(identifier.text));
          if (declaration !== undefined) {
            return { initialiser: ts.isIdentifier(declaration.name) ? declaration.initializer : undefined, statement: statement.getText(source) };
          }
        }
      }
    }
    if (ts.isSourceFile(scope)) {
      return undefined;
    }
    scope = scope.parent;
  }
}

/** The leaves of `expression` that are written into the text it builds, following templates, concatenation, conditionals, parentheses, assertions and names bound to a built text; a quoting call stops the descent, a literal has no leaf. */
function leavesOf(source: ts.SourceFile, expression: ts.Expression, seen: ReadonlySet<string>): readonly { readonly text: string; readonly declaration: string | undefined }[] {
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
    return [];
  }
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.flatMap((span) => leavesOf(source, span.expression, seen));
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...leavesOf(source, expression.left, seen), ...leavesOf(source, expression.right, seen)];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...leavesOf(source, expression.whenTrue, seen), ...leavesOf(source, expression.whenFalse, seen)];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
    return leavesOf(source, expression.expression, seen);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && QUOTING_CALLS.has(expression.expression.text)) {
    return [];
  }
  if (ts.isIdentifier(expression) && expression.text === "undefined") {
    return [];
  }
  if (ts.isIdentifier(expression)) {
    const declaration = declarationOf(source, expression);
    if (declaration?.initialiser !== undefined && !seen.has(expression.text)) {
      const built = leavesOf(source, declaration.initialiser, new Set([...seen, expression.text]));
      // A name bound to a text built from other texts is those texts; one bound to anything else is itself the leaf.
      if (ts.isTemplateExpression(declaration.initialiser) || ts.isBinaryExpression(declaration.initialiser) || ts.isConditionalExpression(declaration.initialiser)) {
        return built;
      }
    }
    return [{ text: expression.text, declaration: declaration?.statement }];
  }
  const head = expression.getText(source).split(/[.([]/u, 1)[0] ?? "";
  const first = ts.isIdentifier(expression) ? undefined : head;
  return [{ text: expression.getText(source), declaration: first === undefined || first === "" ? undefined : (() => {
    const identifier = ts.forEachChild(expression, function find(node): ts.Identifier | undefined { return ts.isIdentifier(node) ? node : ts.forEachChild(node, find); });
    return identifier === undefined ? undefined : declarationOf(source, identifier)?.statement;
  })() }];
}

/** The texts that reach a message in `sourceText` of `file` and are neither quoted nor allowed, and how many message sites it has. */
export function rawTexts(file: string, sourceText: string): { readonly raw: readonly RawText[]; readonly sites: number; readonly allowed: ReadonlyMap<RawAllowance, number> } {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const raw: RawText[] = [];
  const allowed = new Map<RawAllowance, number>();
  let sites = 0;
  const check = (expression: ts.Expression): void => {
    sites += 1;
    for (const leaf of leavesOf(source, expression, new Set())) {
      const entry = RAW_OK.find((candidate) => candidate.file === file && candidate.expression === leaf.text && (candidate.declaredBy === undefined || (leaf.declaration !== undefined && candidate.declaredBy.test(leaf.declaration))));
      if (entry === undefined) {
        raw.push({ expression: leaf.text });
      } else {
        allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (MESSAGE_CALLS.has(callee)) {
        const carrying = MESSAGE_CALLS.get(callee);
        node.arguments.forEach((argument, index) => {
          if ((carrying === undefined || carrying === index) && !ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
            check(argument);
          }
        });
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(source).endsWith("Error")) {
      for (const argument of node.arguments ?? []) {
        check(argument);
      }
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) ? node.name.text : "") === "message") {
      check(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "message") {
      check(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { raw, sites, allowed };
}

/** The allowances of `file` whose exact count of raw sites `sourceText` does not meet. */
function miscounted(file: string, sourceText: string): readonly string[] {
  const found = rawTexts(file, sourceText);
  return RAW_OK.filter((entry) => entry.file === file && (found.allowed.get(entry) ?? 0) !== entry.sites).map((entry) => entry.expression);
}

describe("the text a provider supplied, in a log line or an error message", () => {
  it("reaches a message in no scanned module without going through quotedForLog", () => {
    let sites = 0;
    for (const file of SCANNED) {
      const found = rawTexts(file, fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
      expect(found.raw.map((text) => text.expression), `${file}: quote provider text with quotedForLog, or allow the expression in RAW_OK with its reason`).toEqual([]);
      sites += found.sites;
      expect(miscounted(file, fs.readFileSync(path.join(__dirname, "..", file), "utf8")), `${file}: an allowance's count of raw sites is not the file's: update RAW_OK, or quote the text`).toEqual([]);
    }
    // The scan must be looking at the sites it names: the log lines and error messages of these modules.
    expect(sites).toBeGreaterThan(SCANNED.length);
  });

  it("fails on a new site that spells an allowed expression, and on a site that goes", () => {
    const real = fs.readFileSync(path.join(__dirname, "..", "frontdoor/providerRoute.ts"), "utf8");
    expect(miscounted("frontdoor/providerRoute.ts", real)).toEqual([]);
    const added = `${real}\nfunction addedLater(deps: { log: (line: string) => void }): void {\n  try {\n    throw new Error("x");\n  } catch (error) {\n    deps.log(\`failed: \${error instanceof Error ? error.message : String(error)}\`);\n  }\n}\n`;
    expect(miscounted("frontdoor/providerRoute.ts", added)).toEqual(expect.arrayContaining(["error.message", "String(error)"]));
    expect(miscounted("frontdoor/providerRoute.ts", real.replace("message: res.message", 'message: "gone"'))).toEqual(["res.message"]);
  });

  it("allows only what RAW_OK names for a file, each with a reason", () => {
    for (const entry of RAW_OK) {
      expect(SCANNED).toContain(entry.file);
      expect(entry.why).not.toBe("");
      // An allowance that matches no site is dead weight that hides a later one from the count check: it is deleted, never kept at zero.
      expect(entry.sites).toBeGreaterThan(0);
    }
  });

  describe("is found when it reaches a message by any of these routes", () => {
    const FILE = "frontdoor/httpRequestEdits.ts";
    it.each([
      ["a template passed to a log call", "function f(deps, served) { deps.log(`answered ${served.model}`); }", "served.model"],
      ["an error message builder", "function f(models) { return failed(502, `listed ${models[0].id}`); }", "models[0].id"],
      ["a concatenation", 'function f(deps, served) { deps.log("answered " + served.model); }', "served.model"],
      ["a template bound to a name first", "function f(deps, tool) { const m = `drop ${tool}`; deps.log(m); }", "tool"],
      ["a concatenation bound to a name first", 'function f(deps, tool) { const m = "drop " + tool.name; deps.log(m); }', "tool.name"],
      ["a conditional", "function f(deps, served) { deps.log(served.ok ? `a ${served.model}` : `b`); }", "served.model"],
      ["a message property", "function f(served) { return { ok: false, message: `no ${served.model}` }; }", "served.model"],
      ["a shorthand message property", "function f(served) { const message = `no ${served.model}`; return { ok: false, message }; }", "served.model"],
      ["an error constructor", "function f(served) { throw new Error(`no ${served.model}`); }", "served.model"],
      ["a typed error constructor", "function f(served) { throw new CatalogueFetchError(`no ${served.model}`); }", "served.model"],
      ["console", "function f(served) { console.error(`no ${served.model}`); }", "served.model"],
      ["a helper's result", "function f(deps, served) { deps.log(describe(served)); }", "describe(served)"],
      ["a name the allowance does not cover in this file", "function f(deps, name) { deps.log(`for ${name}`); }", "name"],
    ])("%s", (_label, text, expression) => {
      expect(rawTexts(FILE, text).raw.map((found) => found.expression)).toEqual([expression]);
    });
  });

  describe("is not found when it is quoted, listed or a literal", () => {
    const FILE = "frontdoor/httpRequestEdits.ts";
    it.each([
      ["a quoted text", "function f(deps, served) { deps.log(`answered ${quotedForLog(served.model)}`); }"],
      ["a quoted text bound to a name first", "function f(deps, served) { const m = `answered ${quotedForLog(served.model)}`; deps.log(m); }"],
      ["a listed expression", "function f(deps) { deps.log(`for ${deps.provider}`); }"],
      ["a literal", 'function f(deps) { deps.log("nothing to say"); }'],
    ])("%s", (_label, text) => {
      expect(rawTexts(FILE, text).raw).toEqual([]);
    });

    it("lists a name for the keeper only where the keeper's loop binds it", () => {
      const bound = "function f(deps) { for (const [name, provider] of cataloguedProviders(deps.providers())) { deps.log(`for ${name}`); } }";
      expect(rawTexts("catalogueKeeper.ts", bound).raw).toEqual([]);
      const other = "function f(deps, name) { deps.log(`for ${name}`); }";
      expect(rawTexts("catalogueKeeper.ts", other).raw.map((found) => found.expression)).toEqual(["name"]);
    });
  });
});
