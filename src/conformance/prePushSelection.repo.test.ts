import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const SELECTION = path.join(ROOT, "scripts", "guard-selection.sh");
const HOOK = fs.readFileSync(path.join(ROOT, ".husky", "pre-push"), "utf8");

/** Whether the hook runs the guard for a push that changes `paths`: the exit status of the selection script, 0 meaning yes. */
function runsTheGuard(paths: readonly string[]): boolean {
  const result = spawnSync("sh", [SELECTION], { input: paths.map((entry) => `${entry}\n`).join(""), encoding: "utf8" });
  expect(result.status === 0 || result.status === 1, `the selection script ended with ${String(result.status)}: ${result.stderr}`).toBe(true);
  return result.status === 0;
}

describe("which pushes run the kept-tests guard", () => {
  it("does not run it for a push that changes only code the guard cannot be wrong about", () => {
    expect(runsTheGuard(["src/usage/read.ts", "src/launcher/farm.ts", "package.json", "docs/architecture.md", "scripts/build.mts"])).toBe(false);
    expect(runsTheGuard([])).toBe(false);
  });

  it("runs it for a push that changes a test file, whatever its directory, or a path under conformance/ or src/conformance/", () => {
    for (const changed of ["src/usage/read.test.ts", "src/frontdoor/x.repo.test.ts", "scripts/x.test.ts", "conformance/README.md", "conformance/function/paths.json", "src/conformance/keptTests.ts", "src/conformance/root.ts"]) {
      expect(runsTheGuard(["docs/architecture.md", changed]), changed).toBe(true);
    }
  });

  it("does not take a name that only resembles those paths", () => {
    expect(runsTheGuard(["src/conformanceNotes.ts", "docs/conformance/notes.md", "src/usage/atest.ts", "src/usage/test.ts.bak"])).toBe(false);
  });
});

describe("the pre-push hook", () => {
  const GUARD = "src/conformance/keptTests.repo.test.ts";

  it("names a guard test that exists and keeps the repository-reading suffix", () => {
    expect(HOOK).toContain(`guard="${GUARD}"`);
    expect(fs.existsSync(path.join(ROOT, GUARD))).toBe(true);
    expect(GUARD.endsWith(".repo.test.ts")).toBe(true);
  });

  it("excludes the guard from every other test run of the hook, so a push never runs it twice", () => {
    const runs = HOOK.split("\n").flatMap((line) => line.split("&&")).map((part) => part.trim()).filter((part) => part.startsWith("pnpm test --") && !part.includes('"$guard" --maxWorkers'));
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run, run).toContain('--exclude "**/$guard"');
    }
  });

  it("runs the guard once, and only when the selection script says the push changes what it can be wrong about", () => {
    expect(HOOK.split("\n").filter((line) => line.includes('pnpm test -- "$guard"'))).toHaveLength(1);
    expect(HOOK).toContain('if git diff --name-only "$base" HEAD | sh scripts/guard-selection.sh; then pnpm test -- "$guard"');
  });
});
