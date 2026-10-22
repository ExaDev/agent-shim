import { AUTOCOMPACT_RESERVE_FRACTION, AUTOCOMPACT_RESERVE_RAMP_END, AUTOCOMPACT_RESERVE_RAMP_START, contextBreakdownAt } from "../../../config/statusline";
import type { Translate } from "../../messages/catalogues";
import { barCell, formatTokens, FULL_PERCENT, statusColor, withColor, type BarStyle } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput, type StatuslinePayloadView } from "../context";

/** The cache hit fraction drawn as a percentage in the colour of its band: a hit ratio is better the higher it is, so the bands are the remaining-style ones, red when nearly nothing is served from cache and green when most is. */
function cacheHitText(hitFraction: number, style: BarStyle, t: Translate): string {
  const clamped = Math.max(0, Math.min(1, hitFraction));
  return ` (${t("context.cacheShare", { percent: withColor(statusColor(clamped, false, style), `${(clamped * FULL_PERCENT).toFixed(0)}%`) })})`;
}

/** The prompt cache's hit percentage, preferring the client's own request-level hit ratio, which survives a cold turn, over the last request's share of prompt tokens read from cache, which a single cold turn zeroes. */
function cacheShareText(view: StatuslinePayloadView, style: BarStyle, t: Translate): string {
  const hitRatio = view.cacheHitRatio;
  if (hitRatio !== undefined && Number.isFinite(hitRatio)) {
    return cacheHitText(hitRatio, style, t);
  }
  const promptTotal = (view.cacheReadTokens ?? 0) + (view.freshInputTokens ?? 0);
  if (promptTotal > 0 && (view.cacheReadTokens ?? 0) > 0) {
    return cacheHitText((view.cacheReadTokens ?? 0) / promptTotal, style, t);
  }
  return "";
}


/** The context window the figures are measured against: the setting's window where it gives one, the model's where it does not. */
function windowTokensOf({ settings, view }: RenderContext): number | undefined {
  return settings.context.autoCompactWindow ?? view.contextWindowTokens;
}

/** The tokens held against a window, with the reserve Claude Code keeps for compaction added in proportion: none while the window is nearly empty, all of it once half full, and a straight line between. */
function bufferedPercent(tokens: number, windowTokens: number): number {
  const held = tokens / windowTokens;
  const ramp = Math.max(0, Math.min(1, (held - AUTOCOMPACT_RESERVE_RAMP_START) / (AUTOCOMPACT_RESERVE_RAMP_END - AUTOCOMPACT_RESERVE_RAMP_START)));
  return Math.min(FULL_PERCENT, (held + AUTOCOMPACT_RESERVE_FRACTION * ramp) * FULL_PERCENT);
}

/** The percentage of the window in use, or undefined when there is none to draw. A window set in the settings is measured against the tokens held, and with no tokens reported there is nothing to measure, so the percentage the client reports (which is against its own window) is not drawn in its place. Otherwise it is the percentage the client reports. Where the client reports none, or reports 0 beside tokens already held (which is how a client says it has not worked it out yet), it is the estimate the settings ask for when one can be made from the tokens and the window; a reported value that cannot be replaced by an estimate is kept. */
function usedPercentOf(context: RenderContext): number | undefined {
  const { settings, view } = context;
  const tokens = view.contextTotalTokens;
  const windowTokens = windowTokensOf(context);
  if (settings.context.autoCompactWindow !== undefined) {
    return tokens === undefined ? undefined : Math.min(FULL_PERCENT, (tokens / settings.context.autoCompactWindow) * FULL_PERCENT);
  }
  const estimated = settings.context.estimate === "never" || tokens === undefined || windowTokens === undefined || windowTokens <= 0 ? undefined : estimateOf(settings.context.estimate, tokens, windowTokens);
  const reported = view.contextUsedPercentage;
  const reportedUnworked = reported === 0 && tokens !== undefined && tokens > 0;
  return reported === undefined || (reportedUnworked && estimated !== undefined) ? estimated : reported;
}

/** The percentage of the window the tokens held make up, with the compaction reserve added when asked. */
function estimateOf(kind: "raw" | "buffered", tokens: number, windowTokens: number): number {
  return kind === "buffered" ? bufferedPercent(tokens, windowTokens) : Math.min(FULL_PERCENT, (tokens / windowTokens) * FULL_PERCENT);
}

/** The tokens the last request held, over the input and the cache, as the breakdown writes them, or nothing when the client did not report the last request. */
function breakdownText({ payload, t }: RenderContext): string | undefined {
  const usage = payload.context_window?.current_usage;
  if (usage === undefined) {
    return undefined;
  }
  const cached = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return ` (${t("context.breakdown", { input: formatTokens(usage.input_tokens ?? 0), cached: formatTokens(cached) })})`;
}

/** The context window's bar, or its figures alone, written as the settings ask: the tokens held and the percentage in use, the prompt cache's hit share, and from the breakdown threshold (`contextBreakdownAt`) the breakdown of the last request. */
export function contextRow(context: RenderContext): RowOutput {
  const { view, palette, settings } = context;
  const percent = usedPercentOf(context);
  if (percent === undefined) {
    return settings.context.bar === "shown" ? { kind: "bars", cells: [] } : { kind: "text", lines: [] };
  }
  const style = barStyleOf(context, "context");
  const bands = { warnAt: settings.context.warnAt, criticalAt: settings.context.criticalAt };
  const fraction = Math.max(0, Math.min(1, percent / FULL_PERCENT));
  const color = statusColor(fraction, true, { ...style, bands });
  const windowTokens = windowTokensOf(context);
  const tokens = view.contextTotalTokens;
  const heldAgainstWindow = tokens === undefined || windowTokens === undefined ? undefined : `${formatTokens(tokens)}/${formatTokens(windowTokens)}`;
  const percentText = withColor(color, `${percent.toFixed(1)}%`);
  const beforeBar: string[] = [];
  const afterBar: string[] = [];
  switch (settings.context.value) {
    case "both":
      if (heldAgainstWindow !== undefined) {
        beforeBar.push(heldAgainstWindow);
      }
      afterBar.push(percentText);
      break;
    case "percent":
      afterBar.push(percentText);
      break;
    case "tokens": {
      // Without the window the tokens held stand alone, which is still the figure asked for.
      const held = heldAgainstWindow ?? (tokens === undefined ? undefined : formatTokens(tokens));
      if (held !== undefined) {
        afterBar.push(withColor(color, held));
      }
      break;
    }
    case "remaining":
      afterBar.push(withColor(color, `${Math.max(0, FULL_PERCENT - percent).toFixed(1)}%`));
      break;
    default:
      return settings.context.value satisfies never;
  }
  const high = settings.context.breakdown === "critical" && percent >= contextBreakdownAt(settings) ? breakdownText(context) : undefined;
  if (settings.context.bar === "hidden" && afterBar.length === 0) {
    return { kind: "text", lines: [] };
  }
  const trailer = `${cacheShareText(view, style, context.t)}${high === undefined ? "" : palette.paint("label", high)}`;
  const label = [context.t("context.label"), ...beforeBar].join(" ");
  if (settings.context.bar === "shown") {
    const suffix = afterBar.length === 0 ? trailer : ` ${afterBar.join(" ")}${trailer}`;
    return { kind: "bars", cells: [barCell(palette.paint("label", `${label} `), suffix, fraction, { ...style, bands })] };
  }
  return { kind: "text", lines: [`${[palette.paint("label", label), ...afterBar].join(" ")}${trailer}`] };
}
