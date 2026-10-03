import { planOf, type PlanClass } from "./plan";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { effectiveWindow, formatAge, type EffectiveWindow } from "./preflight";
import { parseUnifiedRateLimit } from "./rateLimit";
import type { AccountMetadata, ProviderUsageState, QuotaWindow, UnifiedRateLimit, UsageRecord, UsageSnapshot } from "./schema";

/**
 * Ranks the members of a pool for a launch, from what the usage store recorded. Pure: snapshots, account metadata, log records and the clock all come in as values, so the launcher, `agent-shim pool pick` and the tests share one ranking.
 *
 * The idea is use-it-or-lose-it. A subscription's window empties on a schedule whatever happens, so unused quota in a window that resets soon is wasted, while unused quota in a window that resets in days can still be spent later. The account to launch on is therefore the one whose remaining quota, in plan-size terms, expires soonest per hour of runway, provided its five-hour window will not run dry at the pace the person has been working, and provided it is not currently refused.
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
const SEVEN_DAY_WINDOW_MS = SEVEN_DAYS * HOURS_PER_DAY * MS_PER_HOUR;

/** Anthropic's longest prompt-cache lifetime (the one-hour tier): a conversation resumed within it still has a warm cache on the account that served it, and the cache is per organisation, so it is lost by switching. */
export const PROMPT_CACHE_TTL_MS = PROMPT_CACHE_TTL_HOURS * MS_PER_HOUR;

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
}

/** In pick order. `scored` has usable quota data; `unknown` has none (never recorded, or unreadable); `pay-per-use` bills by use instead of drawing on a plan; `ineligible` is refused right now. */
type CandidateClass = "scored" | "unknown" | "pay-per-use" | "ineligible";

const CLASS_ORDER: Readonly<Record<CandidateClass, number>> = { scored: 0, unknown: 1, "pay-per-use": 2, ineligible: 3 };

export interface Candidate {
  readonly identity: string;
  readonly class: CandidateClass;
  /** Plan-size-weighted remaining quota per hour until its reset: higher is more wasted if left unused. Present for `scored` only. */
  readonly score?: number;
  /** False when the five-hour window would run dry, at the observed pace, before it resets. A `scored` candidate that is not feasible ranks below every feasible one. */
  readonly feasible: boolean;
  /** When an `ineligible` candidate can be used again. */
  readonly blockedUntilMs?: number;
  readonly plan: PlanClass;
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
  if (Date.parse(state.lastRequestAt) > Date.parse(limit.observedAt)) {
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

/** The pace of five-hour utilisation, per millisecond, over the member's records in its current window, or undefined without two readings that show it rising. */
function fiveHourBurn(records: readonly UsageRecord[]): number | undefined {
  const points: { resetsAt: string; point: BurnPoint }[] = [];
  for (const record of records) {
    const window = record.rateLimitHeaders === undefined ? undefined : parseUnifiedRateLimit(record.rateLimitHeaders)?.fiveHour;
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
}

function assess(member: PoolMember, nowMs: number): Assessment {
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

  const blockedUntil = Math.max(
    windowBlockedUntil([five, seven].flatMap((window) => (window === undefined ? [] : [window]))) ?? 0,
    limitBlockedUntil(state, nowMs) ?? 0,
  );
  if (blockedUntil > nowMs) {
    if (unified.overageStatus === "allowed") {
      return { candidate: { ...base, class: "pay-per-use", reasons: [`plan exhausted until ${new Date(blockedUntil).toISOString()}, continues as extra usage`, ...windowReasons, ...planReasons] } };
    }
    return { candidate: { ...base, class: "ineligible", blockedUntilMs: blockedUntil, reasons: [`refused until ${new Date(blockedUntil).toISOString()} (in ${formatAge(blockedUntil - nowMs)})`, ...windowReasons, ...planReasons] } };
  }

  if (plan.kind === "pay-per-use" || (fiveHourWindow === undefined && sevenDayWindow === undefined)) {
    return { candidate: { ...base, class: "pay-per-use", reasons: [...(plan.kind === "pay-per-use" ? planReasons : ["no plan windows reported, so usage bills as extra usage"])] } };
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
  const burn = fiveHourBurn(member.records);
  return {
    candidate: { ...base, class: "scored", score, reasons: [...windowReasons.map((reason, index) => (index === windowReasons.length - 1 ? `${reason}${observedAgo}` : reason)), ...planReasons] },
    ...(fiveRemaining === undefined ? {} : { fiveHour: { remaining: fiveRemaining, untilResetMs: fiveUntil } }),
    ...(burn === undefined ? {} : { burn }),
  };
}

/**
 * Ranks `members` for a launch.
 *
 * A member is `ineligible` while a window of its plan, or a refusal it last hit, still binds; it is `unknown` without recorded quota, `pay-per-use` when its usage bills by use, and otherwise `scored`. Scored members order by how much plan-size-weighted quota would expire unused per hour of runway, with any whose five-hour window would run dry at the observed pace (their own, or the person's pace on another member rescaled by plan size) placed behind those that would not. The member last picked for this directory then moves to the front if it is still usable and either the launch resumes a conversation or its prompt cache is still warm.
 */
export function rankPool(input: RankPoolInput): PoolRanking {
  const { members, nowMs } = input;
  const assessments = members.map((member) => assess(member, nowMs));

  // The person's demand, in plan-size units per millisecond, is what a member without readings of its own is projected with. The highest observed is used so an unmeasured member is not credited with more room than the measured pace allows.
  const demands = assessments.flatMap(({ candidate, burn }) => (burn === undefined ? [] : [burn * capacityOf(candidate.plan)]));
  const sharedDemand = demands.length === 0 ? undefined : Math.max(...demands);

  const candidates: Candidate[] = assessments.map((assessment) => {
    const { candidate, fiveHour, burn } = assessment;
    const pace = burn ?? (sharedDemand === undefined ? undefined : sharedDemand / capacityOf(candidate.plan));
    if (candidate.class !== "scored" || fiveHour === undefined || pace === undefined) {
      return { ...candidate, feasible: true };
    }
    const runsDryInMs = fiveHour.remaining / pace;
    if (runsDryInMs >= fiveHour.untilResetMs) {
      return { ...candidate, feasible: true };
    }
    return { ...candidate, feasible: false, reasons: [`5h window would run dry in ${formatAge(runsDryInMs)}, before it resets in ${formatAge(fiveHour.untilResetMs)}`, ...candidate.reasons] };
  });

  const ordered = [...candidates].sort(
    (left, right) =>
      CLASS_ORDER[left.class] - CLASS_ORDER[right.class] ||
      Number(right.feasible) - Number(left.feasible) ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.identity.localeCompare(right.identity),
  );

  const sticky = input.sticky;
  const stickyIndex = sticky === undefined ? -1 : ordered.findIndex((candidate) => candidate.identity === sticky.identity);
  const stickyCandidate = ordered[stickyIndex];
  if (sticky !== undefined && stickyCandidate?.class === "scored" && stickyCandidate.feasible) {
    const ageMs = nowMs - Date.parse(sticky.at);
    const warm = ageMs <= PROMPT_CACHE_TTL_MS;
    if (input.resuming || warm) {
      const why = warm ? `used here ${formatAge(ageMs)} ago, prompt cache still warm` : "resuming a conversation started on this account";
      ordered.splice(stickyIndex, 1);
      ordered.unshift({ ...stickyCandidate, reasons: [why, ...stickyCandidate.reasons] });
    }
  }

  const pick = ordered.find((candidate) => candidate.class !== "ineligible");
  const returns = ordered.flatMap((candidate) => (candidate.blockedUntilMs === undefined ? [] : [{ identity: candidate.identity, atMs: candidate.blockedUntilMs }]));
  const earliestReturn = returns.length === 0 ? undefined : returns.reduce((soonest, entry) => (entry.atMs < soonest.atMs ? entry : soonest));
  return {
    candidates: ordered,
    ...(pick === undefined ? { ...(earliestReturn === undefined ? {} : { earliestReturn }) } : { pick }),
  };
}
