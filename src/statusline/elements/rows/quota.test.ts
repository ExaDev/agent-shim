import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../../config/statusline";
import { ESCAPE, visibleLength } from "../../ansi";
import type { StatuslineSummary } from "../../enrich";
import { parseClientPayload } from "../../payload";
import { renderStatuslineBlock, RESERVED_COLUMNS } from "../../render";
import { MIN_STATUSLINE_COLUMNS as MINIMUM_LINE_COLUMNS } from "../../../config/statusline";
import { fakeStatuslinePorts } from "../../testing";

const NOW_MS = Date.parse("2026-10-16T09:00:00.000Z");
const TERMINAL = 170;
/** Narrow enough that three windows of text cannot share a line, and wide enough for any one of them. */
const NARROW_TERMINAL = 40;
/** How much narrower than the narrow terminal the too-narrow one is, and the use shown in the window too wide for it. */
const WIDTH_REMOVED = 20;
const WINDOW_USED = 60;
const NARROW_USABLE_COLUMNS = NARROW_TERMINAL - RESERVED_COLUMNS;
const NO_VIEW = { clientModelName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined };

const SUMMARY: StatuslineSummary = {
  identity: undefined,
  provider: undefined,
  providerAccountEmail: undefined,
  providerAccountSub: undefined,
  providerPlan: undefined,
  loginAccountEmail: undefined,
  loginRateLimitTier: undefined,
  loginOrganizationName: undefined,
  loginOrganizationType: undefined,
  loginSeatTier: undefined,
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
  fiveHourUsed: 25,
  fiveHourResetAt: "2026-10-16T10:30:00.000Z",
  sevenDayUsed: 40,
  sevenDayResetAt: "2026-10-20T10:30:00.000Z",
};

/** The characters a bar is drawn with by default. */
const FILLED = "\u2588";
const EMPTY = "\u2591";
/** How many cells of a default bar at the test terminal's width are filled and empty for the five-hour and weekly windows. */
const FIVE_HOUR_FILLED = 16;
const FIVE_HOUR_EMPTY = 46;
const WEEK_FILLED = 25;
const WEEK_EMPTY = 37;
/** The environment of a test that reads text, not colour. */
const PLAIN = { NO_COLOR: "1" };
const COLOURED = {};

const MODEL_SCOPED_PAYLOAD = { rate_limits: { model_scoped: [{ display_name: "Fable", utilization: 60, resets_at: "2026-10-19T09:00:00.000Z" }] } };

/** The usage settings the tests of one setting hold fixed beneath the settings they name, so each exercises that setting alone: the reset time bare, the weekly window drawn whatever its use, and no per-model windows. The defaults themselves are pinned by the tests of the default row. */
const HELD_USAGE = { resetLabel: false, sevenDayThreshold: 0, modelScoped: false } as const;

/** The quota row's lines under exactly the settings given, over the defaults. */
function defaultQuotaLines(settings: StatuslineSettings, summary: Partial<StatuslineSummary> = {}, payload: unknown = {}, env: Readonly<Record<string, string | undefined>> = PLAIN, terminalWidth: number = TERMINAL): string[] {
  const output = renderStatuslineBlock({
    summary: { ...SUMMARY, ...summary },
    view: NO_VIEW,
    payload: parseClientPayload(payload),
    terminalWidth,
    nowMs: NOW_MS,
    settings: resolveStatusline({ ...settings, layout: { header: [], rows: ["quota"] } }),
    ports: fakeStatuslinePorts({ env }),
  });
  return output === "" ? [] : output.split("\n");
}

/** The quota row's lines under the settings given, laid over `HELD_USAGE`. */
function quotaLines(settings: StatuslineSettings, summary: Partial<StatuslineSummary> = {}, payload: unknown = {}, env: Readonly<Record<string, string | undefined>> = PLAIN, terminalWidth: number = TERMINAL): string[] {
  return defaultQuotaLines({ ...settings, usage: { ...HELD_USAGE, ...settings.usage } }, summary, payload, env, terminalWidth);
}

describe("the quota row's usage settings", () => {
  it("draws a bar per window with the figure and the bare time left under the held usage settings", () => {
    const lines = quotaLines({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`5h [${FILLED.repeat(FIVE_HOUR_FILLED)}${EMPTY.repeat(FIVE_HOUR_EMPTY)}] 25.0% (1h 30m) | Wk [${FILLED.repeat(WEEK_FILLED)}${EMPTY.repeat(WEEK_EMPTY)}] 40.0% (4d 1h)`);
  });

  it("by default introduces the reset with its words and hides a weekly window below claude-hud's weekly threshold when a five-hour window is drawn beside it", () => {
    expect(defaultQuotaLines({ usage: { bar: false } })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, { sevenDayUsed: 80 })).toEqual(["5h 25.0% (resets in 1h 30m) | Wk 80.0% (resets in 4d 1h)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, { sevenDayUsed: 79 })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
  });

  it("draws no subscription window for a Bedrock session that selected no provider, by the environment switch or by the model id", () => {
    // The subscription's windows do not apply to a session billed by use, and a window drawn from the identity's recorded usage would describe quota the session does not spend.
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, {}, { ...PLAIN, CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual([]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, { model: { id: "us.anthropic.claude-opus-4-5-v1:0" } })).toEqual([]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, { model: { id: "claude-opus-4-5" } })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, {}, { ...PLAIN, CLAUDE_CODE_USE_VERTEX: "1" })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, { sevenDayUsed: 80 }, MODEL_SCOPED_PAYLOAD, { ...PLAIN, CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual([]);
  });

  it("still draws a model family's windows and a selected provider's own for a Bedrock session, in whatever form the provider reports them, since none is a subscription window", () => {
    const bedrock = { ...PLAIN, CLAUDE_CODE_USE_BEDROCK: "1" };
    const families = [{ measures: "Gemini", utilization: 0.5, resetsAt: "2026-10-16T10:30:00.000Z" }];
    const providerWindows = [{ measures: "tokens", utilization: 0.5, resetsAt: "2026-10-16T10:30:00.000Z", periodMs: 18_000_000 }];
    expect(defaultQuotaLines({ usage: { bar: false } }, { quotaFamilies: families, fiveHourUsed: undefined, sevenDayUsed: undefined }, {}, bedrock)).toEqual(["Gemini 50.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, { providerQuotaWindows: providerWindows, provider: "z.ai", fiveHourUsed: undefined, sevenDayUsed: undefined }, {}, bedrock)).toEqual(["tokens 50.0% (resets in 1h 30m)"]);
    // A provider that reports its five-hour and weekly windows in the unified form (a codex provider does) holds them in the summary's five-hour and weekly fields; they are the provider's, not the account's, so the Bedrock hide leaves them.
    expect(defaultQuotaLines({ usage: { bar: false } }, { provider: "codexprov" }, {}, bedrock)).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, {}, bedrock)).toEqual([]);
  });

  it("hides the subscription windows for a Bedrock session only when the client is Claude Code, not for an Antigravity client", () => {
    // The switch is Claude Code's; an Antigravity client's own quota windows still draw whatever is exported for Claude Code.
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, { product: "antigravity" }, { ...PLAIN, CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, { product: "antigravity", model: { id: "us.anthropic.claude-opus-4-5-v1:0" } })).toEqual(["5h 25.0% (resets in 1h 30m)"]);
    expect(defaultQuotaLines({ usage: { bar: false } }, {}, {}, { ...PLAIN, CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual([]);
  });

  it("by default draws the per-model weekly windows after the account's own", () => {
    expect(defaultQuotaLines({ usage: { bar: false } }, { sevenDayUsed: 80 }, MODEL_SCOPED_PAYLOAD)).toEqual(["5h 25.0% (resets in 1h 30m) | Wk 80.0% (resets in 4d 1h) | Fable 60.0% (resets in 3d 0h)"]);
    expect(defaultQuotaLines({}, {}, MODEL_SCOPED_PAYLOAD)[0]).toMatch(/^5h \[.*\] 25\.0% \(resets in 1h 30m\) \| Fable \[.*\] 60\.0% \(resets in 3d 0h\)$/u);
  });

  it("writes the share left instead of the share used with usage.value, and keeps the bar and colour on the share used", () => {
    const [plain] = quotaLines({ usage: { value: "remaining" } });
    expect(plain).toContain("75.0% (1h 30m)");
    expect(plain).toContain("60.0% (4d 1h)");
    const filled = (line: string | undefined): number => (line ?? "").split("\u2588").length - 1;
    expect(filled(plain)).toBe(filled(quotaLines({})[0]));
    // 25% used is past the warning threshold of 20, so the figure is yellow although it is the share left that is drawn.
    const [coloured] = quotaLines({ usage: { value: "remaining" }, bands: { warnAt: 20, criticalAt: 30 } }, {}, {}, COLOURED);
    expect(coloured).toContain(`${ESCAPE}[33m75.0%`);
  });

  it("draws text alone, a window after another on one line, when usage.bar is off", () => {
    expect(quotaLines({ usage: { bar: false } })).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)"]);
  });

  it("draws one compact line when usage.compact is on, whatever usage.bar says", () => {
    expect(quotaLines({ usage: { compact: true } })).toEqual(["5h: 25.0% (1h 30m) | Wk: 40.0% (4d 1h)"]);
    expect(quotaLines({ usage: { compact: true, bar: true } })).toEqual(["5h: 25.0% (1h 30m) | Wk: 40.0% (4d 1h)"]);
    expect(quotaLines({ usage: { compact: true, resetLabel: true } })).toEqual(["5h: 25.0% (1h 30m) | Wk: 40.0% (4d 1h)"]);
  });

  it("introduces a reset with its words when usage.resetLabel is on, and uses 'resets' alone before a wall-clock time", () => {
    expect(quotaLines({ usage: { bar: false, resetLabel: true } })).toEqual(["5h 25.0% (resets in 1h 30m) | Wk 40.0% (resets in 4d 1h)"]);
    expect(quotaLines({ usage: { bar: false, resetLabel: true, timeFormat: "absolute" } })).toEqual(["5h 25.0% (resets at 10:30) | Wk 40.0% (resets at 20 Oct 10:30)"]);
    expect(quotaLines({ usage: { bar: false, resetLabel: true, timeFormat: "both" } })).toEqual(["5h 25.0% (resets in 1h 30m, at 10:30) | Wk 40.0% (resets in 4d 1h, at 20 Oct 10:30)"]);
  });

  it("leaves the words off a share elapsed, and off a window with nothing still to reset", () => {
    expect(quotaLines({ usage: { bar: false, resetLabel: true, timeFormat: "elapsed" } })).toEqual(["5h 25.0% (70% elapsed) | Wk 40.0% (42% elapsed)"]);
    expect(quotaLines({ usage: { bar: false, resetLabel: true }, labels: {} }, { fiveHourResetAt: "2026-10-16T08:00:00.000Z" })[0]).toMatch(/^5h 25\.0% \(available\) \|/u);
  });

  it("tells wall-clock times under the clock settings", () => {
    expect(quotaLines({ usage: { bar: false, timeFormat: "absolute" }, clock: { hourCycle: "h12", seconds: true } })).toEqual(["5h 25.0% (at 10:30:00 am) | Wk 40.0% (at 20 Oct 10:30:00 am)"]);
  });

  it("draws the weekly window only from usage.sevenDayThreshold when a five-hour window is beside it", () => {
    expect(quotaLines({ usage: { bar: false, sevenDayThreshold: 41 } })).toEqual(["5h 25.0% (1h 30m)"]);
    expect(quotaLines({ usage: { bar: false, sevenDayThreshold: 40 } })).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)"]);
  });

  it("never hides a weekly window that has no five-hour window beside it by usage.sevenDayThreshold, whatever that is", () => {
    expect(quotaLines({ usage: { bar: false, sevenDayThreshold: 90 } }, { fiveHourUsed: undefined })).toEqual(["Wk 40.0% (4d 1h)"]);
  });

  it("draws nothing until a window has reached usage.threshold, counting the weekly window it hides", () => {
    expect(quotaLines({ usage: { threshold: 41 } })).toEqual([]);
    expect(quotaLines({ usage: { threshold: 41, bar: false, sevenDayThreshold: 90 } })).toEqual([]);
    expect(quotaLines({ usage: { threshold: 40, bar: false, sevenDayThreshold: 90 } })).toEqual(["5h 25.0% (1h 30m)"]);
  });

  it("keeps the colour bands independent of the thresholds that decide what is drawn", () => {
    const [line] = quotaLines({ usage: { threshold: 10 }, bands: { warnAt: 20, criticalAt: 30 } }, {}, {}, COLOURED);
    expect(line).toContain(`${ESCAPE}[33m25.0%`);
    expect(line).toContain(`${ESCAPE}[31m40.0%`);
  });
});

describe("the per-model weekly windows", () => {
  it("draw only when usage.modelScoped is on, after the account's own windows", () => {
    expect(quotaLines({ usage: { bar: false } }, {}, MODEL_SCOPED_PAYLOAD)).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)"]);
    expect(quotaLines({ usage: { bar: false, modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD)).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h) | Fable 60.0% (3d 0h)"]);
  });

  it("draw as a bar of their own, and in the compact line", () => {
    expect(quotaLines({ usage: { modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD)[0]).toMatch(/Fable \[.*\] 60\.0% \(3d 0h\)$/u);
    expect(quotaLines({ usage: { modelScoped: true, compact: true } }, {}, MODEL_SCOPED_PAYLOAD)).toEqual(["5h: 25.0% (1h 30m) | Wk: 40.0% (4d 1h) | Fable: 60.0% (3d 0h)"]);
  });

  it("count towards usage.threshold, and are not hidden by usage.sevenDayThreshold", () => {
    expect(quotaLines({ usage: { bar: false, modelScoped: true, threshold: 50, sevenDayThreshold: 90 } }, {}, MODEL_SCOPED_PAYLOAD)).toEqual(["5h 25.0% (1h 30m) | Fable 60.0% (3d 0h)"]);
  });

  it("show the share of the weekly window gone, and are left out for a session that selected a provider", () => {
    expect(quotaLines({ usage: { bar: false, modelScoped: true, timeFormat: "elapsed" } }, {}, MODEL_SCOPED_PAYLOAD)[0]).toMatch(/Fable 60\.0% \(57% elapsed\)$/u);
    expect(quotaLines({ usage: { bar: false, modelScoped: true } }, { provider: "z.ai" }, MODEL_SCOPED_PAYLOAD)).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)"]);
  });

  it("keep a name's emoji sequences whole when it is cut to a label's width", () => {
    const payload = { rate_limits: { model_scoped: [{ display_name: "\u{1F469}\u200D\u{1F4BB} code review assistant", utilization: 10, resets_at: "2026-10-19T09:00:00.000Z" }] } };
    expect(quotaLines({ usage: { bar: false, modelScoped: true } }, { fiveHourUsed: undefined, sevenDayUsed: undefined }, payload)).toEqual(["\u{1F469}\u200D\u{1F4BB} code revi 10.0% (3d 0h)"]);
  });

  it("skip a window whose name is nothing a person can see, and strip what is invisible from one that has more", () => {
    const named = (display_name: string) => ({ rate_limits: { model_scoped: [{ display_name, utilization: 10, resets_at: "2026-10-19T09:00:00.000Z" }] } });
    const lines = (name: string): string[] => quotaLines({ usage: { bar: false, modelScoped: true } }, { fiveHourUsed: undefined, sevenDayUsed: undefined }, named(name));
    for (const invisible of ["\u200B", "\u2060", "\u2028", "\u200D", " \u200B\u3000 ", `${ESCAPE}]0;title only`]) {
      expect(lines(invisible), JSON.stringify(invisible)).toEqual([]);
    }
    expect(lines("Fa\u200Bble\u2028!")).toEqual(["Fable! 10.0% (3d 0h)"]);
    expect(lines("Claude\u00A0Opus")).toEqual(["Claude Opus 10.0% (3d 0h)"]);
    expect(lines("Fa\u200Crsi")).toEqual(["Fa\u200Crsi 10.0% (3d 0h)"]);
    expect(lines(`Fable${ESCAPE}]0;never terminated`)).toEqual(["Fable 10.0% (3d 0h)"]);
  });

  it("cut a name to the columns a label may take, so a wide character counts for two and a flag stays whole", () => {
    const named = (display_name: string) => ({ rate_limits: { model_scoped: [{ display_name, utilization: 10, resets_at: "2026-10-19T09:00:00.000Z" }] } });
    const lines = (name: string): string[] => quotaLines({ usage: { bar: false, modelScoped: true } }, { fiveHourUsed: undefined, sevenDayUsed: undefined }, named(name));
    expect(lines("\u65E5\u672C\u8A9E\u65E5\u672C\u8A9E\u65E5\u672C")).toEqual(["\u65E5\u672C\u8A9E\u65E5\u672C\u8A9E 10.0% (3d 0h)"]);
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(lines(`${england} Opus`)).toEqual([`${england} Opus 10.0% (3d 0h)`]);
  });

  it("draw a name with its control characters stripped and cut to a label's width, and skip a window with no name or figure", () => {
    const payload = {
      rate_limits: {
        model_scoped: [
          { display_name: `A${ESCAPE}[2Jvery long model name`, utilization: 10, resets_at: "2026-10-19T09:00:00.000Z" },
          { display_name: "", utilization: 10 },
          { display_name: "No figure" },
        ],
      },
    };
    const lines = quotaLines({ usage: { bar: false, modelScoped: true } }, { fiveHourUsed: undefined, sevenDayUsed: undefined }, payload);
    expect(lines).toEqual(["Avery long m 10.0% (3d 0h)"]);
  });
});

describe("the quota row for windows other than the account's own", () => {
  const FAMILIES = [
    { measures: "Gemini", utilization: 0.5, resetsAt: "2026-10-16T10:30:00.000Z" },
    { measures: "Argon", utilization: 0.2, resetsAt: undefined },
  ];

  it("applies the figure and reset settings to every family's window, which have no known length, and never hides one by the weekly threshold", () => {
    expect(quotaLines({ usage: { bar: false, value: "remaining", timeFormat: "elapsedAndAbsolute", sevenDayThreshold: 100 } }, { quotaFamilies: FAMILIES, fiveHourUsed: undefined, sevenDayUsed: undefined })).toEqual(["Gemini 50.0% (at 10:30) | Argon 80.0%"]);
  });

  it("applies the settings to a provider's own windows, whose length the provider reports", () => {
    const windows = [{ measures: "tokens", utilization: 0.5, resetsAt: "2026-10-16T10:30:00.000Z", periodMs: 18_000_000 }];
    expect(quotaLines({ usage: { bar: false, timeFormat: "elapsed" } }, { providerQuotaWindows: windows, provider: "z.ai", fiveHourUsed: undefined, sevenDayUsed: undefined })).toEqual(["tokens 50.0% (70% elapsed)"]);
  });
});

describe("the quota row drawn as text on a narrow terminal", () => {
  const WIDE_WINDOWS = { usage: { bar: false, modelScoped: true } };

  it("breaks the windows onto as many lines as the width needs, a separator between neighbours on a line", () => {
    const lines = quotaLines(WIDE_WINDOWS, {}, MODEL_SCOPED_PAYLOAD, PLAIN, NARROW_TERMINAL);
    expect(lines).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)", "Fable 60.0% (3d 0h)"]);
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(NARROW_USABLE_COLUMNS);
    }
  });

  it("breaks the compact line the same way, which is longer and so takes a line for each window here", () => {
    expect(quotaLines({ usage: { compact: true, modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD, PLAIN, NARROW_TERMINAL)).toEqual(["5h: 25.0% (1h 30m)", "Wk: 40.0% (4d 1h)", "Fable: 60.0% (3d 0h)"]);
  });

  it("draws one line when the windows fit it", () => {
    expect(quotaLines(WIDE_WINDOWS, {}, MODEL_SCOPED_PAYLOAD, PLAIN, TERMINAL)).toHaveLength(1);
  });
});

describe("the quota row's text lines measured in columns", () => {
  const ONE_WINDOW = { fiveHourUsed: undefined, sevenDayUsed: undefined, fiveHourResetAt: undefined, sevenDayResetAt: undefined };
  const named = (display_name: string, utilization = 10) => ({ rate_limits: { model_scoped: [{ display_name, utilization, resets_at: "2026-10-19T09:00:00.000Z" }] } });
  const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");

  it("packs windows by the columns they draw, which a wide character doubles", () => {
    // Two columns each for two characters: the part is 18 columns but 16 UTF-16 units, and with the 17-column five-hour window and the separator it is 38 columns against 36 usable.
    const wide = quotaLines({ usage: { bar: false, modelScoped: true } }, {}, named("\u65E5\u672C"), PLAIN, NARROW_TERMINAL);
    expect(wide).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)", "\u65E5\u672C 10.0% (3d 0h)"]);
    expect(quotaLines({ usage: { bar: false, modelScoped: true, sevenDayThreshold: 100 } }, {}, named("\u65E5\u672C"), PLAIN, NARROW_TERMINAL)).toEqual(["5h 25.0% (1h 30m)", "\u65E5\u672C 10.0% (3d 0h)"]);
  });

  it("counts a joined emoji sequence as the cells it draws, not its code units", () => {
    // One emoji is two columns (five UTF-16 units), so the part is 16 columns and shares a line with the 17-column window within 36.
    const technologist = "\u{1F469}\u200D\u{1F4BB}";
    expect(quotaLines({ usage: { bar: false, modelScoped: true, sevenDayThreshold: 100 } }, {}, named(technologist), PLAIN, NARROW_TERMINAL)).toEqual([`5h 25.0% (1h 30m) | ${technologist} 10.0% (3d 0h)`]);
  });

  it("packs coloured windows by what they draw, whatever escapes they carry", () => {
    const coloured = quotaLines({ usage: { bar: false, modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD, COLOURED, NARROW_TERMINAL);
    expect(coloured.some((line) => line.includes(ESCAPE))).toBe(true);
    expect(coloured.map(stripAnsi)).toEqual(["5h 25.0% (1h 30m) | Wk 40.0% (4d 1h)", "Fable 60.0% (3d 0h)"]);
  });

  it("draws a window wider than the line whole, on a line of its own", () => {
    const lines = quotaLines({ usage: { bar: false, modelScoped: true } }, ONE_WINDOW, named("Longer label", WINDOW_USED), PLAIN, NARROW_TERMINAL - WIDTH_REMOVED);
    expect(lines).toEqual(["Longer label 60.0% (3d 0h)"]);
    expect(visibleLength(lines[0] ?? "")).toBeGreaterThan(NARROW_TERMINAL - WIDTH_REMOVED - RESERVED_COLUMNS);
  });

  it("keeps a floor under the width, however narrow the terminal", () => {
    const atFloor = quotaLines({ usage: { bar: false, modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD, PLAIN, MINIMUM_LINE_COLUMNS + RESERVED_COLUMNS);
    expect(atFloor).toEqual(["5h 25.0% (1h 30m)", "Wk 40.0% (4d 1h)", "Fable 60.0% (3d 0h)"]);
    expect(quotaLines({ usage: { bar: false, modelScoped: true } }, {}, MODEL_SCOPED_PAYLOAD, PLAIN, 1)).toEqual(atFloor);
  });
});
