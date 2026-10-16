import { ANTHROPIC_PROVIDER } from "../usage/middleware";
import { utilisationPerBilledToken } from "../usage/pick";
import { effectiveWindow } from "../usage/preflight";
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

/**
 * Why the identity's quota has reached the point of compacting, or undefined while it has not. With `atUtilisation` it is either window passing that share. Without it the rule is the cost: the five-hour window has less left than compacting every session on the identity would use, measured by what one billed token has cost the identity's own window. A session's context is counted whole, which overstates a compaction that reads a warm cache, so the rule errs towards compacting early. An identity whose cost per token has not been measured, or that reports no five-hour window, never reaches it by this rule.
 */
function triggerReason(input: Readonly<CompactionInput>): string | undefined {
  const unified = input.snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified;
  const five = unified?.fiveHour === undefined ? undefined : effectiveWindow(unified.fiveHour, input.nowMs);
  if (input.atUtilisation !== undefined) {
    const seven = unified?.sevenDay === undefined ? undefined : effectiveWindow(unified.sevenDay, input.nowMs);
    for (const [name, window] of [["5h", five], ["7d", seven]] as const) {
      if (window?.utilization !== undefined && window.utilization * PERCENT >= input.atUtilisation) {
        return `the ${name} window is at ${asPercent(window.utilization)}, past ${String(input.atUtilisation)}%`;
      }
    }
    return undefined;
  }
  const perToken = utilisationPerBilledToken(input.records());
  if (five?.utilization === undefined || perToken === undefined) {
    return undefined;
  }
  const remaining = Math.max(0, 1 - five.utilization);
  const cost = input.sessions.reduce((sum, session) => sum + (session.state?.contextTokens ?? 0), 0) * perToken;
  return remaining < cost ? `the 5h window has ${asPercent(remaining)} left, and compacting every session on this member would use about ${asPercent(cost)}` : undefined;
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
