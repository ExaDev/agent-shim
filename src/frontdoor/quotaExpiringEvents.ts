import { QUOTA_EXPIRING_EVENT_SOURCE, USAGE_EVENT_SOURCE, type QuotaExpiringEvent } from "./eventSchemas";
import type { DoorEventHub } from "./eventHub";
import { UsageSnapshotSchema, type UsageSnapshot } from "../usage/schema";

/**
 * The expiring-quota publisher: an identity's window with allowance still unspent that is about to reset, published once when it enters its final span, so a scheduler can spend what would otherwise be lost. Computed from the same per-identity snapshots and unified windows the pool ranking reads (`rankPool`'s own inputs), without the ranking itself: the event is finer than a pick, one identity, one provider, one window, independent of any pool.
 *
 * The snapshots it checks are kept fresh by the backbone itself: seeded once from the snapshot directory at assembly, then updated by the usage source's own events, so the check on the supervisor's tick costs arithmetic over in-memory state, never a file read, and a window crossing its final span by the clock is still caught even though nothing wrote a snapshot at that moment.
 *
 * One event per (identity, provider, window, reset instant): the window entering its final span publishes, further ticks in the same span stay silent, and a later window instance (a new reset instant) publishes again. A window already fully used publishes nothing, because there is no allowance left to spend.
 */

/** One hour in milliseconds, the unit the windows' own spans are stated in. */
const MS_PER_HOUR = 3_600_000;

/** One day in milliseconds, the unit the seven-day window's span is stated in. */
const MS_PER_DAY = 86_400_000;

/** The hours in the five-hour unified window, the span the header's own name states. */
const FIVE_HOUR_WINDOW_HOURS = 5;

/** The days in the seven-day unified window, the span the header's own name states. */
const SEVEN_DAY_WINDOW_DAYS = 7;

/** The five-hour unified window's own span, the unit its final fraction is taken of. */
export const FIVE_HOUR_WINDOW_MS = FIVE_HOUR_WINDOW_HOURS * MS_PER_HOUR;

/** The seven-day unified window's own span, the unit its final fraction is taken of. */
const SEVEN_DAY_WINDOW_MS = SEVEN_DAY_WINDOW_DAYS * MS_PER_DAY;

/** The denominator of the final-span fraction: the window's span divided by this is the stretch that counts as expiring. */
const FINAL_SPAN_DENOMINATOR = 30;

/**
 * The final fraction of a window's own span within which it counts as expiring: the final thirtieth, which for the five-hour window is the last ten minutes and for the seven-day window the final stretch under six hours. A fraction rather than a flat lead keeps the notice proportional to how long the window took to fill: a scheduler learns of a five-hour window's expiry with minutes to act and a seven-day window's with hours, and no constant is tuned per window.
 */
export const QUOTA_EXPIRING_WINDOW_FRACTION = 1 / FINAL_SPAN_DENOMINATOR;

/** Everything the expiring-quota publisher needs: the backbone (its usage source keeps the snapshots fresh), the snapshots as they stand at assembly, and the clock the tick reads. */
export interface QuotaExpiringPublisher {
  /** Checks every held window against the clock and publishes each one newly inside its final span. Idempotent within one span; cheap enough for the supervisor's every tick. */
  readonly check: () => void;
}

/** One window as the check reads it: the kind (which also names its span), its utilisation, and its reset instant in epoch milliseconds. */
interface WindowView {
  readonly window: "fiveHour" | "sevenDay";
  readonly spanMs: number;
  readonly utilization: number;
  readonly resetsAtMs: number;
}

/** Creates the expiring-quota publisher. One per door process, checked on the supervisor's tick. */
export function createQuotaExpiringPublisher(hub: DoorEventHub, deps: { readonly seed: readonly UsageSnapshot[]; readonly now: () => number }): QuotaExpiringPublisher {
  const publisher = hub.publisher(QUOTA_EXPIRING_EVENT_SOURCE);
  const latest = new Map<string, UsageSnapshot>();
  for (const snapshot of deps.seed) {
    latest.set(snapshot.identity, snapshot);
  }
  hub.subscribe([USAGE_EVENT_SOURCE], (event) => {
    const snapshot = UsageSnapshotSchema.parse(event.payload);
    latest.set(snapshot.identity, snapshot);
  });
  /** The reset instants already published, so one span publishes once; a new reset instant (the next window) is a new key and publishes again. */
  const announced = new Set<string>();
  const windowsOf = (snapshot: UsageSnapshot): readonly { readonly provider: string; readonly view: WindowView }[] => {
    const views: { provider: string; view: WindowView }[] = [];
    for (const provider of Object.keys(snapshot.providers).sort()) {
      const unified = snapshot.providers[provider]?.rateLimit?.unified;
      // A window without both a utilisation and a reset instant cannot be judged for expiry, so it is not one of this source's facts; the schema's own optionality is the honest statement of that.
      const fiveHour = unified?.fiveHour;
      if (fiveHour?.utilization !== undefined && fiveHour.resetsAt !== undefined) {
        views.push({ provider, view: { window: "fiveHour", spanMs: FIVE_HOUR_WINDOW_MS, utilization: fiveHour.utilization, resetsAtMs: Date.parse(fiveHour.resetsAt) } });
      }
      const sevenDay = unified?.sevenDay;
      if (sevenDay?.utilization !== undefined && sevenDay.resetsAt !== undefined) {
        views.push({ provider, view: { window: "sevenDay", spanMs: SEVEN_DAY_WINDOW_MS, utilization: sevenDay.utilization, resetsAtMs: Date.parse(sevenDay.resetsAt) } });
      }
    }
    return views;
  };
  return {
    check: () => {
      const now = deps.now();
      for (const identity of [...latest.keys()].sort()) {
        const snapshot = latest.get(identity);
        if (snapshot === undefined) {
          continue;
        }
        for (const { provider, view } of windowsOf(snapshot)) {
          // The three facts that make an event: allowance still unspent, a reset still in the future, and the final span of the window's own length already entered. A window past its reset reads as reset by every other consumer and has nothing left to spend in any case.
          if (view.utilization >= 1 || view.resetsAtMs <= now || view.resetsAtMs - now >= view.spanMs * QUOTA_EXPIRING_WINDOW_FRACTION) {
            continue;
          }
          const key = `${identity}:${provider}:${view.window}:${String(view.resetsAtMs)}`;
          if (announced.has(key)) {
            continue;
          }
          announced.add(key);
          publisher.publish({ identity, provider, window: view.window, utilization: view.utilization, resetsAt: new Date(view.resetsAtMs).toISOString(), observedAt: now } satisfies QuotaExpiringEvent);
        }
      }
    },
  };
}
