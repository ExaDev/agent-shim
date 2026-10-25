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
function baseBarLineWidth(used: number, cells: number = BASE_CELLS): number {
  return LABEL.length + (cells + BRACKETS) + ` ${used.toFixed(1)}% ${RESET_TEXT}`.length;
}

/** The cells a bar fills at a use, as the drawing rounds it. */
const filledAt = (used: number): number => Math.round((used / FULL_PERCENT) * BASE_CELLS);

/** The settings' stop colours as #rrggbb values, so each expected blend is an exact 24-bit sequence. A stop's own escape is told from a blend by the default named colours below, since a #rrggbb role's escape and a blend at 0 or 1 are the same bytes. */
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
function renderQuota(used: number, gradient: "off" | "use" | "width", colours: Readonly<NonNullable<StatuslineSettings["colours"]>> = HEX_COLOURS, env: Readonly<Record<string, string | undefined>> = {}, cells: number = BASE_CELLS): string {
  const lineWidth = baseBarLineWidth(used, cells);
  return renderStatuslineBlock({
    summary: summaryOf(used, undefined),
    view: NO_VIEW,
    payload: parseClientPayload({}),
    terminalWidth: lineWidth + RESERVED_COLUMNS,
    lineWidth,
    nowMs: NOW_MS,
    settings: resolveStatusline({ layout: { header: [], rows: ["quota"] }, colours, bar: { gradient, width: cells } }),
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
    const BELOW_WARNING = 35;
    const at = belowWarnAt(BELOW_WARNING, WARN_AT);
    const NAMED_GREEN_CHANNEL = 205;
    const FULL_CHANNEL = 255;
    const NAMED_OK: Rgb = [0, NAMED_GREEN_CHANNEL, 0];
    const INDEXED_OK: Rgb = [0, FULL_CHANNEL, 0];
    const GREEN_INDEX = 46;
    expect(barOf(renderQuota(BELOW_WARNING, "use", { usage: "green", usageWarning: "#cdcd00", critical: "#ff0000" }))).toContain(escapeOf(blendOf(NAMED_OK, WARNING, at)));
    expect(barOf(renderQuota(BELOW_WARNING, "use", { usage: GREEN_INDEX, usageWarning: "#cdcd00", critical: "#ff0000" }))).toContain(escapeOf(blendOf(INDEXED_OK, WARNING, at)));
  });

  it("leaves a bar the band colours when any of its three stops names no colour of its own", () => {
    for (const unset of ["default", "dim"] as const) {
      for (const role of ["usage", "usageWarning", "critical"] as const) {
        const colours = { ...HEX_COLOURS, [role]: unset };
        for (const used of [HALF_IN_USE, BETWEEN_BANDS, PAST_CRITICAL]) {
          expect(renderQuota(used, "use", colours), `${role} ${unset} at ${String(used)}%`).toBe(renderQuota(used, "off", colours));
        }
      }
    }
  });

  it("draws a bar whose small use fills no cell in the blend for that use under use, where the band mode draws the band's colour, when colours.empty names no colour", () => {
    const SMALL_USE = 3;
    const colours = { ...HEX_COLOURS, empty: "default" } as const;
    expect(filledAt(SMALL_USE)).toBe(0);
    expect(barOf(renderQuota(SMALL_USE, "use", colours))).toContain(`${escapeOf(blendOf(OK, WARNING, belowWarnAt(SMALL_USE, WARN_AT)))}${EMPTY}`);
    expect(barOf(renderQuota(SMALL_USE, "off", colours))).toContain(`${escapeOf(OK)}${EMPTY}`);
  });
});

describe("bar.gradient width", () => {
  it("colours each column of a full bar with its own escape, the ok colour at the first cell and the critical one at the last", () => {
    const line = renderQuota(FULL_PERCENT, "width");
    const runs = Array.from({ length: BASE_CELLS }, (_, column) => `${escapeOf(acrossBar(column, BASE_CELLS))}${FILL}`);
    expect(barOf(line)).toBe(`${runs.join("")}${EMPTY_COLOUR}${RESET}`);
    expect(new Set(runs).size).toBe(BASE_CELLS);
  });

  it("leaves a bar the band colours when its ok or critical stop names no colour of its own", () => {
    for (const unset of ["default", "dim"] as const) {
      for (const role of ["usage", "critical"] as const) {
        const colours = { ...HEX_COLOURS, [role]: unset };
        for (const used of [HALF_IN_USE, PAST_CRITICAL, FULL_PERCENT]) {
          expect(renderQuota(used, "width", colours), `${role} ${unset} at ${String(used)}%`).toBe(renderQuota(used, "off", colours));
        }
      }
    }
    // The warning colour is not a stop of a width bar, so it may name no colour without leaving the gradient.
    expect(renderQuota(FULL_PERCENT, "width", { ...HEX_COLOURS, usageWarning: "default" })).toBe(renderQuota(FULL_PERCENT, "width"));
  });

  it("draws a bar one cell wide in the ok colour, as it is both the first and the last cell", () => {
    expect(barOf(renderQuota(FULL_PERCENT, "width", HEX_COLOURS, {}, 1))).toBe(`${escapeOf(OK)}${FILL}${EMPTY_COLOUR}${RESET}`);
  });

  it("ends every coloured bar with a reset, so no colour runs on past it, whatever colours.empty is", () => {
    for (const gradient of ["off", "use", "width"] as const) {
      for (const empty of ["default", "dim", "brightBlack"] as const) {
        expect(renderQuota(HALF_IN_USE, gradient, { ...HEX_COLOURS, empty }), `${gradient} empty ${empty}`).toContain(`${RESET}]`);
      }
    }
  });

  it("draws a bar with no used cell as the band mode does, whatever colours.empty is", () => {
    for (const empty of ["default", "dim", "brightBlack"] as const) {
      const colours = { ...HEX_COLOURS, empty };
      expect(renderQuota(0, "width", colours), `empty ${empty}`).toBe(renderQuota(0, "off", colours));
    }
  });

  it("draws a bar whose small use fills no cell as the band mode does under width, whatever colours.empty is", () => {
    const SMALL_USE = 3;
    expect(filledAt(SMALL_USE)).toBe(0);
    for (const empty of ["default", "dim", "brightBlack"] as const) {
      const colours = { ...HEX_COLOURS, empty };
      expect(renderQuota(SMALL_USE, "width", colours), `empty ${empty}`).toBe(renderQuota(SMALL_USE, "off", colours));
    }
  });

  it("colours the drawn columns by where they sit across the bar, whatever the use, and the empty part keeps its own colour", () => {
    const line = renderQuota(HALF_IN_USE, "width");
    const runs = Array.from({ length: filledAt(HALF_IN_USE) }, (_, column) => `${escapeOf(acrossBar(column, BASE_CELLS))}${FILL}`);
    expect(barOf(line)).toBe(`${runs.join("")}${EMPTY_COLOUR}${EMPTY.repeat(BASE_CELLS - filledAt(HALF_IN_USE))}${RESET}`);
    expect(stripAnsi(line)).toBe(stripAnsi(renderQuota(HALF_IN_USE, "off")));
  });
});

/** The bytes the memory figure is measured against in the tests below: only the ratio of use to total reaches the bar. */
const MEMORY_TOTAL_BYTES = 100;
/** A pattern for the cells of a bar drawn in a 24-bit colour, each match one colour escape and the fill character it starts. */
const TRUE_COLOUR_FILL = new RegExp(`${String.fromCharCode(ESCAPE_CODE)}\\[38;2;[0-9;]+m${FILL}`, "g");

/** The memory row alone, at a use of `used` whole percent, with the usage roles set to the hex stops. */
function renderMemory(used: number, gradient: "off" | "use" | "width", colours: Readonly<NonNullable<StatuslineSettings["colours"]>> = HEX_COLOURS): string {
  return renderStatuslineBlock({
    summary: summaryOf(undefined, undefined),
    view: NO_VIEW,
    payload: parseClientPayload({}),
    terminalWidth: WIDE_TERMINAL,
    nowMs: NOW_MS,
    settings: resolveStatusline({ layout: { header: [], rows: ["memory"] }, colours, bar: { gradient } }),
    ports: fakeStatuslinePorts({ memoryUse: () => ({ usedBytes: (used / FULL_PERCENT) * MEMORY_TOTAL_BYTES, totalBytes: MEMORY_TOTAL_BYTES }) }),
  });
}

/** The context row alone, at a use of `used` whole percent, with the context role and the shared warning and critical roles set to the hex stops. */
function renderContext(used: number, gradient: "off" | "use" | "width", colours: Readonly<NonNullable<StatuslineSettings["colours"]>> = { context: HEX_COLOURS.usage, warning: HEX_COLOURS.usageWarning, critical: HEX_COLOURS.critical }): string {
  return renderStatuslineBlock({
    summary: summaryOf(undefined, undefined),
    view: { ...NO_VIEW, contextUsedPercentage: used, contextTotalTokens: used, contextWindowTokens: FULL_PERCENT },
    payload: parseClientPayload({}),
    terminalWidth: WIDE_TERMINAL,
    nowMs: NOW_MS,
    settings: resolveStatusline({ layout: { header: [], rows: ["context"] }, colours, bar: { gradient } }),
    ports: fakeStatuslinePorts(),
  });
}

/** A warning colour whose channels differ from the default yellow's, so a bar that blends towards the wrong warning role draws a different blend. */
const DISTINCT_WARNING_HEX = "#ff8000";
const DISTINCT_WARNING: Rgb = rgbOfHex(DISTINCT_WARNING_HEX);
/** A third colour for the role a bar must not blend towards. */
const OTHER_WARNING_HEX = "#0000ff";

describe("bar.gradient on every bar", () => {
  it("blends the context bar towards colours.warning and the quota bar towards colours.usageWarning, each ignoring the other's", () => {
    const contextLine = renderContext(HALF_IN_USE, "use", { context: HEX_COLOURS.usage, warning: DISTINCT_WARNING_HEX, usageWarning: OTHER_WARNING_HEX, critical: HEX_COLOURS.critical });
    expect(contextLine).toContain(`${escapeOf(blendOf(OK, DISTINCT_WARNING, belowWarnAt(HALF_IN_USE, WARN_AT)))}${FILL}`);
    const quotaBar = barOf(renderQuota(HALF_IN_USE, "use", { ...HEX_COLOURS, usageWarning: DISTINCT_WARNING_HEX, warning: OTHER_WARNING_HEX }));
    expect(quotaBar).toContain(escapeOf(blendOf(OK, DISTINCT_WARNING, belowWarnAt(HALF_IN_USE, WARN_AT))));
  });

  it("leaves the context bar the band colours when colours.context names no colour of its own, at every use", () => {
    for (const unset of ["default", "dim"] as const) {
      for (const used of [HALF_IN_USE, BETWEEN_BANDS, PAST_CRITICAL]) {
        const colours = { context: unset, warning: HEX_COLOURS.usageWarning, critical: HEX_COLOURS.critical };
        expect(renderContext(used, "use", colours), `${unset} at ${String(used)}`).toBe(renderContext(used, "off", colours));
      }
    }
  });

  it("colours the memory bar by its use under use, with the usage roles", () => {
    expect(renderMemory(HALF_IN_USE, "use")).toContain(`${escapeOf(blendOf(OK, WARNING, belowWarnAt(HALF_IN_USE, WARN_AT)))}${FILL}`);
    expect(stripAnsi(renderMemory(HALF_IN_USE, "use"))).toBe(stripAnsi(renderMemory(HALF_IN_USE, "off")));
  });

  it("colours the memory bar across its width under width, the ok colour at its first cell and the critical one at its last", () => {
    const line = renderMemory(FULL_PERCENT, "width");
    expect(line).toContain(`${escapeOf(OK)}${FILL}`);
    expect(line).toContain(`${escapeOf(CRITICAL)}${FILL}`);
    expect(new Set(line.match(TRUE_COLOUR_FILL)).size).toBeGreaterThan(2);
  });

  it("leaves the memory bar in the band's single colour while the gradient is off", () => {
    expect(renderMemory(FULL_PERCENT, "off", {})).not.toContain(`${ESCAPE}[38;2;`);
  });

  it("colours the context bar across its width under width, the ok colour at its first cell and the critical one at its last", () => {
    const line = renderContext(FULL_PERCENT, "width");
    expect(line).toContain(`${escapeOf(OK)}${FILL}`);
    expect(line).toContain(`${escapeOf(CRITICAL)}${FILL}`);
    expect(new Set(line.match(TRUE_COLOUR_FILL)).size).toBeGreaterThan(2);
    expect(stripAnsi(line)).toBe(stripAnsi(renderContext(FULL_PERCENT, "off")));
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

describe("bar.gradient with the default named colours", () => {
  /** The escape sequences of a bar, in the order it draws them. */
  const escapesOf = (bar: string): readonly string[] => bar.match(ANSI_ESCAPE) ?? [];
  /** The one colour escape the bands mode draws a bar's fill in at a use. */
  const bandEscapeAt = (used: number): string | undefined => escapesOf(barOf(renderQuota(used, "off", {})))[0];

  it("under use, draws the band's own escape at none in use, at each threshold and above the critical one, and a 24-bit blend between", () => {
    for (const used of [0, WARN_AT, CRITICAL_AT, PAST_CRITICAL, FULL_PERCENT]) {
      expect(escapesOf(barOf(renderQuota(used, "use", {})))[0], `at ${String(used)}%`).toBe(bandEscapeAt(used));
    }
    expect(escapesOf(barOf(renderQuota(HALF_IN_USE, "use", {})))[0]).toMatch(new RegExp(`^${ESCAPE}\\[38;2;`));
    expect(escapesOf(barOf(renderQuota(HALF_IN_USE, "use", {})))[0]).not.toBe(bandEscapeAt(HALF_IN_USE));
  });

  it("under width, draws the ok role's own escape at the first cell and the critical role's at the last", () => {
    const escapes = escapesOf(barOf(renderQuota(FULL_PERCENT, "width", {})));
    expect(escapes[0]).toBe(bandEscapeAt(0));
    expect(escapes[BASE_CELLS - 1]).toBe(bandEscapeAt(FULL_PERCENT));
    expect(escapes[1]).toMatch(new RegExp(`^${ESCAPE}\\[38;2;`));
  });
});
