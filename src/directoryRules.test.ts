import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { ConfigValidationError } from "./config/load";
import { reportFatalError } from "./cliReport";
import { buildProgram } from "./program";
import { addPool } from "./poolStore";
import { fakeCommandDeps } from "./test-helpers";
import { DirectoryRuleAlreadyExistsError, DirectoryRuleMissingTargetError, DirectoryRuleNotFoundError, addDirectoryRule, listDirectoryRules, readDirectoryRules, removeDirectoryRule, updateDirectoryRule, writeDirectoryRules } from "./directoryRulesStore";

describe("directoryRules", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-rules-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("readDirectoryRules", () => {
    it("returns an empty rule set when the file does not exist yet", () => {
      expect(readDirectoryRules(paths)).toEqual({ rules: [] });
    });
  });

  describe("addDirectoryRule", () => {
    it("creates the file and adds a first rule with a profile", () => {
      const rule = addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme" });
      expect(rule).toEqual({ path: "~/work/clients/acme", configProfile: "client-acme" });
      expect(listDirectoryRules(paths)).toEqual([rule]);
    });

    it("adds a rule with an identity pin instead of a profile", () => {
      const rule = addDirectoryRule(paths, "~/work/clients/regulated", { identity: "work" });
      expect(rule).toEqual({ path: "~/work/clients/regulated", identity: "work" });
    });

    it("adds a rule with both a profile and an identity", () => {
      const rule = addDirectoryRule(paths, "~/work/clients/regulated", {
        configProfile: "client-strict",
        identity: "work",
      });
      expect(rule).toEqual({
        path: "~/work/clients/regulated",
        configProfile: "client-strict",
        identity: "work",
      });
    });

    it("throws DirectoryRuleMissingTargetError when neither --config-profile nor --identity is given", () => {
      expect(() => addDirectoryRule(paths, "~/work", {})).toThrow(DirectoryRuleMissingTargetError);
    });

    it("throws ConfigValidationError, not a raw ZodError, for a rule set that fails DirectoryRulesSchema", () => {
      expect(() => { writeDirectoryRules(paths, { rules: [{ path: "" }] }); }).toThrow(ConfigValidationError);
    });

    it("appends a second rule for a different path", () => {
      addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme" });
      addDirectoryRule(paths, "~/work/clients/widget", { configProfile: "client-widget" });
      expect(listDirectoryRules(paths).map((rule) => rule.path)).toEqual([
        "~/work/clients/acme",
        "~/work/clients/widget",
      ]);
    });

    it("refuses a second rule for the same path rather than updating or duplicating it", () => {
      addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme" });
      expect(() => addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme-v2" })).toThrow(
        DirectoryRuleAlreadyExistsError,
      );
      expect(listDirectoryRules(paths)).toEqual([{ path: "~/work/clients/acme", configProfile: "client-acme" }]);
    });
  });

  describe("updateDirectoryRule", () => {
    it("merges an identity pin onto an existing profile-only rule, keeping its position", () => {
      addDirectoryRule(paths, "~/a", { configProfile: "a" });
      addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme" });
      addDirectoryRule(paths, "~/z", { configProfile: "z" });
      const updated = updateDirectoryRule(paths, "~/work/clients/acme", { identity: "work" });
      expect(updated).toEqual({ path: "~/work/clients/acme", configProfile: "client-acme", identity: "work" });
      expect(listDirectoryRules(paths).map((rule) => rule.path)).toEqual(["~/a", "~/work/clients/acme", "~/z"]);
    });

    it("removes a field given false, keeping every field it was not told about", () => {
      writeDirectoryRules(paths, { rules: [{ path: "~/w", configProfile: "p", identity: "i", categories: { history: false } }] });
      expect(updateDirectoryRule(paths, "~/w", { configProfile: false })).toEqual({ path: "~/w", identity: "i", categories: { history: false } });
    });

    it("refuses an update that would leave a rule doing nothing", () => {
      addDirectoryRule(paths, "~/w", { identity: "i" });
      expect(() => updateDirectoryRule(paths, "~/w", { identity: false })).toThrow(DirectoryRuleMissingTargetError);
      expect(listDirectoryRules(paths)).toEqual([{ path: "~/w", identity: "i" }]);
    });

    it("throws DirectoryRuleNotFoundError for a path with no rule", () => {
      expect(() => updateDirectoryRule(paths, "~/nowhere", { identity: "i" })).toThrow(DirectoryRuleNotFoundError);
    });
  });

  describe("removeDirectoryRule", () => {
    it("removes the matching rule", () => {
      addDirectoryRule(paths, "~/work/clients/acme", { configProfile: "client-acme" });
      addDirectoryRule(paths, "~/work/clients/widget", { configProfile: "client-widget" });
      removeDirectoryRule(paths, "~/work/clients/acme");
      expect(listDirectoryRules(paths).map((rule) => rule.path)).toEqual(["~/work/clients/widget"]);
    });

    it("throws DirectoryRuleNotFoundError when no rule matches", () => {
      expect(() => { removeDirectoryRule(paths, "~/nonexistent"); }).toThrow(DirectoryRuleNotFoundError);
    });

    it("throws DirectoryRuleNotFoundError when the file does not exist at all", () => {
      expect(() => { removeDirectoryRule(paths, "~/nonexistent"); }).toThrow(DirectoryRuleNotFoundError);
    });
  });

  describe("pool selectors as the pinned identity (the command layer)", () => {
    /** Runs one `agent-shim rule` invocation against the throwaway layout the way `src/cli.ts` does. */
    async function ruleCli(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
      const out: string[] = [];
      const err: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
        out.push(`${args.map(String).join(" ")}\n`);
      });
      const error = vi.spyOn(console, "error").mockImplementation((...args: readonly unknown[]) => {
        err.push(`${args.map(String).join(" ")}\n`);
      });
      let code: number;
      try {
        await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() }).parseAsync(["rule", ...argv], { from: "user" });
        code = typeof process.exitCode === "number" ? process.exitCode : 0;
      } catch (thrown) {
        code = reportFatalError(thrown, { env: process.env, writeErr: (line) => { err.push(`${line}\n`); } });
      } finally {
        log.mockRestore();
        error.mockRestore();
        process.exitCode = undefined;
      }
      return { code, stdout: out.join(""), stderr: err.join("") };
    }

    it("accepts pool:<name> when the pool exists", async () => {
      addPool(paths, "subs", ["work"]);
      const result = await ruleCli(["add", "~/work/clients/acme", "--identity", "pool:subs"]);
      expect(result.code).toBe(0);
      expect(readDirectoryRules(paths).rules).toContainEqual({ path: "~/work/clients/acme", identity: "pool:subs" });
    });

    it("refuses pool:<name> when no pool of that name exists", async () => {
      const result = await ruleCli(["add", "~/work/clients/acme", "--identity", "pool:subs"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('No pool named "subs"');
    });

    it("rule set accepts a pool selector for an existing rule", async () => {
      addPool(paths, "subs", ["work"]);
      addDirectoryRule(paths, "~/work/clients/acme", { identity: "work" });
      const result = await ruleCli(["set", "~/work/clients/acme", "--identity", "pool:subs"]);
      expect(result.code).toBe(0);
      expect(readDirectoryRules(paths).rules).toContainEqual({ path: "~/work/clients/acme", identity: "pool:subs" });
    });
  });
});
