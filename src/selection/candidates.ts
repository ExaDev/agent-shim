import type { SelectionCandidate } from "./engine";
import type { TargetObservation } from "./signals";
import { blendedPricePerMTok } from "./signals";

/** One window's facts as the candidate builder reads them: the shape `windowFacts` returns. */
export interface CandidateWindowFacts {
  readonly remaining: number;
  readonly hoursUntilReset: number;
}

/** The least share of a window's period that must have elapsed before its pace is projected forward: earlier than that, a single burst is most of what the window has seen, so the average pace says little and the window is not taken to run dry. */
const MIN_PROJECTION_ELAPSED_SHARE = 0.1;

/** The period each named window runs over, in hours: what turns "remaining allowance" into the pressure of a steady burn. */
const WINDOW_PERIOD_HOURS: Readonly<Record<string, number>> = { fiveHour: 5, sevenDay: 168, extraUsage: 168 };

/**
 * One member's signals, as the door holds them when it builds a virtual model's candidates: the quota windows its provider's recorded rate limit reports (absent when nothing has been recorded, which counts as available until a request says otherwise), what its recent requests observed, and its configured prices.
 */
export interface CandidateFacts {
  readonly quota?: Readonly<Partial<Record<"fiveHour" | "sevenDay" | "extraUsage", CandidateWindowFacts>>>;
  readonly observation?: TargetObservation;
  readonly price?: Readonly<{ input: number; output: number }>;
}

/** Builds one candidate from its member ref, its position, its signals and whether it is what the session already uses. Pure: the door reads the signals, this decides what they mean. */
export function candidateOf(ref: string, order: number, facts: CandidateFacts, isCurrent: boolean): SelectionCandidate {
  const present = Object.entries(facts.quota ?? {}).map(([name, window]) => ({ name, ...window }));
  const available = present.every((window) => window.remaining > 0);
  const remainingAllowance = present.length === 0 ? undefined : Math.min(...present.map((window) => window.remaining));
  const hoursToReset = present.length === 0 ? undefined : Math.min(...present.map((window) => window.hoursUntilReset));
  // The antigravity pressure idea: the allowance divided by the share of the period still to run. A window that has 40% left with 80% of its period gone would leave three quarters of the allowance unspent at a steady burn, so it ranks below an even split.
  const pressure =
    present.length === 0
      ? undefined
      : Math.max(
          ...present.map((window) => {
            const period = WINDOW_PERIOD_HOURS[window.name] ?? Number.NaN;
            return period > 0 && window.hoursUntilReset > 0 ? window.remaining / (window.hoursUntilReset / period) : Number.NaN;
          }),
        );
  // The observed pace is the window's own: the allowance spent so far over the time elapsed since the window opened. Projected forward it says whether the remainder lasts to the reset, which is what separates a candidate with allowance left from one that will not have it when the request is served.
  const runsDry = present.some((window) => {
    const period = WINDOW_PERIOD_HOURS[window.name] ?? Number.NaN;
    const elapsed = period - window.hoursUntilReset;
    if (!(elapsed >= period * MIN_PROJECTION_ELAPSED_SHARE) || window.hoursUntilReset <= 0) {
      return false;
    }
    const pace = (1 - window.remaining) / elapsed;
    return pace > 0 && window.remaining / pace < window.hoursUntilReset;
  });
  return {
    ref,
    order,
    available,
    ...(remainingAllowance === undefined ? {} : { remainingAllowance }),
    ...(hoursToReset === undefined ? {} : { hoursToReset }),
    ...(pressure === undefined || Number.isNaN(pressure) ? {} : { pressure }),
    feasible: available && !runsDry,
    ...(facts.observation?.latencyMs === undefined ? {} : { latencyMs: facts.observation.latencyMs }),
    ...(facts.observation?.successRate === undefined ? {} : { successRate: facts.observation.successRate }),
    ...(facts.price === undefined || facts.observation?.tokenMix === undefined
      ? {}
      : { pricePerMTok: blendedPricePerMTok(facts.price, facts.observation.tokenMix) }),
    isCurrent,
  };
}
