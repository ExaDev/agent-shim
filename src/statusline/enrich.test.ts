import { describe, expect, it } from "vitest";

import { enrichStatuslinePayload, identityOf } from "./enrich";
import type { UsageSnapshot } from "../usage/schema";

const SNAPSHOT = {
  schemaVersion: 1,
  identity: "antigravity",
  updatedAt: "2026-10-15T20:07:50.836Z",
  providers: {
    anthropic: { rateLimit: { unified: { fiveHour: { utilization: 3, resetsAt: "2026-10-15T18:52:54.000Z" }, sevenDay: { utilization: 2, resetsAt: "2026-10-22T13:52:54.000Z" } } } },
    antigravity: {
      rateLimit: { unified: { fiveHour: { utilization: 9, resetsAt: "2026-10-15T20:45:00.000Z" }, sevenDay: { utilization: 28, resetsAt: "2026-10-22T13:52:54.000Z" } } },
      quota: { account: { email: "ada@example.com", accountId: "123456789012345678901" } },
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
      fiveHourUsed: 9,
      fiveHourResetAt: "2026-10-15T20:45:00.000Z",
      sevenDayUsed: 28,
      sevenDayResetAt: "2026-10-22T13:52:54.000Z",
    });
    expect(payload).toEqual({ model: { display_name: "gemini-3.8-flash" }, agent_shim: summary });
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
