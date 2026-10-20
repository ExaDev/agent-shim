import { MIN_STATUSLINE_COLUMNS, STATUSLINE_DEFAULTS, type ResolvedStatusline } from "../config/statusline";
import type { RenderContext, StatuslinePayloadView } from "./elements/context";
import type { ClientPayload } from "./payload";
import type { StatuslinePorts } from "./ports";
import { ELEMENTS, HEADER_ROLES, type ElementRegistry } from "./elements/registry";
import type { StatuslineSummary } from "./enrich";
import { headerUnits, layoutHeader, packLines, SEPARATOR } from "./headerLayout";
import { readTranscriptIdentity } from "./identityTranscript";
import { translatorFor } from "./messages/catalogues";
import { colourEnabled, createPalette, type Palette } from "./palette";
import { compactUnits, layoutRows } from "./rowsLayout";
import { visibleLength } from "./ansi";
import { readTranscript, type TranscriptFacts } from "./transcript/reader";

/** Claude Code indents the status line one column from the terminal edge and truncates at its own usable width, replacing the final column with an ellipsis. COLUMNS is correct in the child environment, but the usable width is short of it by this many columns, so a line as wide as COLUMNS minus two still loses its tail. */
export const RESERVED_COLUMNS = 4;

/** The columns a line may use on a terminal of `terminalColumns`: what the client leaves after its own reserve, and never fewer than a line can be drawn in. */
export function lineWidthOf(terminalColumns: number): number {
  return Math.max(MIN_STATUSLINE_COLUMNS, terminalColumns - RESERVED_COLUMNS);
}

/** What one render takes: what the door knows about the session, the client's payload, the terminal's width and, when the line is not to be drawn to the width less the client's reserve, the width of the line, the clock, the settings, and the ports to the machine. The registry of elements is the built-in one unless a test brings its own. */
export interface RenderInput {
  readonly summary: StatuslineSummary;
  readonly view: StatuslinePayloadView;
  readonly payload: ClientPayload;
  readonly terminalWidth: number;
  /** The columns a line may use; the terminal's width less the client's reserve when omitted. */
  readonly lineWidth?: number;
  readonly nowMs: number;
  readonly settings?: ResolvedStatusline;
  readonly ports: StatuslinePorts;
  readonly elements?: ElementRegistry;
}

/** `read`, run on first call and its result kept, so every later call in the render is free. */
function once<T>(read: () => T): () => T {
  let kept: { readonly value: T } | undefined;
  return () => {
    kept ??= { value: read() };
    return kept.value;
  };
}

/** The character a rule between the header and the rows is drawn with. */
const RULE_CHARACTER = "\u2500";

/** A rule as wide as the header's widest line, at least `MIN_STATUSLINE_COLUMNS` and at most `width`, in the label colour. */
function ruleLine(headerLines: readonly string[], width: number, palette: Palette): string {
  const widest = Math.max(MIN_STATUSLINE_COLUMNS, ...headerLines.map(visibleLength));
  return palette.paint("label", RULE_CHARACTER.repeat(Math.min(width, widest)));
}

/**
 * The built-in statusline, laid out and coloured the way the Antigravity CLI's own statusline is: the model, the provider's account (email and subscription plan) and the identity when it is not that account, on the first line; then the context window's use (tokens against the window, the prompt cache's hit percentage) and the quota windows the door reports, each a bar that fills with use and turns yellow then red, one line when they fit and two when they do not.
 */
export function renderStatuslineBlock(input: Readonly<RenderInput>): string {
  const { terminalWidth, settings = STATUSLINE_DEFAULTS, elements = ELEMENTS } = input;
  const width = input.lineWidth ?? lineWidthOf(terminalWidth);
  const context: RenderContext = {
    summary: input.summary,
    view: input.view,
    payload: input.payload,
    nowMs: input.nowMs,
    terminalWidth,
    width,
    settings,
    t: translatorFor(settings.language),
    palette: createPalette(settings.colours, colourEnabled(input.ports.env)),
    ports: input.ports,
    transcriptIdentity: once(() => (input.payload.transcript_path === undefined ? { model: undefined, advisor: undefined } : readTranscriptIdentity(input.ports, input.payload.transcript_path))),
    transcript: once((): TranscriptFacts | undefined => {
      const transcriptPath = input.payload.transcript_path;
      return transcriptPath === undefined || transcriptPath === "" ? undefined : readTranscript(input.ports, transcriptPath, input.nowMs);
    }),
  };
  // The segments drawn are the ones the settings list, in the order they list them.
  const parts = settings.layout.header.flatMap((name) => {
    const text = elements.header[name](context);
    return text === undefined ? [] : { name, text: context.palette.paint(HEADER_ROLES[name], text) };
  });
  const header = headerUnits(parts, settings.git.branchOverflow);

  const drawn = settings.layout.rows.map((name) => ({ name, output: elements.rows[name](context) }));
  if (settings.layout.mode === "compact") {
    return packLines([...header, ...compactUnits(drawn, settings.bar.width)], width, SEPARATOR)
      .map((line) => line.join(SEPARATOR))
      .join("\n");
  }
  const headerLines = header.length > 0 ? layoutHeader(header, width, SEPARATOR).split("\n") : [];
  const rowLines = layoutRows(drawn, { mergeBars: settings.layout.mergeBars, merge: settings.layout.merge, rightAlign: settings.layout.rightAlign, barCells: settings.bar.width }, width);
  const rule = settings.layout.rule === "belowHeader" && headerLines.length > 0 && rowLines.length > 0 ? [ruleLine(headerLines, width, context.palette)] : [];
  return [...headerLines, ...rule, ...rowLines].join("\n");
}
