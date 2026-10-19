import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../../config/statusline";
import { ESCAPE } from "../../ansi";
import type { StatuslineSummary } from "../../enrich";
import { parseClientPayload } from "../../payload";
import { renderStatuslineBlock } from "../../render";
import { fakeStatuslinePorts } from "../../testing";

const NOW_MS = Date.parse("2026-10-16T09:00:00.000Z");
const TERMINAL = 170;
const NO_VIEW = { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined };

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

/** The environment of a test that reads text, not colour. */
const PLAIN = { NO_COLOR: "1" };
const COLOURED = {};

const MODEL_SCOPED_PAYLOAD = { rate_limits: { model_scoped: [{ display_name: "Fable", utilization: 60, resets_at: "2026-10-19T09:00:00.000Z" }] } };

function quotaLines(settings: StatuslineSettings, summary: Partial<StatuslineSummary> = {}, payload: unknown = {}, env: Readonly<Record<string, string | undefined>> = PLAIN): string[] {
  const output = renderStatuslineBlock({
    summary: { ...SUMMARY, ...summary },
    view: NO_VIEW,
    payload: parseClientPayload(payload),
    terminalWidth: TERMINAL,
    nowMs: NOW_MS,
    settings: resolveStatusline({ ...settings, layout: { header: [], rows: ["quota"] } }),
    ports: fakeStatuslinePorts({ env }),
  });
  return output === "" ? [] : output.split("\n");
}

describe("the quota row's usage settings", () => {
  it("draws a bar per window with the figure and the time left by default", () => {
    const lines = quotaLines({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^5h \[.*\] 25\.0% \(1h 30m\) \| Wk \[.*\] 40\.0% \(4d 1h\)$/u);
  });

  it("writes the share left instead of the share used with usage.value, and keeps the bar and colour on the share used", () => {
    const [plain] = quotaLines({ usage: { value: "remaining" } });
    expect(plain).toContain("75.0% (1h 30m)");
    expect(plain).toContain("60.0% (4d 1h)");
    const filled = (line: string | undefined): number => (line ?? "").split("█").length - 1;
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

  it("always draws a weekly window that has no five-hour window beside it, whatever usage.sevenDayThreshold is", () => {
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
    expect(lines).toEqual(["A[2Jvery lon 10.0% (3d 0h)"]);
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
