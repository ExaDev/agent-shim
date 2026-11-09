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

/** The name a function declaration, or a variable initialised with an arrow or function expression, gives its function, or undefined for any other node. */
function functionName(node: AstNode): string | undefined {
  if (node.type === "FunctionDeclaration") {
    return node.id.name;
  }
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")) {
    return node.id.name;
  }
  return undefined;
}

/** Whether `node` sits inside an allowed function of the file being linted. */
function isAllowed(context: Rule.RuleContext, node: Rule.Node, allowances: readonly Allowance[]): boolean {
  const names = allowances.filter((allowance) => context.filename.endsWith(allowance.file)).flatMap((allowance) => allowance.within);
  return context.sourceCode.getAncestors(node).some((ancestor) => {
    const name = functionName(ancestor);
    return name !== undefined && names.includes(name);
  });
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

/** The name an ESTree property key or member property spells, whether written as an identifier, a string, or a template with no substitutions, or undefined when it is computed from something else. */
function spelledName(node: { readonly type: string }, computed: boolean): string | undefined {
  if (!computed && node.type === "Identifier" && "name" in node && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && "value" in node && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && "quasis" in node && Array.isArray(node.quasis) && node.quasis.length === 1) {
    const only: unknown = node.quasis[0];
    if (typeof only === "object" && only !== null && "value" in only && typeof only.value === "object" && only.value !== null && "cooked" in only.value && typeof only.value.cooked === "string") {
      return only.value.cooked;
    }
  }
  return undefined;
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
  "A URL's host and hostname keep an IPv6 literal's brackets, which net.isIP takes for a name, so a dial built from one fails with EBADNAME: reach a dial target through dialHostOf or dialTargetOf in src/baseUrlDial.ts. Code that never dials (a display or a comparison) disables this one line and says so.";

/** Reports every read of a `URL`'s `host` or `hostname`: member access (dotted, bracketed, string-keyed or templated), destructuring in a declaration, an assignment or a parameter, and optional chaining on any of them. */
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
        const name = spelledName(node.property, node.computed);
        const type = name === undefined || !BRACKETED_HOST_PROPERTIES.has(name) ? undefined : typeOf(node.object);
        if (name !== undefined && type !== undefined && isUrlProperty(checker, type, name) && !isAllowed(context, node, allowances)) {
          context.report({ node, messageId: "read" });
        }
      },
      ObjectPattern(node) {
        // A pattern on the left of an assignment has no type of its own worth reading; the value assigned from is what is destructured.
        const type = typeOf(node.parent.type === "AssignmentExpression" && node.parent.left === node ? node.parent.right : node);
        for (const entry of node.properties) {
          const name = entry.type === "Property" ? spelledName(entry.key, entry.computed) : undefined;
          if (type !== undefined && name !== undefined && BRACKETED_HOST_PROPERTIES.has(name) && isUrlProperty(checker, type, name) && !isAllowed(context, node, allowances)) {
            context.report({ node: entry, messageId: "read" });
          }
        }
      },
    };
  },
};

const COLON_MESSAGE =
  "Splitting a host or authority at a colon takes an IPv6 literal for a host and a port: parse it with parseDialAuthority in src/baseUrlDial.ts, which understands brackets. A line that splits something else (a header line, a credential pair) disables this one line and says so.";

/** The string methods that locate or split at a colon, which is how an authority's port is found. */
const COLON_SPLITTERS: ReadonlySet<string> = new Set(["split", "indexOf", "lastIndexOf"]);

/** Reports `x.split(":")`, `x.indexOf(":")` and `x.lastIndexOf(":")` in any quoting: the three shapes by which an authority is cut at its port. */
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
        const method = spelledName(callee.property, callee.computed);
        const [first] = node.arguments;
        if (method !== undefined && COLON_SPLITTERS.has(method) && first !== undefined && spelledName(first, true) === ":" && !isAllowed(context, node, allowances)) {
          context.report({ node, messageId: "split" });
        }
      },
    };
  },
};

/** The local ESLint plugin that keeps every dial target on the one host rule (`src/baseUrlDial.ts`). */
export const dialPlugin = { rules: { "no-url-host-read": noUrlHostRead, "no-colon-split": noColonSplit } };
