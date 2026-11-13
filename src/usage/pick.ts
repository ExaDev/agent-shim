import type { WhenCondition } from "../config/schema";
import { evaluateWhen, type ConditionContext, type PoolWindowFacts } from "../resolve/conditions";
import { describeWindow, percent } from "./candidateText";
import { planOf, planOfProviderQuota, type PlanClass } from "./plan";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { effectiveWindow, formatAge, type EffectiveWindow } from "./preflight";
import { rankingWindowsOf } from "./providerWindows";
import { quotaFactsOf } from "./quotaFacts";
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "./windowLengths";
import { parseUnifiedRateLimit, soleOverageWindow } from "./rateLimit";
import type { AccountMetadata, ProviderUsageState, UsageRecord, UsageSnapshot } from "./schema";
import { ownEntry } from "../ownEntry";

/**
 * Ranks the members of a pool for a launch, from what the usage store recorded. Pure: snapshots, account metadata, log records and the clock all come in as values, so the launcher, `agent-shim pool pick` and the tests share one ranking.
 *
 * The default idea is use-it-or-lose-it. A subscription's window empties on a schedule whatever happens, so unused quota in a window that resets soon is wasted, while unused quota in a window that resets in days can still be spent later. The account to launch on is therefore the one whose remaining quota, in plan-size terms, expires soonest per hour of runway, provided its five-hour window will not run dry at the pace the person has been working, and provided it is not currently refused. A pool can instead ask for `listed` preference, which ranks members strictly in the order the pool lists them, skipping only a member that is currently refused.
 */

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;
const PROMPT_CACHE_TTL_HOURS = 1;

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
  /** The member that represents this member's login in the ranking, when both hold the same login and so draw on one quota window. This member is then ineligible as a candidate of its own, since ranking it beside its representative would count one window twice and could fail over to a login that is limited too. */
  readonly sameLoginAs?: string;
  /** The provider this member's launch routes through, when it does not spend the member's own Claude account: the member is then assessed against that provider's slice of its snapshot and the records the front door logged for it, and sized by the provider's own quota level. Absent for a launch on the Claude account, which is read from the `anthropic` slice exactly as ever. */
  readonly provider?: string;
  /** Why the provider this member's launch spends could not be resolved (a provider or configuration profile file that fails validation, is in a former format or is not JSON), when that is the case: the member is then ranked as unknown with this reason, and picking it refuses the launch with the file's own error. */
  readonly providerError?: string;
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
  /** The size in tokens of the context a resumed conversation continues with. A member that is not the warm account of that conversation must pay to write this context again, so one whose five-hour window cannot cover it is not feasible. */
  readonly resumeContextTokens?: number;
  /** The context tokens already on their way to each member, by identity: what sessions that moved onto it carry and have not yet written there. The member must afford them as well as `resumeContextTokens`, since they are written there too. */
  readonly committedContextTokens?: Readonly<Record<string, number>>;
  /** How members are ordered: "score" (the default when absent) by the use-it-or-lose-it ranking, "listed" strictly in `members` order. */
  readonly preference?: "score" | "listed";
}

/** In pick order. `scored` has usable quota data; `unknown` has none and no plan known to bill by use (never recorded, or unreadable); `pay-per-use` bills by use instead of drawing on a plan, whether or not any usage is recorded; `ineligible` is refused right now. */
type CandidateClass = "scored" | "unknown" | "pay-per-use" | "ineligible";

const CLASS_ORDER: Readonly<Record<CandidateClass, number>> = { scored: 0, unknown: 1, "pay-per-use": 2, ineligible: 3 };

export interface Candidate {
  readonly identity: string;
  readonly class: CandidateClass;
  /** Plan-size-weighted remaining quota per hour until its reset: higher is more wasted if left unused. Present for `scored` only. */
  readonly score?: number;
  /** The window the score's hours-until-reset come from: the seven-day window, the five-hour one when the member reports no seven-day utilisation, or the five-hour one when its measured-ratio term outranks the weekly one. Present with `score`. */
  readonly scoreWindow?: "sevenDay" | "fiveHour";
  /** False when a quota window would run dry, at the observed pace, before it resets (the five-hour at its own or the rescaled shared pace, the seven-day at its own). A `scored` candidate that is not feasible ranks below every feasible one. */
  readonly feasible: boolean;
  /** When the soonest window projected to run dry is projected to, for a `scored` candidate that is not feasible: the instant its quota is gone at the observed pace, which is what a launch weighs a returning member against. Absent for a feasible candidate. */
  readonly runsDryAtMs?: number;
  /** The fraction of the extra-usage allowance still unspent, for a `pay-per-use` member whose only budget is that allowance (an Enterprise account). A member reporting none ranks as having all of it: no cap is known to bind. */
  readonly headroom?: number;
  /** True for a `pay-per-use` member with no usage recorded: its account metadata says it bills by use, but its extra-usage meter has never been read, so its spend is invisible to `agent-shim usage` and its headroom is unknown rather than full. It ranks behind every `pay-per-use` member whose allowance is on record. */
  readonly usageUnrecorded?: boolean;
  /** When an `ineligible` candidate can be used again. */
  readonly blockedUntilMs?: number;
  /** When the exhausted plan window of a `pay-per-use` candidate that is only on extra usage because its plan ran out resets, so a launch can hold for it rather than spend. Absent for a candidate that bills by use with no plan allowance. */
  readonly planReturnsAtMs?: number;
  readonly plan: PlanClass;
  /** The provider the member was assessed against, when the launch spends one in place of the member's Claude account; absent when it was assessed on the Claude account. */
  readonly provider?: string;
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
  /** When the pick continues on extra usage only because its plan ran out, the identity and the instant its plan window resets: what a launch that would rather wait than spend sleeps until. Absent when the pick is on plan quota, bills by use with no plan, or no member can be picked. */
  readonly planReturn?: { readonly identity: string; readonly atMs: number };
  /** When the pick would run dry before its window resets and a refused member returns before that happens, the earliest such member and when it returns: what a launch that would rather have a full window than start one that dies partway holds for. Absent when the pick is projected to last, nothing is refused, or every refused member returns after the pick would run dry. */
  readonly holdForReturn?: { readonly identity: string; readonly atMs: number };
  /** The member a resumed or continued conversation started on but moved off, and why, when a launch that resumes could not keep it. One sentence for the launch decision line and `check`. */
  readonly movedOff?: { readonly identity: string; readonly reason: string };
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
function windowBurn(records: readonly UsageRecord[], which: PlanWindowName): number | undefined {
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

/** The tokens a response is billed against a window: its input, what it wrote to the prompt cache, and its output. Cache reads are left out, as they barely draw on a window. */
function billedTokensOf(record: UsageRecord): number {
  const usage = record.usage;
  return (usage?.inputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/** A subscription plan window, as the unified rate-limit state names it. */
export type PlanWindowName = "fiveHour" | "sevenDay";

/**
 * How much of the named window's utilisation one billed token costs this member, measured over its records in the current instance of that window, or undefined without two readings of that window in which utilisation rose over tokens that were billed. Each window is priced only from its own readings, so the figure is in that window's utilisation fractions. It converts a context size into the share of the window writing it would take.
 */
export function utilisationPerBilledToken(records: readonly UsageRecord[], which: PlanWindowName): number | undefined {
  const points: { resetsAt: string; utilization: number; billed: number }[] = [];
  for (const record of records) {
    const window = record.rateLimitHeaders === undefined ? undefined : parseUnifiedRateLimit(record.rateLimitHeaders)?.[which];
    if (window?.utilization !== undefined && window.resetsAt !== undefined) {
      points.push({ resetsAt: window.resetsAt, utilization: window.utilization, billed: billedTokensOf(record) });
    }
  }
  const latest = points.at(-1)?.resetsAt;
  const current = points.filter((point) => point.resetsAt === latest);
  const first = current.at(0);
  const last = current.at(-1);
  if (first === undefined || last === undefined || last.utilization <= first.utilization) {
    return undefined;
  }
  // The first reading's own request is what the rise is measured from, so its tokens are not part of the rise.
  const billed = current.slice(1).reduce((sum, point) => sum + point.billed, 0);
  return billed > 0 ? (last.utilization - first.utilization) / billed : undefined;
}

/**
 * How much seven-day utilisation one unit of five-hour utilisation costs this member, measured over the readings in its current instance of both windows, or undefined without two readings in which both rose. It is what converts unused five-hour quota into the seven-day units the score is measured in, so the two windows' capacities are never guessed. The headers report whole percentages, so the ratio is only as fine as that granularity.
 */
function windowRatio(records: readonly UsageRecord[]): number | undefined {
  const points: { fiveResetsAt: string; sevenResetsAt: string; five: number; seven: number }[] = [];
  for (const record of records) {
    const unified = record.rateLimitHeaders === undefined ? undefined : parseUnifiedRateLimit(record.rateLimitHeaders);
    const five = unified?.fiveHour;
    const seven = unified?.sevenDay;
    if (five?.utilization !== undefined && five.resetsAt !== undefined && seven?.utilization !== undefined && seven.resetsAt !== undefined) {
      points.push({ fiveResetsAt: five.resetsAt, sevenResetsAt: seven.resetsAt, five: five.utilization, seven: seven.utilization });
    }
  }
  const latest = points.at(-1);
  const current = points.filter((point) => point.fiveResetsAt === latest?.fiveResetsAt && point.sevenResetsAt === latest.sevenResetsAt);
  const first = current.at(0);
  const last = current.at(-1);
  if (first === undefined || last === undefined || last.five <= first.five || last.seven <= first.seven) {
    return undefined;
  }
  return (last.seven - first.seven) / (last.five - first.five);
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
  const assessment = assessMember(member, nowMs);
  return member.provider === undefined ? assessment : { ...assessment, candidate: { ...assessment.candidate, provider: member.provider } };
}

function assessMember(member: PoolMember, nowMs: number): Assessment {
  if (member.sameLoginAs !== undefined) {
    return { candidate: { identity: member.identity, class: "ineligible", plan: planOf(member.account), reasons: [`same login as ${member.sameLoginAs}`] } };
  }
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

/** The slice of the member's snapshot its launch spends: the provider's when the launch routes through one, the Claude account's (`anthropic`) otherwise. */
function sliceOf(member: PoolMember): ProviderUsageState | undefined {
  return ownEntry(member.snapshot?.providers, member.provider ?? ANTHROPIC_PROVIDER);
}

/** A member whose launch routes through a provider and whose slice for it reports no plan window to rank on: refused while the refusal its provider last answered with still binds, then billed by use when the level its provider reported says so, and otherwise unknown, since another provider's windows (the Claude account's included) say nothing about it. */
function assessProviderWithoutWindows(member: PoolMember, provider: string, state: ProviderUsageState | undefined, base: Pick<Candidate, "identity" | "plan">, planReasons: readonly string[], nowMs: number): Assessment {
  const blockedUntil = limitBlockedUntil(state, nowMs);
  if (blockedUntil !== undefined) {
    return { candidate: { ...base, class: "ineligible", blockedUntilMs: blockedUntil, reasons: [`refused until ${new Date(blockedUntil).toISOString()} (in ${formatAge(blockedUntil - nowMs)})`, ...planReasons] } };
  }
  // A provider whose own quota level classifies as billed by use is a class of its own whether or not it reports windows, as on the Claude path: ranking it `unknown` would put a billed member ahead of every plan member of the same class.
  if (base.plan.kind === "pay-per-use") {
    return { candidate: { ...base, class: "pay-per-use", usageUnrecorded: true, reasons: [...planReasons, `provider ${provider} reports no plan windows, so its spend is not tracked`] } };
  }
  const why = state === undefined ? `no usage recorded for provider ${provider} yet, so its quota is unknown` : `provider ${provider} reports no plan windows, so its quota is unknown`;
  return { candidate: { ...base, class: "unknown", reasons: [why, ...planReasons] } };
}

function assessIdentity(member: PoolMember, nowMs: number): Assessment {
  const state = sliceOf(member);
  const plan = member.provider === undefined ? planOf(member.account) : planOfProviderQuota(state?.quota);
  const planReasons = plan.kind === "pay-per-use" ? ["billed by use (no plan allowance)"] : plan.recognised ? [`${String(plan.capacity)}x plan`] : [`plan tier ${plan.tier === undefined ? "not known" : `"${plan.tier}" not recognised`}, counted as 1x`];
  const base = { identity: member.identity, plan };

  if (member.readError !== undefined) {
    return { candidate: { ...base, class: "unknown", reasons: [`usage state unreadable: ${member.readError}`, ...planReasons] } };
  }
  if (member.providerError !== undefined) {
    return { candidate: { ...base, class: "unknown", reasons: [`provider configuration unreadable: ${member.providerError}`, ...planReasons] } };
  }
  const windows = rankingWindowsOf(member.provider, state);
  if (member.snapshot === undefined || state === undefined || windows === undefined) {
    if (member.provider !== undefined) {
      return assessProviderWithoutWindows(member, member.provider, state, base, planReasons, nowMs);
    }
    // A plan known from account metadata to bill by use is a class of its own whether or not usage is on record: ranking it `unknown` would put it ahead of every `pay-per-use` member and spend a billed account silently.
    if (plan.kind === "pay-per-use") {
      return { candidate: { ...base, class: "pay-per-use", usageUnrecorded: true, reasons: [...planReasons, "no usage recorded yet, so its spend is not tracked (turn on trackUsage for it)"] } };
    }
    return { candidate: { ...base, class: "unknown", reasons: ["no usage recorded yet, so its quota is unknown (turn on trackUsage for it)", ...planReasons] } };
  }
  const { unified } = windows;
  const observedAgo = ` (last seen ${formatAge(nowMs - Date.parse(windows.observedAt))} ago)`;

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
  // A provider's window used in full with no reset time refuses the member for as long as it lasts and says nothing of when that ends, so it is ineligible with no return time rather than scored on an empty window (which would rank a spent member ahead of one with no reading). The Claude account keeps the ranking it has always had for such a window.
  if (member.provider !== undefined) {
    const spent = [
      { name: "5h", window: five },
      { name: "7d", window: seven },
    ]
      .filter(({ window }) => window?.status === "rejected" && window.resetsAtMs === undefined)
      .map(({ name }) => name);
    if (spent.length > 0) {
      return { candidate: { ...base, class: "ineligible", reasons: [`provider ${member.provider} ${spent.join(" and ")} window used in full with no reset time reported, so it is refused until it reports one`, ...windowReasons, ...planReasons] } };
    }
  }
  const blockedUntil = Math.max(
    windowBlockedUntil([five, seven, overage].flatMap((window) => (window === undefined ? [] : [window]))) ?? 0,
    limitBlockedUntil(state, nowMs) ?? 0,
  );
  if (blockedUntil > nowMs) {
    if (unified.overageStatus === "allowed") {
      return { candidate: { ...base, class: "pay-per-use", planReturnsAtMs: blockedUntil, reasons: [`plan exhausted until ${new Date(blockedUntil).toISOString()} (in ${formatAge(blockedUntil - nowMs)}), continues as extra usage`, ...windowReasons, ...planReasons] } };
    }
    return { candidate: { ...base, class: "ineligible", blockedUntilMs: blockedUntil, reasons: [`refused until ${new Date(blockedUntil).toISOString()} (in ${formatAge(blockedUntil - nowMs)})`, ...(unified.fallbackAvailable === true ? ["a fallback is on offer, so requests for some models may still be served"] : []), ...windowReasons, ...overageReasons, ...planReasons] } };
  }

  if (plan.kind === "pay-per-use" || (fiveHourWindow === undefined && sevenDayWindow === undefined)) {
    const headroom = overage?.utilization === undefined ? undefined : Math.max(0, 1 - overage.utilization);
    return { candidate: { ...base, class: "pay-per-use", ...(headroom === undefined ? {} : { headroom }), reasons: [...(plan.kind === "pay-per-use" ? planReasons : ["no plan windows reported, so usage bills as extra usage"]), ...overageReasons] } };
  }

  const basis =
    seven?.utilization !== undefined
      ? { window: seven, windowMs: SEVEN_DAY_WINDOW_MS, name: "sevenDay" as const }
      : five?.utilization !== undefined
        ? { window: five, windowMs: FIVE_HOUR_WINDOW_MS, name: "fiveHour" as const }
        : undefined;
  if (basis?.window.utilization === undefined) {
    return { candidate: { ...base, class: "unknown", reasons: ["quota windows reported no utilisation", ...windowReasons, ...planReasons] } };
  }
  const remaining = Math.max(0, 1 - basis.window.utilization);
  const untilResetMs = basis.window.resetsAtMs === undefined ? basis.windowMs : Math.max(basis.window.resetsAtMs - nowMs, MS_PER_SECOND);
  const weeklyScore = (remaining * plan.capacity) / (untilResetMs / MS_PER_HOUR);

  const fiveRemaining = five?.utilization === undefined ? undefined : Math.max(0, 1 - five.utilization);
  const fiveUntil = five?.resetsAtMs === undefined ? FIVE_HOUR_WINDOW_MS : Math.max(five.resetsAtMs - nowMs, MS_PER_SECOND);
  // A seven-day-scored member's five-hour quota expires far sooner than its weekly one, but is only spendable as far as the week allows: its unused fraction, converted to seven-day units by the member's measured ratio, capped at what the week has left. Without a measured ratio the term is omitted rather than guessed.
  const ratio = windowRatio(member.records);
  const fiveHourScore =
    basis.name === "sevenDay" && fiveRemaining !== undefined && ratio !== undefined
      ? (Math.min(fiveRemaining * ratio, remaining) * plan.capacity) / (fiveUntil / MS_PER_HOUR)
      : undefined;
  const fiveHourLeads = fiveHourScore !== undefined && fiveHourScore > weeklyScore;
  const score = fiveHourLeads ? fiveHourScore : weeklyScore;
  const scoreWindow = fiveHourLeads ? "fiveHour" : basis.name;
  const fiveHourTermReasons =
    basis.name !== "sevenDay" || fiveRemaining === undefined
      ? []
      : ratio === undefined
        ? ["5h reset not scored: no measured 5h to 7d ratio yet"]
        : fiveHourLeads
          ? [`5h term leads: ${percent(fiveRemaining)} of 5h unused is about ${percent(Math.min(fiveRemaining * ratio, remaining))} of the week at the measured ratio, resets in ${formatAge(fiveUntil)}`]
          : [];
  const burn = windowBurn(member.records, "fiveHour");
  const sevenRemaining = seven?.utilization === undefined ? undefined : Math.max(0, 1 - seven.utilization);
  const sevenUntil = seven?.resetsAtMs === undefined ? SEVEN_DAY_WINDOW_MS : Math.max(seven.resetsAtMs - nowMs, MS_PER_SECOND);
  const sevenDayBurn = windowBurn(member.records, "sevenDay");
  return {
    candidate: { ...base, class: "scored", score, scoreWindow, reasons: [...fiveHourTermReasons, ...windowReasons.map((reason, index) => (index === windowReasons.length - 1 ? `${reason}${observedAgo}` : reason)), ...planReasons] },
    ...(fiveRemaining === undefined ? {} : { fiveHour: { remaining: fiveRemaining, untilResetMs: fiveUntil } }),
    ...(burn === undefined ? {} : { burn }),
    ...(sevenRemaining === undefined ? {} : { sevenDay: { remaining: sevenRemaining, untilResetMs: sevenUntil } }),
    ...(sevenDayBurn === undefined ? {} : { sevenDayBurn }),
  };
}

/** One member's pool-selection facts, the reference namespace's `quota.*` and `session.*` half; the window facts the member's own assessment read, and the session facts the whole ranking was given. */
function poolFactsOf(member: PoolMember, nowMs: number, resuming: boolean, sticky?: StickyPick): { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts; readonly burnPerHour?: number; readonly resuming: boolean; readonly lastPickHoursAgo?: number } {
  const { fiveHour, sevenDay, extraUsage } = quotaFactsOf(rankingWindowsOf(member.provider, sliceOf(member))?.unified, nowMs);
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
 * A member is `ineligible` while a window of its plan, or a refusal it last hit, still binds; it is `pay-per-use` when its usage bills by use (including an account whose metadata says so and that has no usage recorded yet), `unknown` without recorded quota and no such plan, and otherwise `scored`. Scored members order by how much plan-size-weighted quota would expire unused per hour of runway, with any whose five-hour window would run dry at the observed pace (their own, or the person's pace on another member rescaled by plan size) or whose seven-day window would run dry at its own observed pace placed behind those that would not. The member last picked for this directory then moves to the front if it still serves on plan quota and is not projected to run dry, and either the launch resumes a conversation or its prompt cache is still warm; a resumed conversation that cannot keep its member re-ranks and continues on the pick, with the move named in `movedOff`.
 *
 * How members are ordered depends on `preference`. The default, "score", is the order above: class first, then feasibility, then (among members that bill by use) those whose usage is recorded before those whose is not, then headroom, then score, with ties by name. "listed" keeps the order of `members`, which callers build in pool member order, so member order, not class, decides: an `unknown` (no usage recorded) or `pay-per-use` member can be picked before a later `scored` one, which is the list owner's stated preference, and a `scored` member that is not feasible keeps its place and its reason line rather than being demoted. In both modes the pick is the first non-`ineligible` candidate, `earliestReturn` still reports the soonest returning refused member, and the sticky-pick promotion applies unchanged.
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
    const dryAfterMs: number[] = [];
    if (fiveHour !== undefined && pace !== undefined) {
      const runsDryInMs = fiveHour.remaining / pace;
      if (runsDryInMs < fiveHour.untilResetMs) {
        dryAfterMs.push(runsDryInMs);
        drySpots.push(`5h window would run dry in ${formatAge(runsDryInMs)}, before it resets in ${formatAge(fiveHour.untilResetMs)}`);
      }
    }
    if (sevenDay !== undefined && sevenDayBurn !== undefined) {
      const runsDryInMs = sevenDay.remaining / sevenDayBurn;
      if (runsDryInMs < sevenDay.untilResetMs) {
        dryAfterMs.push(runsDryInMs);
        drySpots.push(`7d window would run dry in ${formatAge(runsDryInMs)}, before it resets in ${formatAge(sevenDay.untilResetMs)}`);
      }
    }
    // A resumed conversation's context has to be written again on any account that is not the one whose cache is still warm for it. A member that measurably cannot afford that within any of its plan windows would end the session at its first turn. Each window present is charged in its own units, so a member reporting only one of them is still held to it.
    const { sticky } = input;
    const warmHere = sticky?.identity === candidate.identity && nowMs - Date.parse(sticky.at) <= PROMPT_CACHE_TTL_MS;
    const resumeTokens = input.resumeContextTokens;
    if (input.resuming && resumeTokens !== undefined && !warmHere) {
      const committed = ownEntry(input.committedContextTokens, candidate.identity) ?? 0;
      const alongside = committed === 0 ? "" : ` (with ${String(committed)} tokens of other conversations already moving here)`;
      for (const [name, label, window] of [["fiveHour", "5h", fiveHour], ["sevenDay", "7d", sevenDay]] as const) {
        const perToken = window === undefined ? undefined : utilisationPerBilledToken(assessment.member.records, name);
        const cost = perToken === undefined ? undefined : (resumeTokens + committed) * perToken;
        if (window !== undefined && cost !== undefined && cost > window.remaining) {
          dryAfterMs.push(0);
          drySpots.push(`resuming a ${String(resumeTokens)}-token conversation here${alongside} would cost about ${percent(cost)} of the ${label} window, which has ${percent(window.remaining)} left`);
        }
      }
    }
    if (drySpots.length === 0) {
      return { ...candidate, feasible: true };
    }
    return { ...candidate, feasible: false, runsDryAtMs: nowMs + Math.min(...dryAfterMs), reasons: [...drySpots, ...candidate.reasons] };
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
            Number(left.usageUnrecorded ?? false) - Number(right.usageUnrecorded ?? false) ||
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
  // A pick that will run dry before its window resets ends a long session partway; a refused member that is back before that point gives a full window instead, so a launch that waits for returns waits for it.
  const holdForReturn = pick?.runsDryAtMs === undefined ? undefined : returns.filter((entry) => entry.atMs < (pick.runsDryAtMs ?? 0)).reduce<{ readonly identity: string; readonly atMs: number } | undefined>((soonest, entry) => (soonest === undefined || entry.atMs < soonest.atMs ? entry : soonest), undefined);
  return {
    candidates: ordered,
    ...(pick === undefined ? { ...(earliestReturn === undefined ? {} : { earliestReturn }) } : { pick }),
    ...(movedOff === undefined || pick === undefined ? {} : { movedOff }),
    ...(pick?.planReturnsAtMs === undefined ? {} : { planReturn: { identity: pick.identity, atMs: pick.planReturnsAtMs } }),
    ...(holdForReturn === undefined ? {} : { holdForReturn }),
  };
}
