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

/** The most distinct skill names, and the most distinct MCP server names, the state keeps, for the same reason. */
export const MAX_TRACKED_NAMES = 256;

/** The most characters of any one text the state keeps (a target, a description, a todo): all of them are cut to a few dozen columns when drawn, and a command or a prompt can be many kilobytes. */
const MAX_STORED_TEXT_CHARS = 200;

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const TOOL_CALL_MINUTES = 10;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** The longest a tool call can be running and still be taken for live: ten minutes, the most a foreground Bash command may be given (Claude Code's `BASH_MAX_TIMEOUT_MS`), and the longest any other foreground tool call is expected to take. A call with no result after this long was cut off without one (an interrupted or crashed session), and would otherwise show as running for ever. */
export const MAX_LIVE_TOOL_CALL_MS = TOOL_CALL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The longest an agent can be running and still be taken for live: a day. An agent has no timeout (a foreground one holds the turn open for as long as it runs, and a background one runs until the client announces it finished), so the bound only releases the agents of a session that ended without hearing back from them. */
export const MAX_LIVE_AGENT_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The names of the client's tools that start an agent, and that edit a todo list; every other tool is a tool call. */
const AGENT_TOOLS: readonly string[] = ["Task", "Agent"];
const TODO_WRITE_TOOL = "TodoWrite";
const TASK_CREATE_TOOL = "TaskCreate";
const TASK_UPDATE_TOOL = "TaskUpdate";
const SKILL_TOOL = "Skill";

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
});

const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const TodoSchema = z.strictObject({
  content: z.string(),
  status: TodoStatusSchema,
  /** The identifier a later `TaskUpdate` names the item by, when the item was created with one; an item without one is found by its place in the list. */
  id: z.string().optional(),
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
export const EMPTY_ACTIVITY_LATEST: ActivityLatest = { tools: [], agents: [], todos: [] };

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
    case "Bash": {
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

/** The item a `TaskUpdate` names: the one created with that identifier, else the one at that place in the list, counting from one, which is how the client numbers the tasks it creates. */
function todoIndexOf(todos: readonly z.infer<typeof TodoSchema>[], taskId: unknown): number | undefined {
  if (typeof taskId !== "string" && typeof taskId !== "number") {
    return undefined;
  }
  const key = String(taskId);
  const named = todos.findIndex((item) => item.id === key);
  if (named !== -1) {
    return named;
  }
  const position = /^\d+$/.test(key) ? Number.parseInt(key, 10) - 1 : -1;
  return position >= 0 && position < todos.length ? position : undefined;
}

interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>> | undefined;
}

/** The todo list after a call to a tool that edits it, or the state as it was for any other tool. */
function foldTodoCall(state: ActivityLatest, call: ToolUse): ActivityLatest {
  const { input } = call;
  if (call.name === TODO_WRITE_TOOL) {
    const written = input?.todos;
    return Array.isArray(written) ? { ...state, todos: replacedTodos(state.todos, written), todosReplaced: true } : state;
  }
  if (call.name === TASK_CREATE_TOOL) {
    const content = stored(stringField(input, "subject") ?? stringField(input, "description") ?? "Untitled task");
    const given = input?.taskId;
    const id = typeof given === "string" || typeof given === "number" ? String(given) : call.id;
    const status = todoStatusOf(input?.status) ?? "pending";
    return { ...state, todos: [...state.todos, { content, status, id }].slice(-MAX_TRACKED_TODOS), todosEdited: true };
  }
  const index = todoIndexOf(state.todos, input?.taskId);
  const current = index === undefined ? undefined : state.todos[index];
  if (index === undefined || current === undefined) {
    return { ...state, todosEdited: true };
  }
  const subject = stringField(input, "subject") ?? stringField(input, "description");
  const updated = { ...current, status: todoStatusOf(input?.status) ?? current.status, content: subject === undefined ? current.content : stored(subject) };
  return { ...state, todos: state.todos.map((item, at) => (at === index ? updated : item)), todosEdited: true };
}

/** The state after a tool call: an agent, an edit to the todo list, or a tool call to track. */
function foldToolUse(state: ActivityLatest, call: ToolUse, atMs: number | undefined): ActivityLatest {
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
      ...(input?.run_in_background === true ? { background: true as const } : {}),
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

/** The state after a tool call's result: the tracked call it answers is finished, and an agent's result may say which model it ran on and that it was started in the background, in which case it has not finished. */
function foldToolResult(state: ActivityLatest, record: TranscriptRecord, toolUseId: string, failed: boolean, atMs: number | undefined): ActivityLatest {
  const tools = state.tools.map((tool) => (tool.id === toolUseId ? { ...tool, ...(atMs === undefined ? {} : { endedAtMs: atMs }), ...(failed ? { failed: true as const } : {}) } : tool));
  const result = record.toolUseResult;
  const agents = state.agents.map((agent) => {
    if (agent.id !== toolUseId) {
      return agent;
    }
    const background = agent.background === true || result?.isAsync === true || result?.status === "async_launched";
    const model = result?.resolvedModel === undefined ? agent.model : stored(result.resolvedModel);
    return { ...agent, ...(model === undefined ? {} : { model }), ...(background ? { background: true as const } : {}), ...(!background && atMs !== undefined ? { endedAtMs: atMs } : {}) };
  });
  return { ...state, tools, agents };
}

/** The state after the client announced a finished background agent. The result of the call that started it was written at launch, so the announcement is what says when it ended. */
function foldAgentAnnouncement(state: ActivityLatest, toolUseId: string, atMs: number): ActivityLatest {
  return { ...state, agents: state.agents.map((agent) => (agent.id === toolUseId && agent.background === true ? { ...agent, endedAtMs: atMs } : agent)) };
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
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return next;
  }
  for (const block of content) {
    if (block.type === "tool_use" && block.id !== undefined && block.name !== undefined) {
      next = foldToolUse(next, { id: block.id, name: block.name, input: block.input }, atMs);
    } else if (block.type === "tool_result" && block.tool_use_id !== undefined) {
      next = foldToolResult(next, record, block.tool_use_id, block.is_error === true, atMs);
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
  if (record.isSidechain === true || !Array.isArray(content)) {
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

/** A tool call as the line of tools draws it: finished, failed, or still running. A call that has had no result for longer than a live one can take is neither, and is not here. */
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

/** Whether a call started at `startedAtMs` and not yet answered can still be running at `nowMs`, given the longest such a call can run. A call with no start time is given the benefit of the doubt, and one stamped after `nowMs` (clock skew) has run no time at all. */
function isLive(startedAtMs: number | undefined, nowMs: number, maxMs: number): boolean {
  return startedAtMs === undefined || nowMs - startedAtMs <= maxMs;
}

/** The distinct, non-empty visible texts of `names`, in order. */
function visibleNames(names: readonly string[]): string[] {
  return [...new Set(names.map(visibleDisplayText).filter((name) => name !== ""))];
}

/** The calls of `older` followed by those of `newer`. The end of the transcript can reach back over records the state has read already, so a call may be in both; it is then kept once, where `newer` has it, unless only `older` has seen the call's end. */
function followedBy<T extends { readonly id: string; readonly endedAtMs?: number | undefined }>(older: readonly T[], newer: readonly T[]): T[] {
  const olderById = new Map(older.map((call) => [call.id, call]));
  const newerIds = new Set(newer.map((call) => call.id));
  return [
    ...older.filter((call) => !newerIds.has(call.id)),
    ...newer.map((call) => {
      const earlier = olderById.get(call.id);
      return earlier?.endedAtMs !== undefined && call.endedAtMs === undefined ? earlier : call;
    }),
  ];
}

/**
 * The facts a state holds at `nowMs`. `newer`, when given, is the latest-state activity folded from the end of the transcript alone while the cumulative facts are still being caught up: its calls follow the state's, because the end of the transcript is later than anything the state has read, and its todo list replaces the state's once it holds a `TodoWrite`, since a list edited in place cannot be known from its end. A list the end edited in place with no `TodoWrite` before the edits is known to be out of date and not known to be anything else, so it is empty, where a list the end does not touch stands as the state has it.
 */
export function activityFactsOf(state: ActivityState, nowMs: number, newer?: ActivityLatest): ActivityFacts {
  const latest: ActivityLatest =
    newer === undefined
      ? state.latest
      : {
          tools: followedBy(state.latest.tools, newer.tools).slice(-MAX_TRACKED_TOOL_CALLS),
          agents: followedBy(state.latest.agents, newer.agents).slice(-MAX_TRACKED_AGENTS),
          todos: newer.todosReplaced === true ? newer.todos : newer.todosEdited === true ? [] : state.latest.todos,
        };
  return {
    tools: latest.tools.flatMap((tool): ToolCallFact[] => {
      const name = visibleDisplayText(tool.name);
      const resolved = tool.endedAtMs !== undefined;
      if (name === "" || (!resolved && !isLive(tool.startedAtMs, nowMs, MAX_LIVE_TOOL_CALL_MS))) {
        return [];
      }
      const target = tool.target === undefined ? "" : visibleDisplayText(tool.target);
      return [{ name, target: target === "" ? undefined : target, status: !resolved ? "running" : tool.failed === true ? "error" : "completed" }];
    }),
    skills: visibleNames(state.cumulative.skills),
    mcpServers: visibleNames(state.cumulative.mcpServers),
    agents: latest.agents.flatMap((agent): AgentFact[] => {
      const ended = agent.endedAtMs !== undefined;
      if (!ended && !isLive(agent.startedAtMs, nowMs, MAX_LIVE_AGENT_MS)) {
        return [];
      }
      const type = visibleDisplayText(agent.type);
      const model = agent.model === undefined ? "" : visibleDisplayText(agent.model);
      const description = agent.description === undefined ? "" : visibleDisplayText(agent.description);
      return [{ type: type === "" ? "agent" : type, model: model === "" ? undefined : model, description: description === "" ? undefined : description, status: ended ? "completed" : "running", startedAtMs: agent.startedAtMs, endedAtMs: agent.endedAtMs }];
    }),
    todos: latest.todos.flatMap((todo) => {
      const content = visibleDisplayText(todo.content);
      return content === "" ? [] : [{ content, status: todo.status }];
    }),
  };
}
