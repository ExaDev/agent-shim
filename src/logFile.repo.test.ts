import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The modules under `src`, as paths relative to it, but tests and test worlds. */
function modules(): readonly string[] {
  return fs.readdirSync(__dirname, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("TestWorld.ts") && !file.endsWith(".d.ts"));
}

/** The modules whose appends are written inside a string of code another runtime runs, which the check here cannot see, each with how that code keeps a failed append from throwing. */
const EMBEDDED_APPENDS: Readonly<Record<string, string>> = {
  "frontdoor/watchdog.ts": "the respawn source's own log, which wraps its append in a try and drops a line it cannot write",
};

/** Each call of `appendFileSync` or `appendFile` in the TypeScript of `source`, as `<module> <line>`. */
function appendCalls(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /(?:^|\.)appendFile(?:Sync)?$/u.test(node.expression.getText(file))) {
      found.push(`${module} ${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether `source` writes `appendFileSync(` inside a string or template of code. */
function hasEmbeddedAppend(module: string, source: string): boolean {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && node.getText(file).includes("appendFileSync(")) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const sourceOf = (module: string): string => fs.readFileSync(path.join(__dirname, module), "utf8");

describe("an append to a log file in src", () => {
  it("calls appendFile or appendFileSync in logFile.ts alone, whose appendLogText the door's log, headroom's log and the capture append through; an append through an opened descriptor is not read", () => {
    expect(modules().flatMap((module) => appendCalls(module, sourceOf(module))).map((site) => site.split(" ")[0])).toEqual(["logFile.ts"]);
  });

  it("names each module that appends inside a string of code, and how that code drops a failed append", () => {
    const embedded = modules().filter((module) => hasEmbeddedAppend(module, sourceOf(module)));
    expect(embedded.filter((module) => EMBEDDED_APPENDS[module] === undefined)).toEqual([]);
    expect(Object.keys(EMBEDDED_APPENDS).filter((module) => !embedded.includes(module))).toEqual([]);
  });

  it("finds an append called directly and one written in a string", () => {
    expect(appendCalls("x.ts", "fs.appendFileSync(file, text); appendFile(file, text, done);")).toEqual(["x.ts 1", "x.ts 1"]);
    expect(appendCalls("x.ts", "appendLogText(dir, file, text);")).toEqual([]);
    expect(hasEmbeddedAppend("x.ts", "const source = `fs.appendFileSync(logFile, line)`;")).toBe(true);
  });
});
