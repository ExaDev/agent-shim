import type { Rule } from "eslint";
import ts from "typescript";

/** A function in which the rule does not apply, by the file it is in (a path suffix) and its name: the code that is the host rule itself, or that reads a host or a colon for something other than a dial target. */
interface Allowance {
  readonly file: string;
  readonly within: readonly string[];
}

function isAllowance(value: unknown): value is Allowance {
  return typeof value === "object" && value !== null && "file" in value && typeof value.file === "string" && "within" in value && Array.isArray(value.within) && value.within.every((name) => typeof name === "string");
}

/** The allowances a rule was configured with, each checked, or a thrown error naming the malformed option. */
function allowancesOf(options: readonly unknown[]): readonly Allowance[] {
  const [first] = options;
  if (first === undefined) {
    return [];
  }
  if (typeof first !== "object" || first === null || !("allow" in first) || !Array.isArray(first.allow) || !first.allow.every(isAllowance)) {
    throw new Error("the dial rules take { allow: { file, within }[] }");
  }
  return first.allow;
}

/** A node of the ESTree the linter walks. */
type AstNode = ReturnType<Rule.RuleContext["sourceCode"]["getAncestors"]>[number];

/** Whether `node` is a function of any form. */
function isFunction(node: AstNode): boolean {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

/** The name a function declaration, or an arrow or function expression assigned to a variable, goes by, or undefined for an anonymous function. */
function nameOfFunction(node: AstNode, parent: AstNode | undefined): string | undefined {
  if (node.type === "FunctionDeclaration") {
    return node.id.name;
  }
  return parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : undefined;
}

/**
 * Whether `node` sits inside an allowed function of the file being linted. Only the OUTERMOST function enclosing the node is compared with the allowed names, so a function of the same name nested in some other function does not inherit the exemption, and everything inside an allowed top-level function does.
 */
function isAllowed(context: Rule.RuleContext, node: Rule.Node, allowances: readonly Allowance[]): boolean {
  const names = allowances.filter((allowance) => context.filename.endsWith(allowance.file)).flatMap((allowance) => allowance.within);
  const ancestors = context.sourceCode.getAncestors(node);
  const index = ancestors.findIndex(isFunction);
  const outermost = ancestors[index];
  if (outermost === undefined) {
    return false;
  }
  const name = nameOfFunction(outermost, ancestors[index - 1]);
  return name !== undefined && names.includes(name);
}

/** Any node of the ESTree the linter walks. */
type EsNode = Parameters<Rule.RuleContext["sourceCode"]["getScope"]>[0];

/** The text a node spells when it is a string the linter can read without running anything: a literal, a template or a concatenation of such, or a `const` of the same file initialised with one. Anything else (a call's result, a parameter, a property) is undefined, which is what the rules cannot see. */
function staticString(context: Rule.RuleContext, node: EsNode, depth = 0): string | undefined {
  const MAX_DEPTH = 8;
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  if (node.type === "TemplateLiteral") {
    let text = "";
    for (const [index, quasi] of node.quasis.entries()) {
      const expression = node.expressions[index];
      const inserted = expression === undefined ? "" : staticString(context, expression, depth + 1);
      if (quasi.value.cooked === null || quasi.value.cooked === undefined || inserted === undefined) {
        return undefined;
      }
      text += quasi.value.cooked + inserted;
    }
    return text;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = node.left.type === "PrivateIdentifier" ? undefined : staticString(context, node.left, depth + 1);
    const right = staticString(context, node.right, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === "Identifier") {
    let scope: ReturnType<Rule.RuleContext["sourceCode"]["getScope"]> | null = context.sourceCode.getScope(node);
    while (scope !== null) {
      const variable = scope.set.get(node.name);
      if (variable !== undefined) {
        const [definition] = variable.defs;
        if (definition?.type !== "Variable" || definition.parent.kind !== "const") {
          return undefined;
        }
        const initialiser = definition.node.init;
        return initialiser === null || initialiser === undefined ? undefined : staticString(context, initialiser, depth + 1);
      }
      scope = scope.upper;
    }
  }
  return undefined;
}

/** The minimal parser services the type-aware rule reads: the program's checker and the map from an ESTree node to its TypeScript node. */
interface TypeServices {
  readonly program: ts.Program;
  readonly esTreeNodeToTSNodeMap: { readonly get: (node: object) => ts.Node | undefined };
}

function isTypeServices(value: unknown): value is TypeServices {
  return typeof value === "object" && value !== null && "program" in value && "esTreeNodeToTSNodeMap" in value;
}

/** The properties of a `URL` whose value keeps an IPv6 literal's brackets. */
const BRACKETED_HOST_PROPERTIES: ReadonlySet<string> = new Set(["hostname", "host"]);

/** The name an ESTree property key or member property spells: an identifier when not computed, else whatever string the computed expression statically is (`u["hostname"]`, `u[`hostname`]`, `u[KEY]` over a const, `u["host" + "name"]`), or undefined when it depends on something the linter cannot evaluate. */
function spelledName(context: Rule.RuleContext, node: EsNode, computed: boolean): string | undefined {
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  return staticString(context, node);
}

/** Whether `property` of `type` is declared by the platform's `URL`, so a `Pick<URL, "hostname">` and a `URL` subtype count as a URL and an unrelated `host` field does not. */
function isUrlProperty(checker: ts.TypeChecker, type: ts.Type, property: string): boolean {
  const symbol = checker.getPropertyOfType(checker.getNonNullableType(type), property);
  return (symbol?.declarations ?? []).some((declaration) => {
    const owner = declaration.parent;
    return (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) && owner.name?.text === "URL";
  });
}

const BRACKET_MESSAGE =
  "A URL's host and hostname keep an IPv6 literal's brackets, which net.isIP takes for a name, so a dial built from one fails with EBADNAME: reach a dial target through dialHostOf or dialTargetOf in src/baseUrlDial.ts. Code that never dials (a display or a comparison) is added to the rule's allow list in eslint.config.ts, by function, with its reason.";

/**
 * Reports every read of a `URL`'s `host` or `hostname`: member access (dotted, bracketed, string-keyed, templated, keyed by a `const` of the same file or by a concatenation of string literals), destructuring in a declaration, an assignment or a parameter, and optional chaining on any of them.
 *
 * What it cannot see: a key computed by a function's result, a parameter or a property; a value whose type is `any` or an unrelated object that happens to hold a URL's host; and a host read through a different API (`url.href` parsed again, `url.origin`).
 */
const noUrlHostRead: Rule.RuleModule = {
  meta: { type: "problem", schema: [{ type: "object" }], messages: { read: BRACKET_MESSAGE } },
  create(context) {
    const services: unknown = context.sourceCode.parserServices;
    if (!isTypeServices(services)) {
      throw new Error("dial/no-url-host-read needs type information: lint with the project service");
    }
    const allowances = allowancesOf(context.options);
    const checker = services.program.getTypeChecker();
    const typeOf = (node: object): ts.Type | undefined => {
      const mapped = services.esTreeNodeToTSNodeMap.get(node);
      return mapped === undefined ? undefined : checker.getTypeAtLocation(mapped);
    };
    return {
      MemberExpression(node) {
        const name = spelledName(context, node.property, node.computed);
        const type = name === undefined || !BRACKETED_HOST_PROPERTIES.has(name) ? undefined : typeOf(node.object);
        if (name !== undefined && type !== undefined && isUrlProperty(checker, type, name) && !isAllowed(context, node, allowances)) {
          context.report({ node, messageId: "read" });
        }
      },
      ObjectPattern(node) {
        // A pattern on the left of an assignment has no type of its own worth reading; the value assigned from is what is destructured.
        const type = typeOf(node.parent.type === "AssignmentExpression" && node.parent.left === node ? node.parent.right : node);
        for (const entry of node.properties) {
          const name = entry.type === "Property" ? spelledName(context, entry.key, entry.computed) : undefined;
          if (type !== undefined && name !== undefined && BRACKETED_HOST_PROPERTIES.has(name) && isUrlProperty(checker, type, name) && !isAllowed(context, node, allowances)) {
            context.report({ node: entry, messageId: "read" });
          }
        }
      },
    };
  },
};

const COLON_MESSAGE =
  "Splitting a host or authority at a colon takes an IPv6 literal for a host and a port: parse it with parseDialAuthority in src/baseUrlDial.ts, which understands brackets. A function that splits something else (a header line, a credential pair) is added to the rule's allow list in eslint.config.ts, by function, with its reason. This rule is applied to the code that dials (src/frontdoor, src/baseUrl*.ts, src/provider*.ts) and to no other directory.";

/** The methods that locate, split, match or replace at a pattern, which is how an authority's port is found. */
const COLON_METHODS: ReadonlySet<string> = new Set(["split", "indexOf", "lastIndexOf", "match", "matchAll", "search", "replace", "replaceAll", "exec", "test"]);

/** The methods a regular expression itself has, so one written as the receiver (`/:/.test(x)`) is a cut too. */
const REGEXP_METHODS: ReadonlySet<string> = new Set(["exec", "test"]);

/** Whether a regular expression's source holds a colon that is matched, not the `(?:` of a non-capturing group. */
function matchesColon(source: string): boolean {
  return source.replaceAll("(?:", "").includes(":");
}

/** Whether `node` is a regular expression, written as a literal or `new RegExp(<string>)`, that matches a colon. */
function isColonPattern(context: Rule.RuleContext, node: EsNode): boolean {
  if (node.type === "Literal") {
    const regex: unknown = "regex" in node ? node.regex : undefined;
    return typeof regex === "object" && regex !== null && "pattern" in regex && typeof regex.pattern === "string" && matchesColon(regex.pattern);
  }
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "RegExp") {
    const [source] = node.arguments;
    const text = source === undefined ? undefined : staticString(context, source);
    return text !== undefined && matchesColon(text);
  }
  return false;
}

/**
 * Reports a string or pattern method cut at a colon, which is how an authority is split at its port: `split`, `indexOf`, `lastIndexOf`, `match`, `matchAll`, `search`, `replace`, `replaceAll`, `exec` and `test`, with a `":"` argument in any quoting, a template, a concatenation, a `const` of the same file holding one, or a regular expression (literal or `new RegExp` of a static string) that matches a colon, and a colon regular expression used as the receiver of `exec` or `test`.
 *
 * What it cannot see: a colon that reaches the call through a function's result, a parameter, a property or an imported constant; a regular expression held in a variable; a cut made by `slice` at an index found some other way; and any file outside the globs the configuration applies it to.
 */
const noColonSplit: Rule.RuleModule = {
  meta: { type: "problem", schema: [{ type: "object" }], messages: { split: COLON_MESSAGE } },
  create(context) {
    const allowances = allowancesOf(context.options);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") {
          return;
        }
        const method = spelledName(context, callee.property, callee.computed);
        if (method === undefined || !COLON_METHODS.has(method)) {
          return;
        }
        const [first] = node.arguments;
        const cutsAtColon = (first !== undefined && (staticString(context, first) === ":" || isColonPattern(context, first))) || (REGEXP_METHODS.has(method) && isColonPattern(context, callee.object));
        if (cutsAtColon && !isAllowed(context, node, allowances)) {
          context.report({ node, messageId: "split" });
        }
      },
    };
  },
};

/** The local ESLint plugin that keeps every dial target on the one host rule (`src/baseUrlDial.ts`). */
export const dialPlugin = { rules: { "no-url-host-read": noUrlHostRead, "no-colon-split": noColonSplit } };
