import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { reportFatalError } from "./cliReport";
import { addIdentity } from "./identityStore";
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-pools-"));
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

/** Runs one `agent-shim` invocation against the throwaway layout the way `src/cli.ts` does. */
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

describe("agent-shim pool", () => {
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

  it("stores a listed preference on add, round-trips it, keeps it across a member change, and clears it", async () => {
    expect((await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal", "--preference", "listed"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work, personal (preference: listed)");
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Members: work, personal");
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Preference: listed");
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work", "personal"], preference: "listed" });
    const stored = JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8")) as { pools: Record<string, unknown> };
    expect(stored.pools).toEqual({ subs: { identities: ["work", "personal"], preference: "listed" } });
    // Setting the preference alone keeps the members; setting the members alone keeps the preference.
    expect((await cli(["pool", "set", "subs", "--preference", "score"])).code).toBe(0);
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work", "personal"], preference: "score" });
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work, personal (preference: score)");
    expect((await cli(["pool", "set", "subs", "--identity", "work"])).code).toBe(0);
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work"], preference: "score" });
    expect((await cli(["pool", "set", "subs", "--no-preference"])).code).toBe(0);
    expect((await cli(["pool", "show", "subs"])).stdout).not.toContain("Preference:");
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work");
    expect((await cli(["pool", "list"])).stdout).not.toContain("(preference:");
    const cleared = JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8")) as { pools: Record<string, unknown> };
    expect(cleared.pools).toEqual({ subs: { identities: ["work"] } });
  });

  it("switches resuming on a spent quota on and off, and shows it", async () => {
    expect((await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal", "--resume-on-limit"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work, personal (resumes on limit)");
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Resume on limit: yes");
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work", "personal"], resumeOnLimit: true });
    expect((await cli(["pool", "set", "subs", "--preference", "listed"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work, personal (preference: listed, resumes on limit)");
    const stored = JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8")) as { pools: Record<string, unknown> };
    expect(stored.pools).toEqual({ subs: { identities: ["work", "personal"], preference: "listed", resumeOnLimit: true } });
    expect((await cli(["pool", "set", "subs", "--no-resume-on-limit"])).code).toBe(0);
    expect((await cli(["pool", "show", "subs"])).stdout).not.toContain("Resume on limit");
    const cleared = JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8")) as { pools: Record<string, unknown> };
    expect(cleared.pools).toEqual({ subs: { identities: ["work", "personal"], preference: "listed" } });
    expect((await cli(["pool", "set", "subs", "--resume-on-limit"])).code).toBe(0);
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Resume on limit: yes");
  });

  it("sets the compaction settings, shows them, and refuses ones that contradict or are out of range", async () => {
    expect((await cli(["pool", "add", "subs", "--identity", "work", "--resume-on-limit", "--compact-before-limit", "--compact-at-utilisation", "85"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work (resumes on limit, compacts at 85%)");
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Compact before limit: at 85% of a window");
    expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["work"], resumeOnLimit: true, compactBeforeLimit: true, compactAtUtilisation: 85 });
    expect((await cli(["pool", "set", "subs", "--no-compact-at-utilisation"])).code).toBe(0);
    expect((await cli(["pool", "list"])).stdout).toContain("subs: work (resumes on limit, compacts before the limit)");
    expect((await cli(["pool", "show", "subs"])).stdout).toContain("Compact before limit: when compacting would cost more than the member's tightest quota window has left");
    expect((await cli(["pool", "set", "subs", "--no-compact-before-limit"])).code).toBe(0);
    expect((await cli(["pool", "show", "subs"])).stdout).not.toContain("Compact before limit");
    // A setting that needs another one switched on is refused, naming what is missing.
    const contradiction = await cli(["pool", "set", "subs", "--no-resume-on-limit", "--compact-before-limit"]);
    expect(contradiction.code).toBe(EXIT_USAGE);
    expect(contradiction.stderr).toContain("compactBeforeLimit needs resumeOnLimit");
    expect((await cli(["pool", "add", "other", "--identity", "personal", "--compact-before-limit"])).stderr).toContain("compactBeforeLimit needs resumeOnLimit");
    for (const bad of ["0", "101", "abc", "7.5"]) {
      expect((await cli(["pool", "add", "other", "--identity", "personal", "--resume-on-limit", "--compact-before-limit", "--compact-at-utilisation", bad])).code).toBe(EXIT_USAGE);
    }
  });

  it("refuses a pool set with nothing to change, and an unknown preference mode", async () => {
    await cli(["pool", "add", "subs", "--identity", "work"]);
    const nothing = await cli(["pool", "set", "subs"]);
    expect(nothing.code).toBe(EXIT_USAGE);
    expect(nothing.stderr).toContain("Nothing to change");
    const bad = await cli(["pool", "set", "subs", "--preference", "random"]);
    expect(bad.code).toBe(EXIT_USAGE);
    expect((await cli(["pool", "add", "other", "--identity", "personal", "--preference", "random"])).code).toBe(EXIT_USAGE);
  });

  describe("nested members", () => {
    it("accepts a pool:<name> member, and shows and lists it as written", async () => {
      await cli(["pool", "add", "fleet", "--identity", "work", "--identity", "personal"]);
      expect((await cli(["pool", "add", "subs", "--identity", "personal", "--identity", "pool:fleet"])).code).toBe(0);
      expect((await cli(["pool", "show", "subs"])).stdout).toContain("Members: personal, pool:fleet");
      expect((await cli(["pool", "list"])).stdout).toContain("subs: personal, pool:fleet");
      expect(JSON.parse((await cli(["pool", "show", "subs", "--json"])).stdout)).toEqual({ name: "subs", identities: ["personal", "pool:fleet"] });
    });

    it("refuses a nested member naming a pool that is not defined", async () => {
      const missing = await cli(["pool", "add", "subs", "--identity", "pool:nope"]);
      expect(missing.code).toBe(EXIT_USAGE);
      expect(missing.stderr).toContain("pool:nope");
      expect(missing.stderr).toContain("is not defined");
    });

    it("refuses a self-nesting member at add, and a cycle at set, naming the chain", async () => {
      const self = await cli(["pool", "add", "loop", "--identity", "pool:loop"]);
      expect(self.code).toBe(EXIT_USAGE);
      expect(self.stderr).toContain("loop -> loop");
      await cli(["pool", "add", "a", "--identity", "work"]);
      await cli(["pool", "add", "b", "--identity", "pool:a"]);
      const cycle = await cli(["pool", "set", "a", "--identity", "pool:b"]);
      expect(cycle.code).toBe(EXIT_USAGE);
      expect(cycle.stderr).toContain("a -> b -> a");
    });

    it("ranks a nested pool's pick as part of the outer pool's report", async () => {
      seedSnapshot("work", { utilization: U60, resetsInMs: HOUR_MS });
      seedSnapshot("personal", { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" });
      await cli(["pool", "add", "fleet", "--identity", "work"]);
      await cli(["pool", "add", "subs", "--identity", "personal", "--identity", "pool:fleet", "--preference", "listed"]);
      const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as { pick: string; candidates: { identity: string; reasons: string[] }[] };
      expect(report.pick).toBe("work");
      expect(report.candidates.map((candidate) => candidate.identity)).toEqual(["personal", "work"]);
      expect(report.candidates[1]?.reasons[0]).toContain('picked by pool "fleet"');
      const text = (await cli(["pool", "pick", "subs"])).stdout;
      expect(text).toContain("would run as work");
      expect(text).toContain('picked by pool "fleet"');
    });
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

    it("ranks a listed pool in member order rather than by score", async () => {
      seedSnapshot("work", { utilization: U60, resetsInMs: HOUR_MS });
      seedSnapshot("personal", { utilization: U10, resetsInMs: SIX_DAYS_MS });
      await cli(["pool", "add", "subs", "--identity", "personal", "--identity", "work", "--preference", "listed"]);
      const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as { pick: string; candidates: { identity: string }[] };
      expect(report.pick).toBe("personal");
      expect(report.candidates.map((candidate) => candidate.identity)).toEqual(["personal", "work"]);
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

describe("agent-shim pool: members on one login", () => {
  const SHARED_LOGIN = { accountUuid: "account-alex", organizationUuid: "org-example", emailAddress: "alex@example.com", organizationName: "Example Org" };

  function signIn(identity: string, account: Readonly<Record<string, string>>): void {
    fs.writeFileSync(path.join(paths.identitiesDir, identity, ".claude.json"), JSON.stringify({ oauthAccount: account }));
  }

  beforeEach(() => {
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
    addIdentity(paths, "spare");
    signIn("work", SHARED_LOGIN);
    signIn("personal", SHARED_LOGIN);
    signIn("spare", { ...SHARED_LOGIN, accountUuid: "account-sam" });
  });

  it("warns when pool add lists two members that hold one login, and still creates the pool", async () => {
    const result = await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal", "--identity", "spare"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Pool "subs" lists work and personal');
    expect(result.stderr).toContain("alex@example.com (Example Org)");
    expect(result.stdout).toContain('Created pool "subs"');
  });

  it("warns when pool set leaves the pool listing two members that hold one login", async () => {
    await cli(["pool", "add", "subs", "--identity", "work", "--identity", "spare"]);
    const result = await cli(["pool", "set", "subs", "--identity", "work", "--identity", "personal"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Pool "subs" lists work and personal');
  });

  it("keeps the JSON output on stdout clean while it warns", async () => {
    const result = await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "created", name: "subs" });
    expect(result.stderr).toContain("hold the same login");
  });

  it("does not warn for members on different logins", async () => {
    const result = await cli(["pool", "add", "subs", "--identity", "work", "--identity", "spare"]);
    expect(result.stderr).toBe("");
  });

  it("does not warn when pool set changes only a setting of a pool that lists no such pair", async () => {
    await cli(["pool", "add", "subs", "--identity", "work", "--identity", "spare"]);
    expect((await cli(["pool", "set", "subs", "--preference", "listed"])).stderr).toBe("");
  });

  it("shows the twin as the same login in pool pick", async () => {
    await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal"]);
    const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as { candidates: { identity: string; class: string; reasons: string[] }[] };
    const twin = report.candidates.find((candidate) => candidate.class === "ineligible");
    expect(twin?.reasons).toEqual(["same login as work"]);
    expect((await cli(["pool", "pick", "subs"])).stdout).toContain("same login as work");
  });
});

describe("agent-shim pool pick: ranking on a provider", () => {
  const PROVIDER = { displayName: "Example", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "example-token" }] } };

  /** An identity whose Claude seven-day window is spent and whose provider `p` seven-day window is open. */
  function seedSpentClaudeOpenProvider(identity: string): void {
    seedSnapshot(identity, { utilization: FULL, resetsInMs: SIX_DAYS_MS, status: "rejected" });
    const file = snapshotPath(paths.usageSnapshotsDir, identity);
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as { providers: Record<string, unknown> };
    const seen = new Date(Date.now() - HOUR_MS).toISOString();
    snapshot.providers.p = { lastRequestAt: seen, lastStatus: 200, rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: U10, resetsAt: new Date(Date.now() + SIX_DAYS_MS).toISOString() } } } };
    fs.writeFileSync(file, JSON.stringify(snapshot));
  }

  interface PickJson {
    readonly pick?: string;
    readonly candidates: readonly { readonly identity: string; readonly class: string; readonly provider?: string }[];
  }

  beforeEach(async () => {
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "p.json"), JSON.stringify(PROVIDER));
    seedSpentClaudeOpenProvider("work");
    seedSpentClaudeOpenProvider("personal");
    await cli(["pool", "add", "subs", "--identity", "work", "--identity", "personal"]);
  });

  it("ranks each member on the provider the flag names, reporting it per candidate", async () => {
    const report = JSON.parse((await cli(["pool", "pick", "subs", "--provider", "p", "--json"])).stdout) as PickJson;
    expect(report.pick).toBeDefined();
    expect(report.candidates.map((candidate) => [candidate.class, candidate.provider])).toEqual([["scored", "p"], ["scored", "p"]]);
    expect((await cli(["pool", "pick", "subs", "--provider", "p"])).stdout).toContain("on provider p");
  });

  it("ranks the same pool on the Claude account when no provider applies, and with --no-provider", async () => {
    for (const argv of [["pool", "pick", "subs", "--json"], ["pool", "pick", "subs", "--no-provider", "--json"]]) {
      const report = JSON.parse((await cli(argv)).stdout) as PickJson;
      expect(report.pick).toBeUndefined();
      expect(report.candidates.map((candidate) => candidate.class)).toEqual(["ineligible", "ineligible"]);
      expect(report.candidates.every((candidate) => candidate.provider === undefined)).toBe(true);
    }
  });

  it("ranks a member on the provider its own identity declares when the flag names none", async () => {
    const identityFile = path.join(paths.identitiesDir, "work", "identity.json");
    const declared = JSON.parse(fs.readFileSync(identityFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(identityFile, JSON.stringify({ ...declared, provider: "p" }));
    const report = JSON.parse((await cli(["pool", "pick", "subs", "--json"])).stdout) as PickJson;
    expect(report.pick).toBe("work");
    expect(report.candidates.find((candidate) => candidate.identity === "work")).toMatchObject({ class: "scored", provider: "p" });
    expect(report.candidates.find((candidate) => candidate.identity === "personal")).toMatchObject({ class: "ineligible" });
  });
});
