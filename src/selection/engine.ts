/**
 * The selection engine: how a virtual model chooses one member from its candidates.
 *
 * Every mode is a pure function of the candidates and their signals plus a rotation seed, so a choice is testable without a door, a clock or a network, and `--explain` can show the reasons a choice was made. The quota-shaped signals are computed by the caller (the door), from the same sources the antigravity translator and the pool ranking read.
 */

/** One candidate a virtual model may serve a request from, with the signals the modes read. */
export interface SelectionCandidate {
  /** The member's target ref (`z/glm-5.3`). */
  readonly ref: string;
  /** The candidate's position in the member list: the preference order, and the tie-breaker of last resort. */
  readonly order: number;
  /** Whether the candidate's quota lets it serve: unspent, or unknown, which counts as available until a request says otherwise. */
  readonly available: boolean;
  /** The smallest remaining allowance across the candidate's windows, as a fraction of one window (0 to 1). */
  readonly remainingAllowance?: number;
  /** Hours until the candidate's soonest binding window resets. */
  readonly hoursToReset?: number;
  /** The candidate's allowance divided by the share of its period still to run, taking the binding (smallest) window: the antigravity pressure idea, how much of the allowance a steady burn would leave unspent at the reset. */
  readonly pressure?: number;
  /** Whether the candidate would run dry, at the observed pace, before its window resets. */
  readonly feasible: boolean;
  /** The observed median latency of the candidate's recent requests, in milliseconds. */
  readonly latencyMs?: number;
  /** The observed share of the candidate's recent requests that succeeded, from 0 to 1. */
  readonly successRate?: number;
  /** The candidate's blended price per million tokens, from the configured prices weighted by the observed token mix; absent when either half is unknown. */
  readonly pricePerMTok?: number;
  /** Whether this candidate is the model the session is already on: switching re-sends the whole conversation uncached. */
  readonly isCurrent: boolean;
}

/** What the request being placed needs, for the modes that filter before they rank. */
export interface RequestNeeds {
  /** Whether the request carries an image, which only some models accept. */
  readonly hasImage: boolean;
  /** Whether the request carries tools, which only some models accept. */
  readonly hasTools: boolean;
  /** Whether the request asks for extended thinking. */
  readonly thinking: boolean;
  /** The size of the context the request re-sends, in tokens, for weighing a switch. */
  readonly contextTokens: number;
}

/** One candidate augmented with what the request can rule out. */
export interface EvaluatedCandidate {
  readonly candidate: SelectionCandidate;
  readonly capabilities: { readonly vision: boolean; readonly tools: boolean; readonly thinking: boolean };
}

/** The selection modes a virtual model can choose its member by. */
/** The selection modes a virtual model can choose its member by. */
export type SelectionMode = "ordered" | "most-allowance" | "soonest-reset" | "spread" | "adaptive" | "lowest-latency" | "highest-success" | "cheapest";

/** A mode's decision: the member chosen, the candidates it ruled out with why, and the reason it picked what it did. */
export interface Selection {
  readonly ref: string | undefined;
  /** Why each candidate stands where it does, in the order the mode considered them. */
  readonly reasons: readonly string[];
}

/** Below this observed success rate, `adaptive` treats a candidate as unhealthy and rules it out while others stand. */
const ADAPTIVE_HEALTH_FLOOR = 0.5;

/** Compares two numbers that may be absent: an absent value always loses, whether the larger or the smaller wins, because an unknown signal must never outrank a measured one. */
function compareMaybe(left: number | undefined, right: number | undefined, preferHigh: boolean): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return preferHigh ? right - left : left - right;
}

/** Orders candidates by the comparator, with the member list's order and then the ref breaking ties, so a choice is deterministic whatever the signals do. */
function by(comparator: (left: SelectionCandidate, right: SelectionCandidate) => number, candidates: readonly SelectionCandidate[]): SelectionCandidate[] {
  return [...candidates].sort((left, right) => comparator(left, right) || left.order - right.order || (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}

const availability = (candidate: SelectionCandidate): string => (candidate.available ? "" : "quota spent");

/**
 * `ordered`: the member list's order, skipping spent candidates; among the unspent, a spent preference falls to the fallback whose allowance is worth the most (the highest pressure, as antigravity routes today), and when everything is spent, the member whose binding window lifts soonest.
 */
function selectOrdered(candidates: readonly SelectionCandidate[]): Selection {
  const reasons = candidates.map((candidate) => `${candidate.ref}${availability(candidate)}`);
  const unspent = candidates.filter((candidate) => candidate.available);
  const current = unspent.find((candidate) => candidate.isCurrent);
  if (current !== undefined) {
    return { ref: current.ref, reasons: [...reasons, `${current.ref} is the model this session is already on and still has quota`] };
  }
  const first = by((left, right) => left.order - right.order, candidates)[0];
  if (first?.available === true) {
    return { ref: first.ref, reasons: [...reasons, `${first.ref} is the first member with quota`] };
  }
  const byPressure = by((left, right) => compareMaybe(left.pressure, right.pressure, true), unspent);
  const top = byPressure[0];
  if (top !== undefined) {
    return { ref: top.ref, reasons: [...reasons, `${top.ref} carries the most allowance its reset would waste`] };
  }
  const byReset = by((left, right) => compareMaybe(left.hoursToReset, right.hoursToReset, false), candidates);
  return { ref: byReset[0]?.ref, reasons: [...reasons, "every member is spent; serving from the one whose window lifts soonest"] };
}

/** Selects by ranking the available candidates with `comparator`, keeping the current member unless a better one beats it by a margin, and falling back to `ordered` when nothing is available. */
function selectRanked(candidates: readonly SelectionCandidate[], comparator: (left: SelectionCandidate, right: SelectionCandidate) => number, what: string, why: string): Selection {
  const ordered = selectOrdered(candidates);
  const available = candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return ordered;
  }
  const ranked = by(comparator, available);
  const best = ranked[0];
  if (best === undefined) {
    return ordered;
  }
  // A current member that ties the best is kept over it: the same choice, without re-sending the conversation.
  const current = available.find((candidate) => candidate.isCurrent);
  const chosen = current !== undefined && (comparator(current, best) === 0 || best.isCurrent) ? current : best;
  if (chosen.isCurrent || current === undefined) {
    return { ref: chosen.ref, reasons: [...ordered.reasons, `${chosen.ref} ${what}`] };
  }
  return { ref: best.ref, reasons: [...ordered.reasons, `${best.ref} ${what}; the switch from the current member is worth re-sending the conversation because ${why}`] };

}

/**
 * Chooses one member by `mode`. Every mode skips spent candidates and falls back to `ordered`'s spent-handling when none is available; `spread` needs the caller's rotation count, which advances by one each time the mode is used.
 */
export function selectMember(mode: SelectionMode, candidates: readonly EvaluatedCandidate[], options: Readonly<{ rotation?: number; needs?: RequestNeeds }> = {}): Selection {
  const plain = candidates.map((entry) => entry.candidate);
  switch (mode) {
    case "ordered":
      return selectOrdered(plain);
    case "most-allowance":
      return selectRanked(plain, (left, right) => compareMaybe(left.remainingAllowance, right.remainingAllowance, true), "holds the most remaining allowance", "its allowance is the largest");
    case "soonest-reset":
      return selectRanked(plain, (left, right) => compareMaybe(left.hoursToReset, right.hoursToReset, false), "resets soonest, so its allowance is the most use-it-or-lose-it", "its reset is the soonest");
    case "lowest-latency":
      return selectRanked(plain, (left, right) => compareMaybe(left.latencyMs, right.latencyMs, false), "has answered fastest of late", "its latency is the lowest observed");
    case "highest-success":
      return selectRanked(plain, (left, right) => compareMaybe(left.successRate, right.successRate, true), "has succeeded most reliably of late", "its success rate is the highest observed");
    case "cheapest":
      return selectRanked(plain, (left, right) => compareMaybe(left.pricePerMTok, right.pricePerMTok, false), "is the cheapest for the tokens this session sends", "its blended price is the lowest");
    case "spread": {
      const ordered = selectOrdered(plain);
      const available = plain.filter((candidate) => candidate.available);
      if (available.length === 0) {
        return ordered;
      }
      const rotation = options.rotation ?? 0;
      const orderedByList = by((left, right) => left.order - right.order, available);
      const chosen = orderedByList[rotation % orderedByList.length];
      return chosen === undefined ? ordered : { ref: chosen.ref, reasons: [...ordered.reasons, `${chosen.ref} is turn ${String(rotation % orderedByList.length + 1)} of the spread across the members with quota`] };
    }
    case "adaptive":
      return selectAdaptive(candidates, options.needs);
  }
  return selectOrdered(plain);
}

/**
 * `adaptive`: rules out what the request rules out (a capability the request needs, a projection to run dry, a candidate that has been failing), keeps the current member while it stands, and otherwise serves from what the signals rank best, weighing a switch against re-sending the conversation.
 */
function selectAdaptive(candidates: readonly EvaluatedCandidate[], needs: RequestNeeds | undefined): Selection {
  const plain = candidates.map((entry) => entry.candidate);
  const ruledOut = candidates
    .map((entry) => {
      const { candidate, capabilities } = entry;
      if (needs?.hasImage === true && !capabilities.vision) {
        return `${candidate.ref} does not accept images`;
      }
      if (needs?.hasTools === true && !capabilities.tools) {
        return `${candidate.ref} does not accept tools`;
      }
      if (needs?.thinking === true && !capabilities.thinking) {
        return `${candidate.ref} does not think`;
      }
      if (candidate.available && !candidate.feasible) {
        return `${candidate.ref} would run dry before its window resets`;
      }
      if (candidate.successRate !== undefined && candidate.successRate < ADAPTIVE_HEALTH_FLOOR) {
        return `${candidate.ref} has been failing`;
      }
      return undefined;
    })
    .filter((line): line is string => line !== undefined);
  const standing = candidates.filter((entry) => {
    const { candidate, capabilities } = entry;
    if (!candidate.available) {
      return false;
    }
    if (needs?.hasImage === true && !capabilities.vision) {
      return false;
    }
    if (needs?.hasTools === true && !capabilities.tools) {
      return false;
    }
    if (needs?.thinking === true && !capabilities.thinking) {
      return false;
    }
    if (!candidate.feasible) {
      return false;
    }
    return !(candidate.successRate !== undefined && candidate.successRate < ADAPTIVE_HEALTH_FLOOR);
  });
  const reasons = [...ruledOut];
  if (standing.length === 0) {
    const fallback = selectOrdered(plain);
    return { ref: fallback.ref, reasons: [...reasons, "nothing stands: serving by order"] };
  }
  const current = standing.find((entry) => entry.candidate.isCurrent);
  if (current !== undefined) {
    return { ref: current.candidate.ref, reasons: [...reasons, `${current.candidate.ref} stands and is the model this session is already on, so the conversation is not re-sent`] };
  }
  const ranked = by(
    (left, right) =>
      compareMaybe(left.pressure, right.pressure, true) ||
      compareMaybe(left.hoursToReset, right.hoursToReset, false) ||
      compareMaybe(left.successRate, right.successRate, true),
    standing.map((entry) => entry.candidate),
  );
  const best = ranked[0];
  if (best === undefined) {
    return { ref: undefined, reasons };
  }
  return { ref: best.ref, reasons: [...reasons, `${best.ref} stands and carries the most allowance its reset would waste`] };
}
