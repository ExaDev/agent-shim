import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The interval timers `src` may start with a callback that is not a `keepTicking(...)` call, by module and enclosing function, each with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "frontdoor/doorWorker.ts every": "the clock's own timer, whose one caller hands it a keepTicking callback (held by the clock.every check below)",
};

/** The enclosing function's name for each node: a function declaration, a method, or a function bound to a name or a property. */
function enclosingName(node: ts.Node, file: ts.SourceFile): string {
  for (let current: ts.Node = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) return current.name.getText(file);
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && (ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent))) return current.parent.name.getText(file);
  }
  return "(module)";
}

/** Each `setInterval(` and `clock.every(` call in `source` whose callback is not a `keepTicking(` call, as `<module> <enclosing function>`. */
function unwrappedTimers(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      const isTimer = callee === "setInterval" || callee === "window.setInterval" || callee === "clock.every";
      const callback = node.arguments[0];
      const wrapped = callback !== undefined && ts.isCallExpression(callback) && callback.expression.getText(file) === "keepTicking";
      if (isTimer && !wrapped) found.push(`${module} ${enclosingName(node, file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every non-test module under `src`, relative to it. */
function modules(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return modules(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith("TestWorld.ts") ? [path.relative(__dirname, full)] : [];
  });
}

describe("a background loop in a long-lived process", () => {
  const found = modules(__dirname).flatMap((module) => unwrappedTimers(module, fs.readFileSync(path.join(__dirname, module), "utf8")));

  it("ticks through keepTicking at each setInterval and clock.every in src, but where an allowance says why not", () => {
    expect(found.filter((key) => ALLOWED[key] === undefined)).toEqual([]);
  });

  it("names in each allowance a timer the module still has", () => {
    expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("finds a timer whose callback is bare, and leaves one ticking through keepTicking", () => {
    expect(unwrappedTimers("x.ts", "function start() { setInterval(tick, 1000); }")).toEqual(["x.ts start"]);
    expect(unwrappedTimers("x.ts", 'function start() { setInterval(keepTicking("x", tick, log), 1000); }')).toEqual([]);
    expect(unwrappedTimers("x.ts", "function watch() { clock.every(() => undefined, 5); }")).toEqual(["x.ts watch"]);
  });
});
