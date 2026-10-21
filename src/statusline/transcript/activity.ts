import { createHash } from "node:crypto";

import { z } from "zod";

import { graphemesOf } from "../graphemes";
import { visibleDisplayText } from "../sanitise";
import { recordTimeMs, type TranscriptRecord } from "./record";

/**
 * The most tool calls the state keeps: the line of tools shows what the session has just been doing, so older calls are forgotten as newer ones arrive. It is also the most results kept while they wait for their calls. A result is written ahead of its call by a few milliseconds, so only the latest few are really waiting; the others are results (or announcements that a background agent finished) whose call is not in this transcript, because it lies before a compaction or in another one. They are kept like the rest, since the call might still arrive, and leave only when newer ones push them out. A result matters only if its call then stays among the tracked ones, so no more are kept than calls are.
 */
export const MAX_TRACKED_TOOL_CALLS = 20;

/** The most agent calls the state keeps, for the same reason. */
export const MAX_TRACKED_AGENTS = 10;

/** The most items of a todo list the state keeps. A session's list is a handful of items; the bound only stops a runaway one from growing the cache file the statusline rewrites at every refresh, and an item past it is forgotten oldest first. */
export const MAX_TRACKED_TODOS = 200;

const BYTES_PER_KIBIBYTE = 1024;

/** The most characters of any one text the state keeps (a target, a description, a todo): all of them are cut to a few dozen columns when drawn, and a command or a prompt can be many kilobytes. */
export const MAX_STORED_TEXT_CHARS = 200;

/** How much of the cache file, which is rewritten at every refresh, the memory of calls may take in all, and the copies of it the file holds at once: the state's, and the state of the end of the transcript while the state is catching up with it. */
const CALL_MEMORY_KIBIBYTES = 64;
const CALL_MEMORY_BYTES = CALL_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;
const CALL_MEMORY_COPIES = 2;

/** How much of the same cache file the list of calls stamped out of order that the memory forgot may take, counted over the same copies. */
const SKIPPED_MEMORY_KIBIBYTES = 4;
const SKIPPED_MEMORY_BYTES = SKIPPED_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;

/** How much of the cache file each of the two lists of names of one kind may take: the names kept whole, and the digests of the names counted after them. The kinds are the skills used and the MCP servers used. */
const NAME_MEMORY_KIBIBYTES = 16;
const NAME_MEMORY_BYTES = NAME_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;

/** The two quotes and the comma that a string takes in a JSON array, beside the string. */
const QUOTES_AND_COMMA_BYTES = 3;

/** The brackets that enclose a JSON array, and the comma that follows each element but the last. */
const ARRAY_BRACKET_BYTES = 2;
const ARRAY_COMMA_BYTES = 1;

/**
 * The characters a call's time is kept in, in base 36 and padded to a fixed width so that times compare as text. `CALL_TIME_CHARS` characters hold every time below `CALL_TIME_RADIX ** CALL_TIME_CHARS` milliseconds after 1970; a time beyond that or a negative one is kept as none. This many characters are enough for the times of thousands of years, where one fewer would end within the lifetime of the code and make every call untimed from then on, at the cost of one byte in every entry.
 */
const CALL_TIME_CHARS = 9;
const CALL_TIME_RADIX = 36;

/**
 * How unlikely a digest is to lose anything, as powers of two. A digest that matches another by chance makes a genuine call, and the results that wait for it, vanish without a trace, and makes a name uncounted. A session is assumed to make no more than two to the `SESSION_CALLS_BOUND_BITS` new calls (and so new names), far above any session measured, and the chance that it loses even one to a match is held below two to the minus `SESSION_LOSS_TOLERANCE_BITS`: with `entries` the most calls and skipped calls kept, or the most names of one kind counted, that takes more than `SESSION_CALLS_BOUND_BITS + log2(entries) + SESSION_LOSS_TOLERANCE_BITS` bits of digest, which is `DIGEST_BITS_PER_CHAR` bits to the character.
 */
const SESSION_CALLS_BOUND_BITS = 20;
const SESSION_LOSS_TOLERANCE_BITS = 10;
const DIGEST_BITS_PER_CHAR = 6;

/** What one remembered call takes in the cache file for a digest of `digestChars` characters: the digest and the time, the quotes around them and a comma. */
function rememberedCallBytes(digestChars: number): number {
  return digestChars + CALL_TIME_CHARS + QUOTES_AND_COMMA_BYTES;
}

/** How many calls fit the memory of calls for a digest of `digestChars` characters, in all the copies of it the cache file holds. */
function callsRemembered(digestChars: number): number {
  return Math.floor(CALL_MEMORY_BYTES / (CALL_MEMORY_COPIES * rememberedCallBytes(digestChars)));
}

/** How many calls fit the list of skipped calls for a digest of `digestChars` characters, in all the copies of it the cache file holds. */
function callsSkippedAtMost(digestChars: number): number {
  return Math.floor(SKIPPED_MEMORY_BYTES / (CALL_MEMORY_COPIES * rememberedCallBytes(digestChars)));
}

/** How many names of one kind fit the names' memory, counted by a digest of `digestChars` characters. */
function namesCounted(digestChars: number): number {
  return Math.floor(NAME_MEMORY_BYTES / (digestChars + QUOTES_AND_COMMA_BYTES));
}

/**
 * The shortest digest, in characters, of more than `bitsBeyondEntries + log2(entries)` bits, where `entriesAt(chars)` is how many entries fit when the digest has `chars` characters. With that many bits a single new digest matches one of the entries kept by chance with a probability below two to the minus `bitsBeyondEntries`, so over two to the `t` new ones any match has a probability below two to the minus `bitsBeyondEntries - t`.
 */
export function shortestDigestChars(bitsBeyondEntries: number, entriesAt: (chars: number) => number): number {
  let chars = 1;
  while (DIGEST_BITS_PER_CHAR * chars <= bitsBeyondEntries + Math.log2(entriesAt(chars))) {
    chars += 1;
  }
  return chars;
}

/**
 * The characters kept of the digest of a call id or a name. The bounds above are round powers of two, and the shortest digest that satisfies them holds up to `DIGEST_BITS_PER_CHAR` bits more than they need, so a bound moved one power of two either way, or a smaller figure for the entries at the lengths that decide, changes none of the constants derived from this one.
 */
export const CALL_DIGEST_CHARS = shortestDigestChars(SESSION_CALLS_BOUND_BITS + SESSION_LOSS_TOLERANCE_BITS, (chars) => Math.max(callsRemembered(chars) + callsSkippedAtMost(chars), namesCounted(chars)));

/**
 * The largest share of the timed calls remembered after a forgotten call that may be older than it for the call to be in order. A smaller share is safer against being blinded by a clock that ran ahead, since the run must then be longer than one minus the share of the memory, and costs more entries in the list of skipped calls, since a late genuine call or two then makes a forgotten call not in order sooner. A larger share is the reverse.
 */
const MAX_OLDER_SHARE = 0.5;

/**
 * The most calls remembered, to tell a call written again from a new one. A resumed session has the history it resumes from written to its transcript again, with the same ids and the original times. A call is a replay when it is remembered (or was skipped, see `MAX_SKIPPED_CALLS`), or when it is no newer than the newest in-order call forgotten.
 *
 * A forgotten call is in order when no more than `MAX_OLDER_SHARE` of the calls with a time remembered after it are older than it. One that is not, stamped ahead of the calls that followed (by a clock that jumped), would make every genuine call until that time look like a replay, so it moves nothing. A genuine call written late, stamped before calls written before it, is one of the older calls but cannot decide on its own, so it does not hold the floor back.
 *
 * So the memory's length decides only how far back a call that was never written before can lie and still be read as new, and a replay of a call with a time that was in order is never read as new at any length. A call with no time is recognised only while it is remembered.
 *
 * The floor is raised wrongly, and every later genuine call taken for history until real time passes the stamp, only when a forgotten call that was stamped ahead of the genuine calls to come is in order because at least half of the timed calls then remembered are stamped no earlier than it: a clock that ran ahead and came back for more than half as many calls as the memory holds, in one run or in several that are later than the forgotten call. (In a session whose stamps rise, at least half of the calls remembered are always no earlier than the one forgotten, so it is the stamping ahead that carries the condition.) A resumed session can build the same from its replay: ahead calls forgotten while the list of skipped calls was full are read as new when the history is written again, and enter the memory with their stamps. Recognising every skipped call exactly cannot be bounded. A bounded alternative exists, which sends a forgotten call stamped at or after the time of the read to the list of skipped calls; it was not adopted because the fold, and so the content of the cache, would then depend on when the bytes were read.
 */
export const MAX_REMEMBERED_CALLS = callsRemembered(CALL_DIGEST_CHARS);

/** The most forgotten calls that were not in order the state remembers beside the others, by digest and time, so that their replays are recognised too: without them a replay of such a call is read as new, and one that rewrites the todo list would put an old list over the current one. Such calls are rare, so the room is small; when it is full the oldest is let go, and its replay is then read as new again. One whose time the floor has passed needs no room, since the floor recognises it. */
export const MAX_SKIPPED_CALLS = callsSkippedAtMost(CALL_DIGEST_CHARS);

/** The most names of each kind counted after those kept whole, each by its digest. A session that used more has a count that is a floor, and says so. */
export const MAX_COUNTED_NAMES = namesCounted(CALL_DIGEST_CHARS);

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
  /** The kind of agent the call asked for; absent when the call names none, which the row draws as its own word. */
  type: z.string().optional(),
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
  /** The latest calls made, of every kind, oldest first, each as the digest of its id followed by its time in `CALL_TIME_CHARS` characters of base 36, or nothing when it has none: a call remembered is not made again by a record that repeats it. */
  rememberedCalls: z.array(z.string()),
  /** The forgotten calls that were stamped out of order, in the form of `rememberedCalls`, kept while the floor has not passed them. */
  skippedCalls: z.array(z.string()),
  /** The time of the newest in-order call forgotten from `rememberedCalls`: a call at or before it is history written again, whatever its id. */
  forgottenUpToMs: z.number().optional(),
  /** The response of the session's latest assistant record, which the records of one response share. A call is made in one response and answered before the next is written, so a call with no result when a response of another key appears was abandoned (an interrupted tool call). */
  responseKey: z.string().optional(),
});
export type ActivityLatest = z.infer<typeof ActivityLatestSchema>;

/** The distinct names of one kind used, in the order first used: the first few whole, for the rows to draw, and the digests of the rest, for the count. */
const NameSetSchema = z.strictObject({
  names: z.array(z.string()),
  others: z.array(z.string()),
  /** True once a name was used that the digests had no room for: the count is then a floor. */
  overflowed: z.literal(true).optional(),
});
type NameSet = z.infer<typeof NameSetSchema>;

/** The facts that add up over the whole transcript, so only a read of every record makes them exact: the skills and the MCP servers the session has used, each once, in the order first used. */
const ActivityCumulativeSchema = z.strictObject({
  skills: NameSetSchema,
  mcpServers: NameSetSchema,
});

/** Everything the activity facts are folded from, one transcript record at a time, in the two kinds the facts come in. It is JSON-serialisable, because the statusline is a new process at every refresh and keeps it between them. */
export const ActivityStateSchema = z.strictObject({ cumulative: ActivityCumulativeSchema, latest: ActivityLatestSchema });
export type ActivityState = z.infer<typeof ActivityStateSchema>;

const EMPTY_NAME_SET: NameSet = { names: [], others: [] };

/** The latest-state activity before any record has been read. */
export const EMPTY_ACTIVITY_LATEST: ActivityLatest = { tools: [], agents: [], todos: [], unmatchedResults: [], rememberedCalls: [], skippedCalls: [] };

/** The state before any record has been read. */
export const EMPTY_ACTIVITY_STATE: ActivityState = { cumulative: { skills: EMPTY_NAME_SET, mcpServers: EMPTY_NAME_SET }, latest: EMPTY_ACTIVITY_LATEST };

/** `text` cut to the most characters the state keeps of a text, between characters a person sees. The cut to twice that many code units first only bounds the work of finding the characters, since a character takes one or two units in nearly every text: any larger multiple gives the same result. */
function stored(text: string): string {
  return graphemesOf(text.slice(0, MAX_STORED_TEXT_CHARS * 2))
    .slice(0, MAX_STORED_TEXT_CHARS)
    .join("");
}

/**
 * The field `key` of `input` when it is a string with characters, else nothing. An empty string reads as absent, so `??` and `||` fall back the same at every call site.
 */
function stringField(input: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What a tool call acts on, from its input: a file for the tools that read or change one, the pattern of a search, the skill a `Skill` call runs, and a command, with its white space collapsed. The row cuts what it draws to the width it has; the state keeps the text whole, up to the cap on any stored text. */
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
      return command;
    }
    default:
      return undefined;
  }
}

/**
 * A todo's status as the client may spell it, or undefined for a spelling that is none of them. The word it gives is never empty, so `??` and `||` fall back the same at every fallback on it.
 */
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
  // The list found is an array or nothing, and an array is true however empty, so either way of falling back reads the same.
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
    const content = stored(stringField(input, "subject") ?? stringField(input, "description") ?? "");
    const status = todoStatusOf(input?.status) ?? "pending";
    return { ...state, todos: [...state.todos, { content, status, pendingCallId: call.id }].slice(-MAX_TRACKED_TODOS), todosEdited: true };
  }
  const index = todoIndexOf(state.todos, input?.taskId);
  const current = index === undefined ? undefined : state.todos[index];
  // `current` is undefined exactly when `index` is, so either test alone decides; both are written for the types.
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

/** The digest of a call id or a name, which is all the state keeps of one it only counts. */
function digestOf(id: string): string {
  return createHash("sha256").update(id).digest("base64url").slice(0, CALL_DIGEST_CHARS);
}

/** A call's time as it is kept in a memory entry: fixed width so that times compare as text, and nothing for a time that is unknown or does not fit. */
function timeKeyOf(atMs: number | undefined): string {
  const key = atMs === undefined || atMs < 0 ? "" : atMs.toString(CALL_TIME_RADIX);
  return key.length > CALL_TIME_CHARS ? "" : key.padStart(key === "" ? 0 : CALL_TIME_CHARS, "0");
}

const timeKeyOfEntry = (entry: string): string => entry.slice(CALL_DIGEST_CHARS);

/** True when the call `id`, written at `atMs`, has been read before: it is remembered or skipped, or it is no newer than the newest in-order call forgotten. Either way a record repeating it is history written again. */
function isRemembered(state: ActivityLatest, id: string, atMs: number | undefined): boolean {
  if (atMs !== undefined && state.forgottenUpToMs !== undefined && atMs <= state.forgottenUpToMs) {
    return true;
  }
  const digest = digestOf(id);
  return state.rememberedCalls.some((entry) => entry.startsWith(digest)) || state.skippedCalls.some((entry) => entry.startsWith(digest));
}

/** The entries that the floor has not passed, which are the ones the floor does not recognise already. */
function beyondFloor(entries: readonly string[], floorMs: number | undefined): string[] {
  return entries.filter((entry) => floorMs === undefined || Number.parseInt(timeKeyOfEntry(entry), CALL_TIME_RADIX) > floorMs);
}

/**
 * The state remembering the call `id` written at `atMs`. When the memory is full the oldest call remembered is forgotten, and it has a time to give. If it was in order, that time becomes the one up to which every call is history; if not, its digest and time are kept apart, so that a replay of it is still recognised.
 *
 * Neither "no newer than every call remembered after it" nor the same capped at the oldest call remembered is used for in order. Each tells a call stamped ahead from the rest as well as this does, but one genuine call written late, stamped before the calls ahead of it, then holds the floor back for as long as it is remembered: the calls forgotten meanwhile are skipped, and when they are replayed they are read as new and enter the memory with their old times, which keeps the floor back and pushes genuine entries out. Counting how many are older makes a few late or ahead calls unable to decide.
 */
function remember(state: ActivityLatest, id: string, atMs: number | undefined): ActivityLatest {
  const all = [...state.rememberedCalls, `${digestOf(id)}${timeKeyOf(atMs)}`];
  const kept = all.slice(-MAX_REMEMBERED_CALLS);
  const [forgotten] = all.slice(0, -MAX_REMEMBERED_CALLS);
  const forgottenKey = forgotten === undefined ? "" : timeKeyOfEntry(forgotten);
  if (forgotten === undefined || forgottenKey === "") {
    return { ...state, rememberedCalls: kept };
  }
  const keptTimes = kept.map(timeKeyOfEntry).filter((key) => key !== "");
  if (keptTimes.filter((key) => key < forgottenKey).length <= keptTimes.length * MAX_OLDER_SHARE) {
    // The fallback only lowers the maximum and a kept time is never negative, so a remembered floor of zero would give the same maximum as none.
    const forgottenUpToMs = Math.max(state.forgottenUpToMs ?? Number.NEGATIVE_INFINITY, Number.parseInt(forgottenKey, CALL_TIME_RADIX));
    return { ...state, rememberedCalls: kept, skippedCalls: beyondFloor(state.skippedCalls, forgottenUpToMs), forgottenUpToMs };
  }
  return { ...state, rememberedCalls: kept, skippedCalls: beyondFloor([...state.skippedCalls, forgotten], state.forgottenUpToMs).slice(-MAX_SKIPPED_CALLS) };
}

/** The latest-state activity before any record has been read, remembering the calls `earlier` has: for folding a later part of the transcript on its own, so that the history it repeats from the part `earlier` was folded from is not read as new. */
export function replayMemoryOf(earlier: ActivityLatest): ActivityLatest {
  return { ...EMPTY_ACTIVITY_LATEST, rememberedCalls: earlier.rememberedCalls, skippedCalls: earlier.skippedCalls, ...(earlier.forgottenUpToMs === undefined ? {} : { forgottenUpToMs: earlier.forgottenUpToMs }) };
}

/** The state after a tool call, and the results that were written ahead of it, applied in the order they were read. */
function foldToolUse(state: ActivityLatest, call: ToolUse, atMs: number | undefined): ActivityLatest {
  const added = foldTrackedCall(state, call, atMs);
  const waiting = added.unmatchedResults.filter((result) => result.id === call.id);
  // A fold's state is an object, never a falsy value, so `||` would keep the same state.
  return waiting.reduce((folded, result) => applyResult(folded, result) ?? folded, { ...added, unmatchedResults: added.unmatchedResults.filter((result) => result.id !== call.id) });
}

/** The state after a tool call: an agent, an edit to the todo list, or a tool call to track. */
function foldTrackedCall(state: ActivityLatest, call: ToolUse, atMs: number | undefined): ActivityLatest {
  if (AGENT_TOOLS.includes(call.name)) {
    const { input } = call;
    const type = stringField(input, "subagent_type");
    const model = stringField(input, "model");
    const description = stringField(input, "description");
    const agent: z.infer<typeof AgentCallSchema> = {
      id: call.id,
      ...(type === undefined ? {} : { type: stored(type) }),
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
  const tools = state.tools.map((tool) => (tool.id === result.id ? { ...tool, ...(result.atMs === undefined ? {} : { endedAtMs: result.atMs }), ...(result.failed === true ? { failed: true as const } : {}) } : tool));
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
  return isRemembered(state, result.id, result.atMs) ? state : { ...state, unmatchedResults: [...state.unmatchedResults, result].slice(-MAX_TRACKED_TOOL_CALLS) };
}

/** What a `TaskCreate` result says: `Task #12 created successfully: ...`, which names the task whatever else the record carries. */
const CREATED_TASK = /^Task #([^\s:]+) created/;

/** The identifier of the task a `TaskCreate` result reports making, from its text or, when the record holds that one result, from the task the client stamps on the record. */
function createdTaskId(content: string | readonly { readonly text?: string | undefined }[] | undefined, outcome: Readonly<NonNullable<TranscriptRecord["toolUseResult"]>> | undefined): string | undefined {
  const text = typeof content === "string" ? content : content?.find((part) => part.text !== undefined)?.text;
  const named = text === undefined ? undefined : CREATED_TASK.exec(text)?.[1];
  const stamped = outcome?.task?.id;
  // The pattern's capture is at least one character, so a name found in the text is never empty and `||` would read the same.
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
  // The schema's least message id is one character, so an empty one is already absent and `||` would read the same.
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

/** What a name takes in the cache file as an element of a JSON array: its quoted text in UTF-8, escapes included, and the comma. */
function nameBytes(name: string): number {
  return Buffer.byteLength(JSON.stringify([name])) - ARRAY_BRACKET_BYTES + ARRAY_COMMA_BYTES;
}

/** `set` with `name` counted: kept whole while no name has gone to a digest and the names kept whole have room in bytes, else by its digest, and noted as overflowed when the digests are full too. A name used before changes nothing. Names are cut to the cap on any stored text, which in UTF-8 and with escapes is many times as many bytes, so the room is counted in bytes. */
function withName(set: NameSet, name: string | undefined): NameSet {
  if (name === undefined || name === "" || set.names.includes(name)) {
    return set;
  }
  if (set.others.length === 0 && set.names.reduce((total, kept) => total + nameBytes(kept), nameBytes(name)) <= NAME_MEMORY_BYTES) {
    return { ...set, names: [...set.names, name] };
  }
  const digest = digestOf(name);
  if (set.others.includes(digest)) {
    return set;
  }
  if (set.others.length >= MAX_COUNTED_NAMES) {
    return set.overflowed === true ? set : { ...set, overflowed: true };
  }
  return { ...set, others: [...set.others, digest] };
}

/** The cumulative activity after one more transcript record, read in file order. */
function foldActivityCumulative(state: ActivityState["cumulative"], record: TranscriptRecord): ActivityState["cumulative"] {
  const content = record.message?.content;
  if (record.isSidechain === true || record.type !== "assistant" || !Array.isArray(content)) {
    return state;
  }
  let { skills, mcpServers } = state;
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
  return skills === state.skills && mcpServers === state.mcpServers ? state : { skills, mcpServers };
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
  readonly type: string | undefined;
  readonly model: string | undefined;
  readonly description: string | undefined;
  readonly status: "running" | "completed";
  readonly startedAtMs: number | undefined;
  readonly endedAtMs: number | undefined;
}

interface TodoFact {
  readonly content: string | undefined;
  readonly status: z.infer<typeof TodoStatusSchema>;
}

/** The names of one kind used in a session, as many of the first as the state keeps whole, and how many there are: `exact` is false when the state had no room to count them all, so the total is a floor. */
export interface NamesFact {
  readonly names: readonly string[];
  readonly total: number;
  readonly exact: boolean;
}

/** What the session's transcript says about what the session is doing. Every text is reduced to what a person would see (escape sequences, control characters and characters that draw nothing removed, edge space trimmed), and one that is nothing after that is left out. */
export interface ActivityFacts {
  /** The latest tool calls, oldest first. */
  readonly tools: readonly ToolCallFact[];
  /** The skills the session has used, once each, in the order first used. */
  readonly skills: NamesFact;
  /** The MCP servers the session has used a tool of, once each, in the order first used. */
  readonly mcpServers: NamesFact;
  /** The latest agents, oldest first; one that has had no end for longer than a live one can run is not here. */
  readonly agents: readonly AgentFact[];
  /** The todo list as it stands. */
  readonly todos: readonly TodoFact[];
}

/** The facts of a session that has not done anything yet. */
export const EMPTY_ACTIVITY_FACTS: ActivityFacts = { tools: [], skills: { names: [], total: 0, exact: true }, mcpServers: { names: [], total: 0, exact: true }, agents: [], todos: [] };

/** Whether a call started at `startedAtMs` and not yet ended can still be running at `nowMs`, given the longest such a call can run. A call with no start time is given the benefit of the doubt, and one stamped after `nowMs` (clock skew) has run no time at all. */
function isLive(startedAtMs: number | undefined, nowMs: number, maxMs: number): boolean {
  return startedAtMs === undefined || nowMs - startedAtMs <= maxMs;
}

/** The names of `set` as a person sees them, the distinct non-empty ones in order, with the count of all the names. */
function visibleNames(set: NameSet): NamesFact {
  const names = [...new Set(set.names.map((name) => visibleDisplayText(name)).filter((name) => name !== ""))];
  return { names, total: names.length + set.others.length, exact: set.overflowed !== true };
}

/**
 * The facts a state holds at `nowMs`. `newer`, when given, is the latest-state activity folded from the end of the transcript alone while the cumulative facts are still being caught up. The calls the state has read are then not joined to it: they are from an earlier part of the transcript than the end, with the records between not read, and a list joined across that gap would hold calls that never stood side by side. The tools and agents are the end's alone, so they are the latest the session made, as many of them as the end holds; and the todo list is the end's when it holds a `TodoWrite`, which replaces the whole list, and empty otherwise, since a list edited in place cannot be known from its end.
 */
export function activityFactsOf(state: ActivityState, nowMs: number, limits: Readonly<LiveLimits>, newer?: ActivityLatest): ActivityFacts {
  const latest: ActivityLatest =
    newer === undefined ? state.latest : { tools: newer.tools, agents: newer.agents, todos: newer.todosReplaced === true ? newer.todos : [], unmatchedResults: [], rememberedCalls: [], skippedCalls: [] };
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
      const type = agent.type === undefined ? "" : visibleDisplayText(agent.type);
      const model = agent.model === undefined ? "" : visibleDisplayText(agent.model);
      const description = agent.description === undefined ? "" : visibleDisplayText(agent.description);
      return [{ type: type === "" ? undefined : type, model: model === "" ? undefined : model, description: description === "" ? undefined : description, status: ended ? "completed" : "running", startedAtMs: agent.startedAtMs, endedAtMs: agent.endedAtMs }];
    }),
    todos: latest.todos.flatMap((todo) => {
      const content = visibleDisplayText(todo.content);
      return todo.pendingCallId !== undefined ? [] : [{ content: content === "" ? undefined : content, status: todo.status }];
    }),
  };
}
