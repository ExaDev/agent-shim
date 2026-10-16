/** The width assumed when neither the payload nor the environment names one. */
export const DEFAULT_COLUMNS = 80;

/**
 * The terminal width a statusline renders for. A client that states it in the payload (the Antigravity CLI's `terminal_width`, the live width of its interactive terminal) is the authority, since it is current at every render; otherwise the `COLUMNS` the client exports (Claude Code sets it, from dimensions it measured when the session started), otherwise a plain default.
 */
export function terminalWidthOf(payload: unknown, env: Readonly<Record<string, string | undefined>>): number {
  if (typeof payload === "object" && payload !== null && "terminal_width" in payload && typeof payload.terminal_width === "number" && Number.isFinite(payload.terminal_width) && payload.terminal_width > 0) {
    return Math.floor(payload.terminal_width);
  }
  const columns = Number.parseInt(env.COLUMNS ?? "", 10);
  return Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS;
}
