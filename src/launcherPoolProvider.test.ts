import { describe, expect, it } from "vitest";

import type { Pool } from "./config/schema";
import { prepareLaunch, type FarmRuntime, type LaunchDecision } from "./launcher";
import { collectPoolPick } from "./poolPickReport";
import { memberProviderResolver } from "./launcher/memberProvider";
import type { ProviderOf } from "./usage/poolPick";
import {
  FAKE_HOME, FAKE_NOW_MS, createFakeFarmFs, discovered, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, reportedRow, runAndCaptureExit, spawnedEnv,
} from "./test-helpers";

const HOUR_MS = 3_600_000;
const SIX_DAYS_MS = 518_400_000;
const TWO_DAYS_MS = 172_800_000;
const U10 = 0.1;
const U20 = 0.2;
const FULL = 1;
const MAX_20X = "default_claude_max_20x";

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();
const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;
const providerFile = (name: string): string => `${FAKE_HOME}/.agent-shim/providers/${name}.json`;
const identityFile = (name: string): string => `${paths.identitiesDir}/${name}/identity.json`;

const PROVIDER = { displayName: "Example", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "example-token" }] } };

interface Week {
  readonly utilization: number;
  readonly resetsInMs: number;
  readonly status?: string;
}

const SPENT: Week = { utilization: FULL, resetsInMs: TWO_DAYS_MS, status: "rejected" };
const OPEN: Week = { utilization: U20, resetsInMs: SIX_DAYS_MS };

const sliceOf = (week: Week): Record<string, unknown> => ({
  lastRequestAt: iso(-HOUR_MS),
  lastStatus: 200,
  rateLimit: { observedAt: iso(-HOUR_MS), headers: {}, unified: { sevenDay: { utilization: week.utilization, resetsAt: iso(week.resetsInMs), ...(week.status === undefined ? {} : { status: week.status }) } } },
});

/** An identity's snapshot: its Claude account's week and the weeks of the providers it has used. */
function snapshotOf(identity: string, anthropic: Week, providers: Readonly<Record<string, Week>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    identity,
    updatedAt: iso(-HOUR_MS),
    account: { organizationRateLimitTier: MAX_20X },
    providers: { anthropic: sliceOf(anthropic), ...Object.fromEntries(Object.entries(providers).map(([name, week]) => [name, sliceOf(week)])) },
  });
}

const POOLS: Readonly<Record<string, Pool>> = { main: { identities: ["work", "personal"] } };

/** Both members have spent their Claude week; provider `p` is open for both. */
const CLAUDE_SPENT = { [snapshotPath("work")]: snapshotOf("work", SPENT, { p: OPEN }), [snapshotPath("personal")]: snapshotOf("personal", SPENT, { p: OPEN }) };

interface LaunchOptions {
  readonly seed?: Readonly<Record<string, string>>;
  readonly argv?: readonly string[];
  readonly pools?: Readonly<Record<string, Pool>>;
  readonly files?: Readonly<Record<string, unknown>>;
  readonly farmFs?: ReturnType<typeof createFakeFarmFs>;
  readonly farm?: (base: FarmRuntime) => FarmRuntime;
}

function launch(options: LaunchOptions = {}) {
  const farmFs = options.farmFs ?? createFakeFarmFs(options.seed ?? CLAUDE_SPENT);
  const log = fakeLog();
  const spawn = fakeSpawn();
  const base = fakeFarm(farmFs);
  const code = runAndCaptureExit({
    paths,
    fs: fakeFs({ [providerFile("p")]: PROVIDER, ...options.files }),
    spawn,
    proc: fakeProc({}, options.argv ?? ["@pool:main", "--provider", "p", "--print"]),
    log,
    resolveClaudeBinary: () => discovered,
    credentials: fakeCredentials(),
    farm: options.farm === undefined ? base : options.farm(base),
    frontdoor: fakeFrontDoorPort(),
    pools: options.pools ?? POOLS,
  });
  return { log, code, spawn, farmFs };
}

function decisionOf(options: LaunchOptions = {}): LaunchDecision {
  const farmFs = options.farmFs ?? createFakeFarmFs(options.seed ?? CLAUDE_SPENT);
  return prepareLaunch({
    paths,
    fs: fakeFs({ [providerFile("p")]: PROVIDER, ...options.files }),
    proc: fakeProc({}, options.argv ?? ["@pool:main", "--provider", "p", "--print"]),
    log: fakeLog(),
    resolveClaudeBinary: () => discovered,
    credentials: fakeCredentials(),
    farm: fakeFarm(farmFs),
    frontdoor: fakeFrontDoorPort(),
    pools: options.pools ?? POOLS,
  }).decision;
}

describe("a pool launch that resolves a provider", () => {
  it("launches as a member of a pool whose every Claude week is spent, when the provider's windows are open", () => {
    const { code, spawn, log } = launch();
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toMatch(/identities\/(work|personal)$/);
    expect(log.errors).toEqual([]);
  });

  it("is refused as before when it resolves no provider", () => {
    const { code, spawn, log } = launch({ argv: ["@pool:main", "--print"] });
    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain('every member of pool "main" is refused right now');
  });

  it("is refused as before when --no-provider opts out of the provider an identity declares", () => {
    const files = { [identityFile("work")]: { name: "work", allowAmbientCredential: false, provider: "p" }, [identityFile("personal")]: { name: "personal", allowAmbientCredential: false, provider: "p" } };
    expect(launch({ files, argv: ["@pool:main", "--print"] }).code).toBe(0);
    const optedOut = launch({ files, argv: ["@pool:main", "--no-provider", "--print"] });
    expect(optedOut.code).toBe(1);
    expect(optedOut.log.errors[0]).toContain('every member of pool "main" is refused right now');
  });

  it("refuses a member whose provider's own week is spent and launches as the one that has room", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", OPEN, { p: SPENT }), [snapshotPath("personal")]: snapshotOf("personal", SPENT, { p: OPEN }) };
    const { code, spawn } = launch({ seed });
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
  });

  it("is refused when every member is refused on the provider's own slice, naming when the earliest returns", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", OPEN, { p: SPENT }), [snapshotPath("personal")]: snapshotOf("personal", OPEN, { p: SPENT }) };
    const { code, log } = launch({ seed });
    expect(code).toBe(1);
    expect(log.errors[0]).toContain('every member of pool "main" is refused right now');
  });

  it("launches as a member with no reading for the provider, ranked unknown rather than refused on its Claude windows", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", SPENT), [snapshotPath("personal")]: snapshotOf("personal", SPENT) };
    const { code } = launch({ seed });
    expect(code).toBe(0);
  });

  it("names the provider the ranking read on the decision and in the pool row", () => {
    const decision = decisionOf();
    expect(decision.pool?.provider).toBe("p");
    expect(decision.provider).toBe("p");
    const { log } = launch({ argv: ["@pool:main", "--provider", "p", "--explain", "--print"] });
    const pool = reportedRow(log, "pool");
    expect(pool?.detail).toContain("ranked on provider p");
    expect(pool?.notes?.filter((line) => /^\d+\. /.test(line)).every((line) => line.includes("on provider p"))).toBe(true);
  });

  it("names no provider on the decision of a pool launch that spends the Claude account", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", OPEN), [snapshotPath("personal")]: snapshotOf("personal", SPENT) };
    expect(decisionOf({ seed, argv: ["@pool:main", "--print"] }).pool).not.toHaveProperty("provider");
  });

  it("ranks the pool on the provider a cascade layer pins when no flag names one", () => {
    const { code } = launch({ argv: ["@pool:main", "--print"], farm: (base) => ({ ...base, loadCascade: () => ({ home: FAKE_HOME, loadProfile: () => undefined, levels: [], cliOverride: { launch: { provider: "p" } } }) }) });
    expect(code).toBe(0);
  });

  it("assesses each member against the provider its own identity declares, with no flag", () => {
    // `work` declares provider p, so its spent Claude week does not count; `personal` declares none, so its does.
    const files = { [identityFile("work")]: { name: "work", allowAmbientCredential: false, provider: "p" } };
    const mixed = { [snapshotPath("work")]: snapshotOf("work", SPENT, { p: OPEN }), [snapshotPath("personal")]: snapshotOf("personal", SPENT, { p: OPEN }) };
    const { code, spawn } = launch({ files, seed: mixed, argv: ["@pool:main", "--print"] });
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
  });

  it("launches as the first listed member that is not refused on the provider's slice when the pool prefers listed order", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", OPEN, { p: SPENT }), [snapshotPath("personal")]: snapshotOf("personal", SPENT, { p: { utilization: U10, resetsInMs: SIX_DAYS_MS } }) };
    const { code, spawn } = launch({ seed, pools: { main: { identities: ["work", "personal"], preference: "listed" } } });
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
  });

  it("keeps the member the directory last ran as while its prompt cache is warm", () => {
    const seed = { [snapshotPath("work")]: snapshotOf("work", SPENT, { p: { utilization: U10, resetsInMs: HOUR_MS } }), [snapshotPath("personal")]: snapshotOf("personal", SPENT, { p: OPEN }) };
    const farmFs = createFakeFarmFs(seed);
    expect(spawnedEnv(launch({ farmFs }).spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    farmFs.writeFileUtf8(snapshotPath("work"), snapshotOf("work", SPENT, { p: OPEN }));
    farmFs.writeFileUtf8(snapshotPath("personal"), snapshotOf("personal", SPENT, { p: { utilization: U10, resetsInMs: HOUR_MS } }));
    expect(spawnedEnv(launch({ farmFs }).spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
  });
});

describe("pool pick for a provider", () => {
  function pick(providerOf?: ProviderOf) {
    return collectPoolPick({ paths, fs: fakeFs({}), usageFs: createFakeFarmFs(CLAUDE_SPENT), poolName: "main", pools: POOLS, directory: `${FAKE_HOME}/work`, nowMs: FAKE_NOW_MS, ...(providerOf === undefined ? {} : { providerOf }) });
  }

  it("reports a pick and each candidate's provider when the ranking is for one with open windows", () => {
    const report = pick(() => "p");
    expect(report.pick).toBeDefined();
    expect(report.candidates.map((candidate) => [candidate.class, candidate.provider])).toEqual([["scored", "p"], ["scored", "p"]]);
  });

  it("reports every member refused and no provider when the ranking is for the Claude account", () => {
    const report = pick();
    expect(report.pick).toBeUndefined();
    expect(report.candidates.map((candidate) => candidate.class)).toEqual(["ineligible", "ineligible"]);
    expect(report.candidates.every((candidate) => candidate.provider === undefined)).toBe(true);
  });

  it("ranks on the provider the launch flag names through the resolver the CLI builds", () => {
    const providerOf = memberProviderResolver({ paths, fs: fakeFs({ [providerFile("p")]: PROVIDER }), env: {}, cliProvider: "p", loadCascade: () => ({ home: FAKE_HOME, loadProfile: () => undefined, levels: [] }) });
    expect(pick(providerOf).pick).toBeDefined();
  });
});
