import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The modules whose readers the door reads local state through on the request path, from `src`: the overrides, provider files and their listing, a provider's stored catalogue, the provider targets and the door's own state files they read, the route context's durable copy, the headroom routing setting the pipeline reads for each request, the selector state, an identity's account and name, the usage snapshots, and the configuration store and loader they read through. */
const READERS = ["routeOverridesStore.ts", "frontdoor/providerReads.ts", "models/selectorPorts.ts", "identityAccounts.ts", "providersStore.ts", "storedCatalogue.ts", "identityStore.ts", "identityRecords.ts", "usage/read.ts", "config/store.ts", "config/load.ts", "models/targets.ts", "frontdoor/state.ts", "frontdoor/mainLoopRoute.ts", "headroom/routingSetting.ts", "frontdoor/liveSessionRegistry.ts", "supervise/registry.ts", "realPorts.ts"] as const;

/** What a catch calls to classify a failure through the one file-fault set, so a failure of the moment is passed on: directly, or through the identity listing's helper over it. */
const CLASSIFIERS = ["isTransientReadError(", "fileFaultCodeOf(", "unreachableCodeOf("] as const;

/** The catches that need not classify a failure, by module and enclosing function, each with why. A catch around a JSON parse alone (`JSON`) is about the text read. */
const ALLOWED: Readonly<Record<string, string>> = {
  "realPorts.ts realIsProcessAlive": "a process signal's answer, which is no file",
  "routeOverridesStore.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
  "frontdoor/providerReads.ts revisionOf": "a stat that fails names no revision, so the file is read and nothing is kept",
  "storedCatalogue.ts read": "hands the error itself to onUnreadable, and raiseUnreadableCatalogue, the one that answers for the file, keeps a failure of the moment's code",
  "storedCatalogue.ts attempt": "hands the error itself to onUnreadable, as read does",
  "config/load.ts cosmiconfigReader": "rethrows every error but ENOENT, which is absence, and a parse failure, which it names",
  "frontdoor/state.ts identity": "a stat whose failure keeps nothing: an identity that cannot be told is no reason to read, and the next lookup stats again",
  "frontdoor/state.ts readDirectRecordEntry": "a door's direct-listener record, read by the headroom supervisor's allowlist, not on a request's path",
  "frontdoor/mainLoopRoute.ts persist": "a write of the route context's copy, logged and tried again at the next request",
};

/** Each catch clause of `source` that neither classifies its failure through the one file-fault set (`CLASSIFIERS`), nor throws the error it caught again, nor guards a parse of text already read, as `<module> <enclosing function>`, allowed or not. */
function catchesNotPassingOn(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, enclosing: string): void => {
    let name = enclosing;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) name = node.name.getText(file);
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.getText(file);
    if (ts.isCatchClause(node) && !CLASSIFIERS.some((classifier) => node.block.getText(file).includes(classifier))) {
      const tryText = ts.isTryStatement(node.parent) ? node.parent.tryBlock.getText(file) : "";
      // A try that parses text already read, and reads nothing itself, meets no read failure.
      const parsesOnly = tryText.includes("JSON.parse(") && !/\b(readFileUtf8|readFileSync|readdir|readdirSync|statSync|lstat|lstatSync|stat|readConfigFile|fileRevision)\(/u.test(tryText);
      // A catch that throws the error it caught again passes on every failure it does not handle itself, a failure of the moment included; what it handles is held by fileFaults.repo.test.ts, which finds a file-fault code named by hand.
      const caught = node.variableDeclaration?.name.getText(file);
      const rethrows = caught !== undefined && new RegExp(`\\bthrow ${caught}\\b`, "u").test(node.block.getText(file));
      if (!parsesOnly && !rethrows) found.push(`${module} ${name}`);
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
  it("pass it on from each catch in the listed reader modules, or name in an allowance why that catch need not", () => {
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
