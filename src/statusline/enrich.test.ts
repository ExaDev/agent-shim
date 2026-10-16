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
    });
    expect(payload).toEqual({ model: { display_name: "gemini-3.8-flash" }, agent_shim: summary });
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
    });
    expect(payload).toBeNull();
    expect(summary.identity).toBeUndefined();
    expect(summary.provider).toBe("z.ai");
    expect(summary.fiveHourUsed).toBeUndefined();
  });
});
