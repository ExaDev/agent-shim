import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The modules whose readers the door reads local state through on the request path, from `src`: the overrides, provider files and their listing, a provider's stored catalogue, the selector state, an identity's account and name, the usage snapshots, and the configuration store and loader they read through. */
const READERS = ["routeOverridesStore.ts", "frontdoor/providerReads.ts", "models/selectorPorts.ts", "identityAccounts.ts", "providersStore.ts", "storedCatalogue.ts", "identityStore.ts", "identityRecords.ts", "usage/read.ts", "config/store.ts", "config/load.ts"] as const;

/** What a catch calls to classify a failure through the one file-fault set, so a failure of the moment is passed on: directly, or through the identity listing's helper over it. */
const CLASSIFIERS = ["isTransientReadError(", "fileFaultCodeOf(", "unreachableCodeOf("] as const;

/** The catches that need not classify a failure, by module and enclosing function, each with why. A catch around a JSON parse alone (`JSON`) is about the text read. */
const ALLOWED: Readonly<Record<string, string>> = {
  "routeOverridesStore.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
  "frontdoor/providerReads.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
  "providersStore.ts readProvider": "rethrows every error but a JSON parse failure",
  "storedCatalogue.ts read": "hands the error itself to onUnreadable, and raiseUnreadableCatalogue, the one that answers for the file, keeps a failure of the moment's code",
  "storedCatalogue.ts attempt": "hands the error itself to onUnreadable, as read does",
  "identityStore.ts readIdentityForListing": "rethrows every error but the file being no JSON or of another shape",
  "identityStore.ts acquireRemovalLock": "a lock held by another process, never a read",
  "config/store.ts readFileUtf8": "rethrows every error but ENOENT, which is absence",
  "config/store.ts unlinkSync": "a write, rethrowing every error but ENOENT",
  "config/store.ts writeTextAtomic": "a write, rethrowing the error",
  "config/load.ts cosmiconfigReader": "rethrows every error but ENOENT, which is absence",
};

/** Each catch clause of `source` that neither classifies its failure through the one file-fault set (`CLASSIFIERS`) nor guards a JSON parse alone, as `<module> <enclosing function>`, allowed or not. */
function catchesNotPassingOn(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, enclosing: string): void => {
    let name = enclosing;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) name = node.name.getText(file);
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.getText(file);
    if (ts.isCatchClause(node) && !CLASSIFIERS.some((classifier) => node.block.getText(file).includes(classifier))) {
      const parsesJsonAlone = ts.isTryStatement(node.parent) && /^\{\s*(?:[a-z]+ = )?(?:return )?JSON\.parse\([A-Za-z_.]+\);\s*\}$/u.test(node.parent.tryBlock.getText(file));
      if (!parsesJsonAlone) found.push(`${module} ${name}`);
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
