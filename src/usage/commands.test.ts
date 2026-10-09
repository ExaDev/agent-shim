import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EXIT_FAILURE, EXIT_USAGE } from "../cliError";
import { reportFatalError } from "../cliReport";
import { addIdentity, IdentityNotFoundError } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { buildProgram } from "../program";
import { realFarmFs } from "../realPorts";
import { fakeCommandDeps } from "../test-helpers";
import { claudeJsonPath } from "./account";
import { collectAccounts, collectUsageReport } from "./commands";
import { segmentDay, segmentName, snapshotPath } from "./read";
import { USAGE_SCHEMA_VERSION, type UnifiedRateLimit, type UsageRecord, type UsageSnapshot } from "./schema";

const HOUR_MS = 3_600_000;
const FIVE_HOURS = 5;
const THIRTY_DAYS = 30;
const HOURS_PER_DAY = 24;
const MS_PER_SECOND = 1000;
const STALE_HOURS_AGO = 10;
const SINCE_HOURS = 5;
const STALE_MS = STALE_HOURS_AGO * HOUR_MS;
const SINCE_WINDOW_MS = SINCE_HOURS * HOUR_MS;
const OK_STATUS = 200;
const RATE_LIMITED_STATUS = 429;
const WRITER_PID = 31337;
const FIVE_HOUR_UTILISATION = "0.25";
const FIVE_HOUR_RESET_SECONDS = 1_768_500_000;

let root: string;
let paths: LayoutPaths;
let startedAt: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-usage-commands-"));
  paths = buildLayoutPaths(root);
  startedAt = Date.now();
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

/** Runs one `agent-shim` invocation against the throwaway layout the way `src/cli.ts` does, capturing both streams and the exit status. */
async function cli(argv: readonly string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "error").mockImplementation((...args: readonly unknown[]) => {
    err.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
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

function recordAgo(agoMs: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: new Date(startedAt - agoMs).toISOString(),
    identity: "work",
    provider: "anthropic",
    route: "passthrough",
    method: "POST",
    endpoint: "/v1/messages",
    status: OK_STATUS,
    latencyMs: 10,
    durationMs: 20,
    outcome: "completed",
    ...overrides,
  };
}

/** Writes each record into the segment for its own day, the way the store's writer lays the log out. */
function writeLog(records: readonly UsageRecord[], trailingJunk = ""): void {
  fs.mkdirSync(paths.usageLogDir, { recursive: true });
  for (const record of records) {
    const file = path.join(paths.usageLogDir, segmentName(segmentDay(Date.parse(record.at)), WRITER_PID));
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  }
  if (trailingJunk !== "") {
    const [first] = records;
    const file = path.join(paths.usageLogDir, segmentName(segmentDay(Date.parse(first?.at ?? new Date(startedAt).toISOString())), WRITER_PID));
    fs.appendFileSync(file, trailingJunk);
  }
}

function writeSnapshot(snapshot: UsageSnapshot): void {
  fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
  fs.writeFileSync(snapshotPath(paths.usageSnapshotsDir, snapshot.identity), JSON.stringify(snapshot));
}

function snapshotWithQuota(identity: string, unified?: UnifiedRateLimit): UsageSnapshot {
  const at = new Date(startedAt).toISOString();
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: at,
    providers: {
      anthropic: {
        lastRequestAt: at,
        lastStatus: OK_STATUS,
        rateLimit: {
          observedAt: at,
          headers: { "anthropic-ratelimit-unified-status": "allowed" },
          unified: unified ?? {
            status: "allowed",
            fiveHour: { utilization: Number(FIVE_HOUR_UTILISATION), resetsAt: new Date(FIVE_HOUR_RESET_SECONDS * MS_PER_SECOND).toISOString(), status: "allowed" },
          },
        },
      },
    },
  };
}

function writeProfile(identity: string, oauthAccount: unknown): void {
  fs.writeFileSync(claudeJsonPath(paths.identitiesDir, identity), JSON.stringify({ oauthAccount }));
}

const UsageJsonSchema = z.object({
  since: z.string().optional(),
  invalidLines: z.number(),
  summaries: z.array(z.object({ identity: z.string().optional(), provider: z.string(), requests: z.number(), failed: z.number() })),
  snapshots: z.array(z.object({ identity: z.string(), providers: z.record(z.string(), z.object({ lastStatus: z.number() })) })),
});

const AccountJsonSchema = z.object({
  identity: z.string(),
  account: z.object({ emailAddress: z.string().optional(), billingType: z.string().optional(), seatTier: z.string().optional() }).optional(),
  usage: z.object({ identity: z.string() }).optional(),
});

describe("agent-shim usage", () => {
  beforeEach(() => {
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
  });

  it("reports totals per identity and provider as text", async () => {
    writeLog([
      recordAgo(2 * HOUR_MS, { usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 7, cacheCreationInputTokens: 3 }, model: "claude-test" }),
      recordAgo(HOUR_MS, { status: RATE_LIMITED_STATUS, limit: { kind: "quota-exhausted", evidence: [] }, usage: { inputTokens: 5 } }),
      recordAgo(HOUR_MS, { identity: "personal", provider: "z" }),
    ]);

    const result = await cli(["usage"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`work / anthropic: 2 request(s), 1 failed, 0 rate-limited, 1 quota-exhausted`);
    expect(result.stdout).toContain("  tokens: 105 in, 40 out, 7 cache read, 3 cache write");
    expect(result.stdout).toContain("  models: claude-test");
    expect(result.stdout).toContain("personal / z: 1 request(s), 0 failed");
    expect(result.stdout.startsWith(`usage over the retained log (${paths.usageLogDir})`)).toBe(true);
  });

  it("prints the same report as JSON with --json", async () => {
    writeLog([recordAgo(HOUR_MS), recordAgo(HOUR_MS, { status: RATE_LIMITED_STATUS })]);
    writeSnapshot(snapshotWithQuota("work"));

    const result = await cli(["usage", "--json"]);

    const report = UsageJsonSchema.parse(JSON.parse(result.stdout));
    expect(report.since).toBeUndefined();
    expect(report.invalidLines).toBe(0);
    expect(report.summaries).toEqual([{ identity: "work", provider: "anthropic", requests: 2, failed: 1 }]);
    expect(report.snapshots).toEqual([{ identity: "work", providers: { anthropic: { lastStatus: OK_STATUS } } }]);
  });

  it("narrows to an identity and a provider", async () => {
    writeLog([recordAgo(HOUR_MS), recordAgo(HOUR_MS, { provider: "z" }), recordAgo(HOUR_MS, { identity: "personal" })]);

    const result = UsageJsonSchema.parse(JSON.parse((await cli(["usage", "--identity", "work", "--provider", "z", "--json"])).stdout));

    expect(result.summaries).toEqual([{ identity: "work", provider: "z", requests: 1, failed: 0 }]);
  });

  it("limits the period with --since, reporting its start", async () => {
    writeLog([recordAgo(STALE_MS, { requestId: "old" }), recordAgo(HOUR_MS, { requestId: "recent" })]);

    const result = UsageJsonSchema.parse(JSON.parse((await cli(["usage", "--since", `${String(SINCE_HOURS)}h`, "--json"])).stdout));

    expect(result.summaries).toEqual([{ identity: "work", provider: "anthropic", requests: 1, failed: 0 }]);
    expect(Date.parse(result.since ?? "")).toBeGreaterThanOrEqual(startedAt - SINCE_WINDOW_MS);
    expect(Date.parse(result.since ?? "")).toBeLessThanOrEqual(Date.now() - SINCE_WINDOW_MS);
  });

  it("rejects a --since that is not a duration as a usage error", async () => {
    const result = await cli(["usage", "--since", "soon"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("soon");
  });

  it("shows the latest quota from the snapshot under the identity's totals", async () => {
    writeLog([recordAgo(HOUR_MS)]);
    writeSnapshot(snapshotWithQuota("work"));

    const result = await cli(["usage"]);

    expect(result.stdout).toContain("5h 25% used");
    expect(result.stdout).toContain("status allowed");
  });

  it("shows how much of the extra-usage allowance an account with no plan windows has used, and when it resets", async () => {
    const resetsAt = new Date(FIVE_HOUR_RESET_SECONDS * MS_PER_SECOND).toISOString();
    writeLog([recordAgo(HOUR_MS)]);
    writeSnapshot(snapshotWithQuota("work", { status: "allowed", representativeClaim: "overage", overageStatus: "allowed", overageUtilization: 0.42, overageResetsAt: resetsAt }));

    const result = await cli(["usage"]);

    expect(result.stdout).toContain(`extra usage 42% used, resets ${resetsAt} (allowed)`);
  });

  it("shows the spend in money against the cap, and that a response was served on extra usage", async () => {
    writeLog([recordAgo(HOUR_MS)]);
    writeSnapshot(snapshotWithQuota("work", { status: "allowed", overageStatus: "allowed", overageUtilization: 0.4245, overageInUse: true, extraUsageSpend: { usedMinor: 84_900, limitMinor: 200_000, currency: "USD" } }));

    const result = await cli(["usage"]);

    expect(result.stdout).toContain("extra usage spend US$849.00 of US$2,000.00");
    expect(result.stdout).toContain("served on extra usage");
  });

  it("shows a five-hour window in grace and a fallback on offer", async () => {
    writeLog([recordAgo(HOUR_MS)]);
    writeSnapshot(snapshotWithQuota("work", { status: "allowed_warning", fiveHour: { utilization: 0.99, status: "allowed_warning", graceUtilization: 0.34 }, fallbackAvailable: true }));

    const result = await cli(["usage"]);

    expect(result.stdout).toContain("5h 99% used, in grace, 34% of the allowance used (allowed_warning)");
    expect(result.stdout).toContain("fallback available");
  });

  it("says why extra usage is unavailable when the upstream named a reason", async () => {
    writeLog([recordAgo(HOUR_MS)]);
    writeSnapshot(snapshotWithQuota("work", { status: "rejected", overageStatus: "rejected", overageDisabledReason: "out_of_credits" }));

    const result = await cli(["usage"]);

    expect(result.stdout).toContain("extra usage rejected");
    expect(result.stdout).toContain("extra usage disabled: out_of_credits");
  });

  it("shows a provider's pulled quota: each window's length, use, counts and reset, with where and when it was observed", async () => {
    const at = new Date(startedAt).toISOString();
    const resetsAt = new Date(startedAt + HOUR_MS).toISOString();
    writeLog([recordAgo(HOUR_MS, { provider: "z" })]);
    writeSnapshot({
      schemaVersion: USAGE_SCHEMA_VERSION,
      identity: "work",
      updatedAt: at,
      providers: {
        z: {
          lastRequestAt: at,
          lastStatus: OK_STATUS,
          quota: {
            observedAt: at,
            source: "z.ai",
            level: "max",
            windows: [
              { measures: "tokens", periodMs: FIVE_HOURS * HOUR_MS, utilization: 0.13, resetsAt },
              { measures: "tool-calls", periodMs: THIRTY_DAYS * HOURS_PER_DAY * HOUR_MS, utilization: 0.01, limit: 4000, used: 61, resetsAt },
              { measures: "tokens", period: "unit 9 x 2", utilization: 0.5 },
            ],
          },
        },
      },
    });

    const result = await cli(["usage"]);

    expect(result.stdout).toContain(`quota via z.ai (max), observed ${at}: tokens 5h 13% used, resets ${resetsAt}`);
    expect(result.stdout).toContain(`tool-calls 30d 1% used, 61 of 4000, resets ${resetsAt}`);
    expect(result.stdout).toContain("tokens unit 9 x 2 50% used");
  });

  it("still shows a snapshot's quota for a provider with no request in the period", async () => {
    writeLog([recordAgo(STALE_MS)]);
    writeSnapshot(snapshotWithQuota("work"));

    const result = await cli(["usage", "--since", "1h"]);

    expect(result.stdout).toContain("work / anthropic: no requests in this period");
    expect(result.stdout).toContain("5h 25% used");
  });

  it("says nothing was recorded rather than printing an empty report", async () => {
    const result = await cli(["usage"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no usage recorded");
  });

  it("warns about log lines it could not read instead of reading them as no usage", async () => {
    writeLog([recordAgo(HOUR_MS)], "{corrupt line}\n");

    const text = await cli(["usage"]);
    const json = UsageJsonSchema.parse(JSON.parse((await cli(["usage", "--json"])).stdout));

    expect(text.stdout).toContain("warning: 1 log line(s) could not be read as usage records and were skipped");
    expect(json.invalidLines).toBe(1);
  });

  it("fails for an --identity that does not exist, whatever the log holds", async () => {
    writeLog([recordAgo(HOUR_MS, { identity: "ghost" })]);

    const result = await cli(["usage", "--identity", "ghost"]);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('No identity named "ghost"');
    expect(result.stdout).toBe("");
    expect(() => collectUsageReport(realFarmFs, paths, { identity: "ghost" })).toThrow(IdentityNotFoundError);
  });
});

describe("agent-shim account show", () => {
  beforeEach(() => {
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
  });

  it("shows an identity's plan and tier from its stored login as text", async () => {
    writeProfile("work", {
      emailAddress: "me@example.com",
      organizationName: "Example Org",
      organizationType: "claude_team",
      billingType: "stripe_subscription",
      seatTier: "team_standard",
      organizationRateLimitTier: "default_claude_max_5x",
      userRateLimitTier: "default_claude_max_20x",
      hasExtraUsageEnabled: false,
    });

    const result = await cli(["account", "show", "work"]);

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "Identity: work",
      "Account: me@example.com (Example Org, claude_team)",
      "Plan: billing stripe_subscription, seat tier team_standard",
      "Rate-limit tier: organisation default_claude_max_5x, user default_claude_max_20x",
      "Extra usage: disabled",
      "Usage: nothing recorded yet",
      "",
    ]);
  });

  it("says when an identity has no stored login profile", async () => {
    const result = await cli(["account", "show", "personal"]);

    expect(result.stdout).toContain("Identity: personal");
    expect(result.stdout).toContain("Account: (no stored login profile");
  });

  it("includes the latest recorded quota", async () => {
    writeSnapshot(snapshotWithQuota("work"));

    const result = await cli(["account", "show", "work"]);

    expect(result.stdout).toContain("Usage via anthropic: last request");
    expect(result.stdout).toContain("5h 25% used");
  });

  it("prints one identity as an object and every identity as an array with --json", async () => {
    writeProfile("work", { emailAddress: "me@example.com", billingType: "stripe_subscription", seatTier: "team_standard" });
    writeSnapshot(snapshotWithQuota("work"));

    const one = AccountJsonSchema.parse(JSON.parse((await cli(["account", "show", "work", "--json"])).stdout));
    const all = z.array(AccountJsonSchema).parse(JSON.parse((await cli(["account", "show", "--json"])).stdout));

    expect(one).toEqual({ identity: "work", account: { emailAddress: "me@example.com", billingType: "stripe_subscription", seatTier: "team_standard" }, usage: { identity: "work" } });
    expect(all.map((view) => view.identity)).toEqual(["personal", "work"]);
    expect(all.find((view) => view.identity === "personal")).toEqual({ identity: "personal" });
  });

  it("separates the blocks of several identities with a blank line", async () => {
    const result = await cli(["account", "show"]);

    expect(result.stdout.split("\n")).toContain("Identity: personal");
    expect(result.stdout).toMatch(/Usage: nothing recorded yet\n\nIdentity: work/);
  });

  it("reports an unreadable stored login instead of reading it as no account", async () => {
    fs.writeFileSync(claudeJsonPath(paths.identitiesDir, "work"), "{broken");

    const result = await cli(["account", "show", "work"]);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("fails for an unknown identity", async () => {
    const result = await cli(["account", "show", "ghost"]);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('No identity named "ghost"');
    expect(() => collectAccounts(realFarmFs, paths, "ghost")).toThrow(IdentityNotFoundError);
  });

  it("says there are no identities when none exist", async () => {
    fs.rmSync(paths.identitiesDir, { recursive: true, force: true });

    const result = await cli(["account", "show"]);

    expect(result.stdout).toBe("no identities\n");
  });
});
