import type { ResolvedStatusline } from "../../../config/statusline";
import type { RenderContext } from "../context";

/** The symbol that stands for each effort level the client reports: a circle that fills as the level rises. A level with no entry is written as its name. */
const EFFORT_SYMBOLS: Readonly<Record<string, string>> = {
  low: "○",
  medium: "◔",
  high: "◑",
  xhigh: "◕",
  max: "●",
};

/** The effort level the client reports, lower-cased and trimmed, or undefined when it reports none. The client sends the level as a bare string or, from Claude Code 2.1.115, as an object's `level`. */
function effortLevelOf(effort: RenderContext["payload"]["effort"]): string | undefined {
  const level = (typeof effort === "string" ? effort : effort?.level)?.trim().toLowerCase();
  return level === undefined || level === "" ? undefined : level;
}

function formatEffort(level: string, format: ResolvedStatusline["effort"]["format"]): string {
  const symbol = EFFORT_SYMBOLS[level];
  if (symbol === undefined || format === "text") {
    return level;
  }
  return format === "symbol" ? symbol : `${symbol} ${level}`;
}

/** The session's reasoning effort, or undefined when the client reports none. */
export function effortSegment({ payload, settings }: RenderContext): string | undefined {
  const level = effortLevelOf(payload.effort);
  return level === undefined ? undefined : formatEffort(level, settings.effort.format);
}
