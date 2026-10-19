import { STATUSLINE_DEFAULTS, type ResolvedStatusline } from "../config/statusline";
import type { BarCell } from "./barGrid";
import { layoutBarGrid } from "./barGrid";
import type { RenderContext, StatuslinePayloadView } from "./elements/context";
import type { ClientPayload } from "./payload";
import type { StatuslinePorts } from "./ports";
import { ELEMENTS, HEADER_ROLES, type ElementRegistry } from "./elements/registry";
import type { StatuslineSummary } from "./enrich";
import { headerUnits, layoutHeader } from "./headerLayout";
import { colourEnabled, createPalette } from "./palette";
import { TWENTY } from "./style";

/** Claude Code indents the status line one column from the terminal edge and truncates at its own usable width, replacing the final column with an ellipsis. COLUMNS is correct in the child environment, but the usable width is four columns short of it, so a line as wide as COLUMNS minus two still loses its tail. */
export const RESERVED_COLUMNS = 4;
const SEPARATOR = " | ";

/** What one render takes: what the door knows about the session, the client's payload, the terminal's width, the clock, the settings, and the ports to the machine. The registry of elements is the built-in one unless a test brings its own. */
export interface RenderInput {
  readonly summary: StatuslineSummary;
  readonly view: StatuslinePayloadView;
  readonly payload: ClientPayload;
  readonly terminalWidth: number;
  readonly nowMs: number;
  readonly settings?: ResolvedStatusline;
  readonly ports: StatuslinePorts;
  readonly elements?: ElementRegistry;
}

/**
 * The built-in statusline, laid out and coloured the way the Antigravity CLI's own statusline is: the model, the provider's account (email and subscription plan) and the identity when it is not that account, on the first line; then the context window's use (tokens against the window, the prompt cache's hit percentage) and the quota windows the door reports, each a bar that fills with use and turns yellow then red, one line when they fit and two when they do not.
 */
export function renderStatuslineBlock(input: Readonly<RenderInput>): string {
  const { terminalWidth, settings = STATUSLINE_DEFAULTS, elements = ELEMENTS } = input;
  const context: RenderContext = {
    summary: input.summary,
    view: input.view,
    payload: input.payload,
    nowMs: input.nowMs,
    terminalWidth,
    settings,
    palette: createPalette(settings.colours, colourEnabled(input.ports.env)),
    ports: input.ports,
  };
  // The segments drawn are the ones the settings list, in the order they list them.
  const parts = settings.layout.header.flatMap((name) => {
    const text = elements.header[name](context);
    return text === undefined ? [] : { name, text: context.palette.paint(HEADER_ROLES[name], text) };
  });
  const header = headerUnits(parts, settings.git.branchOverflow);

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
