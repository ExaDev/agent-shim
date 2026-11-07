import { realRcEventDial, type RcDialTarget } from "./connectEffects";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { RcStreamEvent } from "./rcSchemas";
import type { RcEventFanout } from "./rcStream";
import { buildRcEventWriteBody, buildRcUserMessagePayload, noOAuthCredentialResult, rcEventWriteResultFromAnswer, rcSessionNotObservedMessage, rcWriteHeaders, type RcDialAnswer, type RcEventDial, type RcEventWriteResult, type RcInjectDeps } from "./rcWrites";

/**
 * Slash commands on the door's own self-hosted Remote Control surface: the route the goal and compaction verbs take for a session no supervisor owns when the door serves Remote Control itself (`rcSessionCommands.ts` chooses the route).
 *
 * On that surface the door is the service, so stamping the writer's platform onto an event is its own job (the real service does the same from each writer's `anthropic-client-platform` header), and writing a command under a person's app is the service vouching for its own client. The worker runs an inbound slash command only when its `client_platform` names a person's app: the 2.1.319 bridge treats `ios`, `android`, `web_claude_ai` and `desktop_app` as a person and demotes any other value to a peer message, which the model reads as text. The door's own browser page is `web_claude_ai`, so that is the value written here. This module never writes to any other host: the router reaches it only when the door serves the surface.
 *
 * The worker's answers, read from live 2.1.319 sessions on the self-hosted surface: a local command's output is a synthetic assistant message whose `local_command_run` names the command and its arguments; a manual compaction ends with a `compact_boundary` whose `compact_metadata.trigger` is `manual`, and a refused one with the local command's output naming the reason.
 */

/** The platform the door writes a command under on its own surface: the claude.ai web app, the one person's app the door itself serves (its browser page). */
const RC_PERSON_CLIENT_PLATFORM = "web_claude_ai";

/** The brand only `rcSelfHostEventDial` puts on a dial: not exported, so no other code can make a value of the type. */
const SELF_HOST_DIAL: unique symbol = Symbol("the door's own self-hosted surface");

/** The loopback addresses a dial to the door's own surface may name, as literals: a name would make the guard depend on how it resolves. Anything else is another machine, the real API host above all. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

/**
 * A dial that reaches the door's own self-hosted surface and nothing else: the one dial a command written as a person's app may ride. Like the client half's other late-targeted dials (`lateRcEventDial`) it refuses a call made while no target is resolved, and unlike them it also refuses a target that is not a loopback address: a write whose target is not resolved, or resolves to anything but a loopback address, is never sent.
 */
export interface RcSelfHostEventDial {
  readonly [SELF_HOST_DIAL]: true;
  readonly writeEvents: RcEventDial["writeEvents"];
}

/** Builds the dial to the door's own self-hosted surface over `resolve`, the late-bound target of that surface (its transparent port, once bound); `makeDial` is the real event dial in production and a fake in tests. */
export function rcSelfHostEventDial(resolve: () => RcDialTarget | undefined, makeDial: (target: RcDialTarget) => RcEventDial = realRcEventDial): RcSelfHostEventDial {
  let built: { readonly for: RcDialTarget; readonly dial: RcEventDial } | undefined;
  return {
    [SELF_HOST_DIAL]: true,
    writeEvents: async (sessionId, headers, body) => {
      const target = resolve();
      if (target === undefined) {
        throw new Error("the door's self-hosted surface is not bound, so a command written as a person's app has nowhere to go but the real API host, and is not sent");
      }
      if (!LOOPBACK_HOSTS.includes(target.host)) {
        throw new Error(`the door's self-hosted surface resolved to ${target.host}, which is not this machine, so a command written as a person's app is not sent there`);
      }
      if (built?.for !== target) {
        built = { for: target, dial: makeDial(target) };
      }
      return await built.dial.writeEvents(sessionId, headers, body);
    },
  };
}

/**
 * Why the door's own self-hosted surface is not bound, from the one input that decides whether it ever will be: `AGENT_SHIM_TRANSPARENT_SURFACE` as the door started with it. Unset or not a port, it never binds; set to a port, the listener has not bound it yet or could not.
 */
export function selfHostSurfaceUnboundReason(transparentSurface: string | undefined): string {
  const port = transparentSurface === undefined ? Number.NaN : Number(transparentSurface);
  if (transparentSurface === undefined) {
    return "AGENT_SHIM_TRANSPARENT_SURFACE is not set, so the door has no surface of its own to write to";
  }
  if (!Number.isInteger(port) || port <= 0) {
    return `AGENT_SHIM_TRANSPARENT_SURFACE is "${transparentSurface}", which is not a port, so the door has no surface of its own to write to`;
  }
  return `the door's transparent surface on port ${String(port)} is not bound: its listener has not started yet or could not bind the port (the door's log says which)`;
}

/** What a person's-app write needs: the client half's credential accessors and id minting, and the self-hosted dial in place of the general one. */
export type RcPersonWriteDeps = Omit<RcInjectDeps, "dial"> & { readonly dial: RcSelfHostEventDial };

/** Writes one user message into a session on the door's own surface as the person's app `RC_PERSON_CLIENT_PLATFORM` names: the client half's user-message write with the observed credential, its platform replaced. It is the only write that names a platform other than the observed one, it can ride only the self-hosted dial, and it is not part of the library, so nothing outside this route can make the door claim an app it is not. */
async function writeRcPersonMessage(deps: RcPersonWriteDeps, sessionId: string, text: string): Promise<RcEventWriteResult> {
  const credential = deps.credentialOf(sessionId);
  if (credential === undefined) {
    return { ok: false, message: rcSessionNotObservedMessage(sessionId) };
  }
  if (credential.authorization === undefined) {
    return noOAuthCredentialResult(sessionId);
  }
  const body = JSON.stringify(buildRcEventWriteBody(buildRcUserMessagePayload(deps.newUuid(), sessionId, text)));
  // The door's own surface reads at most this much of a write, so a larger one would be cut off there rather than refused here.
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > CONTROL_BODY_CAP_BYTES) {
    return { ok: false, message: `the command for session ${sessionId} makes an event write of ${String(bytes)} bytes, over the ${String(CONTROL_BODY_CAP_BYTES)} bytes the door's self-hosted surface reads; shorten its arguments` };
  }
  let answer: RcDialAnswer;
  try {
    answer = await deps.dial.writeEvents(sessionId, rcWriteHeaders({ ...credential, anthropicClientPlatform: RC_PERSON_CLIENT_PLATFORM }), body);
  } catch (error) {
    return { ok: false, message: `the door could not write to its own self-hosted surface for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = rcEventWriteResultFromAnswer(answer);
  if (result.ok) {
    deps.noteSequenceNums(sessionId, result.sequenceNums);
  }
  return result;
}

/** Everything the self-hosted route needs, injected so it runs against fakes in unit tests. */
export interface RcSelfHostCommandDeps {
  /** What writing a command as a person's app needs, its dial the door's own surface alone. */
  readonly personWrite: RcPersonWriteDeps;
  /** Why the door's own surface cannot take a command now (it is not bound, as when the door runs self-hosted without a transparent surface), or undefined when it can. */
  readonly unavailable: () => string | undefined;
  /** The client attachment's fan-out, on which the worker's answer arrives. */
  readonly fanout: RcEventFanout;
  /** The Claude Code version the session's worker last reported in a `system/init`, or undefined when none has been observed. */
  readonly versionOf: (sessionId: string) => string | undefined;
  /** Arms one timer, returning the function that cancels it: `setTimeout` in production, a controllable clock in tests. */
  readonly setTimer: (action: () => void, ms: number) => () => void;
  /** How long to wait when the caller names no bound. */
  readonly defaultWaitMs: number;
}

/** One command this route runs. */
export type RcSelfHostCommand = { readonly kind: "goal-get" } | { readonly kind: "goal-set"; readonly condition: string } | { readonly kind: "goal-clear" } | { readonly kind: "compact"; readonly instructions: string | undefined };

/** What each command reports. */
interface RcSelfHostReports {
  readonly "goal-get": { readonly goal: { readonly condition: string; readonly iterations: number; readonly lastCheck?: string } | null };
  readonly "goal-set": { readonly condition: string };
  readonly "goal-clear": { readonly cleared: string | null };
  readonly compact: { readonly trigger: string; readonly preTokens: number; readonly postTokens: number };
}

type ReportOf<C extends RcSelfHostCommand> = RcSelfHostReports[C["kind"]];

/** One outcome: the report, or a verbose failure. */
type Outcome<T> = { readonly ok: true; readonly report: T } | { readonly ok: false; readonly message: string };

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One local command's answer as the worker emitted it: its output text and, when the worker stated it, the outcome kind. */
interface LocalCommandAnswer {
  readonly text: string;
  readonly outcome: string | undefined;
}

/** The worker's answer to the local command `command` run with exactly `args`, when this stream event is that answer. */
export function rcLocalCommandAnswerOf(event: RcStreamEvent, command: string, args: string): LocalCommandAnswer | undefined {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== "assistant" || !isRecord(payload.local_command_run) || payload.local_command_run.command !== command || payload.local_command_run.args !== args) {
    return undefined;
  }
  const message = payload.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const blocks: readonly unknown[] = message.content;
  const text = blocks.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  const outcome = isRecord(payload.local_command_outcome) && typeof payload.local_command_outcome.kind === "string" ? payload.local_command_outcome.kind : undefined;
  return { text, outcome };
}

/** The token counts a manual compaction's boundary names, when this stream event is that boundary. */
export function rcManualCompactBoundaryOf(event: RcStreamEvent): ReportOf<{ kind: "compact"; instructions: undefined }> | undefined {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== "system" || payload.subtype !== "compact_boundary" || !isRecord(payload.compact_metadata)) {
    return undefined;
  }
  const metadata = payload.compact_metadata;
  if (metadata.trigger !== "manual" || typeof metadata.pre_tokens !== "number" || typeof metadata.post_tokens !== "number") {
    return undefined;
  }
  return { trigger: metadata.trigger, preTokens: metadata.pre_tokens, postTokens: metadata.post_tokens };
}

/** Whether this stream event is the worker passing `text` on to its model as a peer's message, which is what it does with a command it will not run. */
function isPeerDelivery(event: RcStreamEvent, text: string): boolean {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== "user" || !isRecord(payload.origin) || payload.origin.kind !== "peer" || !isRecord(payload.message)) {
    return false;
  }
  return typeof payload.message.content === "string" && payload.message.content.includes(text);
}

/** The line `/goal` answers with when no goal is set, which the read and clear outputs both begin with. */
const NO_GOAL_PREFIX = "No goal set";

/** The active-goal line: the condition (which may span lines), its evaluation count in parentheses, then optionally the check's last reason on a line of its own. */
const ACTIVE_GOAL_PATTERN = /^Goal active: (?<condition>[\s\S]*?) \((?:not yet evaluated|(?<iterations>\d+) turns?)\)(?:\nLast check: (?<lastCheck>[\s\S]*))?$/u;

/** Reads `/goal`'s answer with no argument, or undefined when the text is neither shape the verified versions answer with. */
export function parseRcGoalOutput(output: string): ReportOf<{ kind: "goal-get" }> | undefined {
  if (output.startsWith(NO_GOAL_PREFIX)) {
    return { goal: null };
  }
  const groups = ACTIVE_GOAL_PATTERN.exec(output)?.groups;
  const condition = groups?.condition;
  if (condition === undefined) {
    return undefined;
  }
  return { goal: { condition, iterations: groups?.iterations === undefined ? 0 : Number(groups.iterations), ...(groups?.lastCheck === undefined ? {} : { lastCheck: groups.lastCheck }) } };
}

/** The prefix `/goal clear` answers with when it cleared a goal. */
const GOAL_CLEARED_PREFIX = "Goal cleared: ";

/** The prefix `/goal <condition>` answers with when it set the goal. */
const GOAL_SET_PREFIX = "Goal set: ";

/** The text and arguments one command is written as. */
function commandLine(command: RcSelfHostCommand): { readonly name: string; readonly args: string } {
  if (command.kind === "goal-set") {
    return { name: "goal", args: command.condition };
  }
  if (command.kind === "compact") {
    return { name: "compact", args: command.instructions ?? "" };
  }
  return { name: "goal", args: command.kind === "goal-clear" ? "clear" : "" };
}

/** Reads one stream event for the command's answer: undefined to keep waiting, the outcome otherwise. */
function recognise<C extends RcSelfHostCommand>(command: C, event: RcStreamEvent, name: string, args: string): Outcome<ReportOf<C>> | undefined;
function recognise(command: RcSelfHostCommand, event: RcStreamEvent, name: string, args: string): Outcome<ReportOf<RcSelfHostCommand>> | undefined {
  if (command.kind === "compact") {
    const boundary = rcManualCompactBoundaryOf(event);
    if (boundary !== undefined) {
      return { ok: true, report: boundary };
    }
  }
  const answer = rcLocalCommandAnswerOf(event, name, args);
  if (answer === undefined) {
    return undefined;
  }
  if (answer.outcome === "failed") {
    return { ok: false, message: `the worker reported /${name} failed: ${answer.text}` };
  }
  if (command.kind === "goal-get") {
    const report = parseRcGoalOutput(answer.text);
    return report === undefined ? { ok: false, message: `the worker answered /goal with text the verified versions never produce: ${answer.text}` } : { ok: true, report };
  }
  if (command.kind === "goal-set") {
    return answer.text.startsWith(GOAL_SET_PREFIX) ? { ok: true, report: { condition: answer.text.slice(GOAL_SET_PREFIX.length) } } : { ok: false, message: `the worker did not set the goal: ${answer.text}` };
  }
  if (command.kind === "goal-clear") {
    if (answer.text.startsWith(GOAL_CLEARED_PREFIX)) {
      return { ok: true, report: { cleared: answer.text.slice(GOAL_CLEARED_PREFIX.length) } };
    }
    return answer.text === NO_GOAL_PREFIX ? { ok: true, report: { cleared: null } } : { ok: false, message: `the worker answered /goal clear with text the verified versions never produce: ${answer.text}` };
  }
  // A successful compaction is recognised by its boundary above; a local command answer without one is the worker's reason for not compacting.
  return { ok: false, message: `the worker did not compact the session: ${answer.text}` };
}

/**
 * Runs one slash command on the self-hosted surface and resolves with the worker's answer. Subscribes before writing, so an answer can never arrive between the write and the subscription; judges only worker events numbered after the command's own write, matching a goal command's answer by command and exact arguments (so another command's output, or the same command run with other arguments, never answers this one) and a compaction by the first manual compaction boundary after the write. That correlation is by order, not by identity: the worker's answer names no id the door wrote, so the same command with the same arguments typed by a person in an app at the same moment, or a person's own `/compact`, can answer in this command's place; fails at once when the worker passes the command to its model as a peer's message; and fails once the wait passes or the signal aborts. The router serialises verbs per session.
 */
export async function runSelfHostedSlashCommand<C extends RcSelfHostCommand>(deps: RcSelfHostCommandDeps, sessionId: string, command: C, waitMs: number | undefined, signal: AbortSignal): Promise<Outcome<ReportOf<C>>> {
  const { name, args } = commandLine(command);
  const text = args === "" ? `/${name}` : `/${name} ${args}`;
  const early: RcStreamEvent[] = [];
  let after: number | undefined;
  let settle: ((result: Outcome<ReportOf<C>>) => void) | undefined;
  const judge = (event: RcStreamEvent): void => {
    if (after === undefined) {
      early.push(event);
      return;
    }
    if (event.envelope.sequence_num <= after || event.envelope.source !== "worker") {
      return;
    }
    if (isPeerDelivery(event, text)) {
      settle?.({ ok: false, message: `session ${sessionId}'s worker passed ${text} to its model as a peer's message instead of running it, so it did not read the write as a person's` });
      return;
    }
    const outcome = recognise(command, event, name, args);
    if (outcome !== undefined) {
      settle?.(outcome);
    }
  };
  const detach = deps.fanout.subscribe(sessionId, judge);
  let cancelTimer: (() => void) | undefined;
  const onAbort = (): void => {
    settle?.({ ok: false, message: `the request for ${text} on session ${sessionId} was aborted before the worker answered` });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const answered = new Promise<Outcome<ReportOf<C>>>((resolve) => {
      settle = resolve;
    });
    const written = await writeRcPersonMessage(deps.personWrite, sessionId, text);
    if (!written.ok) {
      return written;
    }
    if (signal.aborted) {
      return { ok: false, message: `the request for ${text} on session ${sessionId} was aborted after it was written (sequence_num ${written.sequenceNums.join(", ")})` };
    }
    after = Math.max(...written.sequenceNums);
    const bound = waitMs ?? deps.defaultWaitMs;
    cancelTimer = deps.setTimer(() => {
      settle?.({ ok: false, message: `${text} was delivered to session ${sessionId} (sequence_num ${written.sequenceNums.join(", ")}) but the worker reported no outcome within ${String(bound)} ms; it may still be queued behind a running turn, so read the session's stream before sending it again` });
    }, bound);
    for (const event of early.splice(0)) {
      judge(event);
    }
    return await answered;
  } finally {
    signal.removeEventListener("abort", onAbort);
    cancelTimer?.();
    detach();
  }
}

/** The Claude Code version each observed session's worker reported, read off its own `system/init` events. */
export interface RcClaudeCodeVersions {
  readonly versionOf: (sessionId: string) => string | undefined;
  /** Drops the sessions `isTracked` no longer holds, so an ended session's version is not kept. */
  readonly sweep: (isTracked: (sessionId: string) => boolean) => void;
}

/** Subscribes to every session's stream and files the `claude_code_version` each worker-sourced `system/init` names, the worker's own statement of the version it runs (it emits one at the start of the stream and after every turn); an event a client wrote is never taken for the worker's. In memory: on the self-hosted surface a session lives exactly as long as the door that serves it. */
export function createRcClaudeCodeVersions(fanout: RcEventFanout): RcClaudeCodeVersions {
  const versions = new Map<string, string>();
  fanout.subscribe(undefined, (event) => {
    const payload = event.envelope.payload;
    if (event.envelope.source === "worker" && isRecord(payload) && payload.type === "system" && payload.subtype === "init" && typeof payload.claude_code_version === "string") {
      versions.set(event.session, payload.claude_code_version);
    }
  });
  return {
    versionOf: (sessionId) => versions.get(sessionId),
    sweep: (isTracked) => {
      for (const sessionId of [...versions.keys()]) {
        if (!isTracked(sessionId)) {
          versions.delete(sessionId);
        }
      }
    },
  };
}
