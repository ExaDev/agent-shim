import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_MS, rankPool, type PoolMember, type RankPoolInput } from "./pick";
import type { AccountMetadata, UsageRecord, UsageSnapshot } from "./schema";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HALF_HOUR_MS = 1_800_000;
const FOUR_HOURS_MS = 14_400_000;
const THREE_HOURS_MS = 10_800_000;
const SIX_HOURS_MS = 21_600_000;
const TWO_DAYS_MS = 172_800_000;
const THREE_DAYS_MS = 259_200_000;
const SIX_DAYS_MS = 518_400_000;
const TEN_MINUTES_MS = 600_000;
const HALF_MINUTE_MS = 30_000;
const TWO_MINUTES_SECONDS = 120;
const MS_PER_SECOND = 1000;
const SEVEN_DAYS_HOURS = 168;
const MAX_20X_CAPACITY = 20;
const U10 = 0.1;
const U30 = 0.3;
const U50 = 0.5;
const U60 = 0.6;
const U80 = 0.8;
const U90 = 0.9;
const U09 = 0.09;
const FULL = 1;
const MAX_20X = "default_claude_max_20x";
const MAX_5X = "default_claude_max_5x";

const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();
const epochSeconds = (offsetMs: number): string => String(Math.floor((NOW_MS + offsetMs) / MS_PER_SECOND));

interface Windows {
  readonly five?: { utilization?: number; status?: string; resetsInMs?: number };
  readonly seven?: { utilization?: number; status?: string; resetsInMs?: number };
  readonly overage?: string;
  readonly lastLimit?: { kind: "rate-limited" | "quota-exhausted"; resetInMs?: number; retryAfterSeconds?: number; observedAgoMs?: number };
  readonly lastRequestAgoMs?: number;
}

function snapshot(identity: string, windows: Windows): UsageSnapshot {
  const window = (spec: Readonly<NonNullable<Windows["five"]>>) => ({
    ...(spec.utilization === undefined ? {} : { utilization: spec.utilization }),
    ...(spec.status === undefined ? {} : { status: spec.status }),
    ...(spec.resetsInMs === undefined ? {} : { resetsAt: at(spec.resetsInMs) }),
  });
  // A refusal is the last thing the snapshot saw unless a later request is stated.
  const lastRequestAt = at(-(windows.lastRequestAgoMs ?? (windows.lastLimit === undefined ? 0 : (windows.lastLimit.observedAgoMs ?? MINUTE_MS))));
  return {
    schemaVersion: 1,
    identity,
    updatedAt: lastRequestAt,
    providers: {
      anthropic: {
        lastRequestAt,
        lastStatus: 200,
        rateLimit: {
          observedAt: at(-MINUTE_MS),
          headers: {},
          unified: {
            ...(windows.five === undefined ? {} : { fiveHour: window(windows.five) }),
            ...(windows.seven === undefined ? {} : { sevenDay: window(windows.seven) }),
            ...(windows.overage === undefined ? {} : { overageStatus: windows.overage }),
          },
        },
        ...(windows.lastLimit === undefined
          ? {}
          : {
              lastLimit: {
                kind: windows.lastLimit.kind,
                evidence: [],
                observedAt: at(-(windows.lastLimit.observedAgoMs ?? MINUTE_MS)),
                status: 429,
                ...(windows.lastLimit.resetInMs === undefined ? {} : { resetAt: at(windows.lastLimit.resetInMs) }),
                ...(windows.lastLimit.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: windows.lastLimit.retryAfterSeconds }),
              },
            }),
      },
    },
  };
}

function member(identity: string, windows: Windows | undefined, tier = MAX_20X, records: readonly UsageRecord[] = []): PoolMember {
  const account: AccountMetadata = { organizationRateLimitTier: tier };
  return { identity, records, account, ...(windows === undefined ? {} : { snapshot: snapshot(identity, windows) }) };
}

function rank(members: readonly PoolMember[], extra: Partial<RankPoolInput> = {}): ReturnType<typeof rankPool> {
  return rankPool({ members, nowMs: NOW_MS, resuming: false, ...extra });
}

const order = (ranking: ReturnType<typeof rankPool>): string[] => ranking.candidates.map((candidate) => candidate.identity);

function burnRecord(identity: string, agoMs: number, fiveHourUtilization: number, resetsInMs: number): UsageRecord {
  return {
    schemaVersion: 1,
    at: at(-agoMs),
    identity,
    provider: "anthropic",
    route: "anthropic",
    method: "POST",
    endpoint: "/v1/messages",
    status: 200,
    latencyMs: 1,
    durationMs: 1,
    outcome: "completed",
    rateLimitHeaders: {
      "anthropic-ratelimit-unified-5h-utilization": String(fiveHourUtilization),
      "anthropic-ratelimit-unified-5h-reset": epochSeconds(resetsInMs),
    },
  };
}

describe("rankPool", () => {
  it("never picks a member whose plan window is rejected and has not reset, and reports when it returns", () => {
    const ranking = rank([member("a", { seven: { utilization: FULL, status: "rejected", resetsInMs: TWO_DAYS_MS } }), member("b", { seven: { utilization: U90, status: "allowed", resetsInMs: DAY_MS } })]);
    expect(ranking.pick?.identity).toBe("b");
    expect(ranking.candidates.find((candidate) => candidate.identity === "a")).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + TWO_DAYS_MS });
  });

  it("reports the earliest return when every member is refused", () => {
    const ranking = rank([member("a", { five: { status: "rejected", resetsInMs: THREE_HOURS_MS } }), member("b", { five: { status: "rejected", resetsInMs: HOUR_MS } })]);
    expect(ranking.pick).toBeUndefined();
    expect(ranking.earliestReturn).toEqual({ identity: "b", atMs: NOW_MS + HOUR_MS });
  });

  it("treats a window whose reset has passed as empty rather than refused", () => {
    const ranking = rank([member("a", { seven: { utilization: FULL, status: "rejected", resetsInMs: -HOUR_MS } })]);
    expect(ranking.pick).toMatchObject({ identity: "a", class: "scored" });
  });

  it("honours a quota-exhausted refusal until its reset, and ignores it once a later request went through", () => {
    const refused = rank([member("a", { seven: { utilization: U50, resetsInMs: DAY_MS }, lastLimit: { kind: "quota-exhausted", resetInMs: HOUR_MS } })]);
    expect(refused.candidates[0]).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + HOUR_MS });
    const lifted = rank([member("a", { seven: { utilization: U50, resetsInMs: DAY_MS }, lastLimit: { kind: "quota-exhausted", resetInMs: HOUR_MS, observedAgoMs: TEN_MINUTES_MS }, lastRequestAgoMs: MINUTE_MS })]);
    expect(lifted.candidates[0]?.class).toBe("scored");
  });

  it("honours a short rate limit for its retry-after", () => {
    const ranking = rank([member("a", { seven: { utilization: U10, resetsInMs: DAY_MS }, lastLimit: { kind: "rate-limited", retryAfterSeconds: TWO_MINUTES_SECONDS, observedAgoMs: HALF_MINUTE_MS } })]);
    expect(ranking.candidates[0]).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS - HALF_MINUTE_MS + TWO_MINUTES_SECONDS * MS_PER_SECOND });
  });

  it("prefers the account whose quota expires sooner over the one with more raw headroom", () => {
    const ranking = rank([member("far", { seven: { utilization: U10, resetsInMs: SIX_DAYS_MS } }), member("soon", { seven: { utilization: 0.6, resetsInMs: SIX_HOURS_MS } })]);
    expect(order(ranking)).toEqual(["soon", "far"]);
  });

  it("weights remaining quota by plan size", () => {
    const equal = { seven: { utilization: U50, resetsInMs: DAY_MS } };
    const ranking = rank([member("small", equal, MAX_5X), member("big", equal, MAX_20X)]);
    expect(order(ranking)).toEqual(["big", "small"]);
  });

  it("falls back to the full window length when a window reports no reset", () => {
    const ranking = rank([member("a", { seven: { utilization: U50 } })]);
    expect(ranking.candidates[0]?.score).toBeCloseTo((U50 * MAX_20X_CAPACITY) / SEVEN_DAYS_HOURS);
  });

  it("demotes a member whose five-hour window would run dry at its own pace, below one that would not", () => {
    const burning = member("hot", { five: { utilization: U80, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U10, resetsInMs: HOUR_MS } }, MAX_20X, [burnRecord("hot", HALF_HOUR_MS, U50, FOUR_HOURS_MS), burnRecord("hot", 0, U80, FOUR_HOURS_MS)]);
    const calm = member("calm", { five: { utilization: U10, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }, MAX_20X, [burnRecord("calm", HALF_HOUR_MS, U09, FOUR_HOURS_MS), burnRecord("calm", 0, U10, FOUR_HOURS_MS)]);
    const ranking = rank([burning, calm]);
    expect(order(ranking)).toEqual(["calm", "hot"]);
    expect(ranking.candidates[1]).toMatchObject({ feasible: false });
    expect(ranking.candidates[1]?.reasons[0]).toContain("would run dry");
  });

  it("projects a member with no readings from the pace seen on another, rescaled by plan size", () => {
    const measured = member("measured", { five: { utilization: U30, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }, MAX_5X, [burnRecord("measured", HOUR_MS, U10, FOUR_HOURS_MS), burnRecord("measured", 0, U30, FOUR_HOURS_MS)]);
    const bigFresh = member("big", { five: { utilization: 0.7, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U10, resetsInMs: SIX_DAYS_MS } }, MAX_20X);
    // measured burns 0.2 of a 5x window per hour = 1 plan unit per hour, so a 20x window burns 0.05 per hour and 0.3 left lasts 6h, past its reset in 4h.
    expect(rank([measured, bigFresh]).candidates.find((candidate) => candidate.identity === "big")?.feasible).toBe(true);
    const bigNearlyOut = member("big", { five: { utilization: 0.95, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U10, resetsInMs: SIX_DAYS_MS } }, MAX_20X);
    // 0.05 left at 0.05 per hour lasts 1h, before its reset in 4h.
    expect(rank([measured, bigNearlyOut]).candidates.find((candidate) => candidate.identity === "big")?.feasible).toBe(false);
  });

  it("keeps the directory's last pick while its prompt cache is warm, and says why", () => {
    const members = [member("old", { seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }), member("better", { seven: { utilization: U10, resetsInMs: HOUR_MS } })];
    const sticky = { identity: "old", at: at(-(PROMPT_CACHE_TTL_MS - MINUTE_MS)) };
    const ranking = rank(members, { sticky });
    expect(ranking.pick?.identity).toBe("old");
    expect(ranking.pick?.reasons[0]).toContain("prompt cache still warm");
    expect(rank(members, { sticky: { identity: "old", at: at(-(PROMPT_CACHE_TTL_MS + MINUTE_MS)) } }).pick?.identity).toBe("better");
  });

  it("keeps the last pick for a resumed conversation whatever its age", () => {
    const members = [member("old", { seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }), member("better", { seven: { utilization: U10, resetsInMs: HOUR_MS } })];
    const ranking = rank(members, { sticky: { identity: "old", at: at(-THREE_DAYS_MS) }, resuming: true });
    expect(ranking.pick?.identity).toBe("old");
    expect(ranking.pick?.reasons[0]).toContain("resuming");
  });

  it("does not keep a last pick that is refused or would run dry", () => {
    const members = [member("old", { seven: { utilization: U50, status: "rejected", resetsInMs: DAY_MS } }), member("other", { seven: { utilization: U50, resetsInMs: DAY_MS } })];
    expect(rank(members, { sticky: { identity: "old", at: at(-MINUTE_MS) } }).pick?.identity).toBe("other");
  });

  it("ranks unknown members after scored ones and pay-per-use after those, refused last, deterministically by name", () => {
    const ranking = rank([
      member("z-refused", { five: { status: "rejected", resetsInMs: HOUR_MS } }),
      member("payg", { seven: undefined, five: undefined }, "default_claude_zero"),
      member("b-unknown", undefined),
      member("a-unknown", undefined),
      member("scored", { seven: { utilization: U50, resetsInMs: DAY_MS } }),
    ]);
    expect(order(ranking)).toEqual(["scored", "a-unknown", "b-unknown", "payg", "z-refused"]);
    expect(ranking.candidates.find((candidate) => candidate.identity === "a-unknown")?.reasons[0]).toContain("trackUsage");
  });

  it("classes an account that reports no plan windows as pay-per-use, and an exhausted plan with extra usage on the same way", () => {
    const noWindows = rank([member("a", {})]);
    expect(noWindows.candidates[0]?.class).toBe("pay-per-use");
    const overage = rank([member("a", { seven: { utilization: FULL, status: "rejected", resetsInMs: DAY_MS }, overage: "allowed" })]);
    expect(overage.candidates[0]?.class).toBe("pay-per-use");
  });

  it("reports an unreadable snapshot as unknown with the reason", () => {
    const ranking = rank([{ identity: "a", records: [], readError: "schema version 2" }]);
    expect(ranking.candidates[0]).toMatchObject({ class: "unknown" });
    expect(ranking.candidates[0]?.reasons[0]).toContain("schema version 2");
  });

  it("flags a tier it did not recognise rather than silently counting it", () => {
    const ranking = rank([member("a", { seven: { utilization: U50, resetsInMs: DAY_MS } }, "default_something_new")]);
    expect(ranking.candidates[0]?.reasons.join(" ")).toContain('"default_something_new" not recognised');
  });

  it("without a preference, ranks by score even when the listed order differs", () => {
    const members = [member("far", { seven: { utilization: U10, resetsInMs: SIX_DAYS_MS } }), member("soon", { seven: { utilization: 0.6, resetsInMs: SIX_HOURS_MS } })];
    expect(order(rank(members))).toEqual(["soon", "far"]);
    expect(order(rank(members, { preference: "listed" }))).toEqual(["far", "soon"]);
  });

  it("in listed preference, keeps the members' own order whatever their class", () => {
    const ranking = rank(
      [
        member("b-unknown", undefined),
        member("payg", { seven: undefined, five: undefined }, "default_claude_zero"),
        member("scored", { seven: { utilization: U50, resetsInMs: DAY_MS } }),
      ],
      { preference: "listed" },
    );
    expect(order(ranking)).toEqual(["b-unknown", "payg", "scored"]);
    expect(ranking.pick?.identity).toBe("b-unknown");
  });

  it("in listed preference, skips a refused member and picks the next one listed", () => {
    const ranking = rank(
      [
        member("refused", { five: { status: "rejected", resetsInMs: THREE_HOURS_MS } }),
        member("next", { seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }),
        member("last", { seven: { utilization: U10, resetsInMs: HOUR_MS } }),
      ],
      { preference: "listed" },
    );
    expect(order(ranking)).toEqual(["refused", "next", "last"]);
    expect(ranking.pick?.identity).toBe("next");
  });

  it("in listed preference, keeps a member that would run dry in its listed place rather than demoting it", () => {
    const burning = member("hot", { five: { utilization: U80, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U10, resetsInMs: HOUR_MS } }, MAX_20X, [burnRecord("hot", HALF_HOUR_MS, U50, FOUR_HOURS_MS), burnRecord("hot", 0, U80, FOUR_HOURS_MS)]);
    const calm = member("calm", { five: { utilization: U10, resetsInMs: FOUR_HOURS_MS }, seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } }, MAX_20X, [burnRecord("calm", HALF_HOUR_MS, U09, FOUR_HOURS_MS), burnRecord("calm", 0, U10, FOUR_HOURS_MS)]);
    const ranking = rank([burning, calm], { preference: "listed" });
    expect(order(ranking)).toEqual(["hot", "calm"]);
    expect(ranking.pick).toMatchObject({ identity: "hot", feasible: false });
    expect(ranking.pick?.reasons[0]).toContain("would run dry");
  });

  it("in listed preference, still promotes the directory's last pick while its prompt cache is warm", () => {
    const members = [member("first", { seven: { utilization: U10, resetsInMs: HOUR_MS } }), member("old", { seven: { utilization: U90, resetsInMs: SIX_DAYS_MS } })];
    const ranking = rank(members, { preference: "listed", sticky: { identity: "old", at: at(-(PROMPT_CACHE_TTL_MS - MINUTE_MS)) } });
    expect(ranking.pick?.identity).toBe("old");
    expect(ranking.pick?.reasons[0]).toContain("prompt cache still warm");
  });

  it("in listed preference, reports the earliest return when every member is refused", () => {
    const ranking = rank([member("a", { five: { status: "rejected", resetsInMs: THREE_HOURS_MS } }), member("b", { five: { status: "rejected", resetsInMs: HOUR_MS } })], { preference: "listed" });
    expect(ranking.pick).toBeUndefined();
    expect(ranking.earliestReturn).toEqual({ identity: "b", atMs: NOW_MS + HOUR_MS });
  });

  describe("nested members", () => {
    /** A member standing for a nested pool entry that has a pick: the picked identity, re-ranked from its own snapshot with the composition in its reasons. */
    function nestedPick(pool: string, identity: string, nestedReasons: readonly string[], windows: Windows): PoolMember {
      return { ...member(identity, windows), nested: { kind: "pick", pool, reasons: nestedReasons } };
    }

    it("contributes the nested pick at its entry's position, with the composition first among its reasons", () => {
      const ranking = rank(
        [member("refused", { five: { status: "rejected", resetsInMs: THREE_HOURS_MS } }), nestedPick("fleet", "spare", ["7d 60% used", "resets in 1h"], { seven: { utilization: U60, resetsInMs: HOUR_MS } })],
        { preference: "listed" },
      );
      expect(ranking.pick).toMatchObject({ identity: "spare" });
      expect(ranking.pick?.reasons[0]).toBe('picked by pool "fleet": 7d 60% used; resets in 1h');
    });

    it("makes an entry whose nested pool is entirely refused ineligible, carrying that pool's earliest return", () => {
      const refused: PoolMember = { identity: "b", records: [], nested: { kind: "refused", pool: "fleet", earliestReturn: { identity: "b", atMs: NOW_MS + HOUR_MS } } };
      const withFallback = rank([refused, member("direct", { seven: { utilization: U50, resetsInMs: DAY_MS } })]);
      expect(withFallback.pick).toMatchObject({ identity: "direct" });
      expect(withFallback.candidates.find((candidate) => candidate.identity === "b")).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + HOUR_MS });
      expect(withFallback.candidates.find((candidate) => candidate.identity === "b")?.reasons[0]).toContain('every member of pool "fleet" is refused; b returns at');
      const alone = rank([refused]);
      expect(alone.pick).toBeUndefined();
      expect(alone.earliestReturn).toEqual({ identity: "b", atMs: NOW_MS + HOUR_MS });
    });

    it("treats a nested pick in a scored pool as one candidate, scored by its own snapshot", () => {
      const nested = nestedPick("fleet", "soon", ["7d 60% used"], { seven: { utilization: U60, resetsInMs: HOUR_MS } });
      expect(order(rank([member("far", { seven: { utilization: U10, resetsInMs: SIX_DAYS_MS } }), nested]))).toEqual(["soon", "far"]);
    });
  });
});
