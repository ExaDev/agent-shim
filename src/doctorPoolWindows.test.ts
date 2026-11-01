import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";
import { USAGE_SCHEMA_VERSION, type UnifiedRateLimit, type UsageSnapshot } from "./usage/schema";

const SEEN = "2026-10-02T12:00:00.000Z";
const RESETS = "2026-10-08T12:00:00.000Z";
const LOW = 0.2;

/** A snapshot whose Anthropic state reports exactly the windows in `unified`. */
function snapshotOf(name: string, unified: Readonly<UnifiedRateLimit>): UsageSnapshot {
  return { schemaVersion: USAGE_SCHEMA_VERSION, identity: name, updatedAt: SEEN, providers: { anthropic: { lastRequestAt: SEEN, lastStatus: 200, rateLimit: { observedAt: SEEN, headers: {}, unified } } } };
}

const BOTH: UnifiedRateLimit = { fiveHour: { utilization: LOW, resetsAt: RESETS }, sevenDay: { utilization: LOW, resetsAt: RESETS } };
const SEVEN_DAY_ONLY: UnifiedRateLimit = { sevenDay: { utilization: LOW, resetsAt: RESETS } };
const EXTRA_USAGE_ONLY: UnifiedRateLimit = { overageStatus: "allowed", overageUtilization: LOW, overageResetsAt: RESETS };

const fiveHourCondition = { kind: "compare", op: "gte", left: { kind: "reference", key: "quota.fiveHour.remaining" }, right: { kind: "numberLiteral", value: LOW } };
const burnCondition = { kind: "compare", op: "lt", left: { kind: "reference", key: "quota.burnPerHour" }, right: { kind: "numberLiteral", value: LOW } };

/** A doctor run over the identities `work` and `home`, whose snapshots are `snapshots`, with `config` as the global config. */
function run(config: unknown, snapshots: Readonly<Record<string, UnifiedRateLimit>> | undefined) {
  return runDoctor(
    baseParams({
      identities: [identity("work"), identity("home")],
      globalConfig: { path: "/agent-shim/config.json", raw: JSON.stringify(config) },
      ...(snapshots === undefined ? {} : { usageSnapshots: Object.fromEntries(Object.entries(snapshots).map(([name, unified]) => [name, snapshotOf(name, unified)])) }),
    }),
  );
}

const warnings = (report: ReturnType<typeof runDoctor>, section: string) => findingsFor(report, section).filter((finding) => finding.severity === "warn");

describe("runDoctor: a pool reading a window a member does not receive", () => {
  it("warns when a member condition reads the five-hour window of a member that reports none, naming the window and not the account", () => {
    const report = run({ pools: { subs: { identities: [{ identity: "work", when: fiveHourCondition }, "home"] } } }, { work: SEVEN_DAY_ONLY, home: BOTH });
    const found = warnings(report, "pool");
    expect(found).toHaveLength(1);
    expect(found[0]?.subject).toBe("subs");
    expect(found[0]?.message).toContain('Pool "subs" guards work with a condition that reads quota.fiveHour');
    expect(found[0]?.message).toContain("work reports no five-hour window");
    expect(found[0]?.message).toContain("undecided");
    expect(report.ok).toBe(true);
  });

  it("counts the five-hour pace as a read of the five-hour window", () => {
    const report = run({ pools: { subs: { identities: [{ identity: "work", when: burnCondition }] } } }, { work: SEVEN_DAY_ONLY });
    expect(warnings(report, "pool")[0]?.message).toContain("reads quota.burnPerHour");
  });

  it("checks every member of a nested pool that a guarded pool entry stands for", () => {
    const report = run({ pools: { outer: { identities: [{ identity: "pool:inner", when: fiveHourCondition }] }, inner: { identities: ["work", "home"] } } }, { work: BOTH, home: SEVEN_DAY_ONLY });
    expect(warnings(report, "pool").map((finding) => finding.message)).toEqual([expect.stringContaining("home reports no five-hour window")]);
  });

  it("warns when a pool compacts before the limit and a member reports no plan window for the trigger to measure", () => {
    const report = run({ pools: { subs: { identities: ["work", "home"], resumeOnLimit: true, compactBeforeLimit: true } } }, { work: EXTRA_USAGE_ONLY, home: SEVEN_DAY_ONLY });
    const found = warnings(report, "pool");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('Pool "subs" compacts before the limit, but work reports no five-hour or seven-day window');
  });

  it("does not warn for a member with no snapshot, whose windows are unknown, nor when the doctor was given no snapshots", () => {
    const config = { pools: { subs: { identities: [{ identity: "work", when: fiveHourCondition }], resumeOnLimit: true, compactBeforeLimit: true } } };
    expect(warnings(run(config, { home: SEVEN_DAY_ONLY }), "pool")).toEqual([]);
    expect(warnings(run(config, undefined), "pool")).toEqual([]);
  });

  it("does not warn when every member receives what the pool reads", () => {
    const report = run({ pools: { subs: { identities: [{ identity: "work", when: fiveHourCondition }, "home"], resumeOnLimit: true, compactBeforeLimit: true } } }, { work: BOTH, home: SEVEN_DAY_ONLY });
    expect(warnings(report, "pool")).toEqual([]);
  });
});

describe("runDoctor: a job timed against a window its identity does not receive", () => {
  const job = (target: unknown, beforeReset: string) => ({ target, trigger: { beforeReset, lead: "20m" }, prompt: "continue the plan", cwd: "/work/app", timeout: "20m" });

  it("warns for an identity job, and for each pool member a pool job could run as", () => {
    const report = run({ pools: { subs: { identities: ["work", "home"] } }, jobs: { burn: job({ identity: "work" }, "fiveHour"), spend: job({ pool: "subs" }, "fiveHour") } }, { work: SEVEN_DAY_ONLY, home: BOTH });
    const found = warnings(report, "global-config");
    expect(found.map((finding) => finding.subject)).toEqual(["burn", "spend"]);
    expect(found[0]?.message).toContain('Job "burn" runs before the five-hour window resets, but work reports no five-hour window');
  });

  it("does not warn for a window the identity receives", () => {
    const report = run({ jobs: { digest: job({ identity: "work" }, "sevenDay") } }, { work: SEVEN_DAY_ONLY });
    expect(warnings(report, "global-config")).toEqual([]);
  });
});
