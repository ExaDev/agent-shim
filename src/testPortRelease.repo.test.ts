import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The one place a test takes a port for a connect it expects to be refused, and the reason it is race-free: `closedLoopbackPort` in `test-ports.ts`. */
const HELPER = "closedLoopbackPort";

/** Whether `node` is a call of a method called `name`. */
function callsMethod(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name;
}

/** Whether the first argument of a `listen` call asks for port 0: `listen(0, ...)` or `listen({ port: 0, ... })`. */
function listensOnAnyPort(call: ts.CallExpression): boolean {
  const [first] = call.arguments;
  if (first === undefined) {
    return false;
  }
  if (ts.isNumericLiteral(first)) {
    return first.text === "0";
  }
  return ts.isObjectLiteralExpression(first) && first.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === "port" && ts.isNumericLiteral(property.initializer) && property.initializer.text === "0");
}

/** Whether `node` is a function-like. */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

/** Whether `call` runs while `owner` runs, rather than later: it is not inside a function `owner` only hands on (a cleanup it registers, a callback it returns), except the executor of a `new Promise`, which runs at once. */
function runsWithin(call: ts.Node, owner: ts.Node): boolean {
  for (let node = call.parent; node !== owner; node = node.parent) {
    if (isFunctionLike(node) && !(ts.isNewExpression(node.parent) && node.parent.expression.getText() === "Promise")) {
      return false;
    }
  }
  return true;
}

/** Whether `node` or anything under it spells a port: the identifier `port` or a `.port` access. */
function mentionsPort(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if ((ts.isIdentifier(child) && child.text === "port") || (ts.isPropertyAccessExpression(child) && child.name.text === "port")) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The functions of a source text that hand back a port taken by binding a listener on port 0 and then closing it: the port is not held, so any listener another test binds on port 0 in parallel can be given it before it is used, and the caller then reaches that listener instead of the closed port it meant (or fails to bind it). Two shapes: a `close` that comes before a returned port in the same body, and a `close` whose callback is what resolves the port.
 */
function releasedPortReturns(sourceText: string): readonly string[] {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body !== undefined) {
      const calls: ts.CallExpression[] = [];
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) {
          calls.push(child);
        }
        ts.forEachChild(child, collect);
      };
      collect(node.body);
      const listen = calls.find((call) => callsMethod(call, "listen") && listensOnAnyPort(call));
      const closes = calls.filter((call) => callsMethod(call, "close"));
      if (listen !== undefined && closes.length > 0) {
        const returnsPortAfterClose = ts.isBlock(node.body) && node.body.statements.some((statement) => ts.isReturnStatement(statement) && statement.expression !== undefined && mentionsPort(statement.expression) && closes.some((close) => runsWithin(close, node) && close.end <= statement.getStart()));
        const closeResolvesPort = closes.some((close) => close.arguments.some((argument) => (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && mentionsPort(argument.body)));
        if (returnsPortAfterClose || closeResolvesPort) {
          found.push(node.getText().split("\n", 1)[0] ?? "");
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The TypeScript modules under `directory` that `wanted` accepts by file name. */
function sourcesUnder(directory: string, wanted: (fileName: string) => boolean): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourcesUnder(child, wanted);
    }
    return /\.m?ts$/.test(entry.name) && wanted(entry.name) ? [child] : [];
  });
}

/** What the guard scans: every module under `src` whose name says it is test code (a test, a test world, a test helper), and every script under `scripts`, which run the same kind of local servers. Nothing else in the repository takes a port this way. */
function scannedSources(): readonly string[] {
  const root = path.join(__dirname, "..");
  return [...sourcesUnder(__dirname, (fileName) => /test/i.test(fileName)), ...sourcesUnder(path.join(root, "scripts"), () => true)];
}

describe("a port a test takes by binding a listener on port 0 and closing it", () => {
  it("is returned by no test source or script: another listener can be given it before it is used", () => {
    const offenders = scannedSources().filter((file) => releasedPortReturns(fs.readFileSync(file, "utf8")).length > 0);
    expect(offenders.map((file) => path.relative(path.join(__dirname, ".."), file)), `take the port from ${HELPER} instead`).toEqual([]);
  });

  it("is looked for in the test sources and in the scripts", () => {
    const scanned = scannedSources().map((file) => path.relative(path.join(__dirname, ".."), file));
    expect(scanned).toContain(path.join("scripts", "headroom-measure-run.ts"));
    expect(scanned).toContain(path.join("src", "test-ports.test.ts"));
  });

  it("is found in a helper that closes its listener and then returns the port", () => {
    expect(
      releasedPortReturns(`
        async function closedPort() {
          const server = net.createServer();
          await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
          const address = server.address();
          await new Promise((resolve) => { server.close(() => { resolve(undefined); }); });
          return address.port;
        }`),
    ).toHaveLength(1);
  });

  it("is found in a helper whose close callback resolves the port", () => {
    expect(
      releasedPortReturns(`
        async function freePort() {
          return await new Promise((resolve) => {
            const server = net.createServer();
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              server.close(() => { resolve(address.port); });
            });
          });
        }`),
    ).toHaveLength(1);
  });

  it("is found when the listener is asked for by an options object", () => {
    expect(
      releasedPortReturns(`
        async function closedPort() {
          const server = net.createServer();
          await new Promise((resolve) => { server.listen({ port: 0, host: "127.0.0.1" }, resolve); });
          const { port } = server.address();
          server.close();
          return port;
        }`),
    ).toHaveLength(1);
  });

  it("is found in a helper that returns the port from an async close callback", () => {
    expect(
      releasedPortReturns(`
        async function freePort() {
          const server = net.createServer();
          await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
          const { port } = server.address();
          return await new Promise((resolve) => {
            server.close(async () => {
              await Promise.resolve();
              resolve(port);
            });
          });
        }`),
    ).toHaveLength(1);
  });

  it("is not found in a helper that keeps its listener open and hands the test a way to close it", () => {
    expect(
      releasedPortReturns(`
        async function startDoor() {
          const server = net.createServer();
          await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
          return { port: server.address().port, close: () => server.close() };
        }`),
    ).toEqual([]);
  });
});
