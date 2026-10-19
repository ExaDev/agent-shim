import { describe, expect, it } from "vitest";

import { enrichStatuslinePayload, identityOf } from "./enrich";
import type { UsageSnapshot } from "../usage/schema";

const NOW_MS = Date.parse("2026-10-15T18:00:00.000Z");
const GEMINI_WEEKLY_USED_PERCENT = 28;
const GEMINI_FIVE_HOUR_USED_PERCENT = 9;
const ANTIGRAVITY_FIVE_HOUR_USED_PERCENT = 20;
const ANTIGRAVITY_WEEKLY_USED_PERCENT = 5;
const FLOAT_PRECISION_DIGITS = 10;
const THIRD_PARTY_WEEKLY_REMAINING = 0.985;
const THIRD_PARTY_WEEKLY_USED = 1 - THIRD_PARTY_WEEKLY_REMAINING;
const ARGON_RESET_SECONDS = 7200;
const LIVE_FIVE_HOUR_USED_PERCENT = 5;
const LIVE_SEVEN_DAY_USED_PERCENT = 34;
const NO_RESET_FIVE_HOUR_USED_PERCENT = 40;
const GEMINI_FIVE_HOUR_RESET_SECONDS = 9000;
const GEMINI_WEEKLY_RESET_SECONDS = 500_000;
const MS_PER_SECOND = 1000;
const PAYLOAD_FIVE_HOUR_USED_PERCENT = 23.5;
const PAYLOAD_SEVEN_DAY_USED_PERCENT = 41.2;
const PAYLOAD_PARTIAL_FIVE_HOUR_USED_PERCENT = 7;

const SNAPSHOT = {
  schemaVersion: 1,
  identity: "antigravity",
  updatedAt: "2026-10-15T20:07:50.836Z",
  providers: {
    anthropic: { rateLimit: { unified: { fiveHour: { utilization: 0.03, resetsAt: "2026-10-15T18:52:54.000Z" }, sevenDay: { utilization: 0.02, resetsAt: "2026-10-22T13:52:54.000Z" } } } },
    antigravity: {
      rateLimit: { unified: { fiveHour: { utilization: 0.094, resetsAt: "2026-10-15T20:45:00.000Z" }, sevenDay: { utilization: 0.282, resetsAt: "2026-10-22T13:52:54.000Z" } } },
      quota: { level: "Pro", account: { email: "ada@example.com", accountId: "123456789012345678901" } },
    },
  },
} as unknown as UsageSnapshot;

describe("identityOf", () => {
  it("reads the identity from the launcher's custom-header environment entry", () => {
    expect(identityOf({ ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: zai" })).toBe("zai");
  });

  it("derives it from the config directory a launch pins, whose parent is the identities directory", () => {
    expect(identityOf({ CLAUDE_CONFIG_DIR: "/root/identities/antigravity" })).toBe("antigravity");
    expect(identityOf({ CLAUDE_CONFIG_DIR: "/home/joe/.claude" })).toBeUndefined();
    expect(identityOf({})).toBeUndefined();
  });
});

describe("enrichStatuslinePayload", () => {
  it("carries every model family's window from the Antigravity CLI's quota map, labelled and in a fixed order", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {
        model: { id: "gemini-3.8-flash-medium" },
        quota: {
          "3p-weekly": { remaining_fraction: THIRD_PARTY_WEEKLY_REMAINING, reset_in_seconds: 3600 },
          "gemini-5h": { remaining_fraction: 0, reset_in_seconds: 60 },
          "gemini-argon-wtu-weekly": { remaining_fraction: 0.75, reset_in_seconds: ARGON_RESET_SECONDS },
        },
      },
      env: {},
      snapshot: undefined,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.quotaFamilies.map((window) => window.measures)).toEqual(["Gem 5h", "3P Wk", "Argon Wk"]);
    expect(summary.quotaFamilies[0]?.utilization).toBe(1);
    expect(summary.quotaFamilies[1]?.utilization).toBeCloseTo(THIRD_PARTY_WEEKLY_USED, FLOAT_PRECISION_DIGITS);
    expect(summary.quotaFamilies[2]?.resetsAt).toBe(new Date(NOW_MS + ARGON_RESET_SECONDS * MS_PER_SECOND).toISOString());
  });

  it("carries every family's window for a session on an Antigravity provider, from the snapshot's bucket windows", () => {
    const snapshot = {
      schemaVersion: 1,
      identity: "antigravity",
      updatedAt: "2026-10-15T20:07:50.836Z",
      providers: {
        antigravity: {
          quota: { windows: [{ measures: "gemini-weekly", utilization: 0.28, resetsAt: "2026-10-22T00:00:00.000Z" }, { measures: "3p-5h", utilization: 0.01, resetsAt: "2026-10-16T03:00:00.000Z" }] },
        },
      },
    } as unknown as UsageSnapshot;
    const { summary } = enrichStatuslinePayload({ payload: {}, env: { AGENT_SHIM_PROVIDER: "Antigravity" }, snapshot, account: undefined, providerName: "antigravity", nowMs: NOW_MS, headroom: undefined });
    expect(summary.quotaFamilies.map((window) => window.measures)).toEqual(["Gem Wk", "3P 5h"]);
  });

  it("adds the identity, provider, account and binding windows under one agent_shim key", () => {
    const { payload, summary } = enrichStatuslinePayload({
      payload: { model: { display_name: "gemini-3.8-flash" } },
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: antigravity", AGENT_SHIM_PROVIDER: "Antigravity" },
      snapshot: SNAPSHOT,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary).toEqual({
      identity: "antigravity",
      provider: "Antigravity",
      providerAccountEmail: "ada@example.com",
      providerAccountSub: "123456789012345678901",
      providerPlan: "Pro",
      fiveHourUsed: 9,
      fiveHourResetAt: "2026-10-15T20:45:00.000Z",
      sevenDayUsed: 28,
      sevenDayResetAt: "2026-10-22T13:52:54.000Z",
      providerQuotaWindows: [],
      quotaFamilies: [],
    });
    expect(payload).toEqual({ model: { display_name: "gemini-3.8-flash" }, agent_shim: summary });
  });

  it("resolves a provider session by its registered name when the display name differs, and draws that provider's own quota windows", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {},
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: zai", AGENT_SHIM_PROVIDER: "z.ai" },
      snapshot: {
        ...SNAPSHOT,
        providers: {
          anthropic: { rateLimit: { unified: { fiveHour: { utilization: 0, resetsAt: "2026-10-16T11:00:00.000Z" }, sevenDay: { utilization: 1, resetsAt: "2026-10-16T21:59:59.000Z" } } } },
          z: {
            quota: {
              level: "max",
              windows: [
                { measures: "tool-calls", periodMs: 2_592_000_000, utilization: 0.04, resetsAt: "2026-10-21T16:29:09.983Z" },
                { measures: "tokens", periodMs: 18_000_000, utilization: 0.5, resetsAt: "2026-10-16T11:25:48.119Z" },
              ],
            },
          },
        },
      } as unknown as UsageSnapshot,
      account: undefined,
      providerName: "z",
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.providerPlan).toBe("max");
    expect(summary.providerQuotaWindows).toEqual([
      { measures: "tokens", utilization: 0.5, resetsAt: "2026-10-16T11:25:48.119Z", periodMs: 18_000_000 },
      { measures: "tool-calls", utilization: 0.04, resetsAt: "2026-10-21T16:29:09.983Z", periodMs: 2_592_000_000 },
    ]);
    // The anthropic login's exhausted week is not this session's usage.
    expect(summary.sevenDayUsed).toBeUndefined();
  });

  it("shows no windows for a provider session whose provider has no state yet, never another provider's", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {},
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: zai", AGENT_SHIM_PROVIDER: "z.ai" },
      snapshot: {
        ...SNAPSHOT,
        providers: { anthropic: { rateLimit: { unified: { sevenDay: { utilization: 1, resetsAt: "2026-10-16T21:59:59.000Z" } } } } },
      } as unknown as UsageSnapshot,
      account: undefined,
      providerName: "z",
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.sevenDayUsed).toBeUndefined();
    expect(summary.providerQuotaWindows).toEqual([]);
  });

  it("ignores a window whose reset has passed, so a stale reading from another provider cannot outrank the live one", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {},
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: zai" },
      snapshot: {
        ...SNAPSHOT,
        providers: {
          anthropic: { rateLimit: { unified: { fiveHour: { utilization: 0.05, resetsAt: "2026-10-15T22:00:00.000Z" }, sevenDay: { utilization: 0.34, resetsAt: "2026-10-20T00:00:00.000Z" } } } },
          other: { rateLimit: { unified: { fiveHour: { utilization: 0.9, resetsAt: "2026-10-15T17:00:00.000Z" }, sevenDay: { utilization: 0.95, resetsAt: "2026-10-15T17:30:00.000Z" } } } },
        },
      } as unknown as UsageSnapshot,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.fiveHourUsed).toBe(LIVE_FIVE_HOUR_USED_PERCENT);
    expect(summary.fiveHourResetAt).toBe("2026-10-15T22:00:00.000Z");
    expect(summary.sevenDayUsed).toBe(LIVE_SEVEN_DAY_USED_PERCENT);
    expect(summary.sevenDayResetAt).toBe("2026-10-20T00:00:00.000Z");
  });

  it("keeps a window that reports no reset, and shows none when every reading has expired", () => {
    const summaryOf = (providers: unknown) =>
      enrichStatuslinePayload({
        payload: {},
        env: {},
        snapshot: { ...SNAPSHOT, providers } as unknown as UsageSnapshot,
        account: undefined,
        providerName: undefined,
        nowMs: NOW_MS,
        headroom: undefined,
      }).summary;
    expect(summaryOf({ anthropic: { rateLimit: { unified: { fiveHour: { utilization: 0.4 } } } } }).fiveHourUsed).toBe(NO_RESET_FIVE_HOUR_USED_PERCENT);
    const expired = summaryOf({ anthropic: { rateLimit: { unified: { fiveHour: { utilization: 1, resetsAt: "2026-10-15T17:59:59.000Z" } } } } });
    expect(expired.fiveHourUsed).toBeUndefined();
    expect(expired.fiveHourResetAt).toBeUndefined();
  });

  it("scopes a provider session's windows to that provider, leaving the login account's out of the main line", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {},
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: antigravity", AGENT_SHIM_PROVIDER: "Antigravity" },
      snapshot: {
        ...SNAPSHOT,
        providers: {
          ...SNAPSHOT.providers,
          anthropic: { rateLimit: { unified: { fiveHour: { utilization: 0.81, resetsAt: "2026-10-15T21:00:00.000Z" }, sevenDay: { utilization: 1, resetsAt: "2026-10-16T21:59:59.000Z" } } } },
        },
      } as unknown as UsageSnapshot,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    // The anthropic login's spent week does not become this session's usage line.
    expect(summary.sevenDayUsed).toBe(GEMINI_WEEKLY_USED_PERCENT);
    expect(summary.providerAccountEmail).toBe("ada@example.com");
  });

  it("takes a providerless session's windows from the client's own rate_limits payload, with no snapshot or door behind it", () => {
    const { summary } = enrichStatuslinePayload({
      payload: { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 }, seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 } } },
      env: {},
      snapshot: undefined,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.fiveHourUsed).toBe(PAYLOAD_FIVE_HOUR_USED_PERCENT);
    expect(summary.fiveHourResetAt).toBe("2025-02-01T16:00:00.000Z");
    expect(summary.sevenDayUsed).toBe(PAYLOAD_SEVEN_DAY_USED_PERCENT);
    expect(summary.sevenDayResetAt).toBe("2025-02-06T16:00:00.000Z");
  });

  it("lets the payload's present window replace the snapshot's and keeps the snapshot's for a window the payload lacks", () => {
    const { summary } = enrichStatuslinePayload({
      payload: { rate_limits: { five_hour: { used_percentage: 7, resets_at: 1_738_425_600 } } },
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: antigravity" },
      snapshot: SNAPSHOT,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.fiveHourUsed).toBe(PAYLOAD_PARTIAL_FIVE_HOUR_USED_PERCENT);
    // The snapshot's binding weekly window stands, the payload having none.
    expect(summary.sevenDayUsed).toBe(GEMINI_WEEKLY_USED_PERCENT);
  });

  it("ignores the payload's windows for a provider session, which spends the provider's quota rather than the login's", () => {
    const { summary } = enrichStatuslinePayload({
      payload: { rate_limits: { five_hour: { used_percentage: 99, resets_at: 1_738_425_600 } } },
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: antigravity", AGENT_SHIM_PROVIDER: "Antigravity" },
      snapshot: SNAPSHOT,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.fiveHourUsed).toBe(GEMINI_FIVE_HOUR_USED_PERCENT);
  });

  it("takes the Antigravity CLI's windows from its quota map, the model's own buckets, as the fraction used", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {
        model: { id: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash" },
        quota: {
          "gemini-5h": { remaining_fraction: 0.8, reset_in_seconds: GEMINI_FIVE_HOUR_RESET_SECONDS },
          "gemini-weekly": { remaining_fraction: 0.95, reset_in_seconds: GEMINI_WEEKLY_RESET_SECONDS },
          "3p-5h": { remaining_fraction: 0.1, reset_in_seconds: 100 },
        },
      },
      env: {},
      snapshot: undefined,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.fiveHourUsed).toBeCloseTo(ANTIGRAVITY_FIVE_HOUR_USED_PERCENT, FLOAT_PRECISION_DIGITS);
    expect(summary.fiveHourResetAt).toBe(new Date(NOW_MS + GEMINI_FIVE_HOUR_RESET_SECONDS * MS_PER_SECOND).toISOString());
    expect(summary.sevenDayUsed).toBeCloseTo(ANTIGRAVITY_WEEKLY_USED_PERCENT, FLOAT_PRECISION_DIGITS);
    expect(summary.sevenDayResetAt).toBe(new Date(NOW_MS + GEMINI_WEEKLY_RESET_SECONDS * MS_PER_SECOND).toISOString());
  });

  it("shows the account a client states for itself, never the Claude profile file read for a session outside agent-shim", () => {
    const { summary } = enrichStatuslinePayload({
      payload: { email: "ada@example.com", plan_tier: "Google AI Pro" },
      env: {},
      snapshot: undefined,
      account: { emailAddress: "claude-login@example.com", organizationType: "claude_max", userRateLimitTier: "default_claude_max_20x" },
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.loginAccountEmail).toBe("ada@example.com");
    expect(summary.loginPlan).toBe("Google AI Pro");
    expect(summary.loginRateLimitTier).toBeUndefined();
    expect(summary.loginOrganizationType).toBeUndefined();
  });

  it("carries identity and provider alone when there is no snapshot, and passes a non-object payload through unchanged", () => {
    const { payload, summary } = enrichStatuslinePayload({
      payload: null,
      env: { AGENT_SHIM_PROVIDER: "z.ai" },
      snapshot: undefined,
      account: undefined,
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(payload).toBeNull();
    expect(summary.identity).toBeUndefined();
    expect(summary.provider).toBe("z.ai");
    expect(summary.fiveHourUsed).toBeUndefined();
  });

  it("carries the identity's own OAuth login account beside the provider's, preferring the user's rate-limit tier", () => {
    const { summary } = enrichStatuslinePayload({
      payload: {},
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: work", AGENT_SHIM_PROVIDER: "Antigravity" },
      snapshot: SNAPSHOT,
      account: { emailAddress: "work@example.com", organizationName: "ExampleOrg", organizationType: "claude_team", seatTier: "team_tier_1", organizationRateLimitTier: "default_claude_max_5x", userRateLimitTier: "claude_pro" },
      providerName: undefined,
      nowMs: NOW_MS,
      headroom: undefined,
    });
    expect(summary.loginAccountEmail).toBe("work@example.com");
    expect(summary.loginRateLimitTier).toBe("claude_pro");
    expect(summary.loginOrganizationName).toBe("ExampleOrg");
    expect(summary.loginOrganizationType).toBe("claude_team");
    expect(summary.loginSeatTier).toBe("team_tier_1");
  });
});

describe("a model choice among alternatives", () => {
  it("threads the choice through to the summary and the enriched payload", () => {
    const modelChoice = { requested: "auto", served: "glm-5.3", provider: "z", providers: ["z", "antigravity"] };
    const { payload, summary } = enrichStatuslinePayload({ payload: {}, env: {}, snapshot: undefined, account: undefined, providerName: undefined, nowMs: NOW_MS, headroom: undefined, modelChoice });
    expect(summary.modelChoice).toEqual(modelChoice);
    const enriched = payload as { agent_shim?: { modelChoice?: unknown } };
    expect(enriched.agent_shim?.modelChoice).toEqual(modelChoice);
  });
});
