import { AUTOCOMPACT_RESERVE_FRACTION, AUTOCOMPACT_RESERVE_RAMP_END, AUTOCOMPACT_RESERVE_RAMP_START, contextBreakdownAt } from "../../../config/statusline";
import { contextFrameOf } from "../../contextFrame";
import type { Translate } from "../../messages/catalogues";
import { contextViewOf, type ContextWindowFrame } from "../../payload";
import { writtenPercent } from "../../percent";
import { barCell, formatTokens, FULL_PERCENT, statusColor, withColor, type BarStyle } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput, type StatuslinePayloadView } from "../context";

/** The cache hit fraction drawn as a percentage in the colour of its band: a hit ratio is better the higher it is, so the bands are the remaining-style ones: red when the share is at most 100 less `criticalAt` percent, yellow when it is above that and at most 100 less `warnAt` percent, and green above that. */
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

/** Half a percentage point, the distance within which a percentage rounds up to a whole one. */
const ROUNDING_HALF_POINT = 0.5;

/** The tokens held against a window, with the reserve Claude Code keeps for compaction added in proportion: none while the window is nearly empty, all of it once half full, and a straight line between. */
function bufferedPercent(tokens: number, windowTokens: number): number {
  const held = tokens / windowTokens;
  const ramp = Math.max(0, Math.min(1, (held - AUTOCOMPACT_RESERVE_RAMP_START) / (AUTOCOMPACT_RESERVE_RAMP_END - AUTOCOMPACT_RESERVE_RAMP_START)));
  // Added to the tokens before the division, as claude-hud adds it, so a half reached by arithmetic rounds the same way there.
  return Math.min(FULL_PERCENT, ((tokens + windowTokens * AUTOCOMPACT_RESERVE_FRACTION * ramp) / windowTokens) * FULL_PERCENT);
}

/** The percentage of the window in use, read from `context.view` (the payload's own frame, or the frame `contextFrameOf` draws in its place), or undefined when there is none to draw. A window set in the settings is measured against the tokens held, and with no tokens reported there is nothing to measure, so the percentage the frame reports (which is against its own window) is not drawn in its place. Otherwise it is the percentage the frame reports. Where the frame reports none, or reports 0 beside tokens already held (which is how a client says it has not worked it out yet), it is the estimate the settings ask for when one can be made from the tokens and the window; a reported value that cannot be replaced by an estimate is kept. */
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

/** The tokens the last request held, over the input and the cache, as the breakdown writes them, or nothing when the frame drawn does not report the last request. */
function breakdownText(frame: ContextWindowFrame | undefined, t: Translate): string | undefined {
  const usage = frame?.current_usage;
  if (usage === undefined) {
    return undefined;
  }
  const cached = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return ` (${t("context.breakdown", { input: formatTokens(usage.input_tokens ?? 0), cached: formatTokens(cached) })})`;
}

/** The context window frame the elements draw from in `context`'s render (`RenderContext.contextFrame` keeps it): the payload's own, or the one `contextFrameOf` draws in its place (the transcript's last good frame, or the percentage its newest compaction left). `contextFrameOf` rewrites the payload's frame only when both of two things hold: the frame is a suspicious zero (a percentage and every `current_usage` counter absent or 0, see `isSuspiciousZero`), and the percentage of the window in use the row works out from it under the settings (`usedPercentOf`) is absent or 0 when rounded to one decimal (`writtenPercent`), whatever figure `context.value` writes from it (`drawsPercent` false), since such a zero carries no more than the zero claude-hud rewrites. A suspicious zero whose percentage in use is written above 0 (an estimate from the tokens it holds) is a reading, and a frame that is not a suspicious zero is drawn as it stands whatever `drawsPercent` is, as claude-hud draws it: a frame reporting a percentage of 0.04 is written as `0%`, and one reporting 45% with no `total_input_tokens` while `context.autoCompactWindow` is set draws no row, and either, carrying a window above 0, is kept as the transcript's last good frame by the rule `contextFrameOf` keeps a frame by. May read and write the transcript's record through `context.ports`, as `contextFrameOf` says when, so it is called once a render. */
export function drawnContextFrameOf(context: RenderContext): ContextWindowFrame | undefined {
  const { payload } = context;
  const percent = usedPercentOf(context);
  const drawsPercent = percent !== undefined && Number(writtenPercent(percent)) > 0;
  return contextFrameOf({ ports: context.ports, transcriptPath: payload.transcript_path, frame: payload.context_window, drawsPercent, nowMs: context.nowMs, compaction: () => context.transcript()?.session.lastCompaction });
}

/** The context row's render context for the frame it draws (`RenderContext.contextFrame`): the payload's own, or the view read from the frame drawn in its place. */
function drawnContextOf(input: RenderContext): { readonly context: RenderContext; readonly frame: ContextWindowFrame | undefined } {
  const { payload } = input;
  const frame = input.contextFrame();
  return { context: frame === payload.context_window ? input : { ...input, view: { ...input.view, ...contextViewOf(frame) } }, frame };
}

/** The context window's bar, or its figures alone, written as the settings ask: the tokens held and the percentage in use, the prompt cache's hit share, and from the breakdown threshold (`contextBreakdownAt`) the breakdown of the last request. The frame drawn is the payload's, or the one `contextFrameOf` draws in place of a frame that reports no use (a percentage and every `current_usage` counter absent or 0) and whose percentage of the window in use, as the row works it out under the settings, is absent or 0 when rounded to one decimal (`writtenPercent`). */
export function contextRow(input: RenderContext): RowOutput {
  const { context, frame } = drawnContextOf(input);
  const { view, palette, settings } = context;
  const percent = usedPercentOf(context);
  if (percent === undefined) {
    return settings.context.bar === "shown" ? { kind: "bars", cells: [] } : { kind: "text", lines: [] };
  }
  const style = barStyleOf(context, "context");
  // claude-hud chooses the colour by the percentage rounded to a whole number, so the band is chosen by that rounded percentage (a half reached by the same arithmetic rounds as it does there); the bar's fill and the text keep the unrounded figure. The thresholds sit half a point lower so the gradient's stops fall where the rounded percentage changes band.
  const bands = { warnAt: settings.context.warnAt - ROUNDING_HALF_POINT, criticalAt: settings.context.criticalAt - ROUNDING_HALF_POINT };
  const fraction = Math.max(0, Math.min(1, percent / FULL_PERCENT));
  const bandFraction = Math.max(0, Math.min(1, Math.round(percent) / FULL_PERCENT));
  const color = statusColor(bandFraction, true, { ...style, bands });
  const windowTokens = windowTokensOf(context);
  const tokens = view.contextTotalTokens;
  const heldAgainstWindow = tokens === undefined || windowTokens === undefined ? undefined : `${formatTokens(tokens)}/${formatTokens(windowTokens)}`;
  const percentText = withColor(color, `${writtenPercent(percent)}%`);
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
      afterBar.push(withColor(color, `${writtenPercent(Math.max(0, FULL_PERCENT - percent))}%`));
      break;
    default:
      return settings.context.value satisfies never;
  }
  const high = settings.context.breakdown === "critical" && Math.round(percent) >= contextBreakdownAt(settings) ? breakdownText(frame, context.t) : undefined;
  if (settings.context.bar === "hidden" && afterBar.length === 0) {
    return { kind: "text", lines: [] };
  }
  const trailer = `${cacheShareText(view, style, context.t)}${high === undefined ? "" : palette.paint("label", high)}`;
  const label = [context.t("context.label"), ...beforeBar].join(" ");
  if (settings.context.bar === "shown") {
    const suffix = afterBar.length === 0 ? trailer : ` ${afterBar.join(" ")}${trailer}`;
    return { kind: "bars", cells: [barCell(palette.paint("label", `${label} `), suffix, fraction, { ...style, bands, bandFraction })] };
  }
  return { kind: "text", lines: [`${[palette.paint("label", label), ...afterBar].join(" ")}${trailer}`] };
}
