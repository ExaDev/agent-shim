import type { ResolvedStatusline } from "../../config/statusline";
import type { StatuslineSummary } from "../enrich";
import type { BarCell } from "../barGrid";
import type { ColourBands } from "../style";

/** The payload fields the built-in statusline shows: the model, the context window's use, and the prompt cache's effectiveness. */
export interface StatuslinePayloadView {
  readonly modelDisplayName: string | undefined;
  readonly contextUsedPercentage: number | undefined;
  readonly contextTotalTokens: number | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly cacheHitRatio: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly freshInputTokens: number | undefined;
}

/** Everything one element needs to draw itself: what the door knows about the session, the client's payload, the clock, and the settings (with the colour bands taken out of them). */
export interface RenderContext {
  readonly summary: StatuslineSummary;
  readonly view: StatuslinePayloadView;
  readonly nowMs: number;
  readonly settings: ResolvedStatusline;
  readonly bands: ColourBands;
}

/** What a row draws: bars, which are laid out on one grid with the bars of the rows beside them, or lines of text, which are drawn as they are. A row with nothing to show returns no cells or no lines. */
export type RowOutput = { readonly kind: "bars"; readonly cells: readonly BarCell[] } | { readonly kind: "text"; readonly lines: readonly string[] };
