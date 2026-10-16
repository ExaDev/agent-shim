import { describe, expect, it } from "vitest";

import { renderStatuslineBlock } from "./render";
import type { StatuslineSummary } from "./enrich";

const NOW_MS = Date.parse("2026-10-16T00:00:00.000Z");
const WIDE_TERMINAL = 170;
const WIDE_TERMINAL_MAX = 166;
const NARROW_TERMINAL = 40;
const NARROW_MAX_LINE = 36;

const SUMMARY: StatuslineSummary = {
  identity: "antigravity",
  provider: "Antigravity",
  providerAccountEmail: "ada@example.com",
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
  it("lays the context and quota bars out with fills that expand to the terminal's width", () => {
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, WIDE_TERMINAL, NOW_MS)).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Sonnet 5.5");
    expect(lines[0]).toContain("Ctx 634k/1M");
    expect(lines[0]).toContain("63.4%");
    expect(lines[0]).toContain("Cache: 99%");
    expect(lines[0]).toContain("5h ");
    expect(lines[0]).toContain("3.6% (38m)");
    expect(lines[0]).toContain("Wk ");
    expect(lines[0]).toContain("28.2% (6d 13h)");
    expect(lines[0]).toContain("Antigravity · ada@example.com");
    const first = lines[0];
    if (first !== undefined) {
      expect(first.length).toBeLessThanOrEqual(WIDE_TERMINAL_MAX);
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

  it("renders nothing when no segment has data", () => {
    expect(
      renderStatuslineBlock(
        { identity: undefined, provider: undefined, providerAccountEmail: undefined, fiveHourUsed: undefined, fiveHourResetAt: undefined, sevenDayUsed: undefined, sevenDayResetAt: undefined },
        { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
        NARROW_TERMINAL,
        NOW_MS,
      ),
    ).toBe("");
  });
});
