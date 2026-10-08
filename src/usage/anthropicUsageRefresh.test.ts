import { describe, expect, it, vi } from "vitest";

import type { Pool } from "../config/schema";
import { ANTHROPIC_USAGE_FRESHNESS_MS, createAnthropicUsageRefresher, isAnthropicUsageProbeable, isAnthropicUsageStale, poolIdentityNames, unifiedFromReportedLimits, type AnthropicUsageRefresherDeps } from "./anthropicUsageRefresh";
import { SEVEN_DAY_WINDOW_MS, type PoolMember } from "./pick";
import type { AccountMetadata, UnifiedRateLimit, UsageSnapshot } from "./schema";
import { USAGE_SCHEMA_VERSION } from "./schema";

const NOW_MS = Date.parse("2026-10-08T10:00:00.000Z");
const ONE_MS = 1;
const PERCENT_WINDOWS = 100;
const SUBSCRIPTION: AccountMetadata = { organizationRateLimitTier: "default_claude_max_5x" };
const PAY_PER_USE: AccountMetadata = { organizationRateLimitTier: "zero" };
const PERCENT_USED = 24;
const FRACTION_USED = 0.24;

function snapshot(observedAtMs: number | undefined, account: Readonly<AccountMetadata> = SUBSCRIPTION): UsageSnapshot {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity: "work",
    updatedAt: new Date(NOW_MS).toISOString(),
    account,
    providers: {
      anthropic: {
        lastRequestAt: new Date(NOW_MS).toISOString(),
        lastStatus: 200,
        ...(observedAtMs === undefined ? {} : { rateLimit: { observedAt: new Date(observedAtMs).toISOString(), headers: {}, unified: { fiveHour: { utilization: FRACTION_USED } } } }),
      },
    },
  };
}

/** A pool member as ranking loads it; `account` null leaves the member with no account of its own, so the plan comes from its snapshot. */
function member(identity: string, usage: UsageSnapshot | undefined, account: AccountMetadata | null = SUBSCRIPTION): PoolMember {
  return { identity, records: [], ...(usage === undefined ? {} : { snapshot: { ...usage, identity } }), ...(account === null ? {} : { account }) };
}

describe("unifiedFromReportedLimits", () => {
  it("converts percentages to fractions and normalises the reset instants to UTC milliseconds", () => {
    const unified = unifiedFromReportedLimits({
      five_hour: { utilization: PERCENT_USED, resets_at: "2026-10-08T10:59:58.695666+00:00" },
      seven_day: { utilization: 16, resets_at: "2026-10-11T12:59:58.695696+01:00" },
    });

    expect(unified).toEqual({
      fiveHour: { utilization: FRACTION_USED, resetsAt: "2026-10-08T10:59:58.695Z" },
      sevenDay: { utilization: 0.16, resetsAt: "2026-10-11T11:59:58.695Z" },
    });
  });

  it("marks a window that is entirely used as refused, and no other window with a status", () => {
    const unified = unifiedFromReportedLimits({ five_hour: { utilization: 100, resets_at: "2026-10-08T10:59:58.000Z" }, seven_day: { utilization: 99, resets_at: null } });

    expect(unified?.fiveHour?.status).toBe("rejected");
    expect(unified?.sevenDay).toEqual({ utilization: 0.99 });
  });

  it("is undefined when the endpoint reported no plan window", () => {
    expect(unifiedFromReportedLimits(null)).toBeUndefined();
    expect(unifiedFromReportedLimits({ five_hour: null, seven_day: { utilization: null, resets_at: null } })).toBeUndefined();
  });

  it("drops a reset instant that is not a date rather than recording it", () => {
    expect(unifiedFromReportedLimits({ five_hour: { utilization: PERCENT_USED, resets_at: "soon" } })).toEqual({ fiveHour: { utilization: FRACTION_USED } });
  });
});

describe("isAnthropicUsageStale", () => {
  it("is fresh while the recorded state is younger than one percent of the five-hour window", () => {
    expect(isAnthropicUsageStale(member("work", snapshot(NOW_MS - ANTHROPIC_USAGE_FRESHNESS_MS + ONE_MS)), NOW_MS)).toBe(false);
  });

  it("is stale from exactly that age, and when a rate-limit state was never observed", () => {
    expect(isAnthropicUsageStale(member("work", snapshot(NOW_MS - ANTHROPIC_USAGE_FRESHNESS_MS)), NOW_MS)).toBe(true);
    expect(isAnthropicUsageStale(member("work", snapshot(undefined)), NOW_MS)).toBe(true);
  });

  it("asks again about an answer with no plan windows only after one percent of the seven-day window", () => {
    const noWindows = (observedAtMs: number): UsageSnapshot => ({ ...snapshot(observedAtMs), providers: { anthropic: { rateLimit: { observedAt: new Date(observedAtMs).toISOString(), headers: {} } } } });
    const sevenDayFreshnessMs = SEVEN_DAY_WINDOW_MS / PERCENT_WINDOWS;

    expect(isAnthropicUsageStale(member("work", noWindows(NOW_MS - ANTHROPIC_USAGE_FRESHNESS_MS)), NOW_MS)).toBe(false);
    expect(isAnthropicUsageStale(member("work", noWindows(NOW_MS - sevenDayFreshnessMs + ONE_MS)), NOW_MS)).toBe(false);
    expect(isAnthropicUsageStale(member("work", noWindows(NOW_MS - sevenDayFreshnessMs)), NOW_MS)).toBe(true);
  });

  it("is stale for a subscription member that has made no request, which has nothing recorded yet", () => {
    expect(isAnthropicUsageStale(member("work", undefined), NOW_MS)).toBe(true);
    expect(isAnthropicUsageProbeable(member("work", undefined))).toBe(true);
  });

  it("is never stale for a pay-per-use member, which has no plan windows", () => {
    expect(isAnthropicUsageStale(member("work", snapshot(undefined, PAY_PER_USE), PAY_PER_USE), NOW_MS)).toBe(false);
  });

  it("reads the plan from the snapshot's account when the member carries none", () => {
    expect(isAnthropicUsageStale(member("work", snapshot(undefined, PAY_PER_USE), null), NOW_MS)).toBe(false);
    expect(isAnthropicUsageStale(member("work", snapshot(undefined, SUBSCRIPTION), null), NOW_MS)).toBe(true);
  });
});

describe("poolIdentityNames", () => {
  const pools: Record<string, Pool> = {
    subs: { identities: ["a", { identity: "b", when: { branch: "main" } }, "pool:fleet"] },
    fleet: { identities: ["b", "c", "pool:subs"] },
  };

  it("lists each identity once across nested pools, and tolerates a cycle and an undefined pool", () => {
    expect(poolIdentityNames(pools, "subs")).toEqual(["a", "b", "c"]);
    expect(poolIdentityNames(pools, "missing")).toEqual([]);
  });
});

describe("createAnthropicUsageRefresher", () => {
  const UNIFIED: UnifiedRateLimit = { fiveHour: { utilization: FRACTION_USED } };

  function harness(overrides: Partial<AnthropicUsageRefresherDeps> = {}) {
    let nowMs = NOW_MS;
    const probe = vi.fn<AnthropicUsageRefresherDeps["probe"]>(async () => await Promise.resolve(UNIFIED));
    const record = vi.fn<AnthropicUsageRefresherDeps["record"]>();
    const log = vi.fn<AnthropicUsageRefresherDeps["log"]>();
    const refresher = createAnthropicUsageRefresher({ probe, record, now: () => nowMs, log, concurrency: 8, ...overrides });
    return {
      refresher,
      probe,
      record,
      log,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it("records the fetched state with the instant it was fetched", async () => {
    const { refresher, record } = harness();

    expect(await refresher.refresh("work")).toEqual({ status: "refreshed" });

    expect(record).toHaveBeenCalledWith("work", { observedAt: new Date(NOW_MS).toISOString(), headers: {}, unified: UNIFIED });
  });

  it("probes only the stale members, all at once", async () => {
    const { refresher, probe } = harness();

    await refresher.refreshStale([member("stale-a", snapshot(undefined)), member("fresh", snapshot(NOW_MS)), member("stale-b", snapshot(NOW_MS - ANTHROPIC_USAGE_FRESHNESS_MS)), member("unused", undefined), member("pay", snapshot(undefined, PAY_PER_USE), PAY_PER_USE)]);

    expect(probe.mock.calls.map(([identity]) => identity)).toEqual(["stale-a", "stale-b", "unused"]);
  });

  it("never has more probes in flight than the configured concurrency, and still probes every stale member", async () => {
    const CONCURRENCY = 2;
    const MEMBERS = 5;
    let running = 0;
    let peak = 0;
    const probe = vi.fn<AnthropicUsageRefresherDeps["probe"]>(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return UNIFIED;
    });
    const { refresher } = harness({ probe, concurrency: CONCURRENCY });

    await refresher.refreshStale(Array.from({ length: MEMBERS }, (_, index) => member(`m${String(index)}`, snapshot(undefined))));

    expect(probe).toHaveBeenCalledTimes(MEMBERS);
    expect(peak).toBe(CONCURRENCY);
  });

  it("shares one fetch between concurrent requests for the same identity", async () => {
    const { refresher, probe } = harness();

    await Promise.all([refresher.refresh("work"), refresher.refresh("work")]);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("reports an answer without plan windows as unavailable, and records that it was asked so it is not asked again at once", async () => {
    const { refresher, record } = harness({
      probe: async () => {
        await Promise.resolve();
        return undefined;
      },
    });

    expect(await refresher.refresh("work")).toEqual({ status: "unavailable" });
    expect(record).toHaveBeenCalledWith("work", { observedAt: new Date(NOW_MS).toISOString(), headers: {} });
  });

  it("logs a failed fetch and leaves the member alone, never throwing", async () => {
    const { refresher, log } = harness({
      probe: async () => await Promise.reject(new Error("the launch was refused")),
    });

    await expect(refresher.refreshStale([member("work", snapshot(undefined))])).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith("usage: refreshing the Anthropic usage of work failed: the launch was refused");
  });

  it("does not retry a failed member until one freshness period has passed, and retries it then", async () => {
    const probe = vi.fn<AnthropicUsageRefresherDeps["probe"]>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(UNIFIED);
    const { refresher, advance } = harness({ probe });
    const stale = [member("work", snapshot(undefined))];
    await refresher.refreshStale(stale);

    advance(ANTHROPIC_USAGE_FRESHNESS_MS - ONE_MS);
    await refresher.refreshStale(stale);
    expect(probe).toHaveBeenCalledTimes(1);

    advance(ONE_MS);
    await refresher.refreshStale(stale);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
