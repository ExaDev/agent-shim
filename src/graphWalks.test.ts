import { describe, expect, it } from "vitest";

import type { Pool } from "./config/schema";
import { poolMemberIdentity } from "./config/schema";
import { poolNameOf } from "./launcher/identity";
import { modelsFindings } from "./models/doctor";
import { expandMembers, virtualModelsReachingCycle } from "./modelsStore";
import { poolWindowReadFindings } from "./poolWindowReads";
import { poolCycleOf, reportedPoolCycles } from "./poolStore";
import { lineariseProfile, type ProfileSource } from "./resolve/extends";
import { rankPool } from "./usage/pick";
import { loadPoolMembers, poolIdentities, rankPoolGraph, PoolGraphError } from "./usage/poolPick";
import { FAKE_NOW_MS, countSteps, createFakeFarmFs, growsLinearly, paths, seededGenerator } from "./test-helpers";
import type { PoolMember } from "./usage/pick";
import type { ModelsConfig } from "./config/schema";

/**
 * Every walk over a graph the user configures (pools nesting pools, profiles extending profiles, virtual models listing virtual models) visits each node once. Each walk is compared with the walk it replaced over many seeded random graphs, cyclic ones and ones naming what is not defined included, and its counted steps are measured at three sizes of the two graphs that break a walk that follows every path: a chain of diamonds (the paths double with each) and a long chain (the path grows with each).
 */

const SEEDS = 150;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The numbers of diamonds the chain of diamonds is measured at. A walk that follows every path makes 2^levels of them, so these stay small enough for it to finish and fail. */
const FIRST_LEVELS = 5;
const DOUBLE = 2;
const TRIPLE = 3;
const QUADRUPLE = 4;
const LEVELS = [FIRST_LEVELS, FIRST_LEVELS * DOUBLE, FIRST_LEVELS * TRIPLE] as const;

/** The lengths of the long chain. */
const FIRST_CHAIN = 100;
const CHAIN = [FIRST_CHAIN, FIRST_CHAIN * DOUBLE, FIRST_CHAIN * QUADRUPLE] as const;

const DIRECT = ["i0", "i1", "i2", "i3", "gone"] as const;
const MOST_POOLS = 7;
const MOST_ENTRIES = 4;
const NESTED_CHANCE = 0.45;
const WHEN_CHANCE = 0.2;
const DAG_CHANCE = 0.5;
const GHOST_CHANCE = 0.04;
const LISTED_CHANCE = 0.3;
const UTILISATION_STRIDE = 7;
const UTILISATION_STEPS = 10;
const RESET_HOURS = 5;
const MODEL_NAMES = 5;

function randomPools(seed: number): Record<string, Pool> {
  const next = seededGenerator(seed);
  const count = 2 + Math.floor(next() * (MOST_POOLS - 1));
  const acyclic = next() < DAG_CHANCE;
  const pools: Record<string, Pool> = {};
  for (let index = 0; index < count; index += 1) {
    const entries = Array.from({ length: 1 + Math.floor(next() * MOST_ENTRIES) }, (): Pool["identities"][number] => {
      let identity: string;
      if (next() < GHOST_CHANCE) {
        identity = "pool:ghost";
      } else if (next() < NESTED_CHANCE) {
        const target = acyclic ? index + 1 + Math.floor(next() * (count - index)) : Math.floor(next() * count);
        identity = target >= count ? "i0" : `pool:p${String(target)}`;
      } else {
        identity = DIRECT[Math.floor(next() * DIRECT.length)] ?? "i0";
      }
      return next() < WHEN_CHANCE ? { identity, when: { kind: "compare", op: "lt", left: { kind: "reference", key: "quota.sevenDay.utilization" }, right: { kind: "numberLiteral", value: 0.5 } } } : identity;
    });
    pools[`p${String(index)}`] = { identities: entries, ...(next() < LISTED_CHANCE ? { preference: "listed" as const } : {}) };
  }
  return pools;
}

/** A chain of diamonds: pool `d0` lists `a0` and `b0`, both list `d1`, and so on, so a walk that follows every path reaches the last pool 2^levels times. Each level's pools also hold an identity of their own. */
function diamondChain(levels: number): Record<string, Pool> {
  const pools: Record<string, Pool> = {};
  for (let level = 0; level < levels; level += 1) {
    pools[`d${String(level)}`] = { identities: [`pool:a${String(level)}`, `pool:b${String(level)}`] };
    for (const side of ["a", "b"]) {
      pools[`${side}${String(level)}`] = { identities: [`${side}id${String(level)}`, `pool:d${String(level + 1)}`] };
    }
  }
  pools[`d${String(levels)}`] = { identities: ["i0", "i1"] };
  return pools;
}

/** A chain of `length` pools, each listing the next and an identity of its own. */
function longChain(length: number): Record<string, Pool> {
  const pools: Record<string, Pool> = {};
  for (let index = 0; index < length; index += 1) {
    pools[`c${String(index)}`] = { identities: [`id${String(index)}`, ...(index + 1 < length ? [`pool:c${String(index + 1)}`] : [])] };
  }
  return pools;
}

/** A ring of `length` pools, each listing the next. */
function ring(length: number): Record<string, Pool> {
  return Object.fromEntries(Array.from({ length }, (_, index) => [`r${String(index)}`, { identities: [`pool:r${String((index + 1) % length)}`] }]));
}

/** Many two-pool cycles, each listing the next pair before its own partner: every pool reaches all the later pairs, a walk through one finds its own cycle only after them, and each pair is a cycle of its own. */
function chainedPairs(pairs: number): Record<string, Pool> {
  const pools: Record<string, Pool> = {};
  for (let index = 0; index < pairs; index += 1) {
    const next = index + 1 < pairs ? [`pool:x${String(index + 1)}`] : [];
    pools[`x${String(index)}`] = { identities: [...next, `pool:y${String(index)}`] };
    pools[`y${String(index)}`] = { identities: [`pool:x${String(index)}`] };
  }
  return pools;
}

/** The three sizes' counted steps must not grow faster than linearly. */
function expectLinear(sizes: readonly [number, number, number], measure: (size: number) => number): void {
  const counts = sizes.map(measure);
  expect(growsLinearly(sizes, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0]), `steps ${counts.join(", ")}`).toBe(true);
}

const nestedNames = (pools: Readonly<Record<string, Pool>>, name: string): string[] => (pools[name]?.identities ?? []).flatMap((entry) => poolNameOf(poolMemberIdentity(entry)) ?? []);

describe("poolCycleOf and reportedPoolCycles", () => {
  /** The walk before each pool was walked once: every path from `name`, a pool already on the path skipped. */
  function naiveCycleOf(pools: Readonly<Record<string, Pool>>, name: string): readonly string[] | undefined {
    const walk = (current: string, path: readonly string[]): readonly string[] | undefined => {
      for (const nested of nestedNames(pools, current)) {
        if (nested === name) {
          return [...path, nested];
        }
        if (path.includes(nested)) {
          continue;
        }
        const found = walk(nested, [...path, nested]);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    return walk(name, [name]);
  }

  it("finds the chain the walk over every path finds, from every pool of many random graphs", () => {
    let cycles = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const pools = randomPools(seed);
      for (const name of Object.keys(pools)) {
        const expected = naiveCycleOf(pools, name);
        cycles += expected === undefined ? 0 : 1;
        expect(poolCycleOf(pools, name), `seed ${String(seed)} from ${name}`).toEqual(expected);
      }
    }
    expect(cycles).toBeGreaterThan(0);
  });

  /** Whether two pools each reach the other, by the walk over every path. */
  const reachesEachOther = (pools: Readonly<Record<string, Pool>>, left: string, right: string): boolean => {
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const walk = (current: string): boolean => nestedNames(pools, current).some((nested) => nested === to || (!seen.has(nested) && (seen.add(nested), walk(nested))));
      return walk(from);
    };
    return reaches(left, right) && reaches(right, left);
  };

  it("reports one chain for each group of pools reaching one another, a real cycle through the group's first name, and the first chain exactly", () => {
    let reported = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const pools = randomPools(seed);
      const cyclic = Object.keys(pools).sort().filter((name) => naiveCycleOf(pools, name) !== undefined);
      // The groups, each named by its first pool.
      const firsts = cyclic.filter((name) => cyclic.find((other) => other === name || reachesEachOther(pools, name, other)) === name);
      const chains = reportedPoolCycles(pools);
      reported += chains.length;
      expect(chains.map((chain) => chain[0]), `seed ${String(seed)}`).toEqual(firsts);
      for (const chain of chains) {
        expect(chain, `seed ${String(seed)}`).toEqual(naiveCycleOf(pools, chain[0] ?? ""));
      }
    }
    expect(reported).toBeGreaterThan(0);
  });

  it("walks each pool once: a ring, a chain of two-pool cycles and a chain of diamonds make steps that grow linearly", () => {
    expectLinear(CHAIN, (size) => countSteps(() => { reportedPoolCycles(ring(size)); }));
    expectLinear(CHAIN, (size) => countSteps(() => { reportedPoolCycles(chainedPairs(size)); }));
    expectLinear(CHAIN, (size) => countSteps(() => { reportedPoolCycles(longChain(size)); }));
    expectLinear(LEVELS, (levels) => countSteps(() => { reportedPoolCycles({ ...diamondChain(levels), back: { identities: ["pool:d0"] }, [`d${String(levels)}`]: { identities: ["pool:d0"] } }); }));
    expectLinear(CHAIN, (size) => countSteps(() => { poolCycleOf(longChain(size), "c0"); }));
    expectLinear(LEVELS, (levels) => countSteps(() => { poolCycleOf(diamondChain(levels), "d0"); }));
  });
});

describe("poolIdentities and rankPoolGraph", () => {
  /** The identities of a pool graph before each pool was walked once. */
  function naiveIdentities(pools: Readonly<Record<string, Pool>>, poolName: string, stack: readonly string[] = [], found = new Set<string>()): Set<string> {
    const pool = pools[poolName];
    if (pool === undefined) {
      throw new PoolGraphError(`No pool named "${poolName}". Run \`agent-shim pool add ${poolName} --identity <name>...\` first.`);
    }
    const childStack = [...stack, poolName];
    for (const entry of pool.identities) {
      const nested = poolNameOf(poolMemberIdentity(entry));
      if (nested === undefined) {
        found.add(poolMemberIdentity(entry));
        continue;
      }
      if (pools[nested] === undefined) {
        throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" names a pool that is not defined.`);
      }
      if (childStack.includes(nested)) {
        throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" closes a cycle: ${[...childStack.slice(childStack.indexOf(nested)), nested].join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
      }
      naiveIdentities(pools, nested, childStack, found);
    }
    return found;
  }

  const messageOf = (run: () => unknown): string | undefined => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it("lists the identities, and fails with the message, that the walk over every path gives, for many random graphs", () => {
    let failures = 0;
    let successes = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const pools = randomPools(seed);
      const expected = messageOf(() => naiveIdentities(pools, "p0"));
      expect(messageOf(() => poolIdentities(pools, "p0")), `seed ${String(seed)}`).toBe(expected);
      if (expected === undefined) {
        successes += 1;
        expect(poolIdentities(pools, "p0")).toEqual([...naiveIdentities(pools, "p0")]);
      } else {
        failures += 1;
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(successes).toBeGreaterThan(0);
  });

  const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;
  const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

  /** A farm in which each identity has a seven-day window that differs, so the picks of the pools differ, and a usage log with a record for each. */
  function farmOf(identities: readonly string[], onRead?: (directory: string) => void, onReadFile?: () => void) {
    const inner = createFakeFarmFs({
      ...Object.fromEntries(identities.map((identity, at) => [snapshotPath(identity), JSON.stringify({ schemaVersion: 1, identity, updatedAt: iso(-HOUR_MS), providers: { anthropic: { lastRequestAt: iso(-HOUR_MS), lastStatus: 200, rateLimit: { observedAt: iso(-HOUR_MS), headers: {}, unified: { sevenDay: { utilization: ((at * UTILISATION_STRIDE) % UTILISATION_STEPS) / UTILISATION_STEPS, resetsAt: iso(((at % RESET_HOURS) + 1) * HOUR_MS) } } } } } })])),
      [`${paths.usageLogDir}/${iso(0).slice(0, "YYYY-MM-DD".length)}.1.jsonl`]: identities.map((identity) => `${JSON.stringify({ schemaVersion: 1, at: iso(-MINUTE_MS), identity, provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`).join(""),
    });
    if (onRead === undefined && onReadFile === undefined) {
      return inner;
    }
    return {
      ...inner,
      readdir: (directory: string) => { onRead?.(directory); return inner.readdir(directory); },
      readFileUtf8: (file: string) => { onReadFile?.(); return inner.readFileUtf8(file); },
    };
  }

  /** The ranking before each pool was ranked once: a nested pool ranked again for every path reaching it, the usage log read again for each. These members carry no account, so no two share a login. */
  function naiveRank(fs: ReturnType<typeof farmOf>, pools: Readonly<Record<string, Pool>>, poolName: string, stack: readonly string[], idOf: (name: string) => string | undefined) {
    const pool = pools[poolName];
    if (pool === undefined) {
      throw new PoolGraphError(`No pool named "${poolName}". Run \`agent-shim pool add ${poolName} --identity <name>...\` first.`);
    }
    const childStack = [...stack, poolName];
    const direct = pool.identities.filter((entry) => poolNameOf(poolMemberIdentity(entry)) === undefined);
    const missing = direct.filter((entry) => idOf(poolMemberIdentity(entry)) === undefined).map((entry) => ({ pool: poolName, identity: poolMemberIdentity(entry) }));
    const loaded = new Map(loadPoolMembers(fs, paths, direct.filter((entry) => idOf(poolMemberIdentity(entry)) !== undefined).map(poolMemberIdentity), FAKE_NOW_MS, idOf).map((member) => [member.identity, member]));
    const members: PoolMember[] = [];
    for (const entry of pool.identities) {
      const nestedName = poolNameOf(poolMemberIdentity(entry));
      if (nestedName === undefined) {
        const member = loaded.get(poolMemberIdentity(entry));
        if (member !== undefined) {
          members.push(typeof entry === "string" ? member : { ...member, policy: entry.when });
        }
        continue;
      }
      if (pools[nestedName] === undefined) {
        throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" names a pool that is not defined.`);
      }
      if (childStack.includes(nestedName)) {
        throw new PoolGraphError(`Pool "${poolName}" member "${poolMemberIdentity(entry)}" closes a cycle: ${[...childStack.slice(childStack.indexOf(nestedName)), nestedName].join(" -> ")}. A pool cannot nest itself, directly or through another pool.`);
      }
      const nested = naiveRank(fs, pools, nestedName, childStack, idOf);
      const pick = nested.ranking.pick;
      let member: PoolMember;
      if (pick !== undefined) {
        const [own] = loadPoolMembers(fs, paths, [pick.identity], FAKE_NOW_MS, idOf);
        member = { ...(own ?? { identity: pick.identity, records: [] }), nested: { kind: "pick", pool: nestedName, reasons: pick.reasons } };
      } else {
        const earliestReturn = nested.ranking.earliestReturn;
        member = { identity: earliestReturn?.identity ?? `pool:${nestedName}`, records: [], nested: { kind: "refused", pool: nestedName, ...(earliestReturn === undefined ? {} : { earliestReturn }) } };
      }
      members.push(typeof entry === "string" ? member : { ...member, policy: entry.when });
      missing.push(...nested.missing);
    }
    return { ranking: rankPool({ members, nowMs: FAKE_NOW_MS, resuming: false, ...(pool.preference === undefined ? {} : { preference: pool.preference }) }), missing };
  }

  const uniqueFirst = <T,>(items: readonly T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };

  it("ranks a graph, and fails with the message, that the ranking of every path gives, for many random graphs", () => {
    const idOf = (name: string): string | undefined => (name === "gone" ? undefined : name);
    let failures = 0;
    let successes = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const pools = randomPools(seed);
      const fs = farmOf(DIRECT.filter((name) => name !== "gone"));
      const expected = (() => { try { return naiveRank(fs, pools, "p0", [], idOf); } catch (error) { return error instanceof Error ? error.message : String(error); } })();
      const actual = (() => { try { return rankPoolGraph({ fs, paths, pools, poolName: "p0", nowMs: FAKE_NOW_MS, resuming: false, identityIdOf: idOf }); } catch (error) { return error instanceof Error ? error.message : String(error); } })();
      if (typeof expected === "string") {
        failures += 1;
        expect(actual, `seed ${String(seed)}`).toBe(expected);
      } else {
        successes += 1;
        expect(actual, `seed ${String(seed)}`).toEqual({ ranking: expected.ranking, missing: uniqueFirst(expected.missing) });
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(successes).toBeGreaterThan(0);
  });

  /**
   * Ranks `pools` from `poolName` and counts the work: how many times an identity name was resolved, a file was read and the usage log listed. These are counted, not the array steps, because the reasons of a pick carry one line for each pool it came through, which copies a list as long as the nesting is deep: a cost of the depth that is part of what a pick reports.
   */
  function rankCost(pools: Readonly<Record<string, Pool>>, poolName: string, identities: readonly string[]): { readonly resolutions: number; readonly fileReads: number; readonly logReads: number } {
    let logReads = 0;
    let fileReads = 0;
    let resolutions = 0;
    const fs = farmOf(identities, (directory) => { logReads += directory === paths.usageLogDir ? 1 : 0; }, () => { fileReads += 1; });
    rankPoolGraph({ fs, paths, pools, poolName, nowMs: FAKE_NOW_MS, resuming: false, identityIdOf: (name) => { resolutions += 1; return name; } });
    return { resolutions, fileReads, logReads };
  }

  const identitiesOfChain = (levels: number): string[] => ["i0", "i1", ...Array.from({ length: levels }, (_, level) => [`aid${String(level)}`, `bid${String(level)}`]).flat()];

  it("ranks a chain of diamonds and a long chain resolving names and reading files in numbers that grow linearly, reading the usage log once", () => {
    const run = (sizes: readonly [number, number, number], build: (size: number) => { pools: Record<string, Pool>; top: string; identities: string[] }): void => {
      const costs = new Map<number, ReturnType<typeof rankCost>>();
      const costOf = (size: number): ReturnType<typeof rankCost> => {
        const { pools, top, identities } = build(size);
        const cost = rankCost(pools, top, identities);
        costs.set(size, cost);
        expect(cost.logReads).toBe(1);
        return cost;
      };
      expectLinear(sizes, (size) => costOf(size).resolutions);
      expectLinear(sizes, (size) => costs.get(size)?.fileReads ?? 0);
    };
    run(LEVELS, (levels) => ({ pools: diamondChain(levels), top: "d0", identities: identitiesOfChain(levels) }));
    run(CHAIN, (size) => ({ pools: longChain(size), top: "c0", identities: Array.from({ length: size }, (_, index) => `id${String(index)}`) }));
  });

  it("lists the identities of a chain of diamonds and a long chain in steps that grow linearly", () => {
    expectLinear(LEVELS, (levels) => countSteps(() => { poolIdentities(diamondChain(levels), "d0"); }));
    expectLinear(CHAIN, (size) => countSteps(() => { poolIdentities(longChain(size), "c0"); }));
  });

  it("reports an identity missing under a pool that several pools nest once", () => {
    const pools = { d0: { identities: ["pool:a", "pool:b"] }, a: { identities: ["pool:c"] }, b: { identities: ["pool:c"] }, c: { identities: ["gone", "i0"] } };
    const result = rankPoolGraph({ fs: farmOf(["i0"]), paths, pools, poolName: "d0", nowMs: FAKE_NOW_MS, resuming: false, identityIdOf: (name) => (name === "gone" ? undefined : name) });
    expect(result.missing).toEqual([{ pool: "c", identity: "gone" }]);
  });
});

describe("the identities a window read covers", () => {
  it("lists the identities of a chain of diamonds, each once, in steps that grow linearly", () => {
    const windowless = (): ReadonlySet<"fiveHour" | "sevenDay" | "extraUsage"> => new Set();
    const read = (levels: number): readonly { readonly message: string }[] => poolWindowReadFindings({ ...diamondChain(levels), top: { identities: [{ identity: "pool:d0", when: { kind: "compare", op: "lt", left: { kind: "reference", key: "quota.fiveHour.utilization" }, right: { kind: "numberLiteral", value: 0.5 } } }] } }, windowless);
    expect(read(2).map((finding) => /but (\S+) reports/.exec(finding.message)?.[1])).toEqual(["aid0", "aid1", "i0", "i1", "bid1", "bid0"]);
    expectLinear(LEVELS, (levels) => countSteps(() => { read(levels); }));
  });
});

describe("lineariseProfile", () => {
  const sourceOf = (extendsList: readonly string[]): ProfileSource => ({ name: "x", profile: { extends: [...extendsList] } });

  /** The walk before the stack was also kept as a set. */
  function naiveLinearise(rootName: string, graph: Readonly<Record<string, readonly string[]>>): { readonly order: readonly string[]; readonly messages: readonly string[] } {
    const stack: string[] = [];
    const visited = new Set<string>();
    const order: string[] = [];
    const messages: string[] = [];
    const visit = (name: string): void => {
      if (stack.includes(name)) {
        messages.push(`Circular profile extends: ${[...stack, name].join(" -> ")}. The cycle is broken here and "${name}" is not applied twice.`);
        return;
      }
      if (visited.has(name)) {
        return;
      }
      const dependencies = graph[name];
      if (dependencies === undefined) {
        messages.push(`Configuration profile "${name}" does not exist.`);
        visited.add(name);
        return;
      }
      stack.push(name);
      dependencies.forEach(visit);
      stack.pop();
      visited.add(name);
      order.push(name);
    };
    visit(rootName);
    return { order, messages };
  }

  it("gives the order and the messages the walk with a list for its stack gives, for many random graphs", () => {
    let cycles = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = seededGenerator(seed);
      const count = 2 + Math.floor(next() * MOST_POOLS);
      const graph = Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${String(index)}`, Array.from({ length: Math.floor(next() * MOST_ENTRIES) }, () => `q${String(Math.floor(next() * (count + 1)))}`)]));
      const expected = naiveLinearise("q0", graph);
      cycles += expected.messages.some((message) => message.startsWith("Circular")) ? 1 : 0;
      const actual = lineariseProfile("q0", (name) => (graph[name] === undefined ? undefined : sourceOf(graph[name])));
      expect({ order: actual.order, messages: actual.diagnostics.map((diagnostic) => diagnostic.message) }, `seed ${String(seed)}`).toEqual(expected);
    }
    expect(cycles).toBeGreaterThan(0);
  });

  it("makes steps that grow linearly on a long chain and on a chain of diamonds", () => {
    expectLinear(CHAIN, (size) => countSteps(() => { lineariseProfile("c0", (name) => sourceOf(name === `c${String(size - 1)}` ? [] : [`c${String(Number(name.slice(1)) + 1)}`])); }));
    expectLinear(LEVELS, (levels) => {
      const graph = Object.fromEntries(Object.entries(diamondChain(levels)).map(([name, pool]) => [name, pool.identities.map(poolMemberIdentity).map((identity) => poolNameOf(identity) ?? identity).filter((entry) => entry in diamondChain(levels))]));
      return countSteps(() => { lineariseProfile("d0", (name) => sourceOf(graph[name] ?? [])); });
    });
  });
});

describe("expandMembers", () => {
  /** The expansion before a virtual model was expanded once. */
  function naiveExpand(name: string, models: ModelsConfig): readonly string[] {
    const virtual = models.virtual ?? {};
    const expanded: string[] = [];
    const seen = new Set<string>();
    const walk = (current: string, chain: readonly string[]): void => {
      const nested = virtual[current];
      if (nested !== undefined) {
        if (chain.includes(current)) {
          throw new Error(`virtual model cycle: ${[...chain, current].join(" -> ")}`);
        }
        for (const member of nested.members) {
          walk(member, [...chain, current]);
        }
        return;
      }
      if (!seen.has(current)) {
        seen.add(current);
        expanded.push(current);
      }
    };
    for (const member of virtual[name]?.members ?? []) {
      walk(member, [name]);
    }
    return expanded;
  }

  const outcomeOf = (run: () => readonly string[]): string => {
    try {
      return run().join(",");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it("expands to the list, and fails with the message, that the walk over every path gives, for many random models", () => {
    let cycles = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = seededGenerator(seed);
      const count = 2 + Math.floor(next() * MOST_POOLS);
      const virtual = Object.fromEntries(Array.from({ length: count }, (_, index) => [`v${String(index)}`, { mode: "ordered" as const, members: Array.from({ length: 1 + Math.floor(next() * MOST_ENTRIES) }, () => (next() < NESTED_CHANCE ? `v${String(Math.floor(next() * count))}` : `p/m${String(Math.floor(next() * MODEL_NAMES))}`)) }]));
      const models: ModelsConfig = { virtual };
      const expected = outcomeOf(() => naiveExpand("v0", models));
      cycles += expected.startsWith("virtual model cycle") ? 1 : 0;
      expect(outcomeOf(() => expandMembers("v0", models)), `seed ${String(seed)}`).toBe(expected);
      const reaching = virtualModelsReachingCycle(models);
      for (const name of Object.keys(virtual)) {
        expect(reaching.has(name), `seed ${String(seed)} ${name}`).toBe(outcomeOf(() => naiveExpand(name, models)).startsWith("virtual model cycle"));
      }
    }
    expect(cycles).toBeGreaterThan(0);
  });

  it("reports a virtual model that chooses by price and reaches a cycle as one that cannot be expanded, without failing", () => {
    const models: ModelsConfig = { virtual: { loop: { mode: "cheapest", members: ["p/a", "other"] }, other: { mode: "ordered", members: ["loop"] } } };
    const messages = modelsFindings({ models, providers: ["p"], identities: [] }).map((finding) => finding.message);
    expect(messages.filter((message) => message.includes("cannot be expanded"))).toEqual([
      'Virtual model "loop" cannot be expanded: virtual model cycle: loop -> other -> loop',
      'Virtual model "other" cannot be expanded: virtual model cycle: other -> loop -> other',
    ]);
  });

  const chainOfDiamonds = (levels: number): ModelsConfig => ({
    virtual: Object.fromEntries(Object.entries(diamondChain(levels)).map(([name, pool]) => [name, { mode: "ordered" as const, members: pool.identities.map(poolMemberIdentity).map((identity) => poolNameOf(identity) ?? `p/${identity}`) }])),
  });

  it("makes steps that grow linearly on a chain of diamonds and on a long chain, and in the models check of them", () => {
    expectLinear(LEVELS, (levels) => countSteps(() => { expandMembers("d0", chainOfDiamonds(levels)); }));
    expectLinear(CHAIN, (size) => countSteps(() => { expandMembers("c0", { virtual: Object.fromEntries(Object.entries(longChain(size)).map(([name, pool]) => [name, { mode: "ordered" as const, members: pool.identities.map(poolMemberIdentity).map((identity) => poolNameOf(identity) ?? `p/${identity}`) }])) }); }));
    expectLinear(LEVELS, (levels) => countSteps(() => { modelsFindings({ models: chainOfDiamonds(levels), providers: ["p"], identities: [] }); }));
  });
});
