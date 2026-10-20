import type { StatuslineSummary } from "../../enrich";
import type { Translate } from "../../messages/catalogues";
import { formatTokens, ONE_PERCENT } from "../../style";
import type { RenderContext } from "../context";

/** What headroom's compression saved this session, as tokens, percentage and dollars; each figure is left out when the proxy did not report it, and undefined when none was reported. */
function headroomText(stats: StatuslineSummary["headroom"], t: Translate): string | undefined {
  if (stats === undefined) {
    return undefined;
  }
  // Under one percent a single decimal hides most of the figure (a saving of 0.01% would read 0.0%), so it gets two.
  const overall = stats.savingsPercent === undefined ? undefined : t("headroom.overall", { percent: stats.savingsPercent.toFixed(stats.savingsPercent < ONE_PERCENT ? 2 : 1) });
  const parts = [
    stats.tokensSaved === undefined ? undefined : t("headroom.saved", { tokens: formatTokens(stats.tokensSaved) }),
    overall,
    stats.savingsUsd === undefined ? undefined : `$${stats.savingsUsd.toFixed(2)}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : t("headroom.label", { parts: parts.join(" \u00B7 ") });
}


/** What headroom saved this session, or undefined when the session does not go through it or the proxy reported no figures. */
export function headroomSegment({ summary, t }: RenderContext): string | undefined {
  return headroomText(summary.headroom, t);
}
