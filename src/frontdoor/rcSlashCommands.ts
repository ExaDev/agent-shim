import type { RcStreamEvent } from "./rcSchemas";
import type { RcEventFanout } from "./rcStream";
import type { RcEventWriteResult } from "./rcWrites";

/**
 * Goal and compaction control over Remote Control: the verbs that read, set and clear a session's `/goal` and run its `/compact`, carried as the slash commands a person types into a claude.ai client, each returning the outcome the worker reports on the session's stream.
 *
 * Why slash commands rather than control requests: the 2.1.319 bridge's inbound `control_request` handler serves no goal or compaction subtype (it answers everything outside its own list with `REPL bridge does not handle control_request subtype`), and both commands declare `thinClientDispatch: "post-text"`, the CLI's own statement that a thin client runs them by posting their text as a user message. The worker runs such a message as a command only when it was written by a person: the bridge classifies an inbound user message by the `client_platform` the service stamps from the writer's `anthropic-client-platform` header, treats `ios`, `android`, `web_claude_ai` and `desktop_app` as a person, and demotes every other value (the CLI's own `claude_code_cli`, which the door's plain `send` replays, among them) to a peer message, which reaches the model as text and never runs. These verbs therefore write their command under `RC_PERSON_CLIENT_PLATFORM`; `send` keeps the observed platform, so a message an agent sends is still framed to the model as a peer's.
 *
 * What the worker answers with, read from live 2.1.319 sessions: a local command's output arrives as a synthetic assistant message whose `local_command_run` names the command and its arguments and whose text is the command's own output; a compaction arrives as a `system` `status` event carrying `compact_result` (`success`, or `failed` with `compact_error`), followed on success by the `compact_boundary` event naming the tokens before and after. The worker emits no event that states a goal on its own (the SDK's `active_goal` message is never forwarded to a Remote Control client), so a goal is read by running `/goal` with no argument and parsing its one line.
 *
 * The mechanism is verified for exactly the Claude Code versions `RC_SLASH_COMMAND_VERIFIED_VERSIONS` names, and every verb refuses a session whose `system/init` reported any other version, or none yet, rather than send a command whose answer it could misread.
 */

/** The `anthropic-client-platform` value the command verbs write under: one of the claude.ai apps the 2.1.319 bridge classifies as a person typing, the only author whose slash command it runs. The door's own web client is a browser page, which is the app this value names. */
export const RC_PERSON_CLIENT_PLATFORM = "web_claude_ai";

/** The Claude Code versions the slash-command route was verified on end to end (the classification rule, the output shapes and the goal line's wording all come from these versions' behaviour); a session reporting any other version is refused. */
export const RC_SLASH_COMMAND_VERIFIED_VERSIONS: readonly string[] = ["2.1.319"];

/** The arguments the 2.1.319 `/goal` command reads as a request to clear the goal rather than set one, compared case-insensitively; a condition that is one of these words cannot be set through `/goal`, so the set verb refuses it rather than clear the goal by accident. */
export const RC_GOAL_CLEAR_WORDS: readonly string[] = ["clear", "stop", "off", "reset", "none", "cancel"];

/**
 * How long a verb waits for the worker's answer when the caller names no bound: ten minutes, the default request timeout of the Anthropic TypeScript SDK the CLI is built on, which bounds the one summary request a compaction makes; a goal command makes no model request and is answered at once by an idle worker, so the same bound covers a goal command queued behind a running turn of ordinary length.
 */
export const RC_SLASH_COMMAND_DEFAULT_WAIT_MS = 600_000;

/** The command names the verbs run, exactly as the worker's `local_command_run.command` names them. */
type RcSlashCommandName = "goal" | "compact";

/** One goal as `/goal` reports it: the condition, how many turns the goal check has evaluated it on (zero when it has not been evaluated yet), and the check's last stated reason when it has given one. */
export interface RcGoal {
  readonly condition: string;
  readonly iterations: number;
  readonly lastCheck?: string;
}

/** What a goal read found: the active goal, or `null` when the session has none. */
export interface RcGoalReport {
  readonly goal: RcGoal | null;
}

/** What a goal clear did: the condition it cleared, or `null` when the session had no goal to clear. */
export interface RcGoalClearReport {
  readonly cleared: string | null;
}

/** What a goal set did: the condition the worker confirmed it set. */
export interface RcGoalSetReport {
  readonly condition: string;
}

/** What a completed compaction reported: the trigger and the token counts its `compact_boundary` event names. */
export interface RcCompactReport {
  readonly trigger: string;
  readonly preTokens: number;
  readonly postTokens: number;
}

/** One verb's outcome: the report and the sequence numbers the command's own write was assigned, or a verbose failure ready to show a user. */
export type RcSlashCommandResult<T> = { readonly ok: true; readonly sequenceNums: readonly number[]; readonly report: T } | { readonly ok: false; readonly message: string };

/** Everything the verbs need, injected so they run against fakes in unit tests. */
export interface RcSlashCommandDeps {
  /** Writes one user message into the session under the named client platform: the inject operation, in production. */
  readonly inject: (sessionId: string, text: string, clientPlatform: string) => Promise<RcEventWriteResult>;
  /** The client attachment's fan-out, on which the worker's answer arrives. */
  readonly fanout: RcEventFanout;
  /** The Claude Code version the session's latest `system/init` reported, or undefined when none has been observed. */
  readonly claudeCodeVersionOf: (sessionId: string) => string | undefined;
  /** Arms one timer, returning the function that cancels it: `setTimeout` in production, a controllable clock in tests. */
  readonly setTimer: (action: () => void, ms: number) => () => void;
}

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The output of one local command, when this stream event is the worker's answer to that command: a synthetic assistant message whose `local_command_run.command` names it, carrying the output as its text. Exported because the renderers and the tests narrow the same payload through the same one definition.
 */
export function rcLocalCommandOutputOf(event: RcStreamEvent, command: string): string | undefined {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== "assistant" || !isRecord(payload.local_command_run) || payload.local_command_run.command !== command) {
    return undefined;
  }
  const message = payload.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const blocks: readonly unknown[] = message.content;
  const texts = blocks.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  return texts.length === 0 ? undefined : texts.join("\n");
}

/** One compaction outcome the stream states: the `status` event's result, or the boundary a successful compaction ends with. */
type RcCompactSignal = { readonly kind: "failed"; readonly error: string } | { readonly kind: "succeeded" } | { readonly kind: "boundary"; readonly report: RcCompactReport };

/** The compaction signal one stream event carries, when it carries one: the worker's `status` event naming the result, or the `compact_boundary` event naming the token counts. */
export function rcCompactSignalOf(event: RcStreamEvent): RcCompactSignal | undefined {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== "system") {
    return undefined;
  }
  if (payload.subtype === "status" && payload.compact_result === "failed") {
    return { kind: "failed", error: typeof payload.compact_error === "string" ? payload.compact_error : "the worker reported the compaction failed and named no reason" };
  }
  if (payload.subtype === "status" && payload.compact_result === "success") {
    return { kind: "succeeded" };
  }
  if (payload.subtype === "compact_boundary" && isRecord(payload.compact_metadata)) {
    const metadata = payload.compact_metadata;
    if (typeof metadata.trigger === "string" && typeof metadata.pre_tokens === "number" && typeof metadata.post_tokens === "number") {
      return { kind: "boundary", report: { trigger: metadata.trigger, preTokens: metadata.pre_tokens, postTokens: metadata.post_tokens } };
    }
  }
  return undefined;
}

/** The line `/goal` answers with when no goal is set, which the read and clear outputs both begin with. */
const NO_GOAL_PREFIX = "No goal set";

/** The active-goal line: the condition, then its evaluation count in parentheses (`not yet evaluated`, or `N turn`/`N turns`), then optionally the check's last reason on its own line. The condition is matched greedily so a condition that itself holds parentheses keeps them; the count group is anchored at the line's end. */
const ACTIVE_GOAL_PATTERN = /^Goal active: (?<condition>.*) \((?:not yet evaluated|(?<iterations>\d+) turns?)\)(?:\nLast check: (?<lastCheck>[\s\S]*))?$/u;

/** Reads `/goal`'s answer with no argument into a goal report, or undefined when the text is neither shape the verified versions answer with. */
export function parseRcGoalReport(output: string): RcGoalReport | undefined {
  if (output.startsWith(NO_GOAL_PREFIX)) {
    return { goal: null };
  }
  const match = ACTIVE_GOAL_PATTERN.exec(output);
  const condition = match?.groups?.condition;
  if (condition === undefined) {
    return undefined;
  }
  const iterations = match?.groups?.iterations;
  const lastCheck = match?.groups?.lastCheck;
  return { goal: { condition, iterations: iterations === undefined ? 0 : Number(iterations), ...(lastCheck === undefined ? {} : { lastCheck }) } };
}

/** The prefix `/goal clear` answers with when it cleared a goal, followed by the condition it cleared. */
const GOAL_CLEARED_PREFIX = "Goal cleared: ";

/** Reads `/goal clear`'s answer into a clear report, or undefined when the text is neither shape the verified versions answer with. */
export function parseRcGoalClearReport(output: string): RcGoalClearReport | undefined {
  if (output.startsWith(GOAL_CLEARED_PREFIX)) {
    return { cleared: output.slice(GOAL_CLEARED_PREFIX.length) };
  }
  return output === NO_GOAL_PREFIX ? { cleared: null } : undefined;
}

/** The prefix `/goal <condition>` answers with when it set the goal, followed by the condition as the worker stored it. */
const GOAL_SET_PREFIX = "Goal set: ";

/** The refusal every verb answers a session whose Claude Code version is not one the route was verified on. */
function unverifiedVersionMessage(sessionId: string, version: string | undefined): string {
  const verified = RC_SLASH_COMMAND_VERIFIED_VERSIONS.join(", ");
  return version === undefined
    ? `session ${sessionId} has not reported its Claude Code version (no system/init has been observed on its stream yet), and goal and compaction control is verified only on Claude Code ${verified}; send it a prompt so it reports one, then retry`
    : `session ${sessionId} runs Claude Code ${version}, and goal and compaction control is verified only on Claude Code ${verified}: the door will not send a command whose answer it could misread on an unverified version`;
}

/**
 * The one engine every verb runs through: refuses an unverified version, subscribes to the session's stream before writing (so an answer can never arrive between the write and the subscription), writes the command as a person's message, and resolves with the first outcome `recognise` reads from an event the worker emitted after the command's own write, or a failure once the wait bound passes. `recognise` returns undefined to keep waiting, a report to finish, or a failure message to fail.
 */
async function runRcSlashCommand<T>(deps: RcSlashCommandDeps, sessionId: string, command: RcSlashCommandName, args: string, waitMs: number, recognise: (event: RcStreamEvent) => { readonly report: T } | { readonly failure: string } | undefined): Promise<RcSlashCommandResult<T>> {
  const version = deps.claudeCodeVersionOf(sessionId);
  if (version === undefined || !RC_SLASH_COMMAND_VERIFIED_VERSIONS.includes(version)) {
    return { ok: false, message: unverifiedVersionMessage(sessionId, version) };
  }
  const text = args === "" ? `/${command}` : `/${command} ${args}`;
  // Events that arrive before the write's own sequence number is known are held, then judged once it is: the worker cannot answer before the service has numbered the command, so only events numbered after it are answers.
  const early: RcStreamEvent[] = [];
  let after: number | undefined;
  let settle: ((result: RcSlashCommandResult<T>) => void) | undefined;
  let sequenceNums: readonly number[] = [];
  const judge = (event: RcStreamEvent): void => {
    if (after === undefined) {
      early.push(event);
      return;
    }
    if (event.envelope.sequence_num <= after || event.envelope.source !== "worker") {
      return;
    }
    const outcome = recognise(event);
    if (outcome === undefined) {
      return;
    }
    settle?.("report" in outcome ? { ok: true, sequenceNums, report: outcome.report } : { ok: false, message: outcome.failure });
  };
  const detach = deps.fanout.subscribe(sessionId, judge);
  let cancelTimer: (() => void) | undefined;
  try {
    const answered = new Promise<RcSlashCommandResult<T>>((resolve) => {
      settle = resolve;
    });
    const written = await deps.inject(sessionId, text, RC_PERSON_CLIENT_PLATFORM);
    if (!written.ok) {
      return written;
    }
    sequenceNums = written.sequenceNums;
    after = Math.max(...written.sequenceNums);
    cancelTimer = deps.setTimer(() => {
      settle?.({ ok: false, message: `the command ${text} was delivered to session ${sessionId} (sequence_num ${written.sequenceNums.join(", ")}) but the worker reported no outcome within ${String(waitMs)} ms; it may still be queued behind a running turn, so read the session's stream before sending it again` });
    }, waitMs);
    for (const event of early.splice(0)) {
      judge(event);
    }
    return await answered;
  } finally {
    cancelTimer?.();
    detach();
  }
}

/** The options every verb takes: how long to wait for the worker's answer. */
export interface RcSlashCommandOptions {
  /** The wait bound in milliseconds; `RC_SLASH_COMMAND_DEFAULT_WAIT_MS` when absent. */
  readonly waitMs?: number;
}

/**
 * Reads one observed session's goal by running `/goal` with no argument: the active goal's condition, how many turns the goal check has evaluated it on and the check's last reason, or `null` when the session has no goal. Running the command changes nothing in the session but its transcript, which records the command and its answer as a person's typed command would.
 */
export async function getRcSessionGoal(deps: RcSlashCommandDeps, sessionId: string, options: RcSlashCommandOptions = {}): Promise<RcSlashCommandResult<RcGoalReport>> {
  return await runRcSlashCommand<RcGoalReport>(deps, sessionId, "goal", "", options.waitMs ?? RC_SLASH_COMMAND_DEFAULT_WAIT_MS, (event) => {
    const output = rcLocalCommandOutputOf(event, "goal");
    if (output === undefined) {
      return undefined;
    }
    const report = parseRcGoalReport(output);
    return report === undefined ? { failure: `the worker answered /goal with text the verified versions never produce: ${output}` } : { report };
  });
}

/**
 * Sets one observed session's goal by running `/goal <condition>`: the worker records the condition and its goal check evaluates it whenever the session would stop. A condition that is empty, or that `/goal` reads as a request to clear (`RC_GOAL_CLEAR_WORDS`), is refused before anything is sent; any answer other than the worker's own confirmation (the condition-length limit's refusal, for one) is returned as the failure, in the worker's words.
 */
export async function setRcSessionGoal(deps: RcSlashCommandDeps, sessionId: string, condition: string, options: RcSlashCommandOptions = {}): Promise<RcSlashCommandResult<RcGoalSetReport>> {
  const trimmed = condition.trim();
  if (trimmed === "") {
    return { ok: false, message: "a goal set needs a non-empty condition: /goal with no argument reads the goal instead of setting one" };
  }
  if (RC_GOAL_CLEAR_WORDS.includes(trimmed.toLowerCase())) {
    return { ok: false, message: `"${trimmed}" cannot be set as a goal condition: /goal reads ${RC_GOAL_CLEAR_WORDS.join(", ")} as a request to clear the goal, so use the clear verb for that` };
  }
  return await runRcSlashCommand<RcGoalSetReport>(deps, sessionId, "goal", trimmed, options.waitMs ?? RC_SLASH_COMMAND_DEFAULT_WAIT_MS, (event) => {
    const output = rcLocalCommandOutputOf(event, "goal");
    if (output === undefined) {
      return undefined;
    }
    return output.startsWith(GOAL_SET_PREFIX) ? { report: { condition: output.slice(GOAL_SET_PREFIX.length) } } : { failure: `the worker did not set the goal: ${output}` };
  });
}

/**
 * Clears one observed session's goal by running `/goal clear`: the condition it cleared, or `null` when the session had no goal, which is not a failure (clearing is idempotent).
 */
export async function clearRcSessionGoal(deps: RcSlashCommandDeps, sessionId: string, options: RcSlashCommandOptions = {}): Promise<RcSlashCommandResult<RcGoalClearReport>> {
  return await runRcSlashCommand<RcGoalClearReport>(deps, sessionId, "goal", "clear", options.waitMs ?? RC_SLASH_COMMAND_DEFAULT_WAIT_MS, (event) => {
    const output = rcLocalCommandOutputOf(event, "goal");
    if (output === undefined) {
      return undefined;
    }
    const report = parseRcGoalClearReport(output);
    return report === undefined ? { failure: `the worker answered /goal clear with text the verified versions never produce: ${output}` } : { report };
  });
}

/** The options a compaction takes beyond the wait bound. */
export interface RcCompactOptions extends RcSlashCommandOptions {
  /** Custom summarisation instructions, passed to `/compact` as its argument. */
  readonly instructions?: string;
}

/**
 * Compacts one observed session's conversation by running `/compact`, optionally with custom summarisation instructions, and resolves once the worker reports the outcome: on success the trigger and the token counts its `compact_boundary` names, on failure the worker's own reason (a conversation too short to compact answers `Not enough messages to compact.`).
 */
export async function compactRcSession(deps: RcSlashCommandDeps, sessionId: string, options: RcCompactOptions = {}): Promise<RcSlashCommandResult<RcCompactReport>> {
  const instructions = options.instructions?.trim() ?? "";
  return await runRcSlashCommand<RcCompactReport>(deps, sessionId, "compact", instructions, options.waitMs ?? RC_SLASH_COMMAND_DEFAULT_WAIT_MS, (event) => {
    const signal = rcCompactSignalOf(event);
    if (signal === undefined || signal.kind === "succeeded") {
      // A success status is followed by the boundary that carries the counts, so the verb waits for that rather than finish without them.
      return undefined;
    }
    return signal.kind === "failed" ? { failure: `the worker did not compact session ${sessionId}: ${signal.error}` } : { report: signal.report };
  });
}

/** The latest Claude Code version each observed session reported, read off the stream's `system/init` events. */
export interface RcClaudeCodeVersions {
  readonly versionOf: (sessionId: string) => string | undefined;
}

/** Subscribes to every session's stream and files the `claude_code_version` each `system/init` event names, the worker's own statement of the version it runs (it emits one at the start of the stream and after every turn). One per door process; the map is bounded by the sessions one door generation observes. */
export function createRcClaudeCodeVersions(fanout: RcEventFanout): RcClaudeCodeVersions {
  const versions = new Map<string, string>();
  fanout.subscribe(undefined, (event) => {
    const payload = event.envelope.payload;
    if (isRecord(payload) && payload.type === "system" && payload.subtype === "init" && typeof payload.claude_code_version === "string") {
      versions.set(event.session, payload.claude_code_version);
    }
  });
  return { versionOf: (sessionId) => versions.get(sessionId) };
}
