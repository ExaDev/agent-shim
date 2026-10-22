import { MAX_STATUSLINE_LABEL_COLUMNS } from "../../../config/statusline";
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "../../../usage/pick";
import { truncateToColumns } from "../../ansi";
import type { BarCell } from "../../barGrid";
import { packLines, SEPARATOR } from "../../headerLayout";
import { paintCore } from "../../messages/around";
import { hidesSubscriptionWindows } from "../../platform";
import { formatResetTime } from "../../resetTime";
import { visibleDisplayText } from "../../sanitise";
import { barCell, FULL_PERCENT, statusColor, withColor, type BarStyle } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput } from "../context";

/** One quota window as the row draws it: how much of it is used, as a fraction, and when it resets. */
interface QuotaWindowView {
  readonly label: string;
  readonly fraction: number;
  readonly resetsAt: string | undefined;
  /** The window's length, when it is known: the share of it already gone needs it. */
  readonly periodMs: number | undefined;
  /** Whether this is the account's own weekly window, the one `usage.sevenDayThreshold` can hide. */
  readonly weekly: boolean;
}

/** `label` as text a terminal draws as it stands and a person can read, cut to the columns a label may take so a long name cannot crowd the bar out; empty when nothing visible is left. */
function safeLabel(label: string): string {
  return truncateToColumns(visibleDisplayText(label), MAX_STATUSLINE_LABEL_COLUMNS).trim();
}

/** The per-model weekly windows the client's payload carries, read only for a session whose quota is the signed-in account's: a window with no name or no figure is not one to draw. */
function modelScopedWindows({ payload }: RenderContext): readonly QuotaWindowView[] {
  return (payload.rate_limits?.model_scoped ?? []).flatMap((window) => {
    const label = safeLabel(window.display_name ?? "");
    if (label === "" || window.utilization === undefined || !Number.isFinite(window.utilization)) {
      return [];
    }
    return [{ label, fraction: window.utilization / FULL_PERCENT, resetsAt: window.resets_at, periodMs: SEVEN_DAY_WINDOW_MS, weekly: false }];
  });
}

/** The windows of the account the session is signed in as: the five-hour and weekly windows, with the per-model weekly ones when asked for and the session selected no provider. None for a Bedrock session (`hidesSubscriptionWindows`: the Bedrock switch on, or a Bedrock model id), which spends none of them. */
function subscriptionWindows(context: RenderContext): { readonly unified: readonly QuotaWindowView[]; readonly modelScoped: readonly QuotaWindowView[] } {
  const { summary, settings } = context;
  if (hidesSubscriptionWindows(context.ports.env, context.payload.model?.id)) {
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

/** Every window the quota row can draw, before the thresholds choose among them: every model family's window for an account whose limits are per family, else the subscription windows (`subscriptionWindows`, none for a Bedrock session) with, when neither the five-hour nor the weekly window is drawn, a provider's own windows. A Bedrock session still draws a model family's windows and a provider's own, which are not the signed-in account's. */
function candidateWindows(context: RenderContext): readonly QuotaWindowView[] {
  const { summary } = context;
  if (summary.quotaFamilies.length > 0) {
    // An Antigravity account's limits are per model family, so every family's window is drawn whichever model is in use.
    return summary.quotaFamilies.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: undefined, weekly: false }));
  }
  const { unified, modelScoped } = subscriptionWindows(context);
  // A provider outside Anthropic's unified rate-limit family (z.ai) reports its usage only through its own quota windows, which are drawn when no unified window is.
  const providerWindows = unified.length > 0 ? [] : summary.providerQuotaWindows.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: window.periodMs, weekly: false }));
  return [...unified, ...providerWindows, ...modelScoped];
}

/** The windows to draw (`candidateWindows`, so no subscription window for a Bedrock session): none when no window has used `usage.threshold` yet, and without the weekly window when a five-hour one is drawn beside it and the weekly use is below `usage.sevenDayThreshold`. */
function visibleWindows(context: RenderContext): readonly QuotaWindowView[] {
  const { summary, settings } = context;
  const candidates = candidateWindows(context);
  const mostUsed = Math.max(0, ...candidates.map((window) => window.fraction * FULL_PERCENT));
  if (mostUsed < settings.usage.threshold) {
    return [];
  }
  const hidesWeekly = summary.fiveHourUsed !== undefined && summary.sevenDayUsed !== undefined && summary.sevenDayUsed < settings.usage.sevenDayThreshold;
  return hidesWeekly ? candidates.filter((window) => !window.weekly) : candidates;
}

/** A window's figure and reset as the row's settings write them. The share is coloured by the window's use whichever way it is written. `reset` is empty when the window has nothing to say about its reset, and `plainReset` is the same reset without the words that introduce it, which the compact form draws. */
function figuresOf(window: QuotaWindowView, context: RenderContext, style: BarStyle): { readonly value: string; readonly reset: string; readonly plainReset: string } {
  const { settings, nowMs, ports } = context;
  const clamped = Math.max(0, Math.min(1, window.fraction));
  const used = window.fraction * FULL_PERCENT;
  const shown = settings.usage.value === "remaining" ? Math.max(0, FULL_PERCENT - used) : used;
  const reset = formatResetTime(window, nowMs, settings, ports.clock, context.t, settings.usage.resetLabel).text;
  const plainReset = settings.usage.resetLabel ? formatResetTime(window, nowMs, settings, ports.clock, context.t, false).text : reset;
  return { value: withColor(statusColor(clamped, true, style), `${shown.toFixed(1)}%`), reset, plainReset };
}

/** A reset in parentheses, or nothing when there is none to tell. */
function parenthesised(reset: string): string {
  return reset === "" ? "" : `(${reset})`;
}

/** The windows of a row drawn as text, a separator between neighbours on a line, broken into as many lines as the width needs. */
function wrapped(windows: readonly string[], width: number): string[] {
  return packLines(windows, width, SEPARATOR).map((line) => line.join(SEPARATOR));
}

/** The quota windows' row: the five-hour and weekly windows, the per-model weekly windows when asked for, every model family's window for an account whose limits are per family, or a provider's own windows when no unified one is drawn. A Bedrock session (the Bedrock switch on, or a Bedrock model id) draws none of the signed-in account's windows (the five-hour, weekly and per-model ones) whatever the settings, and still draws a model family's or a provider's own. Drawn as bars, as text alone, or as one compact line of text, under `settings.usage`. */
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
  const cells: BarCell[] = parts.map(({ window, value, suffix }) => barCell(palette.paint("label", `${window.label} `), ` ${value}${suffix === "" ? "" : ` ${suffix}`}`, Math.max(0, Math.min(1, window.fraction)), style));
  return { kind: "bars", cells };
}
