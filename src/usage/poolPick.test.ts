import { describe, expect, it } from "vitest";

import type { Pool } from "../config/schema";
import { FAKE_NOW_MS, createFakeFarmFs, paths } from "../test-helpers";
import { loadPoolMembers, PoolGraphError, rankPoolGraph, readStickyPick, recordStickyPick } from "./poolPick";
import { PROMPT_CACHE_TTL_MS } from "./pick";
import { USAGE_RETENTION_MS } from "./store";

const HOUR_MS = 3_600_000;
const SIX_HOURS_MS = 21_600_000;
const MINUTE_MS = 60_000;
const DIRECTORY = "/home/testuser/work";
const OTHER_DIRECTORY = "/home/testuser/other";

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

function recordLine(identity: string, offsetMs: number, provider = "anthropic"): string {
  return `${JSON.stringify({ schemaVersion: 1, at: iso(offsetMs), identity, provider, route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
}

describe("loadPoolMembers", () => {
  it("carries a member with a corrupt snapshot as unreadable instead of failing the pick", () => {
    const fs = createFakeFarmFs({ [`${paths.usageSnapshotsDir}/work.json`]: "{ not json" });
    const [member] = loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS);
    expect(member?.readError).toContain("not valid JSON");
  });

  it("reads only the member's own anthropic records from inside the current five-hour window", () => {
    const day = iso(0).slice(0, "YYYY-MM-DD".length);
    const log = [
      recordLine("work", -MINUTE_MS),
      recordLine("work", -SIX_HOURS_MS),
      recordLine("work", -MINUTE_MS, "z"),
      recordLine("personal", -MINUTE_MS),
    ].join("");
    const fs = createFakeFarmFs({ [`${paths.usageLogDir}/${day}.1.jsonl`]: log });
    const [member] = loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS);
    expect(member?.records.map((record) => record.at)).toEqual([iso(-MINUTE_MS)]);
  });

  it("has no snapshot or account for an identity that was never recorded", () => {
    const [member] = loadPoolMembers(createFakeFarmFs({}), paths, ["work"], FAKE_NOW_MS);
    expect(member).toEqual({ identity: "work", records: [] });
  });
});

describe("last-pick record", () => {
  it("round-trips a pick per directory", () => {
    const fs = createFakeFarmFs({});
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    recordStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY, "personal", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY)).toEqual({ sticky: { identity: "work", at: iso(0) } });
    expect(readStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY).sticky?.identity).toBe("personal");
    expect(readStickyPick(fs, paths.usagePicksFile, "/nowhere")).toEqual({});
  });

  it("drops entries older than the usage log's retention when it writes", () => {
    const fs = createFakeFarmFs({});
    recordStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY, "personal", FAKE_NOW_MS - USAGE_RETENTION_MS - HOUR_MS);
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY)).toEqual({});
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).sticky?.identity).toBe("work");
  });

  it("reports an unreadable file and treats it as empty, rather than blocking a launch", () => {
    const fs = createFakeFarmFs({ [paths.usagePicksFile]: "{ not json" });
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).problem).toContain("not valid JSON");
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).sticky?.identity).toBe("work");
  });
});

describe("rankPoolGraph", () => {
  const SIX_DAYS_MS = 518_400_000;
  const THREE_HOURS_MS = 10_800_000;
  const MAX_20X = "default_claude_max_20x";
  const U10 = 0.1;
  const U60 = 0.6;
  const FULL = 1;

  const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;

  function snapshotOf(identity: string, window: { readonly utilization: number; readonly resetsInMs: number; readonly status?: string }): string {
    const seen = iso(-HOUR_MS);
    return JSON.stringify({
      schemaVersion: 1,
      identity,
      updatedAt: seen,
      account: { organizationRateLimitTier: MAX_20X },
      providers: {
        anthropic: {
          lastRequestAt: seen,
          lastStatus: 200,
          rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: window.utilization, resetsAt: iso(window.resetsInMs), ...(window.status === undefined ? {} : { status: window.status }) } } },
        },
      },
    });
  }

  /** Ranks `pools`' entry `poolName` over the given snapshots, with every identity present on disk. */
  function graph(pools: Readonly<Record<string, Pool>>, poolName: string, snapshots: Readonly<Record<string, { utilization: number; resetsInMs: number; status?: string }>>, extra: Readonly<{ sticky?: { identity: string; atMs: number } }> = {}) {
    return rankPoolGraph({
      fs: createFakeFarmFs(Object.fromEntries(Object.entries(snapshots).map(([identity, window]) => [snapshotPath(identity), snapshotOf(identity, window)]))),
      paths,
      pools,
      poolName,
      nowMs: FAKE_NOW_MS,
      resuming: false,
      identityExists: () => true,
      ...(extra.sticky === undefined ? {} : { sticky: { identity: extra.sticky.identity, at: iso(extra.sticky.atMs) } }),
    });
  }

  it("falls back to a nested pool's pick, ranked with its own preference, when a listed pool's first member is refused", () => {
    const pools: Record<string, Pool> = {
      outer: { identities: ["client", "pool:fleet"], preference: "listed" },
      fleet: { identities: ["a", "b"] },
    };
    const { ranking } = graph(pools, "outer", { client: { utilization: FULL, resetsInMs: THREE_HOURS_MS, status: "rejected" }, a: { utilization: U60, resetsInMs: HOUR_MS }, b: { utilization: U10, resetsInMs: SIX_DAYS_MS } });
    expect(ranking.pick).toMatchObject({ identity: "a" });
    expect(ranking.candidates.map((candidate) => candidate.identity)).toEqual(["client", "a"]);
    expect(ranking.pick?.reasons[0]).toBe('picked by pool "fleet"');
    expect(ranking.pick?.reasons.join(" ").split("7d 60% used, resets in 1h")).toHaveLength(2);
  });

  it("guards a nested subtree with its entry's when: a condition that does not hold makes the entry ineligible by policy", () => {
    // The fleet's pick would be eligible; the entry's own policy (seven-day utilisation below half) does not hold, so the whole subtree is skipped and the outer pool falls to its other member.
    const pools: Record<string, Pool> = {
      outer: { identities: [{ identity: "pool:fleet", when: { kind: "compare", op: "lt", left: { kind: "reference", key: "quota.sevenDay.utilization" }, right: { kind: "numberLiteral", value: 0.5 } } }, "far"] },
      fleet: { identities: ["soon"] },
    };
    const { ranking } = graph(pools, "outer", { soon: { utilization: 0.9, resetsInMs: HOUR_MS }, far: { utilization: 0.6, resetsInMs: SIX_DAYS_MS } });
    expect(ranking.pick?.identity).toBe("far");
    const guarded = ranking.candidates.find((candidate) => candidate.identity === "soon");
    expect(guarded).toMatchObject({ class: "ineligible" });
    expect(guarded?.reasons[0]).toContain("skipped by policy");
  });

  it("makes an entry whose nested pool is entirely refused ineligible, propagating that pool's earliest return", () => {
    const pools: Record<string, Pool> = { outer: { identities: ["pool:fleet"] }, fleet: { identities: ["a", "b"] } };
    const { ranking } = graph(pools, "outer", { a: { utilization: FULL, resetsInMs: THREE_HOURS_MS, status: "rejected" }, b: { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" } });
    expect(ranking.pick).toBeUndefined();
    expect(ranking.candidates[0]).toMatchObject({ identity: "b", class: "ineligible", blockedUntilMs: FAKE_NOW_MS + HOUR_MS });
    expect(ranking.candidates[0]?.reasons[0]).toContain('every member of pool "fleet" is refused; b returns at');
    expect(ranking.earliestReturn).toEqual({ identity: "b", atMs: FAKE_NOW_MS + HOUR_MS });
  });

  it("treats a nested pool's pick as one candidate in a scored outer pool", () => {
    const pools: Record<string, Pool> = { outer: { identities: ["far", "pool:fleet"] }, fleet: { identities: ["soon"] } };
    const { ranking } = graph(pools, "outer", { far: { utilization: U10, resetsInMs: SIX_DAYS_MS }, soon: { utilization: U60, resetsInMs: HOUR_MS } });
    expect(ranking.pick).toMatchObject({ identity: "soon" });
    expect(ranking.candidates.map((candidate) => candidate.identity)).toEqual(["soon", "far"]);
  });

  it("honours the sticky pick inside a nested pool, at depth", () => {
    const pools: Record<string, Pool> = { outer: { identities: ["pool:mid"] }, mid: { identities: ["old", "better"] } };
    const { ranking } = graph(pools, "outer", { old: { utilization: U60, resetsInMs: SIX_DAYS_MS }, better: { utilization: U10, resetsInMs: HOUR_MS } }, { sticky: { identity: "old", atMs: -(PROMPT_CACHE_TTL_MS - MINUTE_MS) } });
    expect(ranking.pick).toMatchObject({ identity: "old" });
    expect(ranking.pick?.reasons.join(" ")).toContain('picked by pool "mid"');
    expect(ranking.pick?.reasons.join(" ")).toContain("prompt cache still warm");
  });

  it("reports the missing identities a walk skipped, with the pool that names them", () => {
    const pools: Record<string, Pool> = { outer: { identities: ["pool:fleet"] }, fleet: { identities: ["gone", "kept"] } };
    const { ranking, missing } = rankPoolGraph({
      fs: createFakeFarmFs({ [snapshotPath("kept")]: snapshotOf("kept", { utilization: U60, resetsInMs: HOUR_MS }) }),
      paths,
      pools,
      poolName: "outer",
      nowMs: FAKE_NOW_MS,
      resuming: false,
      identityExists: (name) => name !== "gone",
    });
    expect(missing).toEqual([{ pool: "fleet", identity: "gone" }]);
    expect(ranking.pick).toMatchObject({ identity: "kept" });
  });

  it("refuses a nested member naming a pool that is not defined", () => {
    expect(() => graph({ outer: { identities: ["pool:nope"] } }, "outer", {})).toThrow(PoolGraphError);
    expect(() => graph({ outer: { identities: ["pool:nope"] } }, "outer", {})).toThrow('names a pool that is not defined');
  });

  it("refuses a cycle, naming the chain", () => {
    const cyclic: Record<string, Pool> = { a: { identities: ["pool:b"] }, b: { identities: ["pool:a"] } };
    expect(() => graph(cyclic, "a", {})).toThrow(PoolGraphError);
    expect(() => graph(cyclic, "a", {})).toThrow("a -> b -> a");
    expect(() => graph({ loop: { identities: ["pool:loop"] } }, "loop", {})).toThrow("loop -> loop");
  });
});
