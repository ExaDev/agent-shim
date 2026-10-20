import { MIN_STATUSLINE_COLUMNS, type ResolvedStatusline } from "../config/statusline";
import { lineWidthOf } from "./render";

/** The width assumed when neither the payload nor the environment names one. */
export const DEFAULT_COLUMNS = 80;

/** How wide the terminal is taken to be, and how many columns a line is drawn to. They differ by the columns Claude Code keeps back for itself, except when the width is a configured one, which is the width drawn to exactly. */
export interface Widths {
  readonly terminal: number;
  readonly line: number;
}

/**
 * The widths a statusline renders for. A forced `layout.maxWidth` is both, whatever the client reports. Otherwise a client that states the width in the payload (the Antigravity CLI's `terminal_width`, the live width of its interactive terminal) is the authority, since it is current at every render; then the `COLUMNS` the client exports (Claude Code sets it, from dimensions it measured when the session started); then `layout.maxWidth` when one is set; then a plain default. A width the client or the environment reports is the terminal's, from which the line's is worked out; `layout.maxWidth` is the line's width as it stands.
 */
export function widthsOf(payload: unknown, env: Readonly<Record<string, string | undefined>>, layout: Readonly<Pick<ResolvedStatusline["layout"], "maxWidth" | "forceMaxWidth">>): Widths {
  const configured = { terminal: layout.maxWidth, line: layout.maxWidth };
  if (layout.forceMaxWidth) {
    return configured;
  }
  const reported = (terminal: number): Widths => ({ terminal, line: lineWidthOf(terminal) });
  if (typeof payload === "object" && payload !== null && "terminal_width" in payload && typeof payload.terminal_width === "number" && Number.isFinite(payload.terminal_width) && payload.terminal_width > 0) {
    return reported(Math.floor(payload.terminal_width));
  }
  const columns = Number.parseInt(env.COLUMNS ?? "", 10);
  if (Number.isFinite(columns) && columns > 0) {
    return reported(columns);
  }
  return layout.maxWidth >= MIN_STATUSLINE_COLUMNS ? configured : reported(DEFAULT_COLUMNS);
}
