import type { ResolvedStatusline } from "../../config/statusline";
import type { StatuslineSummary } from "../enrich";
import type { BarCell } from "../barGrid";
import type { TranscriptIdentity } from "../identityTranscript";
import type { Translate } from "../messages/catalogues";
import type { Palette } from "../palette";
import type { ClientPayload } from "../payload";
import type { StatuslinePorts } from "../ports";
import type { BarStyle } from "../style";
import type { TranscriptFacts } from "../transcript/reader";

/** The payload fields the built-in statusline shows: the model, the context window's use, and the prompt cache's effectiveness. */
export interface StatuslinePayloadView {
  /** The model's name as the statusline draws it: the client's display name, else its model id, each trimmed and read as absent when blank, or undefined when neither has any text. */
  readonly clientModelName: string | undefined;
  readonly contextUsedPercentage: number | undefined;
  readonly contextTotalTokens: number | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly cacheHitRatio: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly freshInputTokens: number | undefined;
}

/** Everything one element needs to draw itself: what the door knows about the session, the client's payload, the clock, the terminal's width, the settings, the palette they describe, the ports to the machine, and the session's transcript. */
export interface RenderContext {
  readonly summary: StatuslineSummary;
  readonly view: StatuslinePayloadView;
  /** The client's payload, read into the fields the statusline uses. */
  readonly payload: ClientPayload;
  readonly nowMs: number;
  /** The terminal's width in columns, before the client's own reserve is taken off. */
  readonly terminalWidth: number;
  /** The columns a line may use: a row of text that is wider than this is broken into lines that fit. */
  readonly width: number;
  readonly settings: ResolvedStatusline;
  /** Writes the statusline's words in the language `settings.language` names. */
  readonly t: Translate;
  readonly palette: Palette;
  /** What the statusline may read from the machine. */
  readonly ports: StatuslinePorts;
  /** The model and advisor of the newest assistant record in the session's transcript, or neither when the payload names no transcript or it holds none. Read on first use and the same on every later call in the render, so elements that each need it cost one read between them. */
  readonly transcriptIdentity: () => TranscriptIdentity;
  /** What the session's transcript says, or undefined when the client names no transcript or it cannot be read. The transcript is read the first time an element asks and that read is shared, so a line that draws nothing from it never touches it. */
  readonly transcript: () => TranscriptFacts | undefined;
}

/** How a bar is coloured and drawn under the settings, for the row whose bar is below its warning threshold in `okRole`'s colour. */
export function barStyleOf({ settings, palette }: RenderContext, okRole: BarStyle["okRole"]): BarStyle {
  return { bands: settings.bands, palette, okRole, filled: settings.bar.filled, empty: settings.bar.empty };
}

/** What a row draws: bars, which are laid out on one grid with the bars of the rows beside them, or lines of text, which are drawn as they are. A row with nothing to show returns no cells or no lines. */
export type RowOutput = { readonly kind: "bars"; readonly cells: readonly BarCell[] } | { readonly kind: "text"; readonly lines: readonly string[] };
