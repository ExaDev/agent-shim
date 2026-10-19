import { STATUSLINE_DEFAULTS, type ResolvedStatusline } from "../config/statusline";
import type { BarCell } from "./barGrid";
import { layoutBarGrid } from "./barGrid";
import type { RenderContext, StatuslinePayloadView } from "./elements/context";
import { ELEMENTS, HEADER_ROLES, type ElementRegistry } from "./elements/registry";
import type { StatuslineSummary } from "./enrich";
import { layoutHeader } from "./headerLayout";
import { colourEnabled, createPalette } from "./palette";
import { TWENTY } from "./style";

/** Claude Code indents the status line one column from the terminal edge and truncates at its own usable width, replacing the final column with an ellipsis. COLUMNS is correct in the child environment, but the usable width is four columns short of it, so a line as wide as COLUMNS minus two still loses its tail. */
export const RESERVED_COLUMNS = 4;
const SEPARATOR = " | ";

/**
 * The built-in statusline, laid out and coloured the way the Antigravity CLI's own statusline is: the model, the provider's account (email and subscription plan) and the identity when it is not that account, on the first line; then the context window's use (tokens against the window, the prompt cache's hit percentage) and the quota windows the door reports, each a bar that fills with use and turns yellow then red, one line when they fit and two when they do not.
 */
export function renderStatuslineBlock(
  summary: StatuslineSummary,
  view: StatuslinePayloadView,
  terminalWidth: number,
  nowMs: number,
  settings: ResolvedStatusline = STATUSLINE_DEFAULTS,
  elements: ElementRegistry = ELEMENTS,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const context: RenderContext = { summary, view, nowMs, settings, palette: createPalette(settings.colours, colourEnabled(env)) };
  // The segments drawn are the ones the settings list, in the order they list them.
  const header = settings.layout.header.flatMap((name) => {
    const text = elements.header[name](context);
    return text === undefined ? [] : context.palette.paint(HEADER_ROLES[name], text);
  });

  const width = Math.max(TWENTY, terminalWidth - RESERVED_COLUMNS);
  const lines: string[] = [];
  if (header.length > 0) {
    lines.push(layoutHeader(header, width, SEPARATOR));
  }
  // Bars of neighbouring rows share one grid, so their columns line up; a text row ends the run.
  let barGroups: (readonly BarCell[])[] = [];
  const flushBars = (): void => {
    lines.push(...layoutBarGrid(barGroups, width, SEPARATOR, settings.bar.width));
    barGroups = [];
  };
  for (const name of settings.layout.rows) {
    const output = elements.rows[name](context);
    if (output.kind === "bars") {
      barGroups.push(output.cells);
    } else {
      flushBars();
      lines.push(...output.lines);
    }
  }
  flushBars();
  return lines.join("\n");
}
