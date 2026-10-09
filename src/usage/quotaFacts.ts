import type { PoolWindowFacts } from "../resolve/conditions";
import { soleOverageWindow } from "./rateLimit";
import type { QuotaWindow, UnifiedRateLimit } from "./schema";

const MS_PER_HOUR = 3_600_000;

/**
 * One recorded window as the facts a condition reads, or undefined when the window reported no utilisation or no reset instant: a window that cannot answer every fact is absent as a whole, so a condition naming it is indeterminate, never a guessed zero.
 */
export function windowFacts(window: Readonly<QuotaWindow> | undefined, nowMs: number): PoolWindowFacts | undefined {
  if (window?.utilization === undefined || window.resetsAt === undefined) {
    return undefined;
  }
  return { remaining: Math.max(0, 1 - window.utilization), utilization: window.utilization, hoursUntilReset: Math.max(0, (Date.parse(window.resetsAt) - nowMs) / MS_PER_HOUR) };
}

/** The windows of one recorded rate-limit state as condition facts. `extraUsage` is present only when the extra-usage allowance is the account's sole budget (see `soleOverageWindow`), so a plan account's fallback allowance never answers a condition about its quota. */
export function quotaFactsOf(unified: Readonly<UnifiedRateLimit> | undefined, nowMs: number): { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts } {
  const fiveHour = windowFacts(unified?.fiveHour, nowMs);
  const sevenDay = windowFacts(unified?.sevenDay, nowMs);
  const extraUsage = windowFacts(unified === undefined ? undefined : soleOverageWindow(unified), nowMs);
  return { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }), ...(extraUsage === undefined ? {} : { extraUsage }) };
}
