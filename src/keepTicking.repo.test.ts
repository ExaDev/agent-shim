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

/** The text of `module` under `src`, or an empty text for one that is gone by the time it is read: another test writes and removes a probe module in `src` while the suite runs, and a module that is no longer there holds nothing. */
function sourceOf(module: string): string {
  try {
    return fs.readFileSync(path.join(__dirname, module), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** Every non-test module under `src`, relative to it. */
function modules(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return modules(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith("TestWorld.ts") ? [path.relative(__dirname, full)] : [];
  });
}

/** The loops in `src` that wait between turns (`for (;;)` or `while (true)` whose body awaits a pause, sleep, delay or wait) but need no catch of their own, by module and enclosing function, each with why: each is a bounded wait for one request or one start, whose failure is that request's or that start's to answer. */
const BOUNDED_WAITS: Readonly<Record<string, string>> = {
  "frontdoor/rcSessionCommands.ts settledGoal": "polls one session command's transcript for its goal, under that command's deadline",
  "frontdoor/rcSessionCommands.ts plugin": "polls one session command's result from the session's control plugin, under that command's deadline",
  "frontdoor/server.ts awaitStartHealth": "waits for one start's health probe within its budget, and its caller answers that start",
  "headroom/supervisor.ts waitUntilReady": "waits for one daemon start to answer within its budget",
  "supervise/sessionControl.ts requestInSession": "polls one control command's result, aborted with it",
};

/** The modules whose code is a timer-driven tick, in which a promise started and not returned (`void <chain>`) is the tick's own to catch. */
const TICK_MODULES = ["catalogueKeeper.ts", "usage/jobKeeper.ts", "usage/windowKeeper.ts", "headroom/keeper.ts"] as const;

/** The timers in `src` written inside a string of code another runtime runs, which the TypeScript checks here cannot see or wrap, by module, each with why it needs no keepTicking. */
const EMBEDDED_TIMERS: Readonly<Record<string, string>> = {
  "frontdoor/watchdog.ts": "the watchdog thread's own interval, whose file system calls catch their own failure: the log and record writes, the start lock's clearing and the replacement's spawn inside one try, the native sample's start inside another and its pruning of older samples inside a third",
  "frontdoor/rcClientPage.ts": "the browser page's refresh interval, which runs in the viewer's browser and not in the door",
  "supervise/sessionControlPlugin.ts": "the control plugin's clock, which runs inside Claude Code and not in the door",
};

/** Each infinite loop of `source` that awaits a pause between turns and has no try whose catch goes on to the next turn (`continue`), as `<module> <enclosing function>`. One such try anywhere in the loop's body passes it: which statements of the turn lie inside the try is not checked. */
function uncaughtWaitLoops(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const infinite = (ts.isForStatement(node) && node.condition === undefined) || (ts.isWhileStatement(node) && node.expression.kind === ts.SyntaxKind.TrueKeyword);
    if (infinite) {
      const body = node.statement;
      const waits = /await [a-zA-Z.]*(pause|sleep|delay|wait)[a-zA-Z]*\(/u.test(body.getText(file));
      const caught = (function look(inner: ts.Node): boolean {
        if (ts.isTryStatement(inner) && inner.catchClause !== undefined && /\bcontinue;/u.test(inner.catchClause.block.getText(file))) return true;
        return ts.forEachChild(inner, (child) => (look(child) ? true : undefined)) ?? false;
      })(body);
      if (waits && !caught) found.push(`${module} ${enclosingName(node, file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Each `void <expression>` statement in `source` whose expression has no `.catch(`, as `<module> <line>`. */
function uncaughtVoidChains(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression) && !node.expression.expression.getText(file).includes(".catch(")) {
      found.push(`${module} ${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The modules whose failure handlers a log write must not throw out of: the tick modules, the two supervisors' loops, and `keepTicking.ts` itself. */
const HANDLER_MODULES = [...TICK_MODULES, "frontdoor/supervisor.ts", "headroom/supervisor.ts", "keepTicking.ts"] as const;

/** Each call of a logger named `log` or `<x>.log` (optionally called) written inside a catch clause or a `.catch(` callback of `source` that is not a name the module binds to `quietLog(...)`, as `<module> <line>`. It reads names only: an alias of a logger, a logger passed as the callback itself (`.catch(deps.log)`), a helper that logs, a shadowing parameter, a `.then` rejection handler and a logger by another name pass it. The door's and headroom's loggers drop a line they cannot write wherever they are called (`logFile.repo.test.ts`), and both supervisors wrap the logger they are given in `quietLog` at their entry, so the logger a supervisor's handlers call does not throw; this check is about loggers injected into the listed modules. */
function rawHandlerLogs(module: string, source: string): readonly string[] {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  const quiet = new Set<string>();
  const findQuiet = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(file) === "quietLog") quiet.add(node.name.text);
    ts.forEachChild(node, findQuiet);
  };
  findQuiet(file);
  const found: string[] = [];
  const visit = (node: ts.Node, inHandler: boolean): void => {
    if (inHandler && ts.isCallExpression(node)) {
      const callee = node.expression.getText(file).replace(/\?\.$/u, "");
      if (/^(?:[\w.]+\.)?log$/u.test(callee) && !quiet.has(callee)) found.push(`${module} ${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`);
    }
    const handler = ts.isCatchClause(node) || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch");
    ts.forEachChild(node, (child) => { visit(child, inHandler || handler); });
  };
  visit(file, false);
  return found;
}

/** Whether `source` writes `setInterval(` or `.every(` inside a string or template of code. */
function hasEmbeddedTimer(module: string, source: string): boolean {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /setInterval\(|\.every\(\d/u.test(node.getText(file))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("a background loop in a long-lived process", () => {
  const found = modules(__dirname).flatMap((module) => unwrappedTimers(module, sourceOf(module)));

  it("ticks through keepTicking at each setInterval and clock.every call in the non-test modules of src, but where an allowance says why not", () => {
    expect(found.filter((key) => ALLOWED[key] === undefined)).toEqual([]);
  });

  it("names in each allowance a timer the module still has", () => {
    expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("has in each loop that waits between turns at least one try whose catch goes on to the next turn, but where an allowance says why not; what the turn does outside that try is not read", () => {
    const loops = modules(__dirname).flatMap((module) => uncaughtWaitLoops(module, sourceOf(module)));
    expect(loops.filter((key) => BOUNDED_WAITS[key] === undefined)).toEqual([]);
    expect(Object.keys(BOUNDED_WAITS).filter((key) => !loops.includes(key))).toEqual([]);
  });

  it("has each promise a tick module starts and drops catch its own failure", () => {
    expect(TICK_MODULES.flatMap((module) => uncaughtVoidChains(module, sourceOf(module)))).toEqual([]);
  });

  it("calls no logger named log or <x>.log inside a catch clause or a .catch callback of the listed modules but one bound to quietLog(...); a logger reached another way (an alias, a logger passed as the callback, a helper, a .then rejection handler) is not read", () => {
    expect(HANDLER_MODULES.flatMap((module) => rawHandlerLogs(module, sourceOf(module)))).toEqual([]);
  });

  it("names each module that writes a timer inside a string of code, and why it needs no keepTicking", () => {
    const embedded = modules(__dirname).filter((module) => hasEmbeddedTimer(module, sourceOf(module)));
    expect(embedded.filter((module) => EMBEDDED_TIMERS[module] === undefined)).toEqual([]);
    expect(Object.keys(EMBEDDED_TIMERS).filter((module) => !embedded.includes(module))).toEqual([]);
  });

  it("finds a waiting loop with no catch, a dropped promise with no catch, and a timer written in a string", () => {
    expect(uncaughtWaitLoops("x.ts", "async function run() { for (;;) { work(); await pause(); } }")).toEqual(["x.ts run"]);
    expect(uncaughtWaitLoops("x.ts", "async function run() { for (;;) { try { work(); } catch (error) { log(error); await pause(); continue; } await pause(); } }")).toEqual([]);
    expect(uncaughtVoidChains("x.ts", "function tick() { void refresh().then(done); }")).toEqual(["x.ts 1"]);
    expect(rawHandlerLogs("x.ts", "function tick() { try { work(); } catch (error) { deps.log(String(error)); } }")).toEqual(["x.ts 1"]);
    expect(rawHandlerLogs("x.ts", "function tick() { void run().catch((error) => { log?.(String(error)); }); }")).toEqual(["x.ts 1"]);
    expect(rawHandlerLogs("x.ts", "const log = quietLog(deps.log); function tick() { try { work(); } catch (error) { log(String(error)); } deps.log(\"done\"); }")).toEqual([]);
    expect(uncaughtVoidChains("x.ts", "function tick() { void refresh().then(done).catch(log); }")).toEqual([]);
    expect(hasEmbeddedTimer("x.ts", "const SOURCE = `setInterval(() => beat(), 100);`;")).toBe(true);
  });

  it("finds a timer whose callback is bare, and leaves one ticking through keepTicking", () => {
    expect(unwrappedTimers("x.ts", "function start() { setInterval(tick, 1000); }")).toEqual(["x.ts start"]);
    expect(unwrappedTimers("x.ts", 'function start() { setInterval(keepTicking("x", tick, log), 1000); }')).toEqual([]);
    expect(unwrappedTimers("x.ts", "function watch() { clock.every(() => undefined, 5); }")).toEqual(["x.ts watch"]);
  });
});
