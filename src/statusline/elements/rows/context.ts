import type { BarCell } from "../../barGrid";
import { barCell, formatTokens, FULL_PERCENT, RESET, statusColor, type ColourBands } from "../../style";
import type { RenderContext, RowOutput, StatuslinePayloadView } from "../context";

/** The cache hit fraction drawn as a percentage in the colour of its band: a hit ratio is better the higher it is, so the bands are the remaining-style ones, red when nearly nothing is served from cache and green when most is. */
function cacheHitText(hitFraction: number, bands: ColourBands): string {
  const clamped = Math.max(0, Math.min(1, hitFraction));
  return ` (Cache: ${statusColor(clamped, false, bands)}${(clamped * FULL_PERCENT).toFixed(0)}%${RESET})`;
}

/** The prompt cache's hit percentage, preferring the client's own request-level hit ratio, which survives a cold turn, over the last request's share of prompt tokens read from cache, which a single cold turn zeroes. */
function cacheShareText(view: StatuslinePayloadView, bands: ColourBands): string {
  const hitRatio = view.cacheHitRatio;
  if (hitRatio !== undefined && Number.isFinite(hitRatio)) {
    return cacheHitText(hitRatio, bands);
  }
  const promptTotal = (view.cacheReadTokens ?? 0) + (view.freshInputTokens ?? 0);
  if (promptTotal > 0 && (view.cacheReadTokens ?? 0) > 0) {
    return cacheHitText((view.cacheReadTokens ?? 0) / promptTotal, bands);
  }
  return "";
}


/** The context window's bar, with its tokens and the prompt cache's hit share. */
export function contextRow({ view, bands }: RenderContext): RowOutput {
  const cells: BarCell[] = [];
  if (view.contextUsedPercentage !== undefined) {
    const fraction = Math.max(0, Math.min(1, view.contextUsedPercentage / FULL_PERCENT));
    const color = statusColor(fraction, true, bands);
    const percent = `${color}${view.contextUsedPercentage.toFixed(1)}%${RESET}`;
    const tokens = view.contextTotalTokens !== undefined && view.contextWindowTokens !== undefined ? `${formatTokens(view.contextTotalTokens)}/${formatTokens(view.contextWindowTokens)} ` : "";
    const cache = cacheShareText(view, bands);
    cells.push(barCell(`Ctx ${tokens}`, ` ${percent}${cache}`, fraction, bands));
  }

  return { kind: "bars", cells };
}
