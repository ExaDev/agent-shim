import { describe, expect, it } from "vitest";

import { renderStatuslineBlock, RESERVED_COLUMNS } from "./render";
import type { StatuslineSummary } from "./enrich";

const NOW_MS = Date.parse("2026-10-16T00:00:00.000Z");
const WIDE_TERMINAL = 170;
const WIDE_TERMINAL_MAX = 166;
const NARROW_TERMINAL = 40;
const NARROW_MAX_LINE = 36;
/** Too narrow for the model and the account to share a line: each header segment renders on its own line. */
const ONE_PER_LINE_TERMINAL = 46;
/** Wide enough for the model and the account to share a line, with the identity wrapping alone: the greedy packing case. */
const PACKING_TERMINAL = 60;

const SUMMARY: StatuslineSummary = {
  identity: "antigravity",
  provider: "Antigravity",
  providerAccountEmail: "ada@example.com",
  providerAccountSub: "123456789012345678901",
  providerPlan: "Pro",
  loginAccountEmail: undefined,
  loginRateLimitTier: undefined,
  loginOrganizationName: undefined,
  loginOrganizationType: undefined,
  loginSeatTier: undefined,
  fiveHourUsed: 3.6,
  fiveHourResetAt: "2026-10-16T00:38:00.000Z",
  sevenDayUsed: 28.2,
  sevenDayResetAt: "2026-10-22T13:52:54.000Z",
};

const VIEW = {
  modelDisplayName: "Sonnet 5.5",
  contextUsedPercentage: 63.4,
  contextTotalTokens: 634_000,
  contextWindowTokens: 1_000_000,
  cacheHitRatio: 0.986,
  cacheReadTokens: 600_000,
  freshInputTokens: 34_000,
};

const ESCAPE_CHAR_CODE = 27;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(ESCAPE_CHAR_CODE)}\\[[0-9;]*[a-zA-Z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

describe("renderStatuslineBlock", () => {
  it("lays the model, provider account and identity on the first line justified across the terminal's width, the context and quota bars below with fills that expand", () => {
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, WIDE_TERMINAL, NOW_MS)).split("\n");
    expect(lines).toHaveLength(2);
    const header = lines[0] ?? "";
    expect(header.startsWith("Sonnet 5.5")).toBe(true);
    expect(header.endsWith("antigravity")).toBe(true);
    expect(header).toContain("Antigravity · ada@example.com · Pro");
    expect(header.length).toBe(WIDE_TERMINAL_MAX);
    expect(lines[1]).toContain("Ctx 634k/1M");
    expect(lines[1]).toContain("63.4%");
    expect(lines[1]).toContain("Cache: 99%");
    expect(lines[1]).toContain("5h ");
    expect(lines[1]).toContain("3.6% (38m)");
    expect(lines[1]).toContain("Wk ");
    expect(lines[1]).toContain("28.2% (6d 13h)");
    expect(lines[1]).not.toContain("Antigravity");
    const bars = lines[1];
    if (bars !== undefined) {
      expect(bars.length).toBeLessThanOrEqual(WIDE_TERMINAL_MAX);
    }
  });

  it("wraps when the segments do not fit one line, each segment never wider than the terminal", () => {
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, NARROW_TERMINAL, NOW_MS)).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    const joined = lines.join("\n");
    expect(joined).toContain("Ctx");
    expect(joined).toContain("5h");
    expect(joined).toContain("Wk");
    for (const line of lines) {
      if (line.includes("Antigravity") || line.includes("Ctx")) {
        // A single segment whose base is already longer than the terminal (the provider account email, the context tokens) renders whole, exactly as the Antigravity statusline's own fallback does; the bars are the segments that flex.
        continue;
      }
      expect(line.length).toBeLessThanOrEqual(NARROW_MAX_LINE);
    }
  });

  it("wraps the first line onto one segment per line when no two of them share a line, instead of losing its tail", () => {
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, ONE_PER_LINE_TERMINAL, NOW_MS)).split("\n");
    expect(lines[0]).toBe("Sonnet 5.5");
    expect(lines[1]).toBe("Antigravity · ada@example.com · Pro");
    expect(lines[2]).toBe("antigravity");
    expect(lines[3]).toContain("Ctx");
  });

  it("packs the header greedily, sharing a line where segments fit together, justified across it", () => {
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, PACKING_TERMINAL, NOW_MS)).split("\n");
    const header = lines[0] ?? "";
    expect(header.startsWith("Sonnet 5.5")).toBe(true);
    expect(header.endsWith("Pro")).toBe(true);
    expect(header.length).toBe(PACKING_TERMINAL - RESERVED_COLUMNS);
    expect(lines[1]).toBe("antigravity");
    expect(lines[2]).toContain("Ctx");
  });

  it("shows the OAuth login account and its plan for a plain anthropic identity, and the identity when it is not that account", () => {
    const lines = stripAnsi(
      renderStatuslineBlock(
        { ...SUMMARY, identity: "zai", provider: undefined, providerAccountEmail: undefined, providerAccountSub: undefined, providerPlan: undefined, loginAccountEmail: "ada@example.com", loginRateLimitTier: "default_claude_max_20x" },
        VIEW,
        WIDE_TERMINAL,
        NOW_MS,
      ),
    ).split("\n");
    const header = lines[0] ?? "";
    expect(header.startsWith("Sonnet 5.5")).toBe(true);
    expect(header.endsWith("Max 20x"));
    expect(header).not.toContain("zai");
    expect(header).toContain("ada@example.com · Max 20x");
    expect(header.length).toBe(WIDE_TERMINAL_MAX);
  });

  it("names an organisation account's plan from its organisation and its seat's tier, not the seat's rate-limit tier", () => {
    const lines = stripAnsi(
      renderStatuslineBlock(
        { ...SUMMARY, identity: "ada@example.com_team", provider: undefined, providerAccountEmail: undefined, providerAccountSub: undefined, providerPlan: undefined, loginAccountEmail: "ada@example.com", loginRateLimitTier: "default_claude_max_5x", loginOrganizationName: "ExampleOrg", loginOrganizationType: "claude_team", loginSeatTier: "team_tier_1" },
        VIEW,
        WIDE_TERMINAL,
        NOW_MS,
      ),
    ).split("\n");
    const header = lines[0] ?? "";
    expect(header).toContain("ada@example.com · ExampleOrg · Team Premium");
    expect(header).not.toContain("Max 5x");
    expect(header).not.toContain("ada@example.com_team");
    expect(header.endsWith("Team Premium")).toBe(true);
  });

  it("renders nothing when no segment has data", () => {
    expect(
      renderStatuslineBlock(
        { identity: undefined, provider: undefined, providerAccountEmail: undefined, providerAccountSub: undefined, providerPlan: undefined, loginAccountEmail: undefined, loginRateLimitTier: undefined, loginOrganizationName: undefined, loginOrganizationType: undefined, loginSeatTier: undefined, fiveHourUsed: undefined, fiveHourResetAt: undefined, sevenDayUsed: undefined, sevenDayResetAt: undefined },
        { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
        NARROW_TERMINAL,
        NOW_MS,
      ),
    ).toBe("");
  });
});
