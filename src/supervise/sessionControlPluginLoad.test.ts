import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { stageSessionControlPlugin } from "./sessionControlPlugin";

/**
 * Guards the control plugin against the constraint Claude Code's own loader enforces, which calling the generated hooks directly (sessionControlPlugin.test.ts) cannot see: the 2.1.319 loader refuses a hooks module that passes the plugin API object (`$`) to a function not declared at the module's top level, and then loads nothing of it. Two checks: a static one over the generated source, and the CLI's own `claude plugin validate`, run with the native binary the Agent SDK dependency ships for this platform (it needs no login), so it runs wherever the tests do.
 */

/** The names of the functions the generated module declares at its top level. */
function topLevelFunctions(source: ts.SourceFile): ReadonlySet<string> {
  return new Set(source.statements.flatMap((statement) => (ts.isFunctionDeclaration(statement) && statement.name !== undefined ? [statement.name.text] : [])));
}

/** Every call in the module that passes `$` to a function named by a plain identifier, with that name. */
function callsPassingApi(source: ts.SourceFile): readonly string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "$")) {
      names.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The native Claude Code binary the Agent SDK's platform package ships here, resolved from the SDK's own directory the way the SDK resolves it. */
function bundledClaudeBinary(): string {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  const manifest = createRequire(sdk).resolve(platformPackage);
  return path.join(path.dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
}

/** How long one `plugin validate` run may take: the binary's start dominates, which a heavily loaded machine stretches to tens of seconds; this bounds a hung run, not a slow one. */
const VALIDATE_TIMEOUT_MS = 120_000;

describe("the control plugin as Claude Code's loader reads it", () => {
  it("passes the plugin API object only to functions declared at the module's top level", () => {
    const plugin = stageSessionControlPlugin();
    try {
      const text = readFileSync(path.join(plugin.directory, "hooks", "register.js"), "utf8");
      const source = ts.createSourceFile("register.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const declared = topLevelFunctions(source);
      const passed = callsPassingApi(source);
      expect(passed.length).toBeGreaterThan(0);
      expect(passed.filter((name) => !declared.has(name))).toEqual([]);
    } finally {
      plugin.release();
    }
  });

  it("validates with the Claude Code binary the Agent SDK ships, with no login", () => {
    const plugin = stageSessionControlPlugin();
    const config = mkdtempSync(path.join(tmpdir(), "agent-shim-validate-"));
    try {
      const run = spawnSync(bundledClaudeBinary(), ["plugin", "validate", plugin.directory], { env: { HOME: config, CLAUDE_CONFIG_DIR: config, PATH: process.env.PATH }, encoding: "utf8", timeout: VALIDATE_TIMEOUT_MS });
      expect(run.error).toBeUndefined();
      expect(`${run.stdout}${run.stderr}`).toContain("Validation passed");
      expect(run.status).toBe(0);
    } finally {
      plugin.release();
      rmSync(config, { recursive: true, force: true });
    }
  }, VALIDATE_TIMEOUT_MS);
});
