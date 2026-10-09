import type { WhenCondition } from "../config/schema";
import { evaluateWhen, type ConditionContext, type PoolWindowFacts } from "../resolve/conditions";
import { planOf, type PlanClass } from "./plan";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { effectiveWindow, formatAge, type EffectiveWindow } from "./preflight";
import { quotaFactsOf } from "./quotaFacts";
import { parseUnifiedRateLimit, soleOverageWindow } from "./rateLimit";
import type { AccountMetadata, ProviderUsageState, QuotaWindow, UnifiedRateLimit, UsageRecord, UsageSnapshot } from "./schema";

/**
 * Ranks the members of a pool for a launch, from what the usage store recorded. Pure: snapshots, account metadata, log records and the clock all come in as values, so the launcher, `agent-shim pool pick` and the tests share one ranking.
 *
 * The default idea is use-it-or-lose-it. A subscription's window empties on a schedule whatever happens, so unused quota in a window that resets soon is wasted, while unused quota in a window that resets in days can still be spent later. The account to launch on is therefore the one whose remaining quota, in plan-size terms, expires soonest per hour of runway, provided its five-hour window will not run dry at the pace the person has been working, and provided it is not currently refused. A pool can instead ask for `listed` preference, which ranks members strictly in the order the pool lists them, skipping only a member that is currently refused.
 */

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const FIVE_HOURS = 5;
const PROMPT_CACHE_TTL_HOURS = 1;
const PERCENT = 100;
const SEVEN_DAYS = 7;

/** The lengths of Anthropic's two subscription windows, used when a window reported no reset time of its own. */
export const FIVE_HOUR_WINDOW_MS = FIVE_HOURS * MS_PER_HOUR;
export const SEVEN_DAY_WINDOW_MS = SEVEN_DAYS * HOURS_PER_DAY * MS_PER_HOUR;

/** Anthropic's longest prompt-cache lifetime (the one-hour tier): a conversation resumed within it still has a warm cache on the account that served it, and the cache is per organisation, so it is lost by switching. */
export const PROMPT_CACHE_TTL_MS = PROMPT_CACHE_TTL_HOURS * MS_PER_HOUR;

/**
 * Stands for a nested `pool:<name>` member entry rather than a direct identity. `pick` carries the nested pool's own pick (its identity and reasons), which the outer ranking re-ranks from that identity's snapshot like any member; `refused` marks an entry whose every member is refused, so the entry itself is ineligible, carrying the nested pool's earliest return.
 */
export type NestedContribution =
  | { readonly kind: "pick"; readonly pool: string; readonly reasons: readonly string[] }
  | { readonly kind: "refused"; readonly pool: string; readonly earliestReturn?: { readonly identity: string; readonly atMs: number } };

/** The state a member's ranking was built from. */
export interface PoolMember {
  readonly identity: string;
  /** The identity's usage snapshot, when it has one. */
  readonly snapshot?: UsageSnapshot;
  /** Why the member's recorded state could not be read (a corrupt or newer-schema snapshot, an unreadable login file), when that is the case. */
  readonly readError?: string;
  readonly account?: AccountMetadata;
  /** The member's usage-log records from the current five-hour window on. */
  readonly records: readonly UsageRecord[];
  /** Present when this member stands for a nested `pool:<name>` entry rather than a direct identity. */
  readonly nested?: NestedContribution;
  /** The member entry's policy condition, from the object form of a pool member: definite false skips the member as ineligible by policy, indeterminate demotes it to last within its class, naming the missing fact either way. */
  readonly policy?: WhenCondition;
}

/** The member last picked for this directory, kept so a conversation stays on the account whose prompt cache is warm. */
export interface StickyPick {
  readonly identity: string;
  readonly at: string;
}

export interface RankPoolInput {
  readonly members: readonly PoolMember[];
  readonly nowMs: number;
  readonly sticky?: StickyPick;
  /** True when the launch continues or resumes a conversation, which belongs on the account it started on whatever the cache lifetime. */
  readonly resuming: boolean;
  /** How members are ordered: "score" (the default when absent) by the use-it-or-lose-it ranking, "listed" strictly in `members` order. */
  readonly preference?: "score" | "listed";
}

/** In pick order. `scored` has usable quota data; `unknown` has none (never recorded, or unreadable); `pay-per-use` bills by use instead of drawing on a plan; `ineligible` is refused right now. */
type CandidateClass = "scored" | "unknown" | "pay-per-use" | "ineligible";

const CLASS_ORDER: Readonly<Record<CandidateClass, number>> = { scored: 0, unknown: 1, "pay-per-use": 2, ineligible: 3 };

export interface Candidate {
  readonly identity: string;
  readonly class: CandidateClass;
  /** Plan-size-weighted remaining quota per hour until its reset: higher is more wasted if left unused. Present for `scored` only. */
  readonly score?: number;
  /** False when a quota window would run dry, at the observed pace, before it resets (the five-hour at its own or the rescaled shared pace, the seven-day at its own). A `scored` candidate that is not feasible ranks below every feasible one. */
  readonly feasible: boolean;
  /** The fraction of the extra-usage allowance still unspent, for a `pay-per-use` member whose only budget is that allowance (an Enterprise account). A member reporting none ranks as having all of it: no cap is known to bind. */
  readonly headroom?: number;
  /** When an `ineligible` candidate can be used again. */
  readonly blockedUntilMs?: number;
  readonly plan: PlanClass;
  /** True when the member's policy condition could not be decided and it is ranked last within its class, naming the missing fact in its reasons. */
  readonly policyDemoted?: boolean;
  /** Human-readable facts behind the class and score, in the order they matter. */
  readonly reasons: readonly string[];
}

export interface PoolRanking {
  /** Every member, best first. */
  readonly candidates: readonly Candidate[];
  /** The member to launch on: the best one that is not refused. Undefined when every member is refused. */
  readonly pick?: Candidate;
  /** When nothing can be picked, the soonest any member comes back. */
  readonly earliestReturn?: { readonly identity: string; readonly atMs: number };
  /** The member a resumed or continued conversation started on but moved off, and why, when a launch that resumes could not keep it. One sentence for the launch decision line and `check`. */
  readonly movedOff?: { readonly identity: string; readonly reason: string };
}

function unifiedOf(state: ProviderUsageState | undefined): UnifiedRateLimit | undefined {
  return state?.rateLimit?.unified;
}

/** When a refusal the member last hit still binds, or undefined when it has lapsed or a later request succeeded. */
function limitBlockedUntil(state: ProviderUsageState | undefined, nowMs: number): number | undefined {
  const limit = state?.lastLimit;
  if (state === undefined || limit === undefined) {
    return undefined;
  }
  // The snapshot keeps the last refusal after later successes, so a request that started after the refusal was seen means it has lifted.
  if (state.lastRequestAt !== undefined && Date.parse(state.lastRequestAt) > Date.parse(limit.observedAt)) {
    return undefined;
  }
  const until =
    limit.resetAt === undefined
      ? limit.retryAfterSeconds === undefined
        ? undefined
        : Date.parse(limit.observedAt) + limit.retryAfterSeconds * MS_PER_SECOND
      : Date.parse(limit.resetAt);
  return until !== undefined && until > nowMs ? until : undefined;
}

/** When the member's plan windows, as recorded, stop refusing it: the latest reset among windows still marked rejected. */
function windowBlockedUntil(windows: readonly EffectiveWindow[]): number | undefined {
  const resets = windows.flatMap((window) => (window.status === "rejected" && window.resetsAtMs !== undefined ? [window.resetsAtMs] : []));
  return resets.length === 0 ? undefined : Math.max(...resets);
}

interface BurnPoint {
  readonly atMs: number;
  readonly utilization: number;
}

/**
 * The pace of one window's utilisation, per millisecond, over the member's records in its current instance of that window, or undefined without two readings that show it rising. The same arithmetic reads either window: the records carry both, and each window's pace is measured in its own utilisation fractions.
 */
function windowBurn(records: readonly UsageRecord[], which: "fiveHour" | "sevenDay"): number | undefined {
  const points: { resetsAt: string; point: BurnPoint }[] = [];
  for (const record of records) {
    const window = record.rateLimitHeaders === undefined ? undefined : parseUnifiedRateLimit(record.rateLimitHeaders)?.[which];
    if (window?.utilization !== undefined && window.resetsAt !== undefined) {
      points.push({ resetsAt: window.resetsAt, point: { atMs: Date.parse(record.at), utilization: window.utilization } });
    }
  }
  const latest = points.at(-1)?.resetsAt;
  const current = points.filter((entry) => entry.resetsAt === latest).map((entry) => entry.point);
  const first = current.at(0);
  const last = current.at(-1);
  if (first === undefined || last === undefined || last.atMs <= first.atMs || last.utilization <= first.utilization) {
    return undefined;
  }
  return (last.utilization - first.utilization) / (last.atMs - first.atMs);
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * PERCENT))}%`;
}

function describeWindow(label: string, window: Readonly<QuotaWindow>, effective: EffectiveWindow, nowMs: number): string {
  if (effective.reset) {
    return `${label} window has reset`;
  }
  const used = effective.utilization === undefined ? "usage unknown" : `${percent(effective.utilization)} used`;
  const resets = effective.resetsAtMs === undefined ? "" : `, resets in ${formatAge(effective.resetsAtMs - nowMs)}`;
  return `${label} ${used}${resets}${window.status === "allowed_warning" ? " (nearly used)" : ""}`;
}

/** A candidate before the pool-wide feasibility pass settles `feasible`. */
type Draft = Omit<Candidate, "feasible">;

function capacityOf(plan: PlanClass): number {
  return plan.kind === "subscription" ? plan.capacity : 1;
}

interface Assessment {
  readonly candidate: Draft;
  /** Five-hour remaining fraction and time to reset, for the feasibility pass. */
  readonly fiveHour?: { readonly remaining: number; readonly untilResetMs: number };
  readonly burn?: number;
  /** Seven-day remaining fraction and time to reset, for the same pass over the longer window. */
  readonly sevenDay?: { readonly remaining: number; readonly untilResetMs: number };
  /** The seven-day window's own observed pace, in its own utilisation fractions per millisecond. */
  readonly sevenDayBurn?: number;
}

/** A nested entry whose every member is refused is itself ineligible, carrying the nested pool's earliest return as its blocked-until and naming it in the reason. */
function assessRefusedNested(member: PoolMember, nested: Extract<NestedContribution, { kind: "refused" }>, nowMs: number): Assessment {
  const refusal =
    nested.earliestReturn === undefined
      ? { reason: `no member of pool "${nested.pool}" can be picked` }
      : { reason: `every member of pool "${nested.pool}" is refused; ${nested.earliestReturn.identity} returns at ${new Date(nested.earliestReturn.atMs).toISOString()} (in ${formatAge(nested.earliestReturn.atMs - nowMs)})`, blockedUntilMs: nested.earliestReturn.atMs };
  return {
    candidate: {
      identity: member.identity,
      class: "ineligible",
      ...(refusal.blockedUntilMs === undefined ? {} : { blockedUntilMs: refusal.blockedUntilMs }),
      plan: planOf(member.account),
      reasons: [refusal.reason],
    },
  };
}

/** Assesses one member, unfolding what a nested `pool:<name>` entry contributes: its pool's pick is re-ranked from the picked identity's own snapshot (so it competes in a scored outer pool like any member). The nested pool's own reasons stand in for the member's window and plan lines rather than sitting beside a second copy re-derived from the same snapshot, with the composition named first. */
function assess(member: PoolMember, nowMs: number): Assessment {
  const nested = member.nested;
  if (nested === undefined) {
    return assessIdentity(member, nowMs);
  }
  if (nested.kind === "refused") {
    return assessRefusedNested(member, nested, nowMs);
  }
  const assessment = assessIdentity(member, nowMs);
  return { ...assessment, candidate: { ...assessment.candidate, reasons: [`picked by pool "${nested.pool}"`, ...nested.reasons] } };
}

function assessIdentity(member: PoolMember, nowMs: number): Assessment {
  const plan = planOf(member.account);
  const planReasons = plan.kind === "pay-per-use" ? ["billed by use (no plan allowance)"] : plan.recognised ? [`${String(plan.capacity)}x plan`] : [`plan tier ${plan.tier === undefined ? "not known" : `"${plan.tier}" not recognised`}, counted as 1x`];
  const base = { identity: member.identity, plan };

  if (member.readError !== undefined) {
    return { candidate: { ...base, class: "unknown", reasons: [`usage state unreadable: ${member.readError}`, ...planReasons] } };
  }
  const state = member.snapshot?.providers[ANTHROPIC_PROVIDER];
  const unified = unifiedOf(state);
  if (member.snapshot === undefined || state === undefined || unified === undefined) {
    return { candidate: { ...base, class: "unknown", reasons: ["no usage recorded yet, so its quota is unknown (turn on trackUsage for it)", ...planReasons] } };
  }
  const observedAgo = state.rateLimit === undefined ? "" : ` (last seen ${formatAge(nowMs - Date.parse(state.rateLimit.observedAt))} ago)`;

  const fiveHourWindow = unified.fiveHour;
  const sevenDayWindow = unified.sevenDay;
  const five = fiveHourWindow === undefined ? undefined : effectiveWindow(fiveHourWindow, nowMs);
  const seven = sevenDayWindow === undefined ? undefined : effectiveWindow(sevenDayWindow, nowMs);
  const windowReasons = [
    ...(fiveHourWindow === undefined || five === undefined ? [] : [describeWindow("5h", fiveHourWindow, five, nowMs)]),
    ...(sevenDayWindow === undefined || seven === undefined ? [] : [describeWindow("7d", sevenDayWindow, seven, nowMs)]),
  ];

  const overageWindow = soleOverageWindow(unified);
  const overage = overageWindow === undefined ? undefined : effectiveWindow(overageWindow, nowMs);
  const overageReasons = overageWindow === undefined || overage === undefined ? [] : [describeWindow("extra usage", overageWindow, overage, nowMs)];
  const blockedUntil = Math.max(
    windowBlockedUntil([five, seven, overage].flatMap((window) => (window === undefined ? [] : [window]))) ?? 0,
    limitBlockedUntil(state, nowMs) ?? 0,
  );
  if (blockedUntil > nowMs) {
    if (unified.overageStatus === "allowed") {
      return { candidate: { ...base, class: "pay-per-use", reasons: [`plan exhausted until ${new Date(blockedUntil).toISOString()}, continues as extra usage`, ...windowReasons, ...planReasons] } };
    }
    return { candidate: { ...base, class: "ineligible", blockedUntilMs: blockedUntil, reasons: [`refused until ${new Date(blockedUntil).toISOString()} (in ${formatAge(blockedUntil - nowMs)})`, ...windowReasons, ...overageReasons, ...planReasons] } };
  }

  if (plan.kind === "pay-per-use" || (fiveHourWindow === undefined && sevenDayWindow === undefined)) {
    const headroom = overage?.utilization === undefined ? undefined : Math.max(0, 1 - overage.utilization);
    return { candidate: { ...base, class: "pay-per-use", ...(headroom === undefined ? {} : { headroom }), reasons: [...(plan.kind === "pay-per-use" ? planReasons : ["no plan windows reported, so usage bills as extra usage"]), ...overageReasons] } };
  }

  const basis = seven?.utilization !== undefined ? { window: seven, windowMs: SEVEN_DAY_WINDOW_MS } : five?.utilization !== undefined ? { window: five, windowMs: FIVE_HOUR_WINDOW_MS } : undefined;
  if (basis?.window.utilization === undefined) {
    return { candidate: { ...base, class: "unknown", reasons: ["quota windows reported no utilisation", ...windowReasons, ...planReasons] } };
  }
  const remaining = Math.max(0, 1 - basis.window.utilization);
  const untilResetMs = basis.window.resetsAtMs === undefined ? basis.windowMs : Math.max(basis.window.resetsAtMs - nowMs, MS_PER_SECOND);
  const score = (remaining * plan.capacity) / (untilResetMs / MS_PER_HOUR);

  const fiveRemaining = five?.utilization === undefined ? undefined : Math.max(0, 1 - five.utilization);
  const fiveUntil = five?.resetsAtMs === undefined ? FIVE_HOUR_WINDOW_MS : Math.max(five.resetsAtMs - nowMs, MS_PER_SECOND);
  const burn = windowBurn(member.records, "fiveHour");
  const sevenRemaining = seven?.utilization === undefined ? undefined : Math.max(0, 1 - seven.utilization);
  const sevenUntil = seven?.resetsAtMs === undefined ? SEVEN_DAY_WINDOW_MS : Math.max(seven.resetsAtMs - nowMs, MS_PER_SECOND);
  const sevenDayBurn = windowBurn(member.records, "sevenDay");
  return {
    candidate: { ...base, class: "scored", score, reasons: [...windowReasons.map((reason, index) => (index === windowReasons.length - 1 ? `${reason}${observedAgo}` : reason)), ...planReasons] },
    ...(fiveRemaining === undefined ? {} : { fiveHour: { remaining: fiveRemaining, untilResetMs: fiveUntil } }),
    ...(burn === undefined ? {} : { burn }),
    ...(sevenRemaining === undefined ? {} : { sevenDay: { remaining: sevenRemaining, untilResetMs: sevenUntil } }),
    ...(sevenDayBurn === undefined ? {} : { sevenDayBurn }),
  };
}

/** One member's pool-selection facts, the reference namespace's `quota.*` and `session.*` half; the window facts the member's own assessment read, and the session facts the whole ranking was given. */
function poolFactsOf(member: PoolMember, nowMs: number, resuming: boolean, sticky?: StickyPick): { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts; readonly burnPerHour?: number; readonly resuming: boolean; readonly lastPickHoursAgo?: number } {
  const { fiveHour, sevenDay, extraUsage } = quotaFactsOf(member.snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified, nowMs);
  const burn = windowBurn(member.records, "fiveHour");
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(extraUsage === undefined ? {} : { extraUsage }),
    ...(burn === undefined ? {} : { burnPerHour: burn * MS_PER_HOUR }),
    resuming,
    ...(sticky?.identity === member.identity ? { lastPickHoursAgo: Math.max(0, (nowMs - Date.parse(sticky.at)) / MS_PER_HOUR) } : {}),
  };
}

/**
 * Ranks `members` for a launch.
 *
 * A member is `ineligible` while a window of its plan, or a refusal it last hit, still binds; it is `unknown` without recorded quota, `pay-per-use` when its usage bills by use, and otherwise `scored`. Scored members order by how much plan-size-weighted quota would expire unused per hour of runway, with any whose five-hour window would run dry at the observed pace (their own, or the person's pace on another member rescaled by plan size) or whose seven-day window would run dry at its own observed pace placed behind those that would not. The member last picked for this directory then moves to the front if it still serves on plan quota and is not projected to run dry, and either the launch resumes a conversation or its prompt cache is still warm; a resumed conversation that cannot keep its member re-ranks and continues on the pick, with the move named in `movedOff`.
 *
 * How members are ordered depends on `preference`. The default, "score", is the order above: class first, then feasibility, then score, with ties by name. "listed" keeps the order of `members`, which callers build in pool member order, so member order, not class, decides: an `unknown` (no usage recorded) or `pay-per-use` member can be picked before a later `scored` one, which is the list owner's stated preference, and a `scored` member that is not feasible keeps its place and its reason line rather than being demoted. In both modes the pick is the first non-`ineligible` candidate, `earliestReturn` still reports the soonest returning refused member, and the sticky-pick promotion applies unchanged.
 */
export function rankPool(input: RankPoolInput): PoolRanking {
  const { members, nowMs } = input;
  // The member paired with its assessment, because the policy guard reads the entry's own condition beside what the assessment found.
  const assessments = members.map((member): { member: PoolMember } & Assessment => ({ member, ...assess(member, nowMs) }));

  // The person's demand, in plan-size units per millisecond, is what a member without readings of its own is projected with. The highest observed is used so an unmeasured member is not credited with more room than the measured pace allows.
  const demands = assessments.flatMap(({ candidate, burn }) => (burn === undefined ? [] : [burn * capacityOf(candidate.plan)]));
  const sharedDemand = demands.length === 0 ? undefined : Math.max(...demands);

  // The member entry's policy guard, evaluated over the member's own facts before anything ranks: definite false replaces the candidate with an ineligible-by-policy one naming the condition, indeterminate marks the candidate demoted (last within its class) naming the missing fact. The nested entries carry their condition the same way, so one rule guards a subtree and a member alike.
  const guarded: readonly ({ member: PoolMember } & Assessment)[] = assessments.map((assessment) => {
    const { candidate } = assessment;
    if (candidate.class === "ineligible" || assessment.member.policy === undefined) {
      return assessment;
    }
    const context: ConditionContext = { nowMs, env: {}, pool: poolFactsOf(assessment.member, nowMs, input.resuming, input.sticky) };
    const verdict = evaluateWhen(assessment.member.policy, context);
    if (verdict.status === "indeterminate") {
      return { ...assessment, candidate: { ...candidate, policyDemoted: true, reasons: [`policy undecided (${verdict.checked.join(", ") === "predicate" ? "predicate" : verdict.checked.join(", ")}): ${verdict.reason}`, ...candidate.reasons] } };
    }
    if (verdict.passed) {
      return assessment;
    }
    return { ...assessment, candidate: { ...candidate, class: "ineligible", reasons: [`skipped by policy (${verdict.checked.join(", ")}: did not hold)`, ...candidate.reasons] } };
  });

  const candidates: Candidate[] = guarded.map((assessment): Candidate => {
    const { candidate, fiveHour, burn } = assessment;
    const pace = burn ?? (sharedDemand === undefined ? undefined : sharedDemand / capacityOf(candidate.plan));
    // The seven-day window projects only from its own observed pace. The shared demand is measured in five-hour utilisation fractions rescaled by plan size, and the ratio between the two windows' capacities is not documented anywhere the door can read, so converting a five-hour pace into seven-day fractions would be a guess dressed as arithmetic. A member whose seven-day utilisation has been seen rising twice has a pace of its own, which is exactly the tail case the projection exists for.
    const { sevenDay, sevenDayBurn } = assessment;
    if (candidate.class !== "scored") {
      return { ...candidate, feasible: true };
    }
    const drySpots: string[] = [];
    if (fiveHour !== undefined && pace !== undefined) {
      const runsDryInMs = fiveHour.remaining / pace;
      if (runsDryInMs < fiveHour.untilResetMs) {
        drySpots.push(`5h window would run dry in ${formatAge(runsDryInMs)}, before it resets in ${formatAge(fiveHour.untilResetMs)}`);
      }
    }
    if (sevenDay !== undefined && sevenDayBurn !== undefined) {
      const runsDryInMs = sevenDay.remaining / sevenDayBurn;
      if (runsDryInMs < sevenDay.untilResetMs) {
        drySpots.push(`7d window would run dry in ${formatAge(runsDryInMs)}, before it resets in ${formatAge(sevenDay.untilResetMs)}`);
      }
    }
    if (drySpots.length === 0) {
      return { ...candidate, feasible: true };
    }
    return { ...candidate, feasible: false, reasons: [...drySpots, ...candidate.reasons] };
  });

  // "listed" keeps the members' own order, which is the pool's stated preference; "score" (the default) is the use-it-or-lose-it order.
  const ordered =
    input.preference === "listed"
      ? [...candidates]
      : [...candidates].sort(
          (left, right) =>
            CLASS_ORDER[left.class] - CLASS_ORDER[right.class] ||
            Number(left.policyDemoted ?? false) - Number(right.policyDemoted ?? false) ||
            Number(right.feasible) - Number(left.feasible) ||
            (right.headroom ?? 1) - (left.headroom ?? 1) ||
            (right.score ?? 0) - (left.score ?? 0) ||
            left.identity.localeCompare(right.identity),
        );

  const sticky = input.sticky;
  const stickyIndex = sticky === undefined ? -1 : ordered.findIndex((candidate) => candidate.identity === sticky.identity);
  const stickyCandidate = ordered[stickyIndex];
  const keepSticky = stickyCandidate?.class === "scored" && stickyCandidate.feasible;
  if (sticky !== undefined && keepSticky) {
    const ageMs = nowMs - Date.parse(sticky.at);
    const warm = ageMs <= PROMPT_CACHE_TTL_MS;
    if (input.resuming || warm) {
      const why = warm ? `used here ${formatAge(ageMs)} ago, prompt cache still warm` : "resuming a conversation started on this account";
      ordered.splice(stickyIndex, 1);
      ordered.unshift({ ...stickyCandidate, reasons: [why, ...stickyCandidate.reasons] });
    }
  }

  // The move a resumed conversation makes, named for the decision line: the member it started on could not keep it (not scored, or projected to run dry), so the conversation continues on the pool's pick instead, accepting a cold cache. The sticky member's own leading reason states why precisely; a member no longer in the pool at all says so.
  const movedOff =
    sticky !== undefined && input.resuming && !keepSticky
      ? { identity: sticky.identity, reason: stickyCandidate?.reasons[0] ?? "no longer among the pool's members" }
      : undefined;

  const pick = ordered.find((candidate) => candidate.class !== "ineligible");
  const returns = ordered.flatMap((candidate) => (candidate.blockedUntilMs === undefined ? [] : [{ identity: candidate.identity, atMs: candidate.blockedUntilMs }]));
  const earliestReturn = returns.length === 0 ? undefined : returns.reduce((soonest, entry) => (entry.atMs < soonest.atMs ? entry : soonest));
  return {
    candidates: ordered,
    ...(pick === undefined ? { ...(earliestReturn === undefined ? {} : { earliestReturn }) } : { pick }),
    ...(movedOff === undefined || pick === undefined ? {} : { movedOff }),
  };
}
