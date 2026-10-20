import { graphemesOf, MAX_STATUSLINE_LABEL_CHARS } from "../../../config/statusline";
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "../../../usage/pick";
import type { BarCell } from "../../barGrid";
import { packLines, SEPARATOR } from "../../headerLayout";
import { formatResetTime } from "../../resetTime";
import { sanitiseDisplayText } from "../../sanitise";
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

/** Format characters (zero-width spaces, joiners, word joiners) and separators other than a plain space, except the zero-width joiner, which holds emoji sequences and conjuncts together. */
const INVISIBLE = /(?![ \u200D])[\p{Cf}\p{Z}]/gu;

const ZERO_WIDTH_JOINER = "\u200D";

/** `label` as text a terminal draws as it stands and a person can read: the client's own text with its escape sequences, control characters and invisible characters removed, no more than a label's own width so a long name cannot crowd the bar out, and empty when nothing visible is left. A joiner that joins nothing is invisible and does not count as something left. */
function safeLabel(label: string): string {
  const visible = graphemesOf(sanitiseDisplayText(label).replace(INVISIBLE, "").trim()).filter((grapheme) => grapheme.replaceAll(ZERO_WIDTH_JOINER, "") !== "");
  return visible.slice(0, MAX_STATUSLINE_LABEL_CHARS).join("").trim();
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

/** Every window the quota row can draw, before the thresholds choose among them: every model family's window for an account whose limits are per family, else the five-hour and weekly windows (with the per-model weekly ones when asked for) or, with neither, a provider's own windows. */
function candidateWindows(context: RenderContext): readonly QuotaWindowView[] {
  const { summary, settings } = context;
  if (summary.quotaFamilies.length > 0) {
    // An Antigravity account's limits are per model family, so every family's window is drawn whichever model is in use.
    return summary.quotaFamilies.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: undefined, weekly: false }));
  }
  const windows: QuotaWindowView[] = [];
  if (summary.fiveHourUsed !== undefined) {
    windows.push({ label: settings.labels.fiveHour, fraction: summary.fiveHourUsed / FULL_PERCENT, resetsAt: summary.fiveHourResetAt, periodMs: FIVE_HOUR_WINDOW_MS, weekly: false });
  }
  if (summary.sevenDayUsed !== undefined) {
    windows.push({ label: settings.labels.sevenDay, fraction: summary.sevenDayUsed / FULL_PERCENT, resetsAt: summary.sevenDayResetAt, periodMs: SEVEN_DAY_WINDOW_MS, weekly: true });
  }
  // A provider outside Anthropic's unified rate-limit family (z.ai) reports its usage only through its own quota windows, which are drawn when no unified window is.
  if (summary.fiveHourUsed === undefined && summary.sevenDayUsed === undefined) {
    windows.push(...summary.providerQuotaWindows.map((window) => ({ label: window.measures, fraction: window.utilization, resetsAt: window.resetsAt, periodMs: window.periodMs, weekly: false })));
  }
  // The payload's windows describe the account the session is signed in as, which a session that selected a provider does not spend.
  if (settings.usage.modelScoped && summary.provider === undefined) {
    windows.push(...modelScopedWindows(context));
  }
  return windows;
}

/** The windows to draw: none when no window has used `usage.threshold` yet, and without the weekly window when a five-hour one is drawn beside it and the weekly use is below `usage.sevenDayThreshold`. */
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

/** A window's figure and reset as the row's settings write them. The share is coloured by the window's use whichever way it is written. `reset` is empty when the window has nothing to say about its reset. */
function figuresOf(window: QuotaWindowView, context: RenderContext, style: BarStyle): { readonly value: string; readonly reset: string; readonly pending: boolean } {
  const { settings, nowMs, ports } = context;
  const clamped = Math.max(0, Math.min(1, window.fraction));
  const used = window.fraction * FULL_PERCENT;
  const shown = settings.usage.value === "remaining" ? Math.max(0, FULL_PERCENT - used) : used;
  const { text, pending } = formatResetTime(window, nowMs, settings, ports.clock);
  return { value: withColor(statusColor(clamped, true, style), `${shown.toFixed(1)}%`), reset: text, pending };
}

/** The reset in parentheses, introduced by `resets in` (`resets` before a wall-clock time) when `usage.resetLabel` asks and there is a reset still to come to introduce. */
function resetSuffix(reset: string, pending: boolean, context: RenderContext): string {
  if (reset === "") {
    return "";
  }
  const { usage } = context.settings;
  const elapsedForm = usage.timeFormat === "elapsed" || usage.timeFormat === "elapsedAndAbsolute";
  if (!usage.resetLabel || !pending || elapsedForm) {
    return `(${reset})`;
  }
  return `(${usage.timeFormat === "absolute" ? "resets" : "resets in"} ${reset})`;
}

/** The windows of a row drawn as text, a separator between neighbours on a line, broken into as many lines as the width needs. */
function wrapped(windows: readonly string[], width: number): string[] {
  return packLines(windows, width, SEPARATOR).map((line) => line.join(SEPARATOR));
}

/** The quota windows' row: the five-hour and weekly windows, the per-model weekly windows when asked for, every model family's window for an account whose limits are per family, or a provider's own windows when it reports no unified one. Drawn as bars, as text alone, or as one compact line of text, under `settings.usage`. */
export function quotaRow(context: RenderContext): RowOutput {
  const { palette, settings } = context;
  const style = barStyleOf(context, "usage");
  const windows = visibleWindows(context);
  const parts = windows.map((window) => {
    const { value, reset, pending } = figuresOf(window, context, style);
    return { window, value, reset, suffix: resetSuffix(reset, pending, context) };
  });
  if (settings.usage.compact) {
    const lines = parts.map(({ window, value, reset }) => `${palette.paint("label", `${window.label}:`)} ${value}${reset === "" ? "" : ` ${palette.paint("label", `(${reset})`)}`}`);
    return { kind: "text", lines: wrapped(lines, context.width) };
  }
  if (!settings.usage.bar) {
    const lines = parts.map(({ window, value, suffix }) => `${palette.paint("label", `${window.label} `)}${value}${suffix === "" ? "" : ` ${suffix}`}`);
    return { kind: "text", lines: wrapped(lines, context.width) };
  }
  const cells: BarCell[] = parts.map(({ window, value, suffix }) => barCell(palette.paint("label", `${window.label} `), ` ${value}${suffix === "" ? "" : ` ${suffix}`}`, Math.max(0, Math.min(1, window.fraction)), style));
  return { kind: "bars", cells };
}
