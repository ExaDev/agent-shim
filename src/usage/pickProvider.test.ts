import { describe, expect, it } from "vitest";

import { rankPool, type PoolMember, type RankPoolInput } from "./pick";
import type { ProviderQuota, ProviderUsageState, QuotaWindow, UsageSnapshot } from "./schema";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const FIVE_HOURS_MS = 18_000_000;
const SEVEN_DAYS_MS = 604_800_000;
const SIX_DAYS_MS = 518_400_000;
const TWO_DAYS_MS = 172_800_000;
const U10 = 0.1;
const U20 = 0.2;
const U30 = 0.3;
const U60 = 0.6;
const FULL = 1;
const MAX_20X = "default_claude_max_20x";

const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

/** The Claude account's seven-day window is spent, which is what makes the launch's other provider the thing that matters. */
const ANTHROPIC_SPENT: ProviderUsageState = {
  lastRequestAt: at(-HOUR_MS),
  rateLimit: { observedAt: at(-MINUTE_MS), headers: {}, unified: { sevenDay: { utilization: FULL, status: "rejected", resetsAt: at(TWO_DAYS_MS) } } },
};

const ANTHROPIC_OPEN: ProviderUsageState = {
  lastRequestAt: at(-HOUR_MS),
  rateLimit: { observedAt: at(-MINUTE_MS), headers: {}, unified: { sevenDay: { utilization: U10, resetsAt: at(SIX_DAYS_MS) } } },
};

function window(utilization: number, resetsInMs: number, status?: string): QuotaWindow {
  return { utilization, resetsAt: at(resetsInMs), ...(status === undefined ? {} : { status }) };
}

/** A provider slice that reports its windows the way the front door's header translation does: as unified rate-limit state. */
function headerSlice(windows: { readonly five?: QuotaWindow; readonly seven?: QuotaWindow }): ProviderUsageState {
  return {
    lastRequestAt: at(-HOUR_MS),
    rateLimit: { observedAt: at(-MINUTE_MS), headers: {}, unified: { ...(windows.five === undefined ? {} : { fiveHour: windows.five }), ...(windows.seven === undefined ? {} : { sevenDay: windows.seven }) } },
  };
}

/** A provider slice that reports only what its usage endpoint pulled: quota windows by length, no rate-limit headers. */
function quotaSlice(windows: ProviderQuota["windows"], level?: string): ProviderUsageState {
  return { quota: { observedAt: at(-MINUTE_MS), source: "test endpoint", ...(level === undefined ? {} : { level }), windows } };
}

function snapshotOf(identity: string, providers: Readonly<Record<string, ProviderUsageState>>): UsageSnapshot {
  return { schemaVersion: 1, identity, updatedAt: at(-MINUTE_MS), account: { organizationRateLimitTier: MAX_20X }, providers };
}

function member(identity: string, providers: Readonly<Record<string, ProviderUsageState>>, provider?: string): PoolMember {
  return { identity, records: [], account: { organizationRateLimitTier: MAX_20X }, snapshot: snapshotOf(identity, providers), ...(provider === undefined ? {} : { provider }) };
}

function rank(members: readonly PoolMember[], extra: Partial<RankPoolInput> = {}): ReturnType<typeof rankPool> {
  return rankPool({ members, nowMs: NOW_MS, resuming: false, ...extra });
}

const candidateOf = (ranking: ReturnType<typeof rankPool>, identity: string): NonNullable<ReturnType<typeof rankPool>["pick"]> => {
  const candidate = ranking.candidates.find((entry) => entry.identity === identity);
  if (candidate === undefined) {
    throw new Error(`no candidate ${identity}`);
  }
  return candidate;
};

describe("ranking a pool for a launch through a provider", () => {
  it("scores a member on the provider's open windows although its Claude account's week is spent", () => {
    const open = headerSlice({ seven: window(U20, SIX_DAYS_MS) });
    const ranking = rank([member("a", { anthropic: ANTHROPIC_SPENT, p: open }, "p"), member("b", { anthropic: ANTHROPIC_SPENT, p: open }, "p")]);
    expect(ranking.pick).toBeDefined();
    expect(candidateOf(ranking, "a")).toMatchObject({ class: "scored", provider: "p" });
    expect(candidateOf(ranking, "a").reasons.join("\n")).toContain("7d 20% used");
  });

  it("still refuses the same members when the launch uses the Claude account", () => {
    const open = headerSlice({ seven: window(U20, SIX_DAYS_MS) });
    const ranking = rank([member("a", { anthropic: ANTHROPIC_SPENT, p: open }), member("b", { anthropic: ANTHROPIC_SPENT, p: open })]);
    expect(ranking.pick).toBeUndefined();
    expect(ranking.earliestReturn?.atMs).toBe(NOW_MS + TWO_DAYS_MS);
    expect(candidateOf(ranking, "a")).toMatchObject({ class: "ineligible" });
    expect(candidateOf(ranking, "a").provider).toBeUndefined();
  });

  it("refuses a member whose provider's own window is rejected, whatever its Claude account has left", () => {
    const spent = headerSlice({ five: window(FULL, HOUR_MS, "rejected") });
    const ranking = rank([member("a", { anthropic: ANTHROPIC_OPEN, p: spent }, "p"), member("b", { anthropic: ANTHROPIC_OPEN, p: headerSlice({ seven: window(U30, SIX_DAYS_MS) }) }, "p")]);
    expect(candidateOf(ranking, "a")).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + HOUR_MS, provider: "p" });
    expect(ranking.pick?.identity).toBe("b");
  });

  it("refuses a member for the refusal its provider last answered with while that still binds, when the provider reports no windows", () => {
    const refused: ProviderUsageState = {
      lastRequestAt: at(-HOUR_MS),
      lastLimit: { kind: "quota-exhausted", evidence: [], observedAt: at(-MINUTE_MS), status: 429, resetAt: at(HOUR_MS) },
    };
    const ranking = rank([member("a", { anthropic: ANTHROPIC_OPEN, p: refused }, "p")]);
    expect(candidateOf(ranking, "a")).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + HOUR_MS });
    expect(ranking.pick).toBeUndefined();
  });

  it("ranks a member with no reading for the provider as unknown, never refused on its Claude account's windows", () => {
    const ranking = rank([member("a", { anthropic: ANTHROPIC_SPENT }, "p"), member("never", { anthropic: ANTHROPIC_SPENT, p: { lastRequestAt: at(-HOUR_MS) } }, "p")]);
    expect(candidateOf(ranking, "a")).toMatchObject({ class: "unknown", provider: "p" });
    expect(candidateOf(ranking, "a").reasons.join("\n")).toContain("provider p");
    expect(candidateOf(ranking, "never")).toMatchObject({ class: "unknown" });
    expect(ranking.pick).toBeDefined();
  });

  it("ranks a member with no snapshot at all as unknown for a provider launch", () => {
    const ranking = rank([{ identity: "fresh", records: [], provider: "p" }]);
    expect(ranking.pick).toMatchObject({ identity: "fresh", class: "unknown" });
  });

  it("assesses each member against its own provider's slice when their defaults differ", () => {
    const ranking = rank([
      member("viaP1", { anthropic: ANTHROPIC_SPENT, p1: headerSlice({ seven: window(U20, SIX_DAYS_MS) }), p2: headerSlice({ seven: window(FULL, TWO_DAYS_MS, "rejected") }) }, "p1"),
      member("viaClaude", { anthropic: ANTHROPIC_SPENT, p1: headerSlice({ seven: window(U20, SIX_DAYS_MS) }) }),
      member("viaP2", { anthropic: ANTHROPIC_OPEN, p1: headerSlice({ seven: window(U20, SIX_DAYS_MS) }), p2: headerSlice({ seven: window(FULL, TWO_DAYS_MS, "rejected") }) }, "p2"),
    ]);
    expect(candidateOf(ranking, "viaP1")).toMatchObject({ class: "scored", provider: "p1" });
    expect(candidateOf(ranking, "viaClaude")).toMatchObject({ class: "ineligible" });
    expect(candidateOf(ranking, "viaP2")).toMatchObject({ class: "ineligible", provider: "p2" });
    expect(ranking.pick?.identity).toBe("viaP1");
  });

  it("reads the provider's pulled quota windows by length when it records no rate-limit headers", () => {
    const pulled = quotaSlice([
      { measures: "gemini-5h", periodMs: FIVE_HOURS_MS, utilization: U30, resetsAt: at(HOUR_MS) },
      { measures: "gemini-weekly", periodMs: SEVEN_DAYS_MS, utilization: U60, resetsAt: at(SIX_DAYS_MS) },
    ]);
    const candidate = candidateOf(rank([member("a", { anthropic: ANTHROPIC_SPENT, p: pulled }, "p")]), "a");
    expect(candidate).toMatchObject({ class: "scored", scoreWindow: "sevenDay" });
    expect(candidate.reasons.join("\n")).toContain("7d 60% used");
    expect(candidate.reasons.join("\n")).toContain("5h 30% used");
  });

  it("refuses a member whose pulled provider window is fully used until it resets", () => {
    const pulled = quotaSlice([{ measures: "gemini-5h", periodMs: FIVE_HOURS_MS, utilization: FULL, resetsAt: at(HOUR_MS) }]);
    expect(candidateOf(rank([member("a", { anthropic: ANTHROPIC_OPEN, p: pulled }, "p")]), "a")).toMatchObject({ class: "ineligible", blockedUntilMs: NOW_MS + HOUR_MS });
  });

  it("ranks a member whose pulled windows have no length it knows as unknown", () => {
    const pulled = quotaSlice([{ measures: "credits", period: "prepaid", utilization: U30 }]);
    expect(candidateOf(rank([member("a", { anthropic: ANTHROPIC_SPENT, p: pulled }, "p")]), "a")).toMatchObject({ class: "unknown" });
  });

  it("takes the plan's size from the provider's own quota level, never from the Claude login's tier", () => {
    const slice = (level?: string): ProviderUsageState => ({ ...headerSlice({ seven: window(U20, SIX_DAYS_MS) }), quota: { observedAt: at(-MINUTE_MS), source: "test endpoint", ...(level === undefined ? {} : { level }), windows: [] } });
    const plain = candidateOf(rank([member("a", { anthropic: ANTHROPIC_OPEN, p: slice("Studio") }, "p")]), "a");
    expect(plain.plan).toEqual({ kind: "subscription", capacity: 1, recognised: false, tier: "Studio" });
    expect(plain.reasons.join("\n")).toContain('plan tier "Studio" not recognised, counted as 1x');
    const sized = candidateOf(rank([member("a", { anthropic: ANTHROPIC_OPEN, p: slice("max_5x") }, "p")]), "a");
    expect(sized.plan).toMatchObject({ kind: "subscription", capacity: 5, recognised: true });
    const unlevelled = candidateOf(rank([member("a", { anthropic: ANTHROPIC_OPEN, p: slice() }, "p")]), "a");
    expect(unlevelled.plan).toMatchObject({ kind: "subscription", capacity: 1, recognised: false });
  });

  it("weighs a provider member's score by the provider's plan, so a larger plan with the same use ranks first", () => {
    const base = headerSlice({ seven: window(U20, SIX_DAYS_MS) });
    const big: ProviderUsageState = { ...base, quota: { observedAt: at(-MINUTE_MS), source: "test endpoint", level: "pro_5x", windows: [] } };
    const small: ProviderUsageState = { ...base, quota: { observedAt: at(-MINUTE_MS), source: "test endpoint", level: "free", windows: [] } };
    const ranking = rank([member("small", { p: small }, "p"), member("big", { p: big }, "p")]);
    expect(ranking.candidates.map((candidate) => candidate.identity)).toEqual(["big", "small"]);
  });

  it("keeps the member last picked while it serves on the provider's quota and its prompt cache is warm", () => {
    const open = headerSlice({ seven: window(U20, SIX_DAYS_MS) });
    const fresh = headerSlice({ seven: window(U10, HOUR_MS) });
    const members = [member("a", { p: fresh }, "p"), member("b", { p: open }, "p")];
    expect(rank(members).pick?.identity).toBe("a");
    const sticky = rank(members, { sticky: { identity: "b", at: at(-MINUTE_MS) } });
    expect(sticky.pick?.identity).toBe("b");
    expect(sticky.pick?.reasons[0]).toContain("prompt cache still warm");
  });

  it("orders provider members as listed when the pool prefers it, skipping only a member refused on the provider's slice", () => {
    const refused = headerSlice({ seven: window(FULL, TWO_DAYS_MS, "rejected") });
    const open = headerSlice({ seven: window(U10, SIX_DAYS_MS) });
    const members = [member("first", { anthropic: ANTHROPIC_OPEN, p: refused }, "p"), member("second", { anthropic: ANTHROPIC_SPENT, p: open }, "p"), member("third", { p: open }, "p")];
    const ranking = rank(members, { preference: "listed" });
    expect(ranking.candidates.map((candidate) => candidate.identity)).toEqual(["first", "second", "third"]);
    expect(ranking.pick?.identity).toBe("second");
  });
});
