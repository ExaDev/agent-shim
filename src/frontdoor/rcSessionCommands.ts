import { setTimeout as sleep } from "node:timers/promises";

import { COMPACT_TIMEOUT_MS } from "../supervise/compactTimeout";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { CompactionResult } from "../supervise/realCompact";
import { RESULT_POLL_MS } from "../supervise/sessionControl";
import type { SubmittedTurn } from "../supervise/sessionControl";
import type { TranscriptGoal } from "../supervise/sessionGoal";
import type { PluginTurns } from "../supervise/sessionPluginTurns";
import { runSelfHostedSlashCommand, runSelfHostedTurn, type RcSelfHostCommandDeps } from "./rcSelfHostCommands";

/**
 * Goal, compaction and turn control over a Remote Control session: read, set and clear its `/goal`, compact its conversation, and put a person's typed turn into it, each returning the outcome the session itself reports. One verb surface over the two routes Claude Code 2.1.319 leaves open, chosen per session:
 *
 * - **A supervised session** (one an agent-shim supervisor launched, whatever its account or provider): the door finds the launch through the registry, by the `bridge-session` row Claude Code writes into the session's own transcript, and asks the session's in-process control plugin (`supervise/sessionControlPlugin.ts`), which runs `$.session.compact`, `/goal <condition>` and `/goal clear` through the plugin API, or submits a person's turn with `$.prompt.submit` as the person's words. The goal is read from the transcript's `goal_status` rows, with no effect on the session.
 * - **A session on the door's self-hosted surface** that no supervisor owns: the door is the Remote Control service there, so it writes the slash command or the turn into its own conversation as a person's app would and reads the worker's answer off the stream (`rcSelfHostCommands.ts`).
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

/** The most bytes one UTF-16 code unit can take in a JSON body: a control character JSON escapes as `\uXXXX`, six bytes, and no code unit encodes to more. */
const MAX_JSON_BYTES_PER_CODE_UNIT = 6;

/**
 * The longest compaction instructions the verbs accept, in UTF-16 code units: as many as fit in one request body under the door's control body cap however they encode, so the bound is one a request can actually reach. The self-hosted route also checks the event write it makes against the same cap, since its envelope adds to the instructions.
 */
export const RC_COMPACT_INSTRUCTIONS_MAX_CHARS = Math.floor(CONTROL_BODY_CAP_BYTES / MAX_JSON_BYTES_PER_CODE_UNIT);

/** The longest turn text the turn verb accepts, in UTF-16 code units: as many as fit in one request body under the door's control body cap however they encode, as for compaction instructions. The self-hosted route also checks the event write it makes against the cap, since its envelope adds to the text. */
export const RC_TURN_TEXT_MAX_CHARS = Math.floor(CONTROL_BODY_CAP_BYTES / MAX_JSON_BYTES_PER_CODE_UNIT);

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

/** What a delivered turn reports: the uuid of the user entry the session recorded for it (the transcript row on the supervised route, the worker's mirrored entry on the self-hosted one). */
export interface RcTurnReport {
  readonly route: RcSessionCommandRoute;
  readonly uuid: string;
}

/** Which route the verbs would take for a session now, or why none would: the read a caller makes before offering a person a reply box. */
export type RcSessionRoute = { readonly route: RcSessionCommandRoute } | { readonly route: null; readonly refused: string };

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
  /** Submits `text` as the person's words through the plugin, runnable for `waitMs` and no longer. */
  readonly submitTurn: (text: string, signal: AbortSignal, waitMs: number) => Promise<SubmittedTurn>;
}

/** Everything the verbs need, injected so they run against fakes in unit tests. */
export interface RcSessionCommandDeps {
  /** The supervised launch a `cse_` session belongs to; undefined when no live supervisor owns it, or when it does but its control plugin is not recorded; a refusal when the door cannot tell which launch it is (two live launches claim it). */
  readonly supervisedOf: (sessionId: string) => Promise<RcSupervisedTarget | { readonly refused: string } | undefined>;
  /** The goal a transcript leaves active, read incrementally without blocking (`transcriptFollower.ts`); undefined when the file does not exist. */
  readonly goalOf: (path: string) => Promise<RcGoal | null | undefined>;
  /** The turns the control plugin submitted as the person's words, as a transcript records them (`sessionPluginTurns.ts`), read the same way; undefined when the file does not exist. */
  readonly pluginTurnsOf: (path: string) => Promise<PluginTurns | undefined>;
  /** The door's own surface, present only when the door serves Remote Control itself: the one place it writes a command as a person's app. */
  readonly selfHost: RcSelfHostCommandDeps | undefined;
  /** Whether the door observes the session at all, so a mistyped id is refused as unknown rather than as unsupported. */
  readonly isObserved: (sessionId: string) => boolean;
}

/** The refusal for a session whose Claude Code version is not one the routes were verified on, or is not known. */
function unverifiedVersionMessage(sessionId: string, version: string | undefined, source: string): string {
  const verified = RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ");
  return version === undefined
    ? `session ${sessionId} has not reported its Claude Code version (${source}), and goal, compaction and turn control is verified only on Claude Code ${verified}`
    : `session ${sessionId} runs Claude Code ${version}, and goal, compaction and turn control is verified only on Claude Code ${verified}: the door will not act on a version whose behaviour it has not verified`;
}

/** The refusal for a session neither route reaches. */
function unsupportedMessage(sessionId: string): string {
  return `session ${sessionId} was not launched under an agent-shim supervisor, so the door has no in-process channel into it, and it is not on the door's own self-hosted surface. Over the real Remote Control service, Claude Code ${RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ")} takes a message as a person's (running it when it is a slash command) only when a person's app wrote it and treats any other writer as a peer, whose message the model reads as another session's, and the door does not claim to be a person's app on a service it does not run. Launch the session under a pool with resumeOnLimit (which supervises it), or run it against the door's self-hosted surface; loading the control plugin into every launch (https://github.com/ExaDev/agent-shim/issues/803) would give it a route.`;
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

  /** Resolves the session's route and gates its version: the supervised launch, the door's own surface, or the refusal naming why neither serves it. Reads only, so a caller can ask it outside the session's queue. */
  const resolveRoute = async (sessionId: string): Promise<{ readonly kind: "supervised"; readonly target: RcSupervisedTarget } | { readonly kind: "self-hosted"; readonly selfHost: RcSelfHostCommandDeps } | { readonly kind: "refused"; readonly message: string }> => {
    const target = await deps.supervisedOf(sessionId);
    if (target !== undefined && "refused" in target) {
      return { kind: "refused", message: target.refused };
    }
    if (target !== undefined) {
      if (target.version === undefined || !RC_SESSION_COMMAND_VERIFIED_VERSIONS.includes(target.version)) {
        return { kind: "refused", message: unverifiedVersionMessage(sessionId, target.version, "its supervisor's control plugin has not loaded") };
      }
      return { kind: "supervised", target };
    }
    if (!deps.isObserved(sessionId)) {
      return { kind: "refused", message: `the front door has not observed Remote Control session ${sessionId}` };
    }
    if (deps.selfHost === undefined) {
      return { kind: "refused", message: unsupportedMessage(sessionId) };
    }
    const unavailable = deps.selfHost.unavailable();
    if (unavailable !== undefined) {
      return { kind: "refused", message: `session ${sessionId} was not launched under an agent-shim supervisor, and the door's self-hosted surface cannot take a command: ${unavailable}` };
    }
    const version = deps.selfHost.versionOf(sessionId);
    if (version === undefined || !RC_SESSION_COMMAND_VERIFIED_VERSIONS.includes(version)) {
      return { kind: "refused", message: unverifiedVersionMessage(sessionId, version, "no system/init from its worker has been observed on its stream; send it a prompt so it reports one") };
    }
    return { kind: "self-hosted", selfHost: deps.selfHost };
  };

  /** Resolves the session's route, gates its version and runs the verb there, all inside the session's queue. */
  const onRoute = async <T>(sessionId: string, options: RcSessionCommandOptions, actions: RouteActions<T>): Promise<RcSessionCommandResult<T>> =>
    await serialised(sessionId, async () => {
      const { signal } = options;
      if (signal?.aborted === true) {
        return { ok: false, message: `the request for session ${sessionId} was aborted before it ran` };
      }
      const resolved = await resolveRoute(sessionId);
      if (resolved.kind === "refused") {
        return { ok: false, message: resolved.message };
      }
      if (resolved.kind === "supervised") {
        // The plugin answers only once the session is idle (a request queued behind a turn waiting on a permission prompt waits as long as the prompt does), so the wait is bounded here: the request's own signal or the wait, whichever ends first.
        const waitMs = options.waitMs ?? COMPACT_TIMEOUT_MS;
        const timeout = AbortSignal.timeout(waitMs);
        const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        try {
          return await actions.supervised(resolved.target, bounded, waitMs);
        } catch (error) {
          if (timeout.aborted) {
            return { ok: false, message: `session ${sessionId}'s control plugin did not answer within ${String(waitMs)} ms. A request the plugin had not started is withdrawn; one it had started runs once the session is idle (a turn waiting on a permission prompt holds it), so read the session's goal or transcript before asking again` };
          }
          return { ok: false, message: `session ${sessionId}'s control plugin did not complete the request: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      // One deadline for the whole verb, however many commands it runs (a goal set reads the goal it replaces first): each command's own wait is the whole bound, and this signal ends the verb once the bound has passed in total.
      const waitMs = options.waitMs ?? resolved.selfHost.defaultWaitMs;
      const timeout = AbortSignal.timeout(waitMs);
      const result = await actions.selfHosted(resolved.selfHost, signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
      if (!result.ok && timeout.aborted) {
        return { ok: false, message: `session ${sessionId}'s worker did not answer within ${String(waitMs)} ms in all; it may still be queued behind a running turn, so read the session's stream before asking again` };
      }
      return result;
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

  /** The control plugin's turns as the supervised session's transcript records them now; a failure when the transcript is not named yet or does not exist. */
  const transcriptPluginTurns = async (sessionId: string, target: RcSupervisedTarget): Promise<RcSessionCommandResult<PluginTurns>> => {
    const turns = target.transcriptPath === undefined ? undefined : await deps.pluginTurnsOf(target.transcriptPath);
    return turns === undefined ? { ok: false, message: `session ${sessionId}'s supervisor has not recorded its transcript yet, which is where a turn is confirmed from; retry once it has finished a turn` } : { ok: true, report: turns };
  };

  return {
    /** Which route the verbs would take for the session now, or the refusal naming why none would; reads only, outside the session's queue, so a verb waiting on the session never delays it. */
    routeOf: async (sessionId: string): Promise<RcSessionRoute> => {
      const resolved = await resolveRoute(sessionId);
      return resolved.kind === "refused" ? { route: null, refused: resolved.message } : { route: resolved.kind };
    },

    /**
     * Puts `text` into the session as a person's typed turn, and resolves once the session recorded it as a user entry from the person, never as a peer's message: on the supervised route a transcript row the control plugin submitted as the person's words (`origin: { kind: "plugin", asUser: true }`), on the self-hosted route the worker's mirrored entry with a person's origin (`{ kind: "human" }`). The text reaches the session's model as its user's words (`docs/rc-slash-commands.md`, the trust boundary). Refused unsent: text that is empty, starts with `/` (a slash command, which the goal and compaction verbs run), or is longer than one request carries. Resolves when the turn entered the session, not when the model has answered it.
     */
    turn: async (sessionId: string, text: string, options: RcSessionCommandOptions = {}): Promise<RcSessionCommandResult<RcTurnReport>> => {
      if (text.trim() === "") {
        return { ok: false, message: "a turn needs non-empty text" };
      }
      if (text.trimStart().startsWith("/")) {
        return { ok: false, message: "a turn's text starts with /, which the session would read as a slash command rather than a message, and the turn could not be confirmed as one; use the goal or compaction verbs for those commands, or start the text with something else" };
      }
      if (text.length > RC_TURN_TEXT_MAX_CHARS) {
        return { ok: false, message: `a turn's text is limited to ${String(RC_TURN_TEXT_MAX_CHARS)} characters, and this one has ${String(text.length)}` };
      }
      return await onRoute<RcTurnReport>(sessionId, options, {
        supervised: async (target, signal, waitMs) => {
          const before = await transcriptPluginTurns(sessionId, target);
          if (!before.ok) {
            return before;
          }
          const submitted = await target.submitTurn(text, signal, waitMs);
          if (!submitted.asUser) {
            return { ok: false, message: `session ${sessionId}'s control plugin submitted the turn, but Claude Code did not stamp it as the person's words, so the model may read it framed as the plugin's` };
          }
          // The plugin API resolves once the prompt entered the session or queued behind the running turn; the row that records it lands once the turn starts, so the transcript is re-read at the plugin's own result cadence until it does or the wait ends.
          for (;;) {
            const after = await transcriptPluginTurns(sessionId, target);
            if (!after.ok) {
              return after;
            }
            if (after.report.count > before.report.count && after.report.last !== undefined) {
              return after.report.last.text === text ? { ok: true, report: { route: "supervised", uuid: after.report.last.uuid } } : { ok: false, message: `session ${sessionId}'s transcript records a turn the control plugin submitted, but its text is not the text sent` };
            }
            if (signal.aborted) {
              return { ok: false, message: `session ${sessionId} accepted the turn but its transcript did not record it within ${String(waitMs)} ms; it is queued behind the running turn, so read the transcript before sending it again` };
            }
            await sleep(RESULT_POLL_MS);
          }
        },
        selfHosted: async (selfHost, signal) => {
          const delivered = await runSelfHostedTurn(selfHost, sessionId, text, waitOf(options), signal);
          return delivered.ok ? { ok: true, report: { route: "self-hosted", uuid: delivered.report.uuid } } : delivered;
        },
      });
    },

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
