import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { reportFatalError } from "./cliReport";
import { addIdentity } from "./identityManager";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";
import { snapshotPath } from "./usage/read";

const HOUR_MS = 3_600_000;
const SIX_DAYS_MS = 518_400_000;
const MAX_20X = "default_claude_max_20x";
const U10 = 0.1;
const U60 = 0.6;
const FULL = 1;

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-use-pools-"));
  paths = buildLayoutPaths(root);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one `claude-use` invocation against the throwaway layout the way `src/cli.ts` does. */
async function cli(argv: readonly string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "error").mockImplementation((...args: readonly unknown[]) => {
    err.push(`${args.map(String).join(" ")}\n`);
  });
  let code: number;
  try {
    await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn<(args: readonly string[]) => Promise<void>>() }).parseAsync([...argv], { from: "user" });
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    code = reportFatalError(error, {
      writeErr: (line) => {
        err.push(`${line}\n`);
      },
      env: {},
    });
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function seedSnapshot(identity: string, window: { readonly utilization: number; readonly resetsInMs: number; readonly status?: string }): void {
  const seen = new Date(Date.now() - HOUR_MS).toISOString();
  const snapshot = {
    schemaVersion: 1,
    identity,
    updatedAt: seen,
    account: { organizationRateLimitTier: MAX_20X },
    providers: {
      anthropic: {
        lastRequestAt: seen,
        lastStatus: 200,
        rateLimit: {
          observedAt: seen,
          headers: {},
          unified: { sevenDay: { utilization: window.utilization, resetsAt: new Date(Date.now() + window.resetsInMs).toISOString(), ...(window.status === undefined ? {} : { status: window.status }) } },
        },
      },
    },
  };
  fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
  fs.writeFileSync(snapshotPath(paths.usageSnapshotsDir, identity), JSON.stringify(snapshot));
}

describe("claude-use pool", () => {
  beforeEach(() => {
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
  });

  it("adds, lists, shows, changes and removes a pool", async () => {
    expect((await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work, personal");
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work", "personal"] });
    expect((await cli(["pool", "set", "subs", "--identity", "work"])).code).toBe(0);
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Members: work");
    expect((await cli(["pool", "remove", "subs", "--yes"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("No pools yet");
  });

  it("refuses a duplicate pool, an invalid name, an unknown member, a missing member list and an unknown pool", async () => {
    await cli(["pool", "add", "subs", "--identity", "work"]);
    expect((await cli(["pool", "add", "subs", "--identity", "work"])).stderr).toContain("already exists");
    expect((await cli(["pool", "add", "bad:name", "--identity", "work"])).stderr).toContain("not a valid pool name");
    const ghost = await cli(["pool", "add", "other", "--identity", "ghost"]);
    expect(ghost.code).toBe(EXIT_FAILURE);
    expect(ghost.stderr).toContain("ghost");
    expect((await cli(["pool", "add", "other"])).code).toBe(EXIT_USAGE);
    expect((await cli(["pool", "show", "nope"])).stderr).toContain('No pool named "nope"');
    expect((await cli(["pool", "remove", "nope", "--yes"])).code).toBe(EXIT_FAILURE);
  });

  it("keeps the other pools when one is changed or removed", async () => {
    await cli(["pool", "add", "a", "--identity", "work"]);
    await cli(["pool", "add", "b", "--identity", "personal"]);
    await cli(["pool", "remove", "a", "--yes"]);
    expect(JSON.parse((await cli(["pool", "list", "--json"])).stdout)).toEqual([{ name: "b", identities: ["personal"], active: false }]);
  });

  it("selects a pool as the active selection through `pool use`, `identity use` and the @ shortcut, and marks it in the list", async () => {
    await cli(["pool", "add", "subs", "--identity", "work"]);
    expect((await cli(["pool", "use", "subs"])).code).toBe(0);
    expect(fs.readFileSync(paths.activeIdentityFile, "utf8")).toBe("pool:subs\n");
    expect((await cli(["pool", "list"])).stdout).toContain("* subs");
    await cli(["identity", "use", "work"]);
    expect((await cli(["identity", "use", "pool:subs"])).code).toBe(0);
    expect(fs.readFileSync(paths.activeIdentityFile, "utf8")).toBe("pool:subs\n");
    expect((await cli(["pool", "use", "nope"])).code).toBe(EXIT_FAILURE);
    expect((await cli(["identity", "use", "pool:nope"])).stderr).toContain('No pool named "nope"');
  });

  describe("pick", () => {
    it("ranks the members as a launch would, and records nothing", async () => {
      seedSnapshot("work", { utilization: U60, resetsInMs: HOUR_MS });
      seedSnapshot("personal", { utilization: U10, resetsInMs: SIX_DAYS_MS });
      await cli(["pool", "add", "subs", "--identity", "personal", "--identity", "work"]);
      const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as { pick: string; candidates: { identity: string; class: string }[] };
      expect(report.pick).toBe("work");
      expect(report.candidates.map((candidate) => candidate.identity)).toEqual(["work", "personal"]);
      const text = (await cli(["pool", "pick", "subs"])).stdout;
      expect(text).toContain("would run as work");
      expect(text).toContain("7d 60% used");
      expect(fs.existsSync(paths.usagePicksFile)).toBe(false);
    });

    it("says when every member is refused and when it clears", async () => {
      seedSnapshot("work", { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" });
      await cli(["pool", "add", "subs", "--identity", "work"]);
      const text = (await cli(["pool", "pick", "subs"])).stdout;
      expect(text).toContain("every member is refused");
      expect(text).toContain("work returns at");
    });

    it("lists a member with no recorded usage as unknown, and one that is no longer an identity as skipped", async () => {
      await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal"]);
      fs.rmSync(path.join(paths.identitiesDir, "work"), { recursive: true });
      const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as { candidates: { identity: string; class: string }[]; missing: string[] };
      expect(report.candidates).toMatchObject([{ identity: "personal", class: "unknown" }]);
      expect(report.missing).toEqual(["work"]);
      expect((await cli(["pool", "pick", "subs"])).stdout).toContain("(skipped: work is not an identity)");
    });
  });
});
