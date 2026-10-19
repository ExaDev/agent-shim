import type { StatuslineSummary } from "../../enrich";
import { formatTokens, ONE_PERCENT } from "../../style";
import type { RenderContext } from "../context";

/** What headroom's compression saved this session, as tokens, percentage and dollars; each figure is left out when the proxy did not report it, and undefined when none was reported. */
function headroomText(stats: StatuslineSummary["headroom"]): string | undefined {
  if (stats === undefined) {
    return undefined;
  }
  // Under one percent a single decimal hides most of the figure (a saving of 0.01% would read 0.0%), so it gets two.
  const overall = stats.savingsPercent === undefined ? undefined : `${stats.savingsPercent.toFixed(stats.savingsPercent < ONE_PERCENT ? 2 : 1)}% overall`;
  const parts = [
    stats.tokensSaved === undefined ? undefined : `${formatTokens(stats.tokensSaved)} saved`,
    overall,
    stats.savingsUsd === undefined ? undefined : `$${stats.savingsUsd.toFixed(2)}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : `headroom ${parts.join(" · ")}`;
}


/** What headroom saved this session, or undefined when the session does not go through it or the proxy reported no figures. */
export function headroomSegment({ summary }: RenderContext): string | undefined {
  return headroomText(summary.headroom);
}
