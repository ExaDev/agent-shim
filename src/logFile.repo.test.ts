import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

import { isSourceModule } from "./sourceModules";

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

/** The modules whose appends are written inside a string of code another runtime runs, which the check here cannot see, each with a reason. */
const EMBEDDED_APPENDS: Readonly<Record<string, string>> = {
  "frontdoor/watchdog.ts": "the watchdog and respawn threads' own log, written in the source those threads run",
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

/** The modules that write the door's log, headroom's log and the CONNECT capture. */
const LOG_WRITERS = ["frontdoor/doorLog.ts", "headroom/headroomLog.ts", "frontdoor/capture.ts"] as const;

/** Whether the TypeScript of `source` calls `appendLogText`. */
function callsAppendLogText(module: string, source: string): boolean {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "appendLogText") found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

it("finds appendFile and appendFileSync called in the source modules of src in logFile.ts only", () => {
  expect(sourceModules().flatMap((module) => appendCalls(module, sourceOf(module))).map((site) => site.split(" ")[0])).toEqual(["logFile.ts"]);
});

it("finds a call of appendLogText in each of doorLog.ts, headroomLog.ts and capture.ts", () => {
  expect(LOG_WRITERS.filter((module) => !callsAppendLogText(module, sourceOf(module)))).toEqual([]);
});

it("names each module that writes appendFileSync( inside a string of code, with a reason", () => {
  const embedded = sourceModules().filter((module) => hasEmbeddedAppend(module, sourceOf(module)));
  expect(embedded.filter((module) => EMBEDDED_APPENDS[module] === undefined)).toEqual([]);
  expect(Object.keys(EMBEDDED_APPENDS).filter((module) => !embedded.includes(module))).toEqual([]);
});

it("finds an append called directly and one written in a string, and tells a call of appendLogText from another write", () => {
  expect(appendCalls("x.ts", "fs.appendFileSync(file, text); appendFile(file, text, done);")).toEqual(["x.ts 1", "x.ts 1"]);
  expect(appendCalls("x.ts", "appendLogText(dir, file, text);")).toEqual([]);
  expect(callsAppendLogText("x.ts", "appendLogText(dir, file, text);")).toBe(true);
  expect(callsAppendLogText("x.ts", "fs.writeFileSync(file, text, { flag: \"a\" });")).toBe(false);
  expect(hasEmbeddedAppend("x.ts", "const source = `fs.appendFileSync(logFile, line)`;")).toBe(true);
});
