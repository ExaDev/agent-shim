import type { ProviderQuota, ProviderUsageState, QuotaWindow, UnifiedRateLimit } from "./schema";
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "./windowLengths";

/** The plan windows a ranking reads for one provider's slice of a usage snapshot, and when they were last recorded. */
export interface RankingWindows {
  readonly unified: UnifiedRateLimit;
  readonly observedAt: string;
}

/** The binding window among those of one length: the most used, since a provider can report several buckets of one length (one per model family) and the member can serve only as long as the tightest has room. */
function bindingWindow(quota: Readonly<ProviderQuota>, periodMs: number): QuotaWindow | undefined {
  const same = quota.windows.filter((window) => window.periodMs === periodMs);
  const tightest = same.reduce<ProviderQuota["windows"][number] | undefined>((binding, window) => (binding === undefined || window.utilization > binding.utilization ? window : binding), undefined);
  if (tightest === undefined) {
    return undefined;
  }
  // A window used in full serves nothing until it resets, which is what a rejected window means to every consumer of the unified shape.
  return { utilization: tightest.utilization, ...(tightest.resetsAt === undefined ? {} : { resetsAt: tightest.resetsAt }), status: tightest.utilization >= 1 ? "rejected" : "allowed" };
}

/**
 * The five-hour and seven-day windows a provider's pulled quota reports, in the unified shape the ranking reads, or undefined when none of its windows has either length. A provider's usage endpoint names its windows by its own terms (a bucket id, a token or request count); only a window whose length is known to be one of the two plan windows stands for it, so a daily request allowance or a prepaid balance never poses as a subscription window.
 */
function unifiedFromQuota(quota: Readonly<ProviderQuota>): UnifiedRateLimit | undefined {
  const fiveHour = bindingWindow(quota, FIVE_HOUR_WINDOW_MS);
  const sevenDay = bindingWindow(quota, SEVEN_DAY_WINDOW_MS);
  return fiveHour === undefined && sevenDay === undefined ? undefined : { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }) };
}

/**
 * The windows a pool ranking reads from one provider's slice of a snapshot, or undefined when the slice has none to read.
 *
 * The Claude account (`provider` undefined) is read from the rate-limit state the front door recorded off Anthropic's headers, exactly as before providers existed. A named provider is read from its own recorded rate-limit state when that carries a plan window (the front door derives one from the provider's response headers), else from the quota its usage endpoint last reported; a provider's slice with neither says nothing about the member, which the ranking treats as unknown rather than reading another provider's windows in its place.
 */
export function rankingWindowsOf(provider: string | undefined, state: Readonly<ProviderUsageState> | undefined): RankingWindows | undefined {
  const recorded = state?.rateLimit;
  if (provider === undefined) {
    return recorded?.unified === undefined ? undefined : { unified: recorded.unified, observedAt: recorded.observedAt };
  }
  if (recorded?.unified !== undefined && (recorded.unified.fiveHour !== undefined || recorded.unified.sevenDay !== undefined)) {
    return { unified: recorded.unified, observedAt: recorded.observedAt };
  }
  const pulled = state?.quota === undefined ? undefined : unifiedFromQuota(state.quota);
  return state?.quota === undefined || pulled === undefined ? undefined : { unified: pulled, observedAt: state.quota.observedAt };
}
