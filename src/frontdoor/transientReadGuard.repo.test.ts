import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The modules whose readers the door reads local state through on the request path, from `src`. */
const READERS = ["routeOverridesStore.ts", "frontdoor/providerReads.ts", "models/selectorPorts.ts", "identityAccounts.ts"] as const;

/** The catches that need not pass a failure of the moment on, by module and enclosing function, each with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "routeOverridesStore.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
  "routeOverridesStore.ts readNow JSON": "a parse failure is a property of the text read",
  "frontdoor/providerReads.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
};

/** Each catch clause of `source` that does not pass a failure of the moment on (`isTransientReadError(`), as `<module> <enclosing function>[ JSON]`, allowed or not. */
function catchesNotPassingOn(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, enclosing: string): void => {
    let name = enclosing;
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) name = node.name.text;
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.getText(file);
    if (ts.isCatchClause(node) && !node.block.getText(file).includes("isTransientReadError(")) {
      const parsesJson = ts.isTryStatement(node.parent) && node.parent.tryBlock.getText(file).includes("JSON.parse(");
      found.push(`${module} ${name}${parsesJson ? " JSON" : ""}`);
    }
    ts.forEachChild(node, (child) => {
      visit(child, name);
    });
  };
  visit(file, "(module)");
  return found;
}

/** The catches of `source` that neither pass a failure of the moment on nor are allowed. */
function catchesKeepingTransientFaults(module: string, source: string): readonly string[] {
  return catchesNotPassingOn(module, source).filter((key) => ALLOWED[key] === undefined);
}

describe("the door's local-state readers on a read that fails for the moment", () => {
  it("pass it on from every catch, so none keeps it or answers it as the file's fault", () => {
    const kept = READERS.flatMap((module) => catchesKeepingTransientFaults(module, fs.readFileSync(path.join(__dirname, "..", module), "utf8")));
    expect(kept).toEqual([]);
  });

  it("finds a catch that turns every error into an answer, and leaves one that passes a failure of the moment on", () => {
    const keeps = "const read = () => {\n  try {\n    return readFile();\n  } catch (error) {\n    return { fault: String(error) };\n  }\n};";
    const passes = "const read = () => {\n  try {\n    return readFile();\n  } catch (error) {\n    if (isTransientReadError(error)) throw error;\n    return { fault: String(error) };\n  }\n};";
    expect(catchesKeepingTransientFaults("x.ts", keeps)).toEqual(["x.ts read"]);
    expect(catchesKeepingTransientFaults("x.ts", passes)).toEqual([]);
  });

  it("names in each allowance a catch the module still has", () => {
    const present = READERS.flatMap((module) => catchesNotPassingOn(module, fs.readFileSync(path.join(__dirname, "..", module), "utf8")));
    expect(Object.keys(ALLOWED).filter((key) => !present.includes(key))).toEqual([]);
  });
});
