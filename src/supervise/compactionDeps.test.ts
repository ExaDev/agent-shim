import { describe, expect, it } from "vitest";

import { createFakeFarmFs, FAKE_NOW_MS, paths } from "../test-helpers";
import { USAGE_SCHEMA_VERSION } from "../usage/schema";
import { createCompactionDeps, type CompactionWiring } from "./compactionDeps";
import { readSessionState, registerSupervised, superviseDirOf, writeSessionState, type SupervisedSession } from "./registry";

const POOL = "subs";
const PID = 4000;
const OTHER_PID = 4100;
const DEAD_PID = 4999;
const HOUR_MS = 3_600_000;
const BIG = 300_000;
const SMALL = 100_000;
const HIGH_UTILISATION = 0.9;
const AT_UTILISATION = 85;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

function snapshotOf(identity: string, utilization: number): string {
  const seen = iso(-HOUR_MS);
  return JSON.stringify({
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: seen,
    providers: { anthropic: { lastRequestAt: seen, lastStatus: 200, rateLimit: { observedAt: seen, headers: {}, unified: { fiveHour: { utilization, resetsAt: iso(HOUR_MS) } } } } },
  });
}

function session(sessionId: string, identity: string, overrides: Readonly<Partial<SupervisedSession>> = {}): SupervisedSession {
  return { pid: PID, sessionId, pool: POOL, identity, cwd: "/repo", since: iso(-HOUR_MS), ...overrides };
}

function setup(running: readonly number[] = [PID, OTHER_PID]) {
  const fs = createFakeFarmFs({ [`${paths.usageSnapshotsDir}/work.json`]: snapshotOf("work", HIGH_UTILISATION), [`${paths.usageSnapshotsDir}/spare.json`]: snapshotOf("spare", HIGH_UTILISATION) });
  const wiring: CompactionWiring = {
    paths,
    fs,
    pool: POOL,
    policy: { compactAtUtilisation: AT_UTILISATION },
    pid: PID,
    now: () => FAKE_NOW_MS,
    isRunning: (pid) => running.includes(pid),
    sleep: () => undefined,
    compact: () => {
      throw new Error("the decision and the slot never compact");
    },
  };
  return { fs, deps: createCompactionDeps(wiring) };
}

const idleWith = (contextTokens: number) => ({ mark: "idle" as const, contextTokens, at: iso(0) });

describe("the compaction decision over the shared registry", () => {
  it("lets the largest idle session on an identity go, and the others wait", () => {
    const { fs, deps } = setup();
    for (const [id, tokens] of [["big", BIG], ["small", SMALL]] as const) {
      registerSupervised(fs, paths, session(id, "work"));
      writeSessionState(fs, paths, POOL, id, idleWith(tokens));
    }
    expect(deps.shouldCompact("work", "big")).toMatchObject({ compact: true, contextTokens: BIG });
    expect(deps.shouldCompact("work", "small")).toEqual({ compact: false, reason: "a larger session on this member compacts first" });
  });

  it("counts only the sessions on the identity, and ignores one whose launcher has gone", () => {
    const { fs, deps } = setup();
    registerSupervised(fs, paths, session("mine", "work"));
    writeSessionState(fs, paths, POOL, "mine", idleWith(SMALL));
    registerSupervised(fs, paths, session("elsewhere", "spare", { pid: OTHER_PID }));
    writeSessionState(fs, paths, POOL, "elsewhere", idleWith(BIG));
    registerSupervised(fs, paths, session("gone", "work", { pid: DEAD_PID }));
    writeSessionState(fs, paths, POOL, "gone", idleWith(BIG));
    expect(deps.shouldCompact("work", "mine")).toMatchObject({ compact: true, contextTokens: SMALL });
  });

  it("does not compact a session whose hooks have recorded nothing yet", () => {
    const { fs, deps } = setup();
    registerSupervised(fs, paths, session("fresh", "work"));
    expect(deps.shouldCompact("work", "fresh").compact).toBe(false);
  });
});

describe("the compaction slot", () => {
  it("is held by one session at a time per identity, and free again once released", () => {
    const { deps } = setup();
    const slot = deps.acquire("work");
    expect(slot).toBeDefined();
    expect(deps.acquire("work")).toBeUndefined();
    expect(deps.acquire("spare")).toBeDefined();
    slot?.release();
    expect(deps.acquire("work")).toBeDefined();
  });

  it("is not blocked by a holder whose launcher has gone: the stale slot is cleared, and the next try takes it", () => {
    const { fs, deps } = setup();
    fs.mkdirp(superviseDirOf(paths, POOL));
    fs.writeFileUtf8(`${superviseDirOf(paths, POOL)}/.compact-work.lock`, `${JSON.stringify({ identity: "compact-work", pid: DEAD_PID, token: "old", acquiredAtMs: FAKE_NOW_MS })}\n`);
    expect(deps.acquire("work")).toBeUndefined();
    expect(deps.acquire("work")).toBeDefined();
  });
});

describe("marking a session compacted", () => {
  it("sets the flag the decision reads, keeping the turn mark and context size, and clears it", () => {
    const { fs, deps } = setup();
    registerSupervised(fs, paths, session("s", "work"));
    writeSessionState(fs, paths, POOL, "s", idleWith(BIG));
    deps.markCompacted("s", true);
    expect(readSessionState(fs, paths, POOL, "s")).toEqual({ mark: "idle", contextTokens: BIG, compacted: true, at: iso(0) });
    expect(deps.shouldCompact("work", "s").compact).toBe(false);
    deps.markCompacted("s", false);
    expect(readSessionState(fs, paths, POOL, "s")).toEqual({ mark: "idle", contextTokens: BIG, at: iso(0) });
    expect(deps.shouldCompact("work", "s").compact).toBe(true);
  });

  it("records a session no hook has marked yet as idle", () => {
    const { fs, deps } = setup();
    deps.markCompacted("s", true);
    expect(readSessionState(fs, paths, POOL, "s")).toEqual({ mark: "idle", compacted: true, at: iso(0) });
  });
});
