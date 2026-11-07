import { formatAge, type EffectiveWindow } from "./preflight";
import type { Candidate } from "./pick";
import type { QuotaWindow } from "./schema";

const PERCENT = 100;

/**
 * How a ranked pool member is described after its name, in `pool pick` and in a launch's explanation of its pick: its class, with its score and the reset the score divides by when it has one, a note when its five-hour window would run dry, and the provider it was ranked on when its launch spends one in place of its Claude account.
 */
export function candidateHeading(candidate: Readonly<Pick<Candidate, "class" | "score" | "scoreWindow" | "feasible" | "provider">>): string {
  const score = candidate.score === undefined ? "" : ` score ${candidate.score.toFixed(2)}${candidate.scoreWindow === "fiveHour" ? " by 5h reset" : " by 7d reset"}`;
  const dry = candidate.feasible ? "" : " (5h would run dry)";
  const onProvider = candidate.provider === undefined ? "" : ` on provider ${candidate.provider}`;
  return `[${candidate.class}${score}]${dry}${onProvider}`;
}

/** A fraction as a whole percentage, `0.25` as `25%`. */
export function percent(fraction: number): string {
  return `${String(Math.round(fraction * PERCENT))}%`;
}

/**
 * How one recorded quota window reads in a pool pick's reasons and in a launch's quota row: `label` with how much of it is used and when it resets, or that it has reset when its reset instant has passed (what was last recorded then describes a window that no longer exists). A window the API itself marks `allowed_warning` is flagged nearly used.
 */
export function describeWindow(label: string, window: Readonly<QuotaWindow>, effective: EffectiveWindow, nowMs: number): string {
  if (effective.reset) {
    return `${label} window has reset`;
  }
  const used = effective.utilization === undefined ? "usage unknown" : `${percent(effective.utilization)} used`;
  const resets = effective.resetsAtMs === undefined ? "" : `, resets in ${formatAge(effective.resetsAtMs - nowMs)}`;
  return `${label} ${used}${resets}${window.status === "allowed_warning" ? " (nearly used)" : ""}`;
}
