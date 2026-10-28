import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "../../../usage/pick";
import type { BarCell } from "../../barGrid";
import { leadingGraphemes } from "../../graphemes";
import { packLines, SEPARATOR } from "../../headerLayout";
import { paintCore } from "../../messages/around";
import { writtenPercent } from "../../percent";
import { hidesSubscriptionWindows, platformInputsOf } from "../../platform";
import { formatResetTime } from "../../resetTime";
import { visibleDisplayText } from "../../sanitise";
import { barCell, FULL_PERCENT, statusColor, withColor, type BarStyle } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput } from "../context";

/** One quota window as the row draws it: how much of it is used, as a fraction (undefined for a per-model window the client reports with a null, missing or non-numeric figure, which is drawn as `--`), and when it resets. */
interface QuotaWindowView {
  readonly label: string;
  readonly fraction: number | undefined;
  readonly resetsAt: string | undefined;
  /** The window's length, when it is known: the share of it already gone needs it. */
  readonly periodMs: number | undefined;
  /** Whether this is the weekly window of the unified pair, whoever reports it, the one `usage.sevenDayThreshold` can hide. */
  readonly weekly: boolean;
}

/** Characters a person sees in a per-model window's name that are kept, at least as many as claude-hud keeps (it cuts at 64 UTF-16 units); the client names these windows, so their names are not held to the columns a configured label takes. */
const MODEL_WINDOW_NAME_CHARACTERS = 64;

/** A per-model window's name as text a terminal draws as it stands and a person can read, cut to those characters between the ones a person sees, so an emoji sequence stays whole; empty when nothing visible is left. */
function modelWindowName(name: string): string {
  return leadingGraphemes(visibleDisplayText(name), MODEL_WINDOW_NAME_CHARACTERS).join("").trim();
}

/** The per-model weekly windows the client's payload carries, read only for a session whose quota is the signed-in account's: a window with no name is not one to draw, and one with a null, missing or non-numeric figure is drawn without a share (`--`), since its reset still says something: claude-hud draws a null one so and skips the others, so this draws one more window than it does. */
function modelScopedWindows({ payload }: RenderContext): readonly QuotaWindowView[] {
  return (payload.rate_limits?.model_scoped ?? []).flatMap((window) => {
    const label = modelWindowName(window.display_name ?? "");
    if (label === "") {
      return [];
    }
    const fraction = window.utilization !== undefined && Number.isFinite(window.utilization) ? Math.max(0, Math.min(FULL_PERCENT, window.utilization)) / FULL_PERCENT : undefined;
    return [{ label, fraction, resetsAt: window.resets_at, periodMs: SEVEN_DAY_WINDOW_MS, weekly: false }];
  });
}

/** The five-hour and weekly windows of the unified pair, whoever reports them (the client's payload, the identity's recorded usage or a selected provider), with the per-model weekly ones when asked for and the session selected no provider. None for a Bedrock session that selected no provider (`hidesSubscriptionWindows`: the Bedrock switch on, or a Bedrock model id, for a client that is not the Antigravity CLI), which spends none of them; the windows a provider session holds are that provider's. */
function unifiedWindows(context: RenderContext): { readonly unified: readonly QuotaWindowView[]; readonly modelScoped: readonly QuotaWindowView[] } {
  const { summary, settings } = context;
  const inputs = platformInputsOf(context.payload, context.ports.env, context.payload.model?.id);
  // A session that selected a provider holds that provider's own windows (a codex provider reports its five-hour and weekly ones in the unified form), so the hide does not reach them: a Bedrock session has no subscription window only when it selected no provider.
  if (summary.provider === undefined && hidesSubscriptionWindows(inputs.env, inputs.modelId)) {
    return { unified: [], modelScoped: [] };
  }
  const unified: QuotaWindowView[] = [];
  if (summary.fiveHourUsed !== undefined) {
    unified.push({ label: settings.labels.fiveHour === "" ? context.t("quota.fiveHour") : settings.labels.fiveHour, fraction: summary.fiveHourUsed / FULL_PERCENT, resetsAt: summary.fiveHourResetAt, periodMs: FIVE_HOUR_WINDOW_MS, weekly: false });
  }
  if (summary.sevenDayUsed !== undefined) {
    unified.push({ label: settings.labels.sevenDay === "" ? context.t("quota.sevenDay") : settings.labels.sevenDay, fraction: summary.sevenDayUsed / FULL_PERCENT, resetsAt: summary.sevenDayResetAt, periodMs: SEVEN_DAY_WINDOW_MS, weekly: true });
  }
  // The payload's windows describe the account the session is signed in as, which a session that selected a provider does not spend.
  return { unified, modelScoped: settings.usage.modelScoped && summary.provider === undefined ? modelScopedWindows(context) : [] };
}

/** Every window the quota row can draw, before the thresholds choose among them: every model family's window for an account whose limits are per family, else the unified windows (`unifiedWindows`: none for a Bedrock session that selected no provider) with, when neither the five-hour nor the weekly window is reported, a provider's own windows. A Bedrock session still draws a model family's windows and a provider's own, which are not subscription windows. */
function candidateWindows(context: RenderContext): readonly QuotaWindowView[] {
  const { summary } = context;
  if (summary.quotaFamilies.length > 0) {
    // An Antigravity account's limits are per model family, so every family's window is drawn whichever model is in use.
    return summary.quotaFamilies.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: undefined, weekly: false }));
  }
  const { unified, modelScoped } = unifiedWindows(context);
  // A provider outside Anthropic's unified rate-limit family (z.ai) reports its usage only through its own quota windows, which are drawn when neither the five-hour nor the weekly window is reported.
  const providerWindows = unified.length > 0 ? [] : summary.providerQuotaWindows.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: window.periodMs, weekly: false }));
  return [...unified, ...providerWindows, ...modelScoped];
}

/** Digits a reported percentage is kept to when it is rounded to a whole number: enough decimal places to keep every figure a client reports, and stopping far short of where the representation error of dividing by 100 and multiplying back (about the fourteenth place) appears, which would put a half such as 56.5 a hair under itself. */
const REPORTED_PERCENT_DIGITS = 9;

/** The whole percentage a window's fraction stands for, rounded as claude-hud rounds the percentage it is given (half up), whatever representation error the division by 100 left in the fraction. */
function wholePercentOf(fraction: number): number {
  return Math.round(Number((fraction * FULL_PERCENT).toFixed(REPORTED_PERCENT_DIGITS)));
}

/** The windows to draw (`candidateWindows`, so no subscription window for a Bedrock session): none when no window has used `usage.threshold` yet, and without the weekly window when a five-hour one is drawn beside it and the weekly use is below `usage.sevenDayThreshold`. Both compare the use rounded to a whole percentage, as claude-hud rounds the figures it compares, so a use within half a point below a threshold counts as at it. */
function visibleWindows(context: RenderContext): readonly QuotaWindowView[] {
  const { summary, settings } = context;
  const candidates = candidateWindows(context);
  const mostUsed = Math.max(0, ...candidates.map((window) => (window.fraction === undefined ? 0 : wholePercentOf(window.fraction))));
  if (mostUsed < settings.usage.threshold) {
    return [];
  }
  const hidesWeekly = summary.fiveHourUsed !== undefined && summary.sevenDayUsed !== undefined && Math.round(summary.sevenDayUsed) < settings.usage.sevenDayThreshold;
  return hidesWeekly ? candidates.filter((window) => !window.weekly) : candidates;
}

/** What a window with no usable figure is drawn with in place of its share. */
const NO_FIGURE = "--";

/** A window's figure and reset as the row's settings write them. The share is coloured by the window's use whichever way it is written. `reset` is empty when the window has nothing to say about its reset, and `plainReset` is the same reset without the words that introduce it, which the compact form draws. */
function figuresOf(window: QuotaWindowView, context: RenderContext, style: BarStyle): { readonly value: string; readonly reset: string; readonly plainReset: string } {
  const { settings, nowMs, ports } = context;
  const reset = formatResetTime(window, nowMs, settings, ports.clock, context.t, settings.usage.resetLabel).text;
  const plainReset = settings.usage.resetLabel ? formatResetTime(window, nowMs, settings, ports.clock, context.t, false).text : reset;
  if (window.fraction === undefined) {
    return { value: NO_FIGURE, reset, plainReset };
  }
  const clamped = Math.max(0, Math.min(1, window.fraction));
  const used = window.fraction * FULL_PERCENT;
  const shown = settings.usage.value === "remaining" ? Math.max(0, FULL_PERCENT - used) : used;
  return { value: withColor(statusColor(clamped, true, style), `${writtenPercent(shown)}%`), reset, plainReset };
}

/** A reset in parentheses, or nothing when there is none to tell. */
function parenthesised(reset: string): string {
  return reset === "" ? "" : `(${reset})`;
}

/** The windows of a row drawn as text, a separator between neighbours on a line, broken into as many lines as the width needs. */
function wrapped(windows: readonly string[], width: number): string[] {
  return packLines(windows, width, SEPARATOR).map((line) => line.join(SEPARATOR));
}

/** The quota windows' row: the five-hour and weekly windows, the per-model weekly windows when asked for in a session that selected no provider, every model family's window for an account whose limits are per family, or a provider's own windows when neither the five-hour nor the weekly window is reported. A Bedrock session (the Bedrock switch on, or a Bedrock model id, for a client that is not the Antigravity CLI) draws no subscription window (the five-hour, weekly and per-model windows of a session that selected no provider) whatever the settings, and still draws a model family's, and the windows of a provider the session selected, in whatever form that provider reports them. Drawn as bars, as text alone, or as one compact line of text, under `settings.usage`. */
export function quotaRow(context: RenderContext): RowOutput {
  const { palette, settings } = context;
  const style = barStyleOf(context, "usage");
  const windows = visibleWindows(context);
  const parts = windows.map((window) => {
    const { value, reset, plainReset } = figuresOf(window, context, style);
    return { window, value, plainReset, suffix: parenthesised(reset) };
  });
  if (settings.usage.compact) {
    const lines = parts.map(({ window, value, plainReset }) => `${paintCore(context.t("quota.compactLabel", { label: window.label }), (text) => palette.paint("label", text))}${value}${plainReset === "" ? "" : ` ${palette.paint("label", `(${plainReset})`)}`}`);
    return { kind: "text", lines: wrapped(lines, context.width) };
  }
  if (!settings.usage.bar) {
    const lines = parts.map(({ window, value, suffix }) => `${palette.paint("label", `${window.label} `)}${value}${suffix === "" ? "" : ` ${suffix}`}`);
    return { kind: "text", lines: wrapped(lines, context.width) };
  }
  const cells: BarCell[] = parts.map(({ window, value, suffix }) => barCell(palette.paint("label", `${window.label} `), ` ${value}${suffix === "" ? "" : ` ${suffix}`}`, Math.max(0, Math.min(1, window.fraction ?? 0)), style));
  return { kind: "bars", cells };
}
