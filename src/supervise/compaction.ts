import { ANTHROPIC_PROVIDER } from "../usage/middleware";
import { utilisationPerBilledToken, type PlanWindowName } from "../usage/pick";
import { effectiveWindow, type EffectiveWindow } from "../usage/preflight";
import type { UsageRecord, UsageSnapshot } from "../usage/schema";
import type { SessionState } from "./registry";

/** Utilisation is a fraction of a window; the pool setting and the lines printed are whole percent. */
const PERCENT = 100;

/** A supervised session running on the identity, with what its hooks last recorded about it. */
export interface CompactionCandidate {
  readonly sessionId: string;
  readonly state: SessionState | undefined;
}

/** What the decision reads: the pool's setting, the identity's quota, its recent requests and the sessions on it. */
export interface CompactionInput {
  /** The pool's `compactAtUtilisation`, in whole percent. Absent means the cost rule decides. */
  readonly atUtilisation: number | undefined;
  readonly snapshot: UsageSnapshot | undefined;
  /** The identity's recent usage records, which say what one billed token costs it. A function, because reading them is the costly part of the decision and only the one session that could compact needs them. */
  readonly records: () => readonly UsageRecord[];
  /** Every supervised session now running on the identity, the one deciding included. */
  readonly sessions: readonly CompactionCandidate[];
  /** The session deciding. */
  readonly sessionId: string;
  readonly nowMs: number;
}

/** Whether the session should compact now, and why or why not. */
export type CompactionDecision = { readonly compact: false; readonly reason: string } | { readonly compact: true; readonly contextTokens: number; readonly reason: string };

const asPercent = (fraction: number): string => `${String(Math.round(fraction * PERCENT))}%`;

/** A session that can be compacted right now: its turn has ended, it has a context, and it has not been compacted on this member. */
function compactableTokens(state: SessionState | undefined): number | undefined {
  return state?.mark === "idle" && state.compacted !== true && state.contextTokens !== undefined && state.contextTokens > 0 ? state.contextTokens : undefined;
}

/** One plan window the identity reports, as it stands now, with the label the reason text gives it. */
interface PresentWindow {
  readonly name: PlanWindowName;
  readonly label: string;
  readonly window: EffectiveWindow;
}

/** The plan windows the identity reports, five-hour first, each as it stands at `nowMs`; a window the snapshot does not hold is not one of them. */
function presentWindows(input: Readonly<CompactionInput>): readonly PresentWindow[] {
  const unified = input.snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified;
  return ([["fiveHour", "5h"], ["sevenDay", "7d"]] as const).flatMap(([name, label]) => {
    const recorded = unified?.[name];
    return recorded === undefined ? [] : [{ name, label, window: effectiveWindow(recorded, input.nowMs) }];
  });
}

/**
 * Why the identity's quota has reached the point of compacting, or undefined while it has not. With `atUtilisation` it is either window passing that share. Without it the rule is the cost: the window with the smallest share left, among the plan windows the identity reports that state a utilisation (the five-hour one on a tie), has less left than compacting every session on the identity would use, measured by what one billed token has cost that same window. An account with no five-hour window is therefore measured against its seven-day one. A session's context is counted whole, which overstates a compaction that reads a warm cache, so the rule errs towards compacting early. An identity whose cost per token has not been measured in that window, or that reports no plan window with a utilisation, never reaches it by this rule.
 */
function triggerReason(input: Readonly<CompactionInput>): string | undefined {
  const windows = presentWindows(input);
  if (input.atUtilisation !== undefined) {
    for (const { label, window } of windows) {
      if (window.utilization !== undefined && window.utilization * PERCENT >= input.atUtilisation) {
        return `the ${label} window is at ${asPercent(window.utilization)}, past ${String(input.atUtilisation)}%`;
      }
    }
    return undefined;
  }
  const measured = windows.flatMap(({ name, label, window }) => (window.utilization === undefined ? [] : [{ name, label, remaining: Math.max(0, 1 - window.utilization) }]));
  // The strict comparison keeps the earlier window, the five-hour one, when both have the same share left.
  const tightest = measured.reduce<(typeof measured)[number] | undefined>((least, entry) => (least === undefined || entry.remaining < least.remaining ? entry : least), undefined);
  if (tightest === undefined) {
    return undefined;
  }
  const perToken = utilisationPerBilledToken(input.records(), tightest.name);
  if (perToken === undefined) {
    return undefined;
  }
  const cost = input.sessions.reduce((sum, session) => sum + (session.state?.contextTokens ?? 0), 0) * perToken;
  return tightest.remaining < cost ? `the ${tightest.label} window has ${asPercent(tightest.remaining)} left, and compacting every session on this member would use about ${asPercent(cost)}` : undefined;
}

/**
 * Decides whether a session should compact now. It must be idle with a context and not already compacted on this member, it must be the largest session that could compact (the biggest context is the dearest to resume on a cold cache, so it goes first, and ties go to the lower session id so exactly one session proceeds), and the identity's quota must have reached the trigger. The cheap conditions are checked first, so the usage log is read only for the one session that could go.
 */
export function decideCompaction(input: Readonly<CompactionInput>): CompactionDecision {
  const own = input.sessions.find((session) => session.sessionId === input.sessionId);
  const tokens = compactableTokens(own?.state);
  if (tokens === undefined) {
    return { compact: false, reason: "the session is mid-turn, has no context recorded yet, or was already compacted on this member" };
  }
  const larger = input.sessions.some((session) => {
    const other = compactableTokens(session.state);
    return session.sessionId !== input.sessionId && other !== undefined && (other > tokens || (other === tokens && session.sessionId < input.sessionId));
  });
  if (larger) {
    return { compact: false, reason: "a larger session on this member compacts first" };
  }
  const reason = triggerReason(input);
  return reason === undefined ? { compact: false, reason: "the member's quota has not reached the trigger" } : { compact: true, contextTokens: tokens, reason };
}
