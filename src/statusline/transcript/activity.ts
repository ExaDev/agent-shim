import { createHash } from "node:crypto";

import { z } from "zod";

import { graphemesOf } from "../graphemes";
import { visibleDisplayText } from "../sanitise";
import { recordTimeMs, type TranscriptRecord } from "./record";

/** The most tool calls the state keeps: the line of tools shows what the session has just been doing, so older calls are forgotten as newer ones arrive. */
export const MAX_TRACKED_TOOL_CALLS = 20;

/** The most agent calls the state keeps, for the same reason. */
export const MAX_TRACKED_AGENTS = 10;

/** The most items of a todo list the state keeps. A session's list is a handful of items; the bound only stops a runaway one from growing the cache file the statusline rewrites at every refresh, and an item past it is forgotten oldest first. */
export const MAX_TRACKED_TODOS = 200;

/** The most results kept while they wait for their calls: a result is written ahead of its call by a few milliseconds, so only the latest few can be waiting. */
export const MAX_UNMATCHED_RESULTS = 20;

const BYTES_PER_KIBIBYTE = 1024;

/** The characters kept of the digest of a call id, and the radix a call's time is kept in (a millisecond clock fits in eight characters of it until the year 2058). Forty-eight bits of digest make a collision between two of the few thousand calls remembered about one in a billion. */
const CALL_DIGEST_CHARS = 8;
const CALL_TIME_RADIX = 36;

/** The two quotes and the comma that a string takes in a JSON array, beside the string. */
const QUOTES_AND_COMMA_BYTES = 3;

/** What a remembered call takes in the cache file: its digest and time, the quotes around them and a comma. */
const REMEMBERED_CALL_BYTES = CALL_DIGEST_CHARS + CALL_DIGEST_CHARS + QUOTES_AND_COMMA_BYTES;

/** How much of the cache file, which is rewritten at every refresh, the memory of calls may take. */
const CALL_MEMORY_KIBIBYTES = 64;
const CALL_MEMORY_BYTES = CALL_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;

/**
 * The most calls remembered, to tell a call written again from a new one. A resumed session has the history it resumes from written to its transcript again, with the same ids and the original times. A call is a replay when it is remembered, or when it is no newer than the newest call forgotten, which is every call the memory is too short to hold: so the memory's length decides only how far back a call that was never written before can lie and still be read as new, and no replay is ever read as new at any length.
 */
export const MAX_REMEMBERED_CALLS = Math.floor(CALL_MEMORY_BYTES / REMEMBERED_CALL_BYTES);

/** The most distinct skill names, and the most distinct MCP server names, the state keeps, for the same reason. */
export const MAX_TRACKED_NAMES = 256;

/** The most characters of any one text the state keeps (a target, a description, a todo): all of them are cut to a few dozen columns when drawn, and a command or a prompt can be many kilobytes. */
export const MAX_STORED_TEXT_CHARS = 200;

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** How long Claude Code lets a Bash command run when the call names no timeout, and the most it lets one be given: two minutes and ten minutes, the defaults of `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` (https://code.claude.com/docs/en/env-vars). Both can be set in the environment. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** The positive whole number the environment variable `name` holds, else `fallback`. */
function timeoutFromEnv(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * The longest a Bash call can have run and still be taken for running: the larger of the default and the maximum timeout, as the statusline's own environment sets them (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`) or else the documented defaults. A Bash call with no result after that long was cut off without one. Other tools have no such limit: a call that waits for a person (a question, a plan to approve, a permission) is running for as long as the person takes, and what ends one that gets no result is the session going on without it.
 */
export function bashLiveLimitMs(env: Readonly<Record<string, string | undefined>>): number {
  return Math.max(timeoutFromEnv(env, "BASH_DEFAULT_TIMEOUT_MS", BASH_DEFAULT_TIMEOUT_MS), timeoutFromEnv(env, "BASH_MAX_TIMEOUT_MS", BASH_MAX_TIMEOUT_MS));
}

/** The longest an agent can have run without an end and still be taken for running: a day. An agent has no timeout (a foreground one holds the turn open for as long as it runs, and a background one runs until the client announces it finished), so the bound only releases the agents of a session that ended without hearing back from them. */
export const MAX_LIVE_AGENT_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** What the facts need to know to tell a call that is running from one that is not. */
export interface LiveLimits {
  /** The longest a Bash call can have run without a result and still be running; see `bashLiveLimitMs`. */
  readonly bashMs: number;
}

/** The names of the client's tools that start an agent, and that edit a todo list; every other tool is a tool call. */
const AGENT_TOOLS: readonly string[] = ["Task", "Agent"];
const TODO_WRITE_TOOL = "TodoWrite";
const TASK_CREATE_TOOL = "TaskCreate";
const TASK_UPDATE_TOOL = "TaskUpdate";
const SKILL_TOOL = "Skill";
const BASH_TOOL = "Bash";

/** The statuses of an agent call's result that say the agent goes on running after the call returns: started in the background, or spawned as a teammate. */
const STILL_RUNNING_STATUSES: readonly string[] = ["async_launched", "teammate_spawned"];

/** The tool name the client gives a tool of an MCP server: `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/** The announcement of a finished background agent: the client queues a notification naming the task and the tool call that started it. */
const QUEUED_TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const QUEUED_TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;

/** The characters of a tool call's command that identify it; a longer command is cut. */
const COMMAND_TARGET_CHARS = 30;

const ToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** What the call acts on, when its input names one: a file, a pattern, a skill or the start of a command. */
  target: z.string().optional(),
  startedAtMs: z.number().optional(),
  /** When the call's result was written; absent while it has none. */
  endedAtMs: z.number().optional(),
  failed: z.literal(true).optional(),
  /** True once the session wrote its next response with the call still unanswered. A result can still come after that (results are not always written in order), which finishes the call. */
  abandoned: z.literal(true).optional(),
});

const AgentCallSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  /** The model the agent asked to run on, replaced by the one it resolved to when the result says. */
  model: z.string().optional(),
  description: z.string().optional(),
  startedAtMs: z.number().optional(),
  endedAtMs: z.number().optional(),
  /** True for an agent that keeps running after the call that started it has returned; its result comes much earlier than its end. */
  background: z.literal(true).optional(),
  /** As for a tool call: the session wrote its next response with the agent unanswered. */
  abandoned: z.literal(true).optional(),
  /** When the client announced the agent finished, read before the result that says the agent was started in the background; the agent ends then. */
  announcedAtMs: z.number().optional(),
});

/** The outcome of a tool call whose call has not been read yet. A fast tool's result can be written to the file before its call, so the outcome is kept until the call arrives. */
const CallResultSchema = z.strictObject({
  id: z.string(),
  atMs: z.number().optional(),
  failed: z.literal(true).optional(),
  /** The model an agent's result says it ran on. */
  resolvedModel: z.string().optional(),
  /** True when the result says the agent was started in the background. */
  async: z.literal(true).optional(),
  /** The identifier the client gave the task a `TaskCreate` made. */
  taskId: z.string().optional(),
  /** True for the client's announcement that a background agent finished, which can be queued ahead of the call that started the agent; `atMs` is then when the agent ended. */
  announced: z.literal(true).optional(),
});
type CallResult = z.infer<typeof CallResultSchema>;

const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const TodoSchema = z.strictObject({
  content: z.string(),
  status: TodoStatusSchema,
  /** The identifier a later `TaskUpdate` names the item by. The client assigns it, and only the result of the `TaskCreate` that made the item carries it; an item from a `TodoWrite` has none. */
  id: z.string().optional(),
  /** The `TaskCreate` call that made the item while its result has not been read: the item has no identifier yet, is not drawn, and is dropped when the result says the call failed. */
  pendingCallId: z.string().optional(),
});

/**
 * The facts that are the newest value of something, so the end of the transcript settles them whatever came before: the latest tool calls, the latest agents, and the todo list. A list that is edited in place (`TaskCreate`, `TaskUpdate`) depends on what came before, so the end of a transcript settles it only once it holds a `TodoWrite`, which replaces the whole list: `todosReplaced` says one has been read, and `todosEdited` that the list has been edited in place since the start of what was folded.
 */
export const ActivityLatestSchema = z.strictObject({
  tools: z.array(ToolCallSchema),
  agents: z.array(AgentCallSchema),
  todos: z.array(TodoSchema),
  todosReplaced: z.literal(true).optional(),
  /** True once a `TaskCreate` or `TaskUpdate` has been read: the list was edited in place, so a list read from before that is out of date. */
  todosEdited: z.literal(true).optional(),
  /** Results read before their calls, oldest first. */
  unmatchedResults: z.array(CallResultSchema),
  /** The latest calls made, of every kind, oldest first, each as the digest of its id followed by its time in base 36: a call remembered is not made again by a record that repeats it. */
  rememberedCalls: z.array(z.string()),
  /** The time of the newest call forgotten from `rememberedCalls`: a call at or before it is history written again, whatever its id. */
  forgottenUpToMs: z.number().optional(),
  /** The response of the session's latest assistant record, which the records of one response share. A call is made in one response and answered before the next is written, so a call with no result when a response of another key appears was abandoned (an interrupted tool call). */
  responseKey: z.string().optional(),
});
export type ActivityLatest = z.infer<typeof ActivityLatestSchema>;

/** The facts that add up over the whole transcript, so only a read of every record makes them exact: the skills and the MCP servers the session has used, each once, in the order first used. */
const ActivityCumulativeSchema = z.strictObject({
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
});

/** Everything the activity facts are folded from, one transcript record at a time, in the two kinds the facts come in. It is JSON-serialisable, because the statusline is a new process at every refresh and keeps it between them. */
export const ActivityStateSchema = z.strictObject({ cumulative: ActivityCumulativeSchema, latest: ActivityLatestSchema });
export type ActivityState = z.infer<typeof ActivityStateSchema>;

/** The latest-state activity before any record has been read. */
export const EMPTY_ACTIVITY_LATEST: ActivityLatest = { tools: [], agents: [], todos: [], unmatchedResults: [], rememberedCalls: [] };

/** The state before any record has been read. */
export const EMPTY_ACTIVITY_STATE: ActivityState = { cumulative: { skills: [], mcpServers: [] }, latest: EMPTY_ACTIVITY_LATEST };

/** `text` cut to the most characters the state keeps of a text, between characters a person sees. */
function stored(text: string): string {
  return graphemesOf(text.slice(0, MAX_STORED_TEXT_CHARS * 2))
    .slice(0, MAX_STORED_TEXT_CHARS)
    .join("");
}

function stringField(input: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What a tool call acts on, from its input: a file for the tools that read or change one, the pattern of a search, the skill a `Skill` call runs, and the start of a command, with its white space collapsed. */
function targetOf(name: string, input: Readonly<Record<string, unknown>> | undefined): string | undefined {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return stringField(input, "file_path") ?? stringField(input, "path");
    case "Glob":
    case "Grep":
      return stringField(input, "pattern");
    case SKILL_TOOL:
      return stringField(input, "skill");
    case BASH_TOOL: {
      const command = stringField(input, "command")?.replace(/\s+/g, " ").trim();
      if (command === undefined || command === "") {
        return undefined;
      }
      return command.length > COMMAND_TARGET_CHARS ? `${command.slice(0, COMMAND_TARGET_CHARS).trimEnd()}...` : command;
    }
    default:
      return undefined;
  }
}

/** A todo's status as the client may spell it, or undefined for a spelling that is none of them. */
function todoStatusOf(status: unknown): z.infer<typeof TodoStatusSchema> | undefined {
  switch (status) {
    case "pending":
    case "not_started":
      return "pending";
    case "in_progress":
    case "running":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    default:
      return undefined;
  }
}

/** The list `TodoWrite` wrote, with the identifiers of the list it replaces kept on the items that still have their words: an item written again keeps the name later updates know it by, and two items with the same words each keep their own. */
function replacedTodos(previous: readonly z.infer<typeof TodoSchema>[], written: readonly unknown[]): z.infer<typeof TodoSchema>[] {
  const idsByContent = new Map<string, string[]>();
  for (const item of previous) {
    if (item.id !== undefined) {
      idsByContent.set(item.content, [...(idsByContent.get(item.content) ?? []), item.id]);
    }
  }
  return written.slice(-MAX_TRACKED_TODOS).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("content" in entry) || typeof entry.content !== "string") {
      return [];
    }
    const content = stored(entry.content);
    const id = idsByContent.get(content)?.shift();
    const status = "status" in entry ? (todoStatusOf(entry.status) ?? "pending") : "pending";
    return [{ content, status, ...(id === undefined ? {} : { id }) }];
  });
}

/** The item a `TaskUpdate` names, by the identifier the client gave its task. */
function todoIndexOf(todos: readonly z.infer<typeof TodoSchema>[], taskId: unknown): number | undefined {
  if (typeof taskId !== "string" && typeof taskId !== "number") {
    return undefined;
  }
  const index = todos.findIndex((item) => item.id === String(taskId));
  return index === -1 ? undefined : index;
}

interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>> | undefined;
}

/** The todo list after a call to a tool that edits it. A `TaskCreate` adds an item that is not drawn until its result names it: the client assigns the identifier, results come back in any order, and a call that fails makes nothing. A `TaskUpdate` that sets the status `deleted` removes the item, and its description is a detail of the task, not its title. */
function foldTodoCall(state: ActivityLatest, call: ToolUse): ActivityLatest {
  const { input } = call;
  if (call.name === TODO_WRITE_TOOL) {
    const written = input?.todos;
    return Array.isArray(written) ? { ...state, todos: replacedTodos(state.todos, written), todosReplaced: true } : state;
  }
  if (call.name === TASK_CREATE_TOOL) {
    const content = stored(stringField(input, "subject") ?? stringField(input, "description") ?? "Untitled task");
    const status = todoStatusOf(input?.status) ?? "pending";
    return { ...state, todos: [...state.todos, { content, status, pendingCallId: call.id }].slice(-MAX_TRACKED_TODOS), todosEdited: true };
  }
  const index = todoIndexOf(state.todos, input?.taskId);
  const current = index === undefined ? undefined : state.todos[index];
  if (index === undefined || current === undefined) {
    return { ...state, todosEdited: true };
  }
  if (input?.status === "deleted") {
    return { ...state, todos: state.todos.filter((_, at) => at !== index), todosEdited: true };
  }
  const subject = stringField(input, "subject");
  const updated = { ...current, status: todoStatusOf(input?.status) ?? current.status, content: subject === undefined ? current.content : stored(subject) };
  return { ...state, todos: state.todos.map((item, at) => (at === index ? updated : item)), todosEdited: true };
}

/** The digest of a call id, which is all the state keeps of a call it only remembers. */
function digestOf(id: string): string {
  return createHash("sha256").update(id).digest("base64url").slice(0, CALL_DIGEST_CHARS);
}

function rememberedTimeMs(entry: string): number | undefined {
  const time = Number.parseInt(entry.slice(CALL_DIGEST_CHARS), CALL_TIME_RADIX);
  return Number.isNaN(time) ? undefined : time;
}

/** True when the call `id`, written at `atMs`, has been read before: it is remembered, or it is no newer than the newest call forgotten. Either way a record repeating it is history written again. */
function isRemembered(state: ActivityLatest, id: string, atMs: number | undefined): boolean {
  if (atMs !== undefined && state.forgottenUpToMs !== undefined && atMs <= state.forgottenUpToMs) {
    return true;
  }
  const digest = digestOf(id);
  return state.rememberedCalls.some((entry) => entry.startsWith(digest));
}

/** The state remembering the call `id` written at `atMs`; the oldest call remembered is forgotten when the memory is full, and its time becomes the one up to which every call is history. */
function remember(state: ActivityLatest, id: string, atMs: number | undefined): ActivityLatest {
  const all = [...state.rememberedCalls, `${digestOf(id)}${atMs === undefined ? "" : atMs.toString(CALL_TIME_RADIX)}`];
  const forgotten = all.slice(0, -MAX_REMEMBERED_CALLS).flatMap((entry) => rememberedTimeMs(entry) ?? []);
  const forgottenUpToMs = Math.max(state.forgottenUpToMs ?? Number.NEGATIVE_INFINITY, ...forgotten);
  return { ...state, rememberedCalls: all.slice(-MAX_REMEMBERED_CALLS), ...(Number.isFinite(forgottenUpToMs) ? { forgottenUpToMs } : {}) };
}

/** The state after a tool call, and the results that were written ahead of it, applied in the order they were read. */
function foldToolUse(state: ActivityLatest, call: ToolUse, atMs: number | undefined): ActivityLatest {
  const added = foldTrackedCall(state, call, atMs);
  const waiting = added.unmatchedResults.filter((result) => result.id === call.id);
  return waiting.reduce((folded, result) => applyResult(folded, result) ?? folded, { ...added, unmatchedResults: added.unmatchedResults.filter((result) => result.id !== call.id) });
}

/** The state after a tool call: an agent, an edit to the todo list, or a tool call to track. */
function foldTrackedCall(state: ActivityLatest, call: ToolUse, atMs: number | undefined): ActivityLatest {
  if (AGENT_TOOLS.includes(call.name)) {
    const { input } = call;
    const model = stringField(input, "model");
    const description = stringField(input, "description");
    const agent: z.infer<typeof AgentCallSchema> = {
      id: call.id,
      type: stored(stringField(input, "subagent_type") ?? "agent"),
      ...(model === undefined ? {} : { model: stored(model) }),
      ...(description === undefined ? {} : { description: stored(description) }),
      ...(atMs === undefined ? {} : { startedAtMs: atMs }),
      ...(input?.run_in_background === true || input?.run_in_background === "true" ? { background: true as const } : {}),
    };
    return { ...state, agents: [...state.agents, agent].slice(-MAX_TRACKED_AGENTS) };
  }
  if (call.name === TODO_WRITE_TOOL || call.name === TASK_CREATE_TOOL || call.name === TASK_UPDATE_TOOL) {
    return foldTodoCall(state, call);
  }
  const target = targetOf(call.name, call.input);
  const tool: z.infer<typeof ToolCallSchema> = { id: call.id, name: stored(call.name), ...(target === undefined ? {} : { target: stored(target) }), ...(atMs === undefined ? {} : { startedAtMs: atMs }) };
  return { ...state, tools: [...state.tools, tool].slice(-MAX_TRACKED_TOOL_CALLS) };
}

/** The state with `result` applied to the tracked call it answers: the call is finished (a `TaskCreate` that made a task has its identifier, and one that failed leaves no item), and an agent's result may say which model it ran on and that it was started in the background, in which case it has not finished. Undefined when no tracked call has the result's id. */
function applyResult(state: ActivityLatest, result: Readonly<CallResult>): ActivityLatest | undefined {
  const answersAgent = state.agents.some((agent) => agent.id === result.id);
  if (result.announced === true ? !answersAgent : !state.tools.some((tool) => tool.id === result.id) && !answersAgent && !state.todos.some((item) => item.pendingCallId === result.id)) {
    return undefined;
  }
  const tools = state.tools.map((tool) => (tool.id === result.id && result.announced !== true ? { ...tool, ...(result.atMs === undefined ? {} : { endedAtMs: result.atMs }), ...(result.failed === true ? { failed: true as const } : {}) } : tool));
  const agents = state.agents.map((agent) => {
    if (agent.id !== result.id) {
      return agent;
    }
    if (result.announced === true) {
      return result.atMs === undefined ? agent : agent.background === true ? { ...agent, endedAtMs: result.atMs } : { ...agent, announcedAtMs: result.atMs };
    }
    const background = agent.background === true || result.async === true;
    const model = result.resolvedModel === undefined ? agent.model : stored(result.resolvedModel);
    const endedAtMs = background ? agent.announcedAtMs : result.atMs;
    return { ...agent, ...(model === undefined ? {} : { model }), ...(background ? { background: true as const } : {}), ...(endedAtMs === undefined ? {} : { endedAtMs }) };
  });
  // A task made with an identifier the list already has begins a new list: the client numbers from one again once its list is empty, so the earlier tasks are gone.
  const restarted = state.todos.some((item) => item.pendingCallId === result.id && result.failed !== true && result.taskId !== undefined && state.todos.some((other) => other.id === result.taskId));
  const todos = (restarted ? state.todos.filter((item) => item.pendingCallId !== undefined) : state.todos).flatMap((item): z.infer<typeof TodoSchema>[] => {
    if (item.pendingCallId !== result.id) {
      return [item];
    }
    return result.failed === true || result.taskId === undefined ? [] : [{ content: item.content, status: item.status, id: result.taskId }];
  });
  return { ...state, tools, agents, todos };
}

/** The state after a tool call's result: applied to its call, or kept until the call is read when the result was written first. A result of a call that has been read and is no longer tracked is not kept, since no call will come for it. */
function foldToolResult(state: ActivityLatest, result: Readonly<CallResult>): ActivityLatest {
  const applied = applyResult(state, result);
  if (applied !== undefined) {
    return applied;
  }
  return isRemembered(state, result.id, result.atMs) ? state : { ...state, unmatchedResults: [...state.unmatchedResults, result].slice(-MAX_UNMATCHED_RESULTS) };
}

/** What a `TaskCreate` result says: `Task #12 created successfully: ...`, which names the task whatever else the record carries. */
const CREATED_TASK = /^Task #([^\s:]+) created/;

/** The identifier of the task a `TaskCreate` result reports making, from its text or, when the record holds that one result, from the task the client stamps on the record. */
function createdTaskId(content: string | readonly { readonly text?: string | undefined }[] | undefined, outcome: Readonly<NonNullable<TranscriptRecord["toolUseResult"]>> | undefined): string | undefined {
  const text = typeof content === "string" ? content : content?.find((part) => part.text !== undefined)?.text;
  const named = text === undefined ? undefined : CREATED_TASK.exec(text)?.[1];
  const stamped = outcome?.task?.id;
  return named ?? (stamped === undefined ? undefined : String(stamped));
}

/** The state after the client announced a finished background agent. The result of the call that started it was written at launch, so the announcement is what says when it ended. It can be queued ahead of the call, and is then kept until the call arrives. */
function foldAgentAnnouncement(state: ActivityLatest, toolUseId: string, atMs: number): ActivityLatest {
  return foldToolResult(state, { id: toolUseId, atMs, announced: true });
}

/** The calls with no result marked as abandoned, for the agents all but those started in the background, whose result came at launch and whose end is announced. */
function withUnanswered(tools: readonly z.infer<typeof ToolCallSchema>[], agents: readonly z.infer<typeof AgentCallSchema>[]): { readonly tools: z.infer<typeof ToolCallSchema>[]; readonly agents: z.infer<typeof AgentCallSchema>[] } {
  return {
    tools: tools.map((tool) => (tool.endedAtMs === undefined ? { ...tool, abandoned: true as const } : tool)),
    agents: agents.map((agent) => (agent.endedAtMs === undefined && agent.background !== true ? { ...agent, abandoned: true as const } : agent)),
  };
}

/** The state when a new response begins: the calls of the earlier responses that have no result were abandoned (a response is only written once the calls it asked for have answered or been given up, by an interrupt for one). A result written later still finishes a call. */
function foldNewResponse(state: ActivityLatest, key: string): ActivityLatest {
  return { ...state, responseKey: key, ...withUnanswered(state.tools, state.agents) };
}

/** The latest-state activity after one more transcript record, read in file order. The records of a subagent are left out of all of it: they belong to a conversation of its own, whose calls and todo list are not the session's. */
export function foldActivityLatest(state: ActivityLatest, record: TranscriptRecord): ActivityLatest {
  if (record.isSidechain === true) {
    return state;
  }
  const atMs = recordTimeMs(record);
  let next = state;
  if (record.type === "queue-operation" && record.operation === "enqueue" && record.content !== undefined && atMs !== undefined) {
    const toolUseId = QUEUED_TOOL_USE_ID.exec(record.content)?.[1];
    if (toolUseId !== undefined && QUEUED_TASK_ID.test(record.content)) {
      next = foldAgentAnnouncement(next, toolUseId, atMs);
    }
  }
  const responseKey = record.type === "assistant" ? (record.message?.id ?? record.requestId) : undefined;
  if (responseKey !== undefined && responseKey !== next.responseKey) {
    next = next.responseKey === undefined ? { ...next, responseKey } : foldNewResponse(next, responseKey);
  }
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return next;
  }
  // Calls are made in assistant records and answered in user records. Other records can carry copies of both (the client writes the requests it sends to the API as `api-request-blob` records, whose messages hold earlier calls and results again), and a copy is not a second call.
  // The record's own outcome (the model an agent ran on, whether it was started in the background) is its result's only when it holds one result.
  const resultCount = content.filter((block) => block.type === "tool_result").length;
  for (const block of content) {
    if (record.type === "assistant" && block.type === "tool_use" && block.id !== undefined && block.name !== undefined && !isRemembered(next, block.id, atMs)) {
      next = foldToolUse(remember(next, block.id, atMs), { id: block.id, name: block.name, input: block.input }, atMs);
    } else if (record.type === "user" && block.type === "tool_result" && block.tool_use_id !== undefined) {
      const outcome = resultCount === 1 ? record.toolUseResult : undefined;
      const taskId = createdTaskId(block.content, outcome);
      next = foldToolResult(next, {
        id: block.tool_use_id,
        ...(taskId === undefined ? {} : { taskId }),
        ...(atMs === undefined ? {} : { atMs }),
        ...(block.is_error === true ? { failed: true as const } : {}),
        ...(outcome?.resolvedModel === undefined ? {} : { resolvedModel: outcome.resolvedModel }),
        ...(outcome?.isAsync === true || (outcome?.status !== undefined && STILL_RUNNING_STATUSES.includes(outcome.status)) ? { async: true as const } : {}),
      });
    }
  }
  return next;
}

/** `names` with `name` after them, unless it is there already or the list is full. */
function withName(names: readonly string[], name: string | undefined): readonly string[] {
  return name === undefined || name === "" || names.includes(name) || names.length >= MAX_TRACKED_NAMES ? names : [...names, name];
}

/** The cumulative activity after one more transcript record, read in file order. */
function foldActivityCumulative(state: ActivityState["cumulative"], record: TranscriptRecord): ActivityState["cumulative"] {
  const content = record.message?.content;
  if (record.isSidechain === true || record.type !== "assistant" || !Array.isArray(content)) {
    return state;
  }
  let skills: readonly string[] = state.skills;
  let mcpServers: readonly string[] = state.mcpServers;
  for (const block of content) {
    if (block.type !== "tool_use" || block.name === undefined) {
      continue;
    }
    if (block.name === SKILL_TOOL) {
      const skill = stringField(block.input, "skill");
      skills = withName(skills, skill === undefined ? undefined : stored(skill));
    }
    const server = MCP_TOOL_NAME.exec(block.name)?.[1];
    mcpServers = withName(mcpServers, server === undefined ? undefined : stored(server));
  }
  return skills === state.skills && mcpServers === state.mcpServers ? state : { skills: [...skills], mcpServers: [...mcpServers] };
}

/** `state` after one more transcript record, read in file order. */
export function foldActivity(state: ActivityState, record: TranscriptRecord): ActivityState {
  return { cumulative: foldActivityCumulative(state.cumulative, record), latest: foldActivityLatest(state.latest, record) };
}

/** A tool call as the line of tools draws it: finished, failed, or still running. A call that was abandoned, or that is a Bash call with no result after the longest a Bash call can run, is neither, and is not here. */
export interface ToolCallFact {
  readonly name: string;
  readonly target: string | undefined;
  readonly status: "running" | "completed" | "error";
}

export interface AgentFact {
  readonly type: string;
  readonly model: string | undefined;
  readonly description: string | undefined;
  readonly status: "running" | "completed";
  readonly startedAtMs: number | undefined;
  readonly endedAtMs: number | undefined;
}

interface TodoFact {
  readonly content: string;
  readonly status: z.infer<typeof TodoStatusSchema>;
}

/** What the session's transcript says about what the session is doing. Every text is reduced to what a person would see (escape sequences, control characters and characters that draw nothing removed, edge space trimmed), and one that is nothing after that is left out. */
export interface ActivityFacts {
  /** The latest tool calls, oldest first. */
  readonly tools: readonly ToolCallFact[];
  /** The skills the session has used, once each, in the order first used. */
  readonly skills: readonly string[];
  /** The MCP servers the session has used a tool of, once each, in the order first used. */
  readonly mcpServers: readonly string[];
  /** The latest agents, oldest first; one that has had no end for longer than a live one can run is not here. */
  readonly agents: readonly AgentFact[];
  /** The todo list as it stands. */
  readonly todos: readonly TodoFact[];
}

/** The facts of a session that has not done anything yet. */
export const EMPTY_ACTIVITY_FACTS: ActivityFacts = { tools: [], skills: [], mcpServers: [], agents: [], todos: [] };

/** Whether a call started at `startedAtMs` and not yet ended can still be running at `nowMs`, given the longest such a call can run. A call with no start time is given the benefit of the doubt, and one stamped after `nowMs` (clock skew) has run no time at all. */
function isLive(startedAtMs: number | undefined, nowMs: number, maxMs: number): boolean {
  return startedAtMs === undefined || nowMs - startedAtMs <= maxMs;
}

/** The distinct, non-empty visible texts of `names`, in order. */
function visibleNames(names: readonly string[]): string[] {
  return [...new Set(names.map(visibleDisplayText).filter((name) => name !== ""))];
}

/**
 * The facts a state holds at `nowMs`. `newer`, when given, is the latest-state activity folded from the end of the transcript alone while the cumulative facts are still being caught up. The calls the state has read are then not joined to it: they are from an earlier part of the transcript than the end, with the records between not read, and a list joined across that gap would hold calls that never stood side by side. The tools and agents are the end's alone, so they are the latest the session made, as many of them as the end holds; and the todo list is the end's when it holds a `TodoWrite`, which replaces the whole list, and empty otherwise, since a list edited in place cannot be known from its end.
 */
export function activityFactsOf(state: ActivityState, nowMs: number, limits: Readonly<LiveLimits>, newer?: ActivityLatest): ActivityFacts {
  const latest: ActivityLatest =
    newer === undefined ? state.latest : { tools: newer.tools, agents: newer.agents, todos: newer.todosReplaced === true ? newer.todos : [], unmatchedResults: [], rememberedCalls: [] };
  return {
    tools: latest.tools.flatMap((tool): ToolCallFact[] => {
      const name = visibleDisplayText(tool.name);
      const resolved = tool.endedAtMs !== undefined;
      if (name === "" || (!resolved && (tool.abandoned === true || (tool.name === BASH_TOOL && !isLive(tool.startedAtMs, nowMs, limits.bashMs))))) {
        return [];
      }
      const target = tool.target === undefined ? "" : visibleDisplayText(tool.target);
      return [{ name, target: target === "" ? undefined : target, status: !resolved ? "running" : tool.failed === true ? "error" : "completed" }];
    }),
    skills: visibleNames(state.cumulative.skills),
    mcpServers: visibleNames(state.cumulative.mcpServers),
    agents: latest.agents.flatMap((agent): AgentFact[] => {
      const ended = agent.endedAtMs !== undefined;
      if (!ended && (agent.abandoned === true || !isLive(agent.startedAtMs, nowMs, MAX_LIVE_AGENT_MS))) {
        return [];
      }
      const type = visibleDisplayText(agent.type);
      const model = agent.model === undefined ? "" : visibleDisplayText(agent.model);
      const description = agent.description === undefined ? "" : visibleDisplayText(agent.description);
      return [{ type: type === "" ? "agent" : type, model: model === "" ? undefined : model, description: description === "" ? undefined : description, status: ended ? "completed" : "running", startedAtMs: agent.startedAtMs, endedAtMs: agent.endedAtMs }];
    }),
    todos: latest.todos.flatMap((todo) => {
      const content = visibleDisplayText(todo.content);
      return content === "" || todo.pendingCallId !== undefined ? [] : [{ content, status: todo.status }];
    }),
  };
}
