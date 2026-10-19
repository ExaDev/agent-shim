import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { ELEMENTS, type ElementRegistry } from "./elements/registry";
import { ESCAPE } from "./ansi";
import { RESET } from "./palette";
import { renderStatuslineBlock, RESERVED_COLUMNS } from "./render";
import type { StatuslineSummary } from "./enrich";

const NOW_MS = Date.parse("2026-10-16T00:00:00.000Z");
const WIDE_TERMINAL = 170;
const WIDE_TERMINAL_MAX = 166;
const NARROW_TERMINAL = 40;
const NARROW_MAX_LINE = 36;
/** The ANSI colour codes the renderer's bands use, and a cache hit ratio inside each band. */
const HEADROOM_TOKENS_SAVED = 41_816;
const HEADROOM_SAVINGS_PERCENT = 3.5;
const HEADROOM_SAVINGS_USD = 0.13;
const HEADROOM_TINY_PERCENT = 0.01;
const GREEN_CODE = "32";
const YELLOW_CODE = "33";
const RED_CODE = "31";
const HIGH_HIT_RATIO = 0.93;
const LOW_HIT_RATIO = 0.2;
const NEAR_ZERO_HIT_RATIO = 0.05;
/** Too narrow for the model and the account to share a line: each header segment renders on its own line. */
const ONE_PER_LINE_TERMINAL = 46;
/** Wide enough for the model and the account to share a line, with the identity wrapping alone: the greedy packing case. */
const PACKING_TERMINAL = 60;
/** Wide enough for the context bar to span two columns of family windows, and too narrow for every bar to share one row. */
const ALIGNED_TERMINAL = 104;
/** Too narrow for the identity and the model to share a line, so the order they are listed in shows as the order of the lines. */
const TWO_SEGMENT_LINE_TERMINAL = 24;
/** A base bar width small enough for the context bar and both quota bars to share a row at `ALIGNED_TERMINAL`, and one too wide for them to. */
const NARROW_BAR_CELLS = 4;
/** A use between the default warning and critical thresholds, and one above the critical one. */
const USED_AT_WARNING = 80;
const USED_AT_CRITICAL = 95;
const WIDE_BAR_CELLS = 30;

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
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
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

  it("names a provider session's login by its organisation, not the plan the session is not drawing from", () => {
    const lines = stripAnsi(
      renderStatuslineBlock(
        { ...SUMMARY, providerAccountEmail: "ada@z.ai", loginAccountEmail: "ada@example.com", loginRateLimitTier: "default_claude_max_20x" },
        VIEW,
        WIDE_TERMINAL,
        NOW_MS,
      ),
    ).split("\n");
    const header = lines[0] ?? "";
    expect(header).toContain("ada@example.com");
    expect(header).not.toContain("Max 20x");
  });

  it("draws a provider's own quota windows as bars when it reports no unified window", () => {
    const lines = stripAnsi(
      renderStatuslineBlock(
        {
          ...SUMMARY,
          fiveHourUsed: undefined,
          fiveHourResetAt: undefined,
          sevenDayUsed: undefined,
          sevenDayResetAt: undefined,
          providerQuotaWindows: [
            { measures: "tokens", utilization: 0.5, resetsAt: "2026-10-16T00:38:00.000Z" },
            { measures: "tool-calls", utilization: 0.04, resetsAt: "2026-10-21T00:00:00.000Z" },
          ],
        },
        VIEW,
        WIDE_TERMINAL,
        NOW_MS,
      ),
    ).split("\n");
    const bars = lines.join("\n");
    expect(bars).toContain("tokens [");
    expect(bars).toContain("50.0% (38m)");
    expect(bars).toContain("tool-calls [");
    expect(bars).toContain("4.0%");
    expect(bars).not.toContain("5h [");
  });

  it("draws every model family's window when the account's quota is per family, whichever model is in use", () => {
    const bars = stripAnsi(
      renderStatuslineBlock(
        {
          ...SUMMARY,
          fiveHourUsed: 100,
          sevenDayUsed: 28,
          quotaFamilies: [
            { measures: "Gem 5h", utilization: 1, resetsAt: "2026-10-16T00:38:00.000Z" },
            { measures: "3P 5h", utilization: 0.0001, resetsAt: "2026-10-16T03:00:00.000Z" },
            { measures: "3P Wk", utilization: 0.015, resetsAt: "2026-10-21T00:00:00.000Z" },
          ],
        },
        VIEW,
        WIDE_TERMINAL,
        NOW_MS,
      ),
    );
    expect(bars).toContain("Gem 5h [");
    expect(bars).toContain("3P 5h [");
    expect(bars).toContain("3P Wk [");
    expect(bars).toContain("1.5%");
    expect(bars).not.toContain("28.0%");
  });

  it("lines the bars of the context row and the family windows up, starts and ends, whatever each row's label and figures", () => {
    const rows = stripAnsi(
      renderStatuslineBlock(
        {
          ...SUMMARY,
          quotaFamilies: [
            { measures: "Gem 5h", utilization: 0.169, resetsAt: "2026-10-16T04:15:00.000Z" },
            { measures: "Gem Wk", utilization: 0.336, resetsAt: "2026-10-22T18:00:00.000Z" },
            { measures: "3P 5h", utilization: 0.387, resetsAt: "2026-10-16T03:07:00.000Z" },
            { measures: "3P Wk", utilization: 0.208, resetsAt: "2026-10-22T02:00:00.000Z" },
            { measures: "Argon Wk", utilization: 0.775, resetsAt: "2026-10-22T22:00:00.000Z" },
          ],
        },
        VIEW,
        ALIGNED_TERMINAL,
        NOW_MS,
      ),
    )
      .split("\n")
      .slice(1);
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((row) => row.indexOf("["))).size).toBe(1);
    expect(new Set(rows.map((row) => row.lastIndexOf("]"))).size).toBe(1);
  });

  it("shows what headroom saved the session at the end of the first line, and nothing when there are no figures", () => {
    const withSavings = stripAnsi(renderStatuslineBlock({ ...SUMMARY, headroom: { tokensSaved: HEADROOM_TOKENS_SAVED, savingsPercent: HEADROOM_SAVINGS_PERCENT, savingsUsd: HEADROOM_SAVINGS_USD } }, VIEW, WIDE_TERMINAL, NOW_MS)).split("\n");
    expect(withSavings[0]?.endsWith("headroom 42k saved · 3.5% overall · $0.13")).toBe(true);
    const tiny = stripAnsi(renderStatuslineBlock({ ...SUMMARY, headroom: { tokensSaved: HEADROOM_TOKENS_SAVED, savingsPercent: HEADROOM_TINY_PERCENT, savingsUsd: undefined } }, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(tiny).toContain("0.01% overall");
    const partial = stripAnsi(renderStatuslineBlock({ ...SUMMARY, headroom: { tokensSaved: HEADROOM_TOKENS_SAVED, savingsPercent: undefined, savingsUsd: undefined } }, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(partial).toContain("headroom 42k saved");
    expect(partial).not.toContain("$");
    const empty = stripAnsi(renderStatuslineBlock({ ...SUMMARY, headroom: { tokensSaved: undefined, savingsPercent: undefined, savingsUsd: undefined } }, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(empty).not.toContain("headroom");
  });

  it("colours the cache hit percentage by its band: green when most is served from cache, yellow when little is, red when nearly none is", () => {
    const previous = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const esc = String.fromCharCode(ESCAPE_CHAR_CODE);
      const colourOfCache = (hitRatio: number): string | undefined => {
        const raw = renderStatuslineBlock(SUMMARY, { ...VIEW, cacheHitRatio: hitRatio }, WIDE_TERMINAL, NOW_MS);
        return new RegExp(`Cache: ${esc}\\[(\\d+)m`).exec(raw)?.[1];
      };
      expect(colourOfCache(HIGH_HIT_RATIO)).toBe(GREEN_CODE);
      expect(colourOfCache(LOW_HIT_RATIO)).toBe(YELLOW_CODE);
      expect(colourOfCache(NEAR_ZERO_HIT_RATIO)).toBe(RED_CODE);
    } finally {
      if (previous === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previous;
      }
    }
  });

  it("renders nothing when no segment has data", () => {
    expect(
      renderStatuslineBlock(
        { identity: undefined, provider: undefined, providerAccountEmail: undefined, providerAccountSub: undefined, providerPlan: undefined, loginAccountEmail: undefined, loginRateLimitTier: undefined, loginOrganizationName: undefined, loginOrganizationType: undefined, loginSeatTier: undefined, loginPlan: undefined, fiveHourUsed: undefined, fiveHourResetAt: undefined, sevenDayUsed: undefined, sevenDayResetAt: undefined, providerQuotaWindows: [], quotaFamilies: [], headroom: undefined },
        { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
        NARROW_TERMINAL,
        NOW_MS,
      ),
    ).toBe("");
  });
});

describe("a dynamic mode's choice beside the model name", () => {
  it("draws the served model beside the name the session typed, naming the provider when the choice could cross providers", () => {
    const summary: StatuslineSummary = { ...SUMMARY, modelChoice: { requested: "auto", served: "glm-5.3", provider: "z", providers: ["z", "antigravity"] } };
    const text = stripAnsi(renderStatuslineBlock(summary, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(text).toContain("Sonnet 5.5 -> z/glm-5.3");
  });

  it("draws the served model alone when the choice never left one provider", () => {
    const summary: StatuslineSummary = { ...SUMMARY, modelChoice: { requested: "auto", served: "gemini-4-argon-medium", provider: "antigravity", providers: [] } };
    const text = stripAnsi(renderStatuslineBlock(summary, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(text).toContain("Sonnet 5.5 -> gemini-4-argon-medium");
    expect(text).not.toContain("z/glm");
  });

  it("folds the served provider into the arrow instead of a separate via segment when routing left the launch provider", () => {
    const summary: StatuslineSummary = { ...SUMMARY, routedTarget: "z/glm-5.3", modelChoice: { requested: "auto", served: "glm-5.3", provider: "z", providers: ["z"] } };
    const text = stripAnsi(renderStatuslineBlock(summary, VIEW, WIDE_TERMINAL, NOW_MS));
    expect(text).toContain("Sonnet 5.5 -> z/glm-5.3");
    expect(text).not.toContain("via ");
  });
});

describe("statusline settings", () => {
  const render = (settings: StatuslineSettings, summary: StatuslineSummary = SUMMARY, terminalWidth = WIDE_TERMINAL): string =>
    renderStatuslineBlock(summary, VIEW, terminalWidth, NOW_MS, resolveStatusline(settings));

  it("draws exactly what it drew before settings existed when every setting is the default", () => {
    expect(render({})).toBe(renderStatuslineBlock(SUMMARY, VIEW, WIDE_TERMINAL, NOW_MS));
  });

  it("draws the header segments in the order listed and hides the ones left out", () => {
    const header = stripAnsi(render({ layout: { header: ["identity", "model"] } }, SUMMARY, TWO_SEGMENT_LINE_TERMINAL)).split("\n");
    expect(header.slice(0, 2)).toEqual(["antigravity", "Sonnet 5.5"]);
    expect(header.join("\n")).not.toContain("ada@example.com");
  });

  it("hides the whole header when the list is empty", () => {
    const lines = stripAnsi(render({ layout: { header: [] } })).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ctx");
  });

  it("draws the rows in the order listed, and none when the list is empty", () => {
    const quotaFirst = stripAnsi(render({ layout: { header: [], rows: ["quota", "context"] } }, SUMMARY, ALIGNED_TERMINAL)).split("\n");
    expect(quotaFirst.findIndex((line) => line.includes("5h"))).toBeLessThan(quotaFirst.findIndex((line) => line.includes("Ctx")));
    expect(render({ layout: { header: [], rows: [] } })).toBe("");
    const quotaOnly = stripAnsi(render({ layout: { rows: ["quota"] } }));
    expect(quotaOnly).toContain("5h");
    expect(quotaOnly).not.toContain("Ctx");
  });

  it("names the two subscription windows as set", () => {
    const text = stripAnsi(render({ labels: { fiveHour: "Session", sevenDay: "Week" } }));
    expect(text).toContain("Session ");
    expect(text).toContain("Week ");
    expect(text).not.toContain("5h ");
  });

  it("moves the colour bands with the thresholds", () => {
    const at = (used: number) => ({ ...SUMMARY, fiveHourUsed: used, sevenDayUsed: undefined });
    const quota = (settings: StatuslineSettings, used: number): string => render({ layout: { rows: ["quota"] }, ...settings }, at(used));
    const usedBetweenWarnAndCritical = 60;
    const text = `${String(usedBetweenWarnAndCritical)}.0%`;
    expect(quota({}, usedBetweenWarnAndCritical)).toContain(`[${GREEN_CODE}m${text}`);
    expect(quota({ bands: { warnAt: 50, criticalAt: 80 } }, usedBetweenWarnAndCritical)).toContain(`[${YELLOW_CODE}m${text}`);
    expect(quota({ bands: { warnAt: 50, criticalAt: 55 } }, usedBetweenWarnAndCritical)).toContain(`[${RED_CODE}m${text}`);
  });

  it("sets the base width of a bar, which decides how many bars share a row", () => {
    const rows = (width: number): number => stripAnsi(render({ layout: { header: [] }, bar: { width } }, SUMMARY, ALIGNED_TERMINAL)).split("\n").length;
    expect(rows(NARROW_BAR_CELLS)).toBeLessThan(rows(WIDE_BAR_CELLS));
  });

  it("draws a text row as its own lines, ending the run of bars before it", () => {
    const withNotes: ElementRegistry = { ...ELEMENTS, rows: { ...ELEMENTS.rows, quota: () => ({ kind: "text", lines: ["first note", "second note"] }) } };
    const lines = stripAnsi(renderStatuslineBlock(SUMMARY, VIEW, WIDE_TERMINAL, NOW_MS, resolveStatusline({ layout: { header: [] } }), withNotes)).split("\n");
    expect(lines[0]).toContain("Ctx");
    expect(lines.slice(1)).toEqual(["first note", "second note"]);
  });

  it("paints each segment and label in its colour role, and leaves a default role as plain text", () => {
    const painted = render({ colours: { model: "cyan", label: 208 } }, SUMMARY, WIDE_TERMINAL);
    expect(painted).toContain(`${ESCAPE}[36mSonnet 5.5${RESET}`);
    expect(painted).toContain(`${ESCAPE}[38;5;208mantigravity${RESET}`);
    expect(painted).toContain(`${ESCAPE}[38;5;208m5h ${RESET}`);
    expect(render({})).not.toContain(`${ESCAPE}[36m`);
  });

  it("colours a bar below its warning threshold in the role of its row", () => {
    const below = { ...SUMMARY, fiveHourUsed: 10, sevenDayUsed: undefined };
    expect(render({ layout: { rows: ["quota"] }, colours: { usage: "blue" } }, below)).toContain(`${ESCAPE}[34m`);
    expect(render({ layout: { rows: ["context"] }, colours: { usage: "blue" } }, below)).not.toContain(`${ESCAPE}[34m`);
    expect(render({ layout: { rows: ["context"] }, colours: { context: "magenta" } }, below)).toContain(`${ESCAPE}[35m`);
  });

  it("colours a bar at its warning and critical thresholds in their own roles", () => {
    const at = (used: number) => ({ ...SUMMARY, fiveHourUsed: used, sevenDayUsed: undefined });
    const colours = { usage: "blue", usageWarning: "magenta", critical: "cyan" } as const;
    expect(render({ layout: { rows: ["quota"] }, colours }, at(USED_AT_WARNING))).toContain(`${ESCAPE}[35m${String(USED_AT_WARNING)}.0%`);
    expect(render({ layout: { rows: ["quota"] }, colours }, at(USED_AT_CRITICAL))).toContain(`${ESCAPE}[36m${String(USED_AT_CRITICAL)}.0%`);
  });

  it("draws a bar with the characters set and colours its unused part in the empty role", () => {
    const text = render({ layout: { header: [], rows: ["quota"] }, bar: { filled: "#", empty: "-" }, colours: { empty: "red" } });
    expect(text).toContain(`${ESCAPE}[31m-`);
    expect(stripAnsi(text)).toMatch(/\[#+-+\]/);
  });

  it("draws plain text with colour off, whatever the colour settings are", () => {
    const text = renderStatuslineBlock(SUMMARY, VIEW, WIDE_TERMINAL, NOW_MS, resolveStatusline({ colours: { model: "red", label: "#ff0000" } }), ELEMENTS, { NO_COLOR: "1" });
    expect(text).not.toContain(`${ESCAPE}[`);
  });
});
