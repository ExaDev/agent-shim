import { describe, expect, it } from "vitest";

import { enrichStatuslinePayload, identityOf } from "./enrich";
import type { UsageSnapshot } from "../usage/schema";

const GEMINI_WEEKLY_USED_PERCENT = 28;

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
  it("adds the identity, provider, account and binding windows under one agent_shim key", () => {
    const { payload, summary } = enrichStatuslinePayload({
      payload: { model: { display_name: "gemini-3.8-flash" } },
      env: { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: antigravity", AGENT_SHIM_PROVIDER: "Antigravity" },
      snapshot: SNAPSHOT,
      account: undefined,
      providerName: undefined,
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
    });
    expect(summary.providerPlan).toBe("max");
    expect(summary.providerQuotaWindows).toEqual([
      { measures: "tokens", utilization: 0.5, resetsAt: "2026-10-16T11:25:48.119Z" },
      { measures: "tool-calls", utilization: 0.04, resetsAt: "2026-10-21T16:29:09.983Z" },
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
    });
    expect(summary.sevenDayUsed).toBeUndefined();
    expect(summary.providerQuotaWindows).toEqual([]);
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
    });
    // The anthropic login's spent week does not become this session's usage line.
    expect(summary.sevenDayUsed).toBe(GEMINI_WEEKLY_USED_PERCENT);
    expect(summary.providerAccountEmail).toBe("ada@example.com");
  });

  it("carries identity and provider alone when there is no snapshot, and passes a non-object payload through unchanged", () => {
    const { payload, summary } = enrichStatuslinePayload({
      payload: null,
      env: { AGENT_SHIM_PROVIDER: "z.ai" },
      snapshot: undefined,
      account: undefined,
      providerName: undefined,
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
    });
    expect(summary.loginAccountEmail).toBe("work@example.com");
    expect(summary.loginRateLimitTier).toBe("claude_pro");
    expect(summary.loginOrganizationName).toBe("ExampleOrg");
    expect(summary.loginOrganizationType).toBe("claude_team");
    expect(summary.loginSeatTier).toBe("team_tier_1");
  });
});
