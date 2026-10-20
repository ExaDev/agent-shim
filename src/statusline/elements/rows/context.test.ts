import { describe, expect, it } from "vitest";

import { AUTOCOMPACT_RESERVE_FRACTION, resolveStatusline, type ResolvedStatusline, type StatuslineSettings } from "../../../config/statusline";
import { ESCAPE } from "../../ansi";
import { layoutBarGrid } from "../../barGrid";
import { createPalette } from "../../palette";
import { fakeRenderContext } from "../../testing";
import type { RenderContext, RowOutput, StatuslinePayloadView } from "../context";
import { contextRow } from "./context";

const WINDOW = 200_000;
const HELD = 90_000;
const REPORTED_PERCENT = 45;
const PERCENT = 100;
const IN_WARNING_BAND = 75;
const ABOVE_BANDS_BELOW_CRITICAL = 88;
const OWN_WARN_AT = 60;
const OWN_CRITICAL_AT = 70;
const LATE_WARN_AT = 80;
const LATE_CRITICAL_AT = 95;
const EARLY_CRITICAL_AT = 85;
const LOW_THRESHOLDS = { warnAt: 20, criticalAt: 40 };
const HALF = 2;
const QUARTER = 4;
const JUST_CLEARED = 100;
/** The default critical threshold of the bands, and how far under a threshold a percentage still counts as under it. */
const DEFAULT_WARN_AT = 70;
const DEFAULT_CRITICAL_AT = 90;
const JUST_BELOW = 0.1;
const GREEN = `${ESCAPE}[32m`;
const YELLOW = `${ESCAPE}[33m`;
const RED = `${ESCAPE}[31m`;
const BAR_CELLS = 10;
const LINE_WIDTH = 200;
const SEPARATOR = " | ";

const REPORTED: StatuslinePayloadView = {
  modelDisplayName: undefined,
  contextUsedPercentage: REPORTED_PERCENT,
  contextTotalTokens: HELD,
  contextWindowTokens: WINDOW,
  cacheHitRatio: undefined,
  cacheReadTokens: undefined,
  freshInputTokens: undefined,
};

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");
}

/** A render context under `settings` with colour on, so a test can see which colour a figure is drawn in. */
function withColour(settings: ResolvedStatusline, view: StatuslinePayloadView, payload: unknown): RenderContext {
  return fakeRenderContext({ settings, view, payload, palette: createPalette(settings.colours, true) });
}

/** The context row as the renderer would draw it under `settings`, with the view and payload given, as the lines it ends up on. */
function draw(settings: StatuslineSettings, view: Partial<StatuslinePayloadView> = {}, payload: unknown = {}): string[] {
  const resolved = resolveStatusline(settings);
  return linesOf(contextRow(withColour(resolved, { ...REPORTED, ...view }, payload)));
}

function linesOf(output: RowOutput): string[] {
  return output.kind === "text" ? [...output.lines] : layoutBarGrid([output.cells], LINE_WIDTH, SEPARATOR, BAR_CELLS);
}

describe("the context row's figure", () => {
  it("writes the tokens held over the window before the bar and the percentage after it by default", () => {
    const [line] = draw({});
    expect(stripAnsi(line ?? "")).toMatch(/^Ctx 90k\/200k \[.*\] 45\.0%$/);
  });

  it("writes only the percentage for percent, only the tokens held for tokens, and the percentage left for remaining", () => {
    expect(stripAnsi(draw({ context: { value: "percent" } })[0] ?? "")).toMatch(/^Ctx \[.*\] 45\.0%$/);
    expect(stripAnsi(draw({ context: { value: "tokens" } })[0] ?? "")).toMatch(/^Ctx \[.*\] 90k\/200k$/);
    expect(stripAnsi(draw({ context: { value: "remaining" } })[0] ?? "")).toMatch(/^Ctx \[.*\] 55\.0%$/);
  });

  it("writes the tokens alone for tokens when the client reports no window, and nothing when it reports no tokens", () => {
    expect(stripAnsi(draw({ context: { value: "tokens" } }, { contextWindowTokens: undefined })[0] ?? "")).toMatch(/\] 90k$/);
    expect(stripAnsi(draw({ context: { value: "tokens" } }, { contextTotalTokens: undefined })[0] ?? "")).toMatch(/^Ctx \[.*\]$/);
  });

  it("does not let the remaining percentage go below nothing when the percentage reported is over the window", () => {
    expect(stripAnsi(draw({ context: { value: "remaining" } }, { contextUsedPercentage: 104 })[0] ?? "")).toMatch(/\] 0\.0%$/);
  });

  it("colours the figure the bar's colour in every value mode", () => {
    for (const value of ["both", "percent", "tokens", "remaining"] as const) {
      const [line] = draw({ context: { value } }, { contextUsedPercentage: 95 });
      expect(line, value).toContain(RED);
    }
  });
});

describe("the context row without its bar", () => {
  it("draws its figures as one line of text, with the same figure for each value", () => {
    expect(draw({ context: { bar: "hidden" } }).map(stripAnsi)).toEqual(["Ctx 90k/200k 45.0%"]);
    expect(draw({ context: { bar: "hidden", value: "percent" } }).map(stripAnsi)).toEqual(["Ctx 45.0%"]);
    expect(draw({ context: { bar: "hidden", value: "tokens" } }).map(stripAnsi)).toEqual(["Ctx 90k/200k"]);
    expect(draw({ context: { bar: "hidden", value: "remaining" } }).map(stripAnsi)).toEqual(["Ctx 55.0%"]);
  });

  it("keeps the cache share beside the figure, and draws nothing when there is no percentage", () => {
    expect(draw({ context: { bar: "hidden" } }, { cacheHitRatio: 0.93 }).map(stripAnsi)).toEqual(["Ctx 90k/200k 45.0% (Cache: 93%)"]);
    expect(draw({ context: { bar: "hidden" } }, { contextUsedPercentage: undefined })).toEqual([]);
  });

  it("is a row of text, so it ends a run of bars rather than joining their grid", () => {
    const resolved = resolveStatusline({ context: { bar: "hidden" } });
    expect(contextRow(withColour(resolved, REPORTED, {})).kind).toBe("text");
    expect(contextRow(withColour(resolveStatusline({}), REPORTED, {})).kind).toBe("bars");
  });
});

describe("the context row with nothing to show", () => {
  it("draws nothing for tokens without a bar when the client reports no tokens, but still draws the bar with the percentage", () => {
    expect(draw({ context: { bar: "hidden", value: "tokens" } }, { contextTotalTokens: undefined, cacheHitRatio: 0.93 })).toEqual([]);
    expect(stripAnsi(draw({ context: { value: "tokens" } }, { contextTotalTokens: undefined })[0] ?? "")).toMatch(/^Ctx \[.*\]$/);
  });
});

describe("the context row's thresholds", () => {
  it("colours the figure and the bar by the bands until the context thresholds are set, then by those", () => {
    const at = (percent: number, settings: StatuslineSettings, colour: string): void => {
      const line = draw(settings, { contextUsedPercentage: percent })[0] ?? "";
      expect(line, `figure at ${String(percent)}`).toContain(`${colour}${percent.toFixed(1)}%`);
      expect(line, `bar at ${String(percent)}`).toContain(`[${colour}\u2588`);
    };
    at(IN_WARNING_BAND, {}, YELLOW);
    at(IN_WARNING_BAND, { context: { warnAt: LATE_WARN_AT } }, GREEN);
    at(IN_WARNING_BAND, { context: { warnAt: OWN_WARN_AT, criticalAt: OWN_CRITICAL_AT } }, RED);
    at(IN_WARNING_BAND, { bands: { warnAt: LATE_WARN_AT, criticalAt: LATE_CRITICAL_AT } }, GREEN);
    at(ABOVE_BANDS_BELOW_CRITICAL, { context: { criticalAt: EARLY_CRITICAL_AT } }, RED);
    at(ABOVE_BANDS_BELOW_CRITICAL, {}, YELLOW);
  });

  it("colours at exactly each threshold in the colour of the band it opens", () => {
    const line = (percent: number): string => draw({}, { contextUsedPercentage: percent })[0] ?? "";
    expect(line(DEFAULT_WARN_AT - JUST_BELOW)).toContain(`${GREEN}${(DEFAULT_WARN_AT - JUST_BELOW).toFixed(1)}%`);
    expect(line(DEFAULT_WARN_AT)).toContain(`${YELLOW}${DEFAULT_WARN_AT.toFixed(1)}%`);
    expect(line(DEFAULT_CRITICAL_AT - JUST_BELOW)).toContain(`${YELLOW}${(DEFAULT_CRITICAL_AT - JUST_BELOW).toFixed(1)}%`);
    expect(line(DEFAULT_CRITICAL_AT)).toContain(`${RED}${DEFAULT_CRITICAL_AT.toFixed(1)}%`);
  });

  it("leaves the cache share on the bands, whatever the context thresholds are", () => {
    const [line] = draw({ context: { warnAt: 10, criticalAt: 20 } }, { cacheHitRatio: 0.93 });
    expect(line).toContain(`(Cache: ${GREEN}93%`);
  });
});

describe("the context row measured against a window", () => {
  it("measures the tokens held against the window set, not the one the client reports, and shows that window", () => {
    const [line] = draw({ context: { autoCompactWindow: 100_000 } });
    expect(stripAnsi(line ?? "")).toMatch(/^Ctx 90k\/100k \[.*\] 90\.0%$/);
  });

  it("never reads over the window", () => {
    const [line] = draw({ context: { autoCompactWindow: 50_000 } });
    expect(stripAnsi(line ?? "")).toMatch(/\] 100\.0%$/);
  });

  it("draws nothing while the client reports no tokens to measure, rather than the percentage against its own window", () => {
    expect(draw({ context: { autoCompactWindow: 100_000 } }, { contextTotalTokens: undefined })).toEqual([]);
    expect(draw({ context: { autoCompactWindow: 100_000, bar: "hidden" } }, { contextTotalTokens: undefined })).toEqual([]);
  });

  it("draws 0.0% for tokens not yet held", () => {
    expect(stripAnsi(draw({ context: { autoCompactWindow: 100_000 } }, { contextTotalTokens: 0 })[0] ?? "")).toMatch(/\] 0\.0%$/);
  });
});

describe("the context row when the client reports no percentage", () => {
  const unreported = { contextUsedPercentage: undefined };

  it("draws nothing by default, even beside tokens and a window", () => {
    expect(draw({}, unreported)).toEqual([]);
  });

  it("estimates from the tokens held for raw", () => {
    expect(stripAnsi(draw({ context: { estimate: "raw" } }, unreported)[0] ?? "")).toMatch(/\] 45\.0%$/);
  });

  it("adds the reserve to the estimate for buffered, in full from half the window held and in part below it", () => {
    const half = draw({ context: { estimate: "buffered" } }, { ...unreported, contextTotalTokens: WINDOW / HALF })[0] ?? "";
    expect(stripAnsi(half)).toContain(`${(PERCENT / HALF + AUTOCOMPACT_RESERVE_FRACTION * PERCENT).toFixed(1)}%`);
    const quarter = draw({ context: { estimate: "buffered" } }, { ...unreported, contextTotalTokens: WINDOW / QUARTER })[0] ?? "";
    const shown = Number.parseFloat(/(\d+\.\d)%$/.exec(stripAnsi(quarter))?.[1] ?? "");
    expect(shown).toBeGreaterThan(PERCENT / QUARTER);
    expect(shown).toBeLessThan(PERCENT / QUARTER + AUTOCOMPACT_RESERVE_FRACTION * PERCENT);
  });

  it("adds no reserve to a window that has just been cleared", () => {
    const line = draw({ context: { estimate: "buffered" } }, { ...unreported, contextTotalTokens: WINDOW / JUST_CLEARED })[0] ?? "";
    expect(stripAnsi(line)).toMatch(/\] 1\.0%$/);
  });

  it("draws nothing when there is no window or no tokens to estimate from", () => {
    expect(draw({ context: { estimate: "raw" } }, { ...unreported, contextWindowTokens: undefined })).toEqual([]);
    expect(draw({ context: { estimate: "raw" } }, { ...unreported, contextTotalTokens: undefined })).toEqual([]);
  });

  it("treats a reported 0 beside tokens already held as not yet worked out when asked to estimate, and as 0 when not", () => {
    expect(stripAnsi(draw({ context: { estimate: "raw" } }, { contextUsedPercentage: 0 })[0] ?? "")).toMatch(/\] 45\.0%$/);
    expect(stripAnsi(draw({}, { contextUsedPercentage: 0 })[0] ?? "")).toMatch(/\] 0\.0%$/);
  });

  it("keeps a reported 0 when no estimate can be made from the tokens and the window", () => {
    for (const estimate of ["raw", "buffered"] as const) {
      const noWindow = draw({ context: { estimate } }, { contextUsedPercentage: 0, contextWindowTokens: undefined });
      expect(stripAnsi(noWindow[0] ?? ""), estimate).toMatch(/\] 0\.0%$/);
      const noTokens = draw({ context: { estimate } }, { contextUsedPercentage: 0, contextTotalTokens: undefined });
      expect(stripAnsi(noTokens[0] ?? ""), estimate).toMatch(/\] 0\.0%$/);
    }
  });

  it("keeps the percentage the client reports when it reports one", () => {
    expect(stripAnsi(draw({ context: { estimate: "buffered" } }, { contextUsedPercentage: 20 })[0] ?? "")).toMatch(/\] 20\.0%$/);
  });
});

describe("the context row's breakdown at high use", () => {
  const usage = { context_window: { current_usage: { input_tokens: 2000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 86_000 } } };
  const high = { contextUsedPercentage: 92 };

  it("adds the input and cache tokens of the last request from the critical threshold when asked", () => {
    expect(stripAnsi(draw({ context: { breakdown: "critical" } }, high, usage)[0] ?? "")).toMatch(/92\.0% \(in: 2\.0k, cache: 90k\)$/);
    expect(stripAnsi(draw({ context: { breakdown: "critical", bar: "hidden" } }, high, usage)[0] ?? "")).toBe("Ctx 90k/200k 92.0% (in: 2.0k, cache: 90k)");
  });

  it("adds nothing below the threshold, when not asked, or when the client reports no last request", () => {
    expect(stripAnsi(draw({ context: { breakdown: "critical" } }, { contextUsedPercentage: 80 }, usage)[0] ?? "")).not.toContain("in:");
    expect(stripAnsi(draw({}, high, usage)[0] ?? "")).not.toContain("in:");
    expect(stripAnsi(draw({ context: { breakdown: "critical" } }, high)[0] ?? "")).not.toContain("in:");
  });

  it("adds the breakdown at exactly the critical threshold, and not a hair below it", () => {
    const atAndBelow = (settings: StatuslineSettings, threshold: number): void => {
      expect(stripAnsi(draw(settings, { contextUsedPercentage: threshold }, usage)[0] ?? ""), `at ${String(threshold)}`).toContain("in:");
      expect(stripAnsi(draw(settings, { contextUsedPercentage: threshold - JUST_BELOW }, usage)[0] ?? ""), `below ${String(threshold)}`).not.toContain("in:");
    };
    atAndBelow({ context: { breakdown: "critical" } }, DEFAULT_CRITICAL_AT);
    atAndBelow({ context: { breakdown: "critical", criticalAt: EARLY_CRITICAL_AT } }, EARLY_CRITICAL_AT);
    atAndBelow({ context: { breakdown: "critical" }, bands: { warnAt: OWN_WARN_AT, criticalAt: OWN_CRITICAL_AT } }, OWN_CRITICAL_AT);
  });

  it("takes its threshold from context.criticalAt", () => {
    expect(stripAnsi(draw({ context: { breakdown: "critical", criticalAt: 95 } }, high, usage)[0] ?? "")).not.toContain("in:");
    expect(stripAnsi(draw({ context: { breakdown: "critical", ...LOW_THRESHOLDS } }, { contextUsedPercentage: 50 }, usage)[0] ?? "")).toContain("in:");
  });
});
