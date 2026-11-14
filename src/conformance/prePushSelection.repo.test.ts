import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const SELECTION = path.join(ROOT, "scripts", "guard-selection.mts");
const HOOK = fs.readFileSync(path.join(ROOT, ".husky", "pre-push"), "utf8");

/** What the selection script says for a push that changes `paths`, with the real vitest configuration and tracked files. */
function selection(paths: readonly string[]): string {
  const result = spawnSync(process.execPath, [SELECTION], { cwd: ROOT, input: paths.map((entry) => `${entry}\n`).join(""), encoding: "utf8" });
  expect(result.status, `the selection script ended with ${String(result.status)}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

describe("which pushes run the kept-tests guard, by the repository's own vitest configuration", () => {
  it("does not run it for a push that changes nothing the guard reads, nor for an empty one", () => {
    expect(selection(["docs/architecture.md", "scripts/build.mts", "docs/conformance/notes.md"])).toBe("skip");
    expect(selection([])).toBe("skip");
  });

  it("runs it for a test file in any form vitest takes, deleted or not, or a path under conformance/ or src/conformance/", () => {
    for (const changed of ["src/usage/read.test.ts", "src/frontdoor/x.repo.test.ts", "scripts/x.test.ts", "src/new.spec.ts", "src/new.test.mts", "src/was.test.ts", "conformance/README.md", "conformance/function/paths.json", "src/conformance/keptTests.ts"]) {
      expect(selection(["docs/architecture.md", changed]), changed).toBe("run");
    }
  });

  it("runs it for the configuration, the files it runs before the tests and the files that fix versions, which it reads from the configuration", () => {
    const config = fs.readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    const setup = [...config.matchAll(/(?:setupFiles|globalSetup): \["\.\/([^"]+)"\]/gu)].map((match) => match[1] ?? "");
    expect(setup.length).toBeGreaterThan(0);
    for (const changed of ["vitest.config.ts", "package.json", "pnpm-lock.yaml", ...setup]) {
      expect(selection([changed]), changed).toBe("run");
    }
  });

  it("fails and does not read as a skip when it cannot read its input", () => {
    const result = spawnSync(process.execPath, [SELECTION], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, PATH: "" } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
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

  it("runs the guard once, only when the selection says run, from the changes listed without rename detection, and stops when the selection fails", () => {
    expect(HOOK.split("\n").filter((line) => line.includes('pnpm test -- "$guard"'))).toHaveLength(1);
    expect(HOOK).toContain('changed=$(git diff --no-renames --name-only "$base" HEAD) && selected=$(printf \'%s\\n\' "$changed" | node scripts/guard-selection.mts) && if [ "$selected" = run ]; then pnpm test -- "$guard"');
  });
});
