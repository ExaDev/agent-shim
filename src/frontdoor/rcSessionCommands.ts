import { setTimeout as sleep } from "node:timers/promises";

import { COMPACT_TIMEOUT_MS } from "../supervise/compactTimeout";
import type { CompactionResult } from "../supervise/realCompact";
import { RESULT_POLL_MS } from "../supervise/sessionControl";
import type { TranscriptGoal } from "../supervise/sessionGoal";
import { runSelfHostedSlashCommand, type RcSelfHostCommandDeps } from "./rcSelfHostCommands";

/**
 * Goal and compaction control over a Remote Control session: read, set and clear its `/goal`, and compact its conversation, each returning the outcome the session itself reports. One verb surface over the two routes Claude Code 2.1.319 leaves open, chosen per session:
 *
 * - **A supervised session** (one an agent-shim supervisor launched, whatever its account or provider): the door finds the launch through the registry, by the `bridge-session` row Claude Code writes into the session's own transcript, and asks the session's in-process control plugin (`supervise/sessionControlPlugin.ts`), which runs `$.session.compact` or `/goal <condition>` and `/goal clear` through the plugin API. The goal is read from the transcript's `goal_status` rows, with no effect on the session.
 * - **A session on the door's self-hosted surface** that no supervisor owns: the door is the Remote Control service there, so it writes the slash command into its own conversation as a person's app would and reads the worker's answer off the stream (`rcSelfHostCommands.ts`).
 *
 * Any other session is refused with the reason: the door has no in-process channel into it, and on the real service the worker runs a slash command only when a person's app wrote it (it treats every other writer, the door's own `send` among them, as a peer whose message the model reads as text), which the door will not claim to be.
 *
 * Both routes are verified for exactly the Claude Code versions `RC_SESSION_COMMAND_VERIFIED_VERSIONS` names, read from the running binary itself (the plugin's `$.session.version()`, or the worker's own `system/init`), and every verb refuses a session on any other version, or one whose version is not known.
 */

/** The Claude Code versions both routes were verified on end to end; a session reporting any other version is refused. */
export const RC_SESSION_COMMAND_VERIFIED_VERSIONS: readonly string[] = ["2.1.319"];

/** The arguments the 2.1.319 `/goal` command reads as a request to clear the goal rather than set one, compared case-insensitively; a condition that is one of these words cannot be set through `/goal`, so the set verb refuses it rather than clear the goal by accident. */
export const RC_GOAL_CLEAR_WORDS: readonly string[] = ["clear", "stop", "off", "reset", "none", "cancel"];

/** The longest goal condition the 2.1.319 `/goal` command accepts, in characters; it refuses a longer one with its own message, so the set verb refuses it first, unsent. */
export const RC_GOAL_CONDITION_MAX_CHARS = 4000;

/**
 * The longest any verb waits for the session's answer: the largest delay Node's timers accept (a signed 32-bit millisecond count), since a larger one fires after one millisecond instead. Every wait the verbs take is bounded by it, in the schema, the CLI's parser and the timer itself.
 */
export const RC_SESSION_COMMAND_MAX_WAIT_MS = 2_147_483_647;

/** Who answered: the session's supervisor through its in-process plugin, or the door's own self-hosted surface. */
export type RcSessionCommandRoute = "supervised" | "self-hosted";

/** One goal as the session reports it. */
export type RcGoal = TranscriptGoal;

/** What a goal read found: the active goal, or `null` when the session has none. */
export interface RcGoalReport {
  readonly route: RcSessionCommandRoute;
  readonly goal: RcGoal | null;
}

/** What a goal set did: the condition now set, and the one it replaced, or `null` when none was set. */
export interface RcGoalSetReport {
  readonly route: RcSessionCommandRoute;
  readonly condition: string;
  readonly superseded: string | null;
}

/** What a goal clear did: the condition it cleared, or `null` when the session had no goal to clear. */
export interface RcGoalClearReport {
  readonly route: RcSessionCommandRoute;
  readonly cleared: string | null;
}

/** What a completed compaction reported: what triggered it as the session names it, and the token counts before and after when the session recorded them. */
export interface RcCompactReport {
  readonly route: RcSessionCommandRoute;
  readonly trigger: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
}

/** One verb's outcome: the report, or a verbose failure ready to show a user. */
export type RcSessionCommandResult<T> = { readonly ok: true; readonly report: T } | { readonly ok: false; readonly message: string };

/** The options every verb takes. */
export interface RcSessionCommandOptions {
  /** How long to wait for the session's answer, in milliseconds, at most `RC_SESSION_COMMAND_MAX_WAIT_MS`; the supervisor's own bound on one compaction (`COMPACT_TIMEOUT_MS`) when absent, since a compaction's one summary request is the longest thing a verb waits on and a goal command, which makes no model request, is answered well within it. */
  readonly waitMs?: number;
  /** Aborts the wait, as the caller's request ending does. */
  readonly signal?: AbortSignal;
}

/** A compaction's options beyond the wait. */
export interface RcCompactOptions extends RcSessionCommandOptions {
  /** Custom summarisation instructions. A directive to the session's model, which is why the typed API serves it under its own grant. */
  readonly instructions?: string;
}


/** The supervised launch a Remote Control session belongs to, as the door reaches it. */
export interface RcSupervisedTarget {
  /** The conversation the plugin acts on: the session's current one, which differs from its launch id after `/clear`. */
  readonly conversationId: string;
  /** The session's current transcript, the goal's record; undefined until the session's hooks have named it. */
  readonly transcriptPath: string | undefined;
  /** The Claude Code version the plugin reported when it loaded; undefined when it has not loaded. */
  readonly version: string | undefined;
  /** Compacts through the plugin; the request is runnable for `waitMs` and no longer. */
  readonly compact: (signal: AbortSignal, instructions: string | undefined, waitMs: number) => Promise<CompactionResult>;
  /** Runs `/goal <args>` through the plugin, runnable for `waitMs` and no longer. */
  readonly runGoal: (args: string, signal: AbortSignal, waitMs: number) => Promise<unknown>;
}

/** Everything the verbs need, injected so they run against fakes in unit tests. */
export interface RcSessionCommandDeps {
  /** The supervised launch a `cse_` session belongs to; undefined when no live supervisor owns it, or when it does but its control plugin is not recorded; a refusal when the door cannot tell which launch it is (two live launches claim it). */
  readonly supervisedOf: (sessionId: string) => Promise<RcSupervisedTarget | { readonly refused: string } | undefined>;
  /** The goal a transcript leaves active, read incrementally without blocking (`transcriptFollower.ts`); undefined when the file does not exist. */
  readonly goalOf: (path: string) => Promise<RcGoal | null | undefined>;
  /** The door's own surface, present only when the door serves Remote Control itself: the one place it writes a command as a person's app. */
  readonly selfHost: RcSelfHostCommandDeps | undefined;
  /** Whether the door observes the session at all, so a mistyped id is refused as unknown rather than as unsupported. */
  readonly isObserved: (sessionId: string) => boolean;
}

/** The refusal for a session whose Claude Code version is not one the routes were verified on, or is not known. */
function unverifiedVersionMessage(sessionId: string, version: string | undefined, source: string): string {
  const verified = RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ");
  return version === undefined
    ? `session ${sessionId} has not reported its Claude Code version (${source}), and goal and compaction control is verified only on Claude Code ${verified}`
    : `session ${sessionId} runs Claude Code ${version}, and goal and compaction control is verified only on Claude Code ${verified}: the door will not act on a version whose behaviour it has not verified`;
}

/** The refusal for a session neither route reaches. */
function unsupportedMessage(sessionId: string): string {
  return `session ${sessionId} was not launched under an agent-shim supervisor, so the door has no in-process channel into it, and it is not on the door's own self-hosted surface. Over the real Remote Control service, Claude Code ${RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ")} runs a slash command only when a person's app wrote it and treats any other writer as a peer, whose message the model reads as text, and the door does not claim to be a person's app on a service it does not run. Launch the session under a pool with resumeOnLimit (which supervises it), or run it against the door's self-hosted surface.`;
}

/** One verb's work on a resolved route. */
interface RouteActions<T> {
  readonly supervised: (target: RcSupervisedTarget, signal: AbortSignal, waitMs: number) => Promise<RcSessionCommandResult<T>>;
  readonly selfHosted: (selfHost: RcSelfHostCommandDeps, signal: AbortSignal) => Promise<RcSessionCommandResult<T>>;
}

/** Creates the verbs over their dependencies. Verbs on one session run one at a time, in the order they were asked, so two commands never interleave on one session and one never reads the other's answer. */
export function createRcSessionCommands(deps: RcSessionCommandDeps) {
  const queues = new Map<string, Promise<unknown>>();

  /** Runs `work` after every verb already queued on the session, then forgets the queue once it has drained. */
  const serialised = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const before = queues.get(sessionId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(sessionId, settled);
    try {
      return await run;
    } finally {
      if (queues.get(sessionId) === settled) {
        queues.delete(sessionId);
      }
    }
  };

  /** Resolves the session's route, gates its version and runs the verb there, all inside the session's queue. */
  const onRoute = async <T>(sessionId: string, options: RcSessionCommandOptions, actions: RouteActions<T>): Promise<RcSessionCommandResult<T>> =>
    await serialised(sessionId, async () => {
      const signal = options.signal ?? new AbortController().signal;
      if (signal.aborted) {
        return { ok: false, message: `the request for session ${sessionId} was aborted before it ran` };
      }
      const target = await deps.supervisedOf(sessionId);
      if (target !== undefined && "refused" in target) {
        return { ok: false, message: target.refused };
      }
      if (target !== undefined) {
        if (target.version === undefined || !RC_SESSION_COMMAND_VERIFIED_VERSIONS.includes(target.version)) {
          return { ok: false, message: unverifiedVersionMessage(sessionId, target.version, "its supervisor's control plugin has not loaded") };
        }
        // The plugin answers only once the session is idle (a request queued behind a turn waiting on a permission prompt waits as long as the prompt does), so the wait is bounded here: the request's own signal or the wait, whichever ends first.
        const waitMs = options.waitMs ?? COMPACT_TIMEOUT_MS;
        const timeout = AbortSignal.timeout(waitMs);
        const bounded = AbortSignal.any([signal, timeout]);
        try {
          return await actions.supervised(target, bounded, waitMs);
        } catch (error) {
          if (timeout.aborted) {
            return { ok: false, message: `session ${sessionId}'s control plugin did not answer within ${String(waitMs)} ms. A request the plugin had not started is withdrawn; one it had started runs once the session is idle (a turn waiting on a permission prompt holds it), so read the session's goal or transcript before asking again` };
          }
          return { ok: false, message: `session ${sessionId}'s control plugin did not complete the request: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (!deps.isObserved(sessionId)) {
        return { ok: false, message: `the front door has not observed Remote Control session ${sessionId}` };
      }
      if (deps.selfHost !== undefined) {
        const unavailable = deps.selfHost.unavailable();
        if (unavailable !== undefined) {
          return { ok: false, message: `session ${sessionId} was not launched under an agent-shim supervisor, and the door's self-hosted surface cannot take a command: ${unavailable}` };
        }
        const version = deps.selfHost.versionOf(sessionId);
        if (version === undefined || !RC_SESSION_COMMAND_VERIFIED_VERSIONS.includes(version)) {
          return { ok: false, message: unverifiedVersionMessage(sessionId, version, "no system/init from its worker has been observed on its stream; send it a prompt so it reports one") };
        }
        // One deadline for the whole verb, however many commands it runs (a goal set reads the goal it replaces first): each command's own wait is the whole bound, and this signal ends the verb once the bound has passed in total.
        const waitMs = options.waitMs ?? deps.selfHost.defaultWaitMs;
        const timeout = AbortSignal.timeout(waitMs);
        const result = await actions.selfHosted(deps.selfHost, AbortSignal.any([signal, timeout]));
        if (!result.ok && timeout.aborted) {
          return { ok: false, message: `session ${sessionId}'s worker did not answer within ${String(waitMs)} ms in all; it may still be queued behind a running turn, so read the session's stream before asking again` };
        }
        return result;
      }
      return { ok: false, message: unsupportedMessage(sessionId) };
    });

  /** The supervised session's goal as its transcript records it now. */
  const transcriptGoal = async (sessionId: string, target: RcSupervisedTarget): Promise<RcSessionCommandResult<RcGoal | null>> => {
    const goal = target.transcriptPath === undefined ? undefined : await deps.goalOf(target.transcriptPath);
    if (goal === undefined) {
      return { ok: false, message: `session ${sessionId}'s supervisor has not recorded its transcript yet, which is where its goal is read from; retry once it has finished a turn` };
    }
    return { ok: true, report: goal };
  };

  /**
   * The supervised session's goal once `holds` is true of it, re-reading the transcript at the plugin's own result cadence until it is or the verb's signal ends: the plugin reports the command run once `$.command.run` resolves, and the transcript row that records its effect can land a moment after. When the signal ends first, the last read is returned, and the caller reports that it does not show the change.
   */
  const settledGoal = async (sessionId: string, target: RcSupervisedTarget, signal: AbortSignal, holds: (goal: RcGoal | null) => boolean): Promise<RcSessionCommandResult<RcGoal | null>> => {
    for (;;) {
      const read = await transcriptGoal(sessionId, target);
      if (!read.ok || holds(read.report) || signal.aborted) {
        return read;
      }
      await sleep(RESULT_POLL_MS);
    }
  };

  const waitOf = (options: RcSessionCommandOptions): number | undefined => options.waitMs;

  return {
    /** Reads the session's goal: from the transcript for a supervised session, with no effect on it; by running `/goal` on the self-hosted surface otherwise. */
    goalGet: async (sessionId: string, options: RcSessionCommandOptions = {}): Promise<RcSessionCommandResult<RcGoalReport>> =>
      await onRoute<RcGoalReport>(sessionId, options, {
        supervised: async (target) => {
          const read = await transcriptGoal(sessionId, target);
          return await Promise.resolve(read.ok ? { ok: true as const, report: { route: "supervised" as const, goal: read.report } } : read);
        },
        selfHosted: async (selfHost, signal) => {
          const read = await runSelfHostedSlashCommand(selfHost, sessionId, { kind: "goal-get" }, waitOf(options), signal);
          return read.ok ? { ok: true, report: { route: "self-hosted", goal: read.report.goal } } : read;
        },
      }),

    /**
     * Sets the session's goal: the goal check then keeps the session working until the condition holds, and the condition reaches its model as a directive (`docs/rc-slash-commands.md`, the trust boundary). Refused unsent: an empty condition, one `/goal` reads as a clear, and one longer than it accepts. The answer names the goal it replaced.
     */
    goalSet: async (sessionId: string, condition: string, options: RcSessionCommandOptions = {}): Promise<RcSessionCommandResult<RcGoalSetReport>> => {
      const trimmed = condition.trim();
      if (trimmed === "") {
        return { ok: false, message: "a goal set needs a non-empty condition" };
      }
      if (RC_GOAL_CLEAR_WORDS.includes(trimmed.toLowerCase())) {
        return { ok: false, message: `"${trimmed}" cannot be set as a goal condition: /goal reads ${RC_GOAL_CLEAR_WORDS.join(", ")} as a request to clear the goal, so use the clear verb for that` };
      }
      if (/[\r\n]/u.test(trimmed)) {
        return { ok: false, message: "a goal condition is one line: /goal reads its condition from the line it is typed on, and both routes confirm the goal by the exact condition, so a condition spanning lines is refused rather than set as something else" };
      }
      if (trimmed.length > RC_GOAL_CONDITION_MAX_CHARS) {
        return { ok: false, message: `a goal condition is limited to ${String(RC_GOAL_CONDITION_MAX_CHARS)} characters, and this one has ${String(trimmed.length)}` };
      }
      return await onRoute<RcGoalSetReport>(sessionId, options, {
        supervised: async (target, signal, waitMs) => {
          const before = await transcriptGoal(sessionId, target);
          if (!before.ok) {
            return before;
          }
          await target.runGoal(trimmed, signal, waitMs);
          const after = await settledGoal(sessionId, target, signal, (goal) => goal?.condition === trimmed);
          if (!after.ok) {
            return after;
          }
          return after.report?.condition === trimmed ? { ok: true, report: { route: "supervised", condition: trimmed, superseded: before.report?.condition ?? null } } : { ok: false, message: `session ${sessionId} ran /goal but its transcript does not record the goal as set` };
        },
        selfHosted: async (selfHost, signal) => {
          const before = await runSelfHostedSlashCommand(selfHost, sessionId, { kind: "goal-get" }, waitOf(options), signal);
          if (!before.ok) {
            return before;
          }
          const set = await runSelfHostedSlashCommand(selfHost, sessionId, { kind: "goal-set", condition: trimmed }, waitOf(options), signal);
          return set.ok ? { ok: true, report: { route: "self-hosted", condition: set.report.condition, superseded: before.report.goal?.condition ?? null } } : set;
        },
      });
    },

    /** Clears the session's goal and names the condition it cleared, or `null` when there was none, which is not a failure (clearing is idempotent). */
    goalClear: async (sessionId: string, options: RcSessionCommandOptions = {}): Promise<RcSessionCommandResult<RcGoalClearReport>> =>
      await onRoute<RcGoalClearReport>(sessionId, options, {
        supervised: async (target, signal, waitMs) => {
          const before = await transcriptGoal(sessionId, target);
          if (!before.ok) {
            return before;
          }
          if (before.report === null) {
            return { ok: true, report: { route: "supervised", cleared: null } };
          }
          await target.runGoal("clear", signal, waitMs);
          const after = await settledGoal(sessionId, target, signal, (goal) => goal === null);
          if (!after.ok) {
            return after;
          }
          return after.report === null ? { ok: true, report: { route: "supervised", cleared: before.report.condition } } : { ok: false, message: `session ${sessionId} ran /goal clear but its transcript still records the goal "${after.report.condition}"` };
        },
        selfHosted: async (selfHost, signal) => {
          const cleared = await runSelfHostedSlashCommand(selfHost, sessionId, { kind: "goal-clear" }, waitOf(options), signal);
          return cleared.ok ? { ok: true, report: { route: "self-hosted", cleared: cleared.report.cleared } } : cleared;
        },
      }),

    /** Compacts the session's conversation, with custom summary instructions when given, and resolves with the outcome: the trigger and token counts, or the session's reason for not compacting. */
    compact: async (sessionId: string, options: RcCompactOptions = {}): Promise<RcSessionCommandResult<RcCompactReport>> => {
      const instructions = options.instructions?.trim();
      const given = instructions === undefined || instructions === "" ? undefined : instructions;
      return await onRoute<RcCompactReport>(sessionId, options, {
        supervised: async (target, signal, waitMs) => {
          const result = await target.compact(signal, given, waitMs);
          if (result.kind === "unchanged") {
            return { ok: false, message: `session ${sessionId} was not compacted: ${result.reason}` };
          }
          // `$.session.compact` is the `session.compact` event with trigger `plugin`, which is what the plugin API names a compaction it asked for.
          return { ok: true, report: { route: "supervised", trigger: "plugin", ...(result.beforeTokens === undefined ? {} : { preTokens: result.beforeTokens }), ...(result.afterTokens === undefined ? {} : { postTokens: result.afterTokens }) } };
        },
        selfHosted: async (selfHost, signal) => {
          const compacted = await runSelfHostedSlashCommand(selfHost, sessionId, { kind: "compact", instructions: given }, waitOf(options), signal);
          return compacted.ok ? { ok: true, report: { route: "self-hosted", ...compacted.report } } : compacted;
        },
      });
    },
  };
}

/** The verbs as `createRcSessionCommands` builds them. */
export type RcSessionCommands = ReturnType<typeof createRcSessionCommands>;
