import type { BarCell } from "../../barGrid";
import { barCell, formatDuration, FULL_PERCENT, secondsUntil, statusColor, withColor } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput } from "../context";

/** The subscription quota windows' bars: the five-hour and weekly windows, every model family's window for an account whose limits are per family, or a provider's own windows when it reports no unified one. */
export function quotaRow(context: RenderContext): RowOutput {
  const { summary, nowMs, settings, palette } = context;
  const style = barStyleOf(context, "usage");
  const cells: BarCell[] = [];
  const drawWindow = (label: string, fraction: number, resetsAt: string | undefined): void => {
    const clamped = Math.max(0, Math.min(1, fraction));
    const color = statusColor(clamped, true, style);
    cells.push(barCell(palette.paint("label", `${label} `), ` ${withColor(color, `${(fraction * FULL_PERCENT).toFixed(1)}%`)} (${formatDuration(secondsUntil(resetsAt, nowMs))})`, clamped, style));
  };
  if (summary.quotaFamilies.length > 0) {
    // An Antigravity account's limits are per model family, so every family's window is drawn whichever model is in use.
    for (const window of summary.quotaFamilies) {
      drawWindow(window.measures, window.utilization, window.resetsAt);
    }
  } else {
    if (summary.fiveHourUsed !== undefined) {
      drawWindow(settings.labels.fiveHour, summary.fiveHourUsed / FULL_PERCENT, summary.fiveHourResetAt);
    }
    if (summary.sevenDayUsed !== undefined) {
      drawWindow(settings.labels.sevenDay, summary.sevenDayUsed / FULL_PERCENT, summary.sevenDayResetAt);
    }
    // A provider outside Anthropic's unified rate-limit family (z.ai) reports its usage only through its own quota windows, which are drawn when no unified window is.
    if (summary.fiveHourUsed === undefined && summary.sevenDayUsed === undefined) {
      for (const window of summary.providerQuotaWindows) {
        drawWindow(window.measures, window.utilization, window.resetsAt);
      }
    }
  }

  return { kind: "bars", cells };
}
