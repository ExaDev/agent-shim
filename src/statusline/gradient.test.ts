import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import type { StatuslinePayloadView } from "./elements/context";
import { rgbOfHex, type Rgb } from "./colour";
import type { StatuslineSummary } from "./enrich";
import { RESET } from "./palette";
import { parseClientPayload } from "./payload";
import { renderStatuslineBlock, RESERVED_COLUMNS } from "./render";
import { FULL_PERCENT } from "./style";
import { fakeStatuslinePorts } from "./testing";

const NOW_MS = Date.parse("2026-10-16T00:00:00.000Z");
/** The quota bar's base width in cells, as `bar.width` defaults to, plus the two columns its brackets take. */
const BASE_CELLS = 10;
const BRACKETS = 2;
/** The label before the quota bar and the reset its figures carry, fixed by the summary below. */
const LABEL = "5h ";
const RESET_TEXT = "(38m)";
/** The default bands the quota bar steps at, which the gradient's spans stop at. */
const WARN_AT = 70;
const CRITICAL_AT = 90;
/** A terminal wide enough that every row here draws on one line of its own. */
const WIDE_TERMINAL = 170;
/** Uses the tests draw, named by where each sits against the default bands: half the window, between the thresholds, and past the critical threshold. */
const HALF_IN_USE = 50;
const BETWEEN_BANDS = 80;
const PAST_CRITICAL = 95;

/** The quota row's line exactly wide enough for its bar at the base ten cells, so the layout shares no spare width into the bar and every column's colour is known: the label, the bracketed cells and the figures, whose width is the percentage's (` 80.0% (38m)` against ` 100.0% (38m)`). */
function baseBarLineWidth(used: number): number {
  return LABEL.length + (BASE_CELLS + BRACKETS) + ` ${used.toFixed(1)}% ${RESET_TEXT}`.length;
}

/** The cells a bar fills at a use, as the drawing rounds it. */
const filledAt = (used: number): number => Math.round((used / FULL_PERCENT) * BASE_CELLS);

/** The settings' stop colours as #rrggbb values, so a stop's escape is the exact 24-bit sequence and a threshold's blend can be told from the role's own colour. */
const HEX_COLOURS = { usage: "#00cd00", usageWarning: "#cdcd00", critical: "#ff0000" } as const;
/** The gradient's stops, read from those same hex values, which the renderer blends between. */
const OK: Rgb = rgbOfHex(HEX_COLOURS.usage);
const WARNING: Rgb = rgbOfHex(HEX_COLOURS.usageWarning);
const CRITICAL: Rgb = rgbOfHex(HEX_COLOURS.critical);
const FILL = "█";
const EMPTY = "░";
/** The escape the default empty colour (brightBlack) starts the unused part of a bar with. */
const EMPTY_COLOUR = `${ESCAPE}[90m`;
const ESCAPE_CODE = 27;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(ESCAPE_CODE)}\\[[0-9;]*[a-zA-Z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** The escape that starts a 24-bit colour of these channels. */
const escapeOf = (channels: Rgb): string => `${ESCAPE}[38;2;${channels.join(";")}m`;

/** One channel of a blend the test computes itself, so a wrong blend in the renderer fails the test rather than agreeing with it. */
const blendChannel = (from: number, to: number, at: number): number => Math.round(from + (to - from) * at);

/** The stops blended per channel, rounded to the nearest whole value, written out here so a wrong blend in the renderer fails the test rather than agreeing with it. */
function blendOf(from: Rgb, to: Rgb, at: number): Rgb {
  return [blendChannel(from[0], to[0], at), blendChannel(from[1], to[1], at), blendChannel(from[2], to[2], at)];
}

/** The colour of one column of a bar coloured across its width: the ok colour at the first cell, the critical one at the last. */
function acrossBar(column: number, cells: number): Rgb {
  return blendOf(OK, CRITICAL, column / (cells - 1));
}

/** A blend's position between the warning and critical thresholds, and below the warning one, computed as the renderer computes them from the use and the thresholds, floats included, so an expected colour is its exact blend. */
const betweenBands = (used: number, warnAt: number, criticalAt: number): number => (used / FULL_PERCENT - warnAt / FULL_PERCENT) / (criticalAt / FULL_PERCENT - warnAt / FULL_PERCENT);
const belowWarnAt = (used: number, warnAt: number): number => used / FULL_PERCENT / (warnAt / FULL_PERCENT);

const summaryOf = (fiveHourUsed: number | undefined, sevenDayUsed: number | undefined): StatuslineSummary => ({
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
  fiveHourUsed,
  fiveHourResetAt: fiveHourUsed === undefined ? undefined : "2026-10-16T00:38:00.000Z",
  sevenDayUsed,
  sevenDayResetAt: sevenDayUsed === undefined ? undefined : "2026-10-22T13:52:54.000Z",
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
});

const NO_VIEW: StatuslinePayloadView = { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined };

/** The quota row alone, with the gradient's stop colours set as hex values, at a use of `used` whole percent on a line that leaves its bar the base ten cells. */
function renderQuota(used: number, gradient: "off" | "use" | "width", colours: Readonly<NonNullable<StatuslineSettings["colours"]>> = HEX_COLOURS, env: Readonly<Record<string, string | undefined>> = {}): string {
  const lineWidth = baseBarLineWidth(used);
  return renderStatuslineBlock({
    summary: summaryOf(used, undefined),
    view: NO_VIEW,
    payload: parseClientPayload({}),
    terminalWidth: lineWidth + RESERVED_COLUMNS,
    lineWidth,
    nowMs: NOW_MS,
    settings: resolveStatusline({ layout: { header: [], rows: ["quota"] }, colours, bar: { gradient } }),
    ports: fakeStatuslinePorts({ env }),
  });
}

/** The one bar a quota-only line draws, brackets excluded. */
function barOf(line: string): string {
  return /\[([^\]]*)\]/.exec(line)?.[1] ?? "";
}

describe("bar.gradient off (the default)", () => {
  const PINNED_FIVE_HOUR = 3.6;
  const PINNED_SEVEN_DAY = 28.2;
  const PINNED_VIEW: StatuslinePayloadView = { modelDisplayName: "Sonnet 5.5", contextUsedPercentage: 63.4, contextTotalTokens: 634_000, contextWindowTokens: 1_000_000, cacheHitRatio: 0.986, cacheReadTokens: 600_000, freshInputTokens: 34_000 };
  const pinned = renderStatuslineBlock({ summary: summaryOf(PINNED_FIVE_HOUR, PINNED_SEVEN_DAY), view: PINNED_VIEW, payload: parseClientPayload({}), terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, ports: fakeStatuslinePorts() });

  it("draws the same bytes as before the setting existed, which it pins", () => {
    expect(pinned).toBe(
      [
        `Sonnet 5.5                           |                           Antigravity · ada@example.com · Pro                           |                           antigravity`,
        `Ctx 634k/1M [${ESCAPE}[32m████████████████████${ESCAPE}[90m░░░░░░░░░░░${ESCAPE}[0m] ${ESCAPE}[32m63.4%${ESCAPE}[0m (Cache: ${ESCAPE}[32m99%${ESCAPE}[0m) | 5h [${ESCAPE}[32m█${ESCAPE}[90m░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${ESCAPE}[0m] ${ESCAPE}[32m3.6%${ESCAPE}[0m (38m) | Wk [${ESCAPE}[32m████████${ESCAPE}[90m░░░░░░░░░░░░░░░░░░░░░░${ESCAPE}[0m] ${ESCAPE}[32m28.2%${ESCAPE}[0m (6d 13h)`,
      ].join("\n"),
    );
  });

  it("leaves a bar that says so in the band's single colour, whatever the use", () => {
    for (const used of [0, HALF_IN_USE, WARN_AT, BETWEEN_BANDS, CRITICAL_AT, FULL_PERCENT]) {
      const line = renderQuota(used, "off");
      const filled = filledAt(used);
      const band = used >= CRITICAL_AT ? CRITICAL : used >= WARN_AT ? WARNING : OK;
      expect(barOf(line), `at ${String(used)}%`).toBe(`${escapeOf(band)}${FILL.repeat(filled)}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filled)}${RESET}`);
    }
  });
});

describe("bar.gradient use", () => {
  it("holds the ok colour at none in use, the warning colour at the warning threshold and the critical one at the critical threshold and above, exactly as the bands draw them", () => {
    expect(barOf(renderQuota(0, "use"))).toBe(`${escapeOf(OK)}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS)}${RESET}`);
    expect(barOf(renderQuota(WARN_AT, "use"))).toBe(`${escapeOf(WARNING)}${FILL.repeat(filledAt(WARN_AT))}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(WARN_AT))}${RESET}`);
    expect(barOf(renderQuota(CRITICAL_AT, "use"))).toBe(`${escapeOf(CRITICAL)}${FILL.repeat(filledAt(CRITICAL_AT))}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(CRITICAL_AT))}${RESET}`);
    // The empty colour's escape still ends a bar with nothing empty to draw, exactly as the bands mode leaves it.
    expect(barOf(renderQuota(FULL_PERCENT, "use"))).toBe(`${escapeOf(CRITICAL)}${FILL.repeat(BASE_CELLS)}${EMPTY_COLOUR}${RESET}`);
  });

  it("blends between the stops, so a use between the thresholds holds a colour strictly between theirs", () => {
    const mid = blendOf(WARNING, CRITICAL, betweenBands(BETWEEN_BANDS, WARN_AT, CRITICAL_AT));
    const line = renderQuota(BETWEEN_BANDS, "use");
    expect(barOf(line)).toBe(`${escapeOf(mid)}${FILL.repeat(filledAt(BETWEEN_BANDS))}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(BETWEEN_BANDS))}${RESET}`);
    expect(mid).not.toEqual(WARNING);
    expect(mid).not.toEqual(CRITICAL);
    // The first span blends from the ok colour at none in use, not a band of it.
    expect(barOf(renderQuota(HALF_IN_USE, "use"))).toBe(`${escapeOf(blendOf(OK, WARNING, belowWarnAt(HALF_IN_USE, WARN_AT)))}${FILL.repeat(filledAt(HALF_IN_USE))}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(HALF_IN_USE))}${RESET}`);
  });

  it("keeps the figures beside the bar in the band's colour, and every character of the line as it was", () => {
    const line = renderQuota(BETWEEN_BANDS, "use");
    expect(line).toContain(`${escapeOf(WARNING)}80.0%${RESET}`);
    expect(line).not.toContain(`${escapeOf(blendOf(WARNING, CRITICAL, betweenBands(BETWEEN_BANDS, WARN_AT, CRITICAL_AT)))}80.0%`);
    expect(stripAnsi(line)).toBe(stripAnsi(renderQuota(BETWEEN_BANDS, "off")));
  });

  it("follows the context bar's own thresholds, and leaves its breakdown as it was", () => {
    const CONTEXT_WARN_AT = 50;
    const CONTEXT_CRITICAL_AT = 60;
    const CONTEXT_BETWEEN = 55;
    const settings: StatuslineSettings = { layout: { header: [], rows: ["context"] }, colours: { context: "#00cd00", warning: "#cdcd00", critical: "#ff0000" } };
    const view = { ...NO_VIEW, contextUsedPercentage: CONTEXT_BETWEEN, contextTotalTokens: 110_000, contextWindowTokens: 200_000 };
    const render = (gradient: "off" | "use"): string =>
      renderStatuslineBlock({ summary: summaryOf(undefined, undefined), view, payload: parseClientPayload({}), terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, settings: resolveStatusline({ ...settings, context: { warnAt: CONTEXT_WARN_AT, criticalAt: CONTEXT_CRITICAL_AT, breakdown: "critical" }, bar: { gradient } }), ports: fakeStatuslinePorts() });
    // Between the context bar's own thresholds the fill holds the blend of the warning and critical colours, while its figures hold the band's warning colour.
    expect(render("use")).toContain(`${escapeOf(blendOf(WARNING, CRITICAL, betweenBands(CONTEXT_BETWEEN, CONTEXT_WARN_AT, CONTEXT_CRITICAL_AT)))}${FILL}`);
    expect(render("use")).toContain(`${escapeOf(WARNING)}55.0%${RESET}`);
    expect(stripAnsi(render("use"))).toBe(stripAnsi(render("off")));
  });

  it("approximates a named stop at the default RGB the xterm scheme gives it, and takes a palette index exactly as the table defines it", () => {
    expect(barOf(renderQuota(0, "use", { usage: "green", usageWarning: "#cdcd00", critical: "#ff0000" }))).toContain(`${ESCAPE}[38;2;0;205;0m`);
    expect(barOf(renderQuota(0, "use", { usage: 46, usageWarning: "#cdcd00", critical: "#ff0000" }))).toContain(`${ESCAPE}[38;2;0;255;0m`);
  });

  it("leaves a bar the band colours when a stop names no colour of its own", () => {
    const colours = { usage: "#00cd00", usageWarning: "#cdcd00", critical: "default" };
    expect(renderQuota(PAST_CRITICAL, "use", colours)).toBe(renderQuota(PAST_CRITICAL, "off", colours));
  });
});

describe("bar.gradient width", () => {
  it("colours each column of a full bar with its own escape, the ok colour at the first cell and the critical one at the last", () => {
    const line = renderQuota(FULL_PERCENT, "width");
    const runs = Array.from({ length: BASE_CELLS }, (_, column) => `${escapeOf(acrossBar(column, BASE_CELLS))}${FILL}`);
    expect(barOf(line)).toBe(`${runs.join("")}${EMPTY_COLOUR}${RESET}`);
    expect(new Set(runs).size).toBe(BASE_CELLS);
  });

  it("colours the drawn columns by where they sit across the bar, whatever the use, and the empty part keeps its own colour", () => {
    const line = renderQuota(HALF_IN_USE, "width");
    const runs = Array.from({ length: filledAt(HALF_IN_USE) }, (_, column) => `${escapeOf(acrossBar(column, BASE_CELLS))}${FILL}`);
    expect(barOf(line)).toBe(`${runs.join("")}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(HALF_IN_USE))}${RESET}`);
    expect(stripAnsi(line)).toBe(stripAnsi(renderQuota(HALF_IN_USE, "off")));
  });
});

describe("bar.gradient with colour off", () => {
  it("draws no escape in either mode", () => {
    for (const gradient of ["use", "width"] as const) {
      const line = renderQuota(BETWEEN_BANDS, gradient, HEX_COLOURS, { NO_COLOR: "1" });
      expect(line, gradient).not.toContain(ESCAPE);
      expect(stripAnsi(line)).toBe(stripAnsi(renderQuota(BETWEEN_BANDS, "off")));
    }
  });
});
