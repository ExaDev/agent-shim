import type { ResolvedStatusline } from "../../config/statusline";
import type { StatuslineSummary } from "../enrich";
import type { BarCell } from "../barGrid";
import type { TranscriptIdentity } from "../identityTranscript";
import type { Translate } from "../messages/catalogues";
import type { Palette } from "../palette";
import type { ClientPayload, ContextWindowFrame } from "../payload";
import type { StatuslinePorts } from "../ports";
import type { BarStyle } from "../style";
import type { TranscriptFacts } from "../transcript/reader";

/** The payload fields the built-in statusline shows: the model, the context window's use, and the prompt cache's effectiveness. */
export interface StatuslinePayloadView {
  /** The model's name as the client gives it, before `model.override`, the transcript's name and `model.format` apply: its display name, else its model id, each trimmed and read as absent when blank, or undefined when neither has any text or when the Antigravity CLI stacks this line under its own, which already names the model. */
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
  /** What the session's transcript says, or undefined when the client names no transcript or it cannot be read. The transcript is read the first time something in the render asks and that read is shared, so a line that draws nothing from it touches it only for the context frame (`contextFrame`), which every render works out and which asks for the transcript's newest compaction on a frame it may rewrite and on no other. */
  readonly transcript: () => TranscriptFacts | undefined;
  /** The context window frame the elements draw from, as claude-hud's `context-cache` rewrites the whole payload: the payload's own, or the transcript's last good frame or the percentage its newest compaction left in place of a frame that reports no use (see `drawnContextFrameOf`). Worked out on first use and the same on every later call in the render, so however many elements ask, a render reads and writes the record only as one call of `contextFrameOf` does; the render asks for it after the elements when none did, so that call is made whatever the layout draws. */
  readonly contextFrame: () => ContextWindowFrame | undefined;
}

/** How a bar is coloured and drawn under the settings, for the row whose bar's own colour, below its warning threshold while `bar.gradient` is `off`, is `okRole`'s. */
export function barStyleOf({ settings, palette }: RenderContext, okRole: BarStyle["okRole"]): BarStyle {
  return { bands: settings.bands, palette, okRole, gradient: settings.bar.gradient, filled: settings.bar.filled, empty: settings.bar.empty };
}

/** What a row draws: bars, which the shared grid lines up with the bars of the rows beside them wherever its layout allows, or lines of text, which are drawn as they are. A row with nothing to show returns no cells or no lines. */
export type RowOutput = { readonly kind: "bars"; readonly cells: readonly BarCell[] } | { readonly kind: "text"; readonly lines: readonly string[] };
