import { describe, expect, it } from "vitest";

import {
  ActivityStateSchema,
  MAX_LIVE_AGENT_MS,
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  bashLiveLimitMs,
  MAX_STORED_TEXT_CHARS,
  MAX_TRACKED_AGENTS,
  MAX_COUNTED_NAMES,
  MAX_TRACKED_TODOS,
  MAX_TRACKED_TOOL_CALLS,
} from "./activity";

import { STEP, BYTES_PER_KIBIBYTE, NAMES_THAT_OVERFILL, NAME_MEMORY_KIBIBYTES, isRecord, at, use, result, fold, factsAt } from "./activityTesting";

/** What the state keeps of each kind of fact, which the tools line, the agents lines and the todo list are drawn from. */
const TRACKED_TOOLS = 20;
const TRACKED_AGENTS = 10;
const TRACKED_TODOS = 200;
const STORED_TEXT_CHARS = 200;
/** A name of sixty-one characters takes sixty-four bytes in the cache file, so the budget holds an exact number of them. */
const SIXTY_ONE_CHARS = 61;
const SIXTY_FOUR_BYTES = 64;
const SIX_DIGITS = 6;
/** Values a TodoWrite entry may hold that are not an object, and a content that is not text. */
const NOT_AN_OBJECT = 5;
const NOT_A_TEXT = 3;
const NAME_ROOM_BYTES_FOR_TESTS = NAME_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;
/** Two minutes, ten minutes and a day in milliseconds, which Claude Code's documented defaults and the longest an agent is believed to run are stated as. */
const TWO_MINUTES_MS = 120_000;
const TEN_MINUTES_MS = 600_000;
const ONE_DAY_MS = 86_400_000;

describe("the state the cache keeps", () => {
  const announcement = (toolUseId: string, ms: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at(ms),
    content: `<task-notification><task-id>t</task-id><tool-use-id>${toolUseId}</tool-use-id></task-notification>`,
    ...overrides,
  });
  const withResponse = (key: string, record: Record<string, unknown>): Record<string, unknown> => ({ ...record, message: { ...(isRecord(record.message) ? record.message : {}), id: key } });

  it("reads back from the cache file as it was written, with every flag the fold sets", () => {
    const records = [
      withResponse("r1", use("failing", "Read", {}, 1)),
      result("failing", 2, true),
      withResponse("r1", use("silent", "Edit", {}, STEP.third)),
      withResponse("r1", use("bg", "Agent", { subagent_type: "x", run_in_background: true }, STEP.third)),
      withResponse("r2", use("next", "Grep", {}, STEP.fourth)),
      result("orphan", STEP.fifth, false, { toolUseResult: { isAsync: true } }),
      announcement("orphan-agent", STEP.sixth),
      use("w", "TodoWrite", { todos: [{ content: "a", status: "pending" }] }, STEP.ninth),
      use("c", "TaskCreate", { subject: "b" }, STEP.ninth + 1),
    ];
    const state = fold(records);
    const { latest } = state;
    expect(latest.tools.map((tool) => [tool.failed, tool.abandoned])).toEqual([[true, undefined], [undefined, true], [undefined, undefined]]);
    expect(latest.agents[0]?.background).toBe(true);
    expect(latest.unmatchedResults.map((unmatched) => [unmatched.async, unmatched.announced])).toEqual([[true, undefined], [undefined, true]]);
    expect(latest).toMatchObject({ todosReplaced: true, todosEdited: true });
    expect(ActivityStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("reads back an abandoned agent and a state whose name lists overflowed", () => {
    const names = Array.from({ length: MAX_COUNTED_NAMES + NAMES_THAT_OVERFILL }, (_, index) => use(`s${String(index)}`, "Skill", { skill: `${"n".repeat(MAX_STORED_TEXT_CHARS - SIX_DIGITS)}${String(index).padStart(SIX_DIGITS, "0")}` }));
    const state = fold([withResponse("r1", use("fg", "Agent", { subagent_type: "x" }, 1)), withResponse("r2", use("next", "Glob", {}, 2)), ...names]);
    expect(state.latest.agents[0]?.abandoned).toBe(true);
    expect(state.cumulative.skills.overflowed).toBe(true);
    expect(ActivityStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("marks the list as edited in place by every edit to it, and as replaced only by a TodoWrite", () => {
    const created = [use("c", "TaskCreate", { subject: "x" }, 1), { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Task #1 created" }] } }];
    const edited = (records: readonly Record<string, unknown>[]): boolean | undefined => fold(records).latest.todosEdited;
    expect(edited([use("c", "TaskCreate", { subject: "x" })])).toBe(true);
    expect(edited([...created, use("u", "TaskUpdate", { taskId: "1", status: "completed" }, 2)])).toBe(true);
    expect(edited([...created, use("u", "TaskUpdate", { taskId: "1", status: "deleted" }, 2)])).toBe(true);
    expect(edited([...created, use("u", "TaskUpdate", { taskId: "9", status: "completed" }, 2)])).toBe(true);
    expect(edited([use("w", "TodoWrite", { todos: [] })])).toBeUndefined();
    expect(fold([use("c", "TaskCreate", { subject: "x" })]).latest.todosReplaced).toBeUndefined();
  });

  it("takes a task's identifier from the first text part of a result that has several parts, or from a plain text result", () => {
    const task = (content: unknown): string[] => {
      const records = [use("c", "TaskCreate", { subject: "x" }, 1), { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "c", content }] } }, use("u", "TaskUpdate", { taskId: "7", status: "completed" }, 2)];
      return factsAt(records).todos.map((todo) => `${todo.content ?? ""}:${todo.status}`);
    };
    expect(task([{ type: "image" }, { type: "text", text: "Task #7 created" }])).toEqual(["x:completed"]);
    expect(task("Task #7 created")).toEqual(["x:completed"]);
    expect(task([{ type: "text", text: "no task here" }])).toEqual([]);
    expect(task(undefined)).toEqual([]);
  });

  it("ends a background agent only by an enqueue announcement of the task, with a time", () => {
    const launched = [use("bg", "Agent", { subagent_type: "x", run_in_background: true }, 0), result("bg", 1, false, { toolUseResult: { isAsync: true } })];
    const status = (extra: Record<string, unknown>): string | undefined => factsAt([...launched, announcement("bg", STEP.third, extra)]).agents[0]?.status;
    expect(status({})).toBe("completed");
    expect(status({ type: "user" })).toBe("running");
    expect(status({ operation: "dequeue" })).toBe("running");
    expect(status({ content: undefined })).toBe("running");
    expect(status({ timestamp: undefined })).toBe("running");
    expect(status({ content: "<tool-use-id>bg</tool-use-id>" })).toBe("running");
    expect(status({ content: "<task-id>t</task-id>" })).toBe("running");
  });

  it("reads a result only from a user record and a call only from an assistant record", () => {
    const calls = (type: string): string[] =>
      factsAt([use("a", "Read", {}, 1), { type, timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "a", content: "done" }, { type: "tool_use", id: "b", name: "Grep", input: {} }] } }]).tools.map((tool) => `${tool.name}:${tool.status}`);
    expect(calls("user")).toEqual(["Read:completed"]);
    expect(calls("assistant")).toEqual(["Read:running", "Grep:running"]);
    expect(calls("api-request-blob")).toEqual(["Read:running"]);
  });

  it("holds the constants that time is measured by to what they are documented to be", () => {
    expect(bashLiveLimitMs({})).toBe(BASH_MAX_TIMEOUT_MS);
    expect(BASH_DEFAULT_TIMEOUT_MS).toBe(TWO_MINUTES_MS);
    expect(BASH_MAX_TIMEOUT_MS).toBe(TEN_MINUTES_MS);
    expect(MAX_LIVE_AGENT_MS).toBe(ONE_DAY_MS);
  });
});

describe("what the fold takes from the input of a call", () => {
  it("reads a field that is an empty string, or not a string, as absent", () => {
    expect(factsAt([use("a", "Agent", { subagent_type: "", model: 5, description: "" })]).agents).toMatchObject([{ type: undefined, model: undefined, description: undefined }]);
    expect(factsAt([use("a", "Read", { file_path: 42 })]).tools[0]?.target).toBeUndefined();
    expect(factsAt([use("a", "Read", { file_path: "" })]).tools[0]?.target).toBeUndefined();
  });

  it("reads a command of white space alone as no target", () => {
    expect(fold([use("a", "Bash", { command: " \n\t " })]).latest.tools[0]).not.toHaveProperty("target");
  });

  it("leaves out the entries of a TodoWrite that are not objects with a text of their own", () => {
    const todos = [null, NOT_AN_OBJECT, "text", {}, { content: NOT_A_TEXT }, { status: "pending" }, { content: "kept", status: "completed" }];
    expect(factsAt([use("w", "TodoWrite", { todos })]).todos).toEqual([{ content: "kept", status: "completed" }]);
  });

  it("holds the limits on what the state keeps to what they are documented to be", () => {
    expect([MAX_TRACKED_TOOL_CALLS, MAX_TRACKED_AGENTS, MAX_TRACKED_TODOS, MAX_STORED_TEXT_CHARS]).toEqual([TRACKED_TOOLS, TRACKED_AGENTS, TRACKED_TODOS, STORED_TEXT_CHARS]);
  });
});

describe("the cases the fold's guards are for", () => {
  const taskCreated = (callId: string, subject: string, taskId: string, ms: number): Record<string, unknown>[] => [
    use(callId, "TaskCreate", { subject }, ms),
    { type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: callId, content: `Task #${taskId} created successfully: ${subject}` }] } },
  ];
  const todoTexts = (records: readonly Record<string, unknown>[]): string[] => factsAt(records).todos.map((todo) => `${todo.content ?? ""}:${todo.status}`);

  it("reads the timeouts from the environment only when they are whole numbers above zero", () => {
    expect(bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: "1", BASH_DEFAULT_TIMEOUT_MS: "1" })).toBe(1);
    for (const value of ["0", "-5", "2.5", "many", ""]) {
      expect(bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: value, BASH_DEFAULT_TIMEOUT_MS: value }), value).toBe(BASH_MAX_TIMEOUT_MS);
    }
  });

  it("keeps a text of characters that take two code units whole up to the cap", () => {
    const emoji = "\u{1F600}".repeat(MAX_STORED_TEXT_CHARS);
    expect(factsAt([use("a", "Bash", { command: emoji })]).tools[0]?.target).toBe(emoji);
  });

  it("names a task by a number as well as by text in an update, and ignores any other kind of name", () => {
    const created = taskCreated("c", "x", "1", 1);
    expect(todoTexts([...created, use("u", "TaskUpdate", { taskId: 1, status: "completed" }, 2)])).toEqual(["x:completed"]);
    expect(todoTexts([...created, use("u", "TaskUpdate", { taskId: true, status: "completed" }, 2)])).toEqual(["x:pending"]);
    expect(todoTexts([...created, use("u", "TaskUpdate", { status: "completed" }, 2)])).toEqual(["x:pending"]);
  });

  it("does not end a tool call by the announcement of a background agent, which only agents have", () => {
    expect(factsAt([use("t", "Bash", {}, 1), { type: "queue-operation", operation: "enqueue", timestamp: at(2), content: "<task-id>k</task-id><tool-use-id>t</tool-use-id>" }]).tools.map((tool) => tool.status)).toEqual(["running"]);
  });

  it("does not start a new list for a result of another call that happens to name a task the list has", () => {
    const earlier = taskCreated("c1", "first", "1", 1);
    const misleading = { type: "user", timestamp: at(STEP.fourth), message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "Task #1 created" }] } };
    expect(todoTexts([...earlier, use("bash", "Bash", {}, STEP.third), use("c4", "TaskCreate", { subject: "fourth" }, STEP.third), misleading])).toEqual(["first:pending"]);
  });

  it("starts a new list only when a task that was made gets an identifier the list has, and not when the call failed or the result belongs to another call", () => {
    const earlier = [...taskCreated("c1", "first", "1", 1), ...taskCreated("c2", "second", "2", 2)];
    expect(todoTexts([...earlier, ...taskCreated("c3", "third", "1", STEP.third)])).toEqual(["third:pending"]);
    expect(todoTexts([...earlier, ...taskCreated("c3", "third", "3", STEP.third)])).toEqual(["first:pending", "second:pending", "third:pending"]);
    const failed = [use("c3", "TaskCreate", { subject: "third" }, STEP.third), { type: "user", timestamp: at(STEP.third), message: { content: [{ type: "tool_result", tool_use_id: "c3", is_error: true, content: "Task #1 created" }] } }];
    expect(todoTexts([...earlier, ...failed])).toEqual(["first:pending", "second:pending"]);
    const other = { type: "user", timestamp: at(STEP.fourth), message: { content: [{ type: "tool_result", tool_use_id: "elsewhere", content: "Task #1 created" }] } };
    expect(todoTexts([...earlier, use("c4", "TaskCreate", { subject: "fourth" }, STEP.third), other])).toEqual(["first:pending", "second:pending"]);
  });

  it("keeps the names that fit the byte budget exactly, and no name that does not", () => {
    const names = Array.from({ length: NAME_ROOM_BYTES_FOR_TESTS / SIXTY_FOUR_BYTES + 1 }, (_, index) => `${"n".repeat(SIXTY_ONE_CHARS - SIX_DIGITS)}${String(index).padStart(SIX_DIGITS, "0")}`);
    const kept = fold(names.map((name, index) => use(`s${String(index)}`, "Skill", { skill: name }))).cumulative.skills;
    expect(kept.names).toHaveLength(NAME_ROOM_BYTES_FOR_TESTS / SIXTY_FOUR_BYTES);
    expect(kept.others).toHaveLength(1);
  });

  it("hands back the same name list when a name arrives after the digests are full, as nothing changes", () => {
    const names = Array.from({ length: MAX_COUNTED_NAMES + NAMES_THAT_OVERFILL }, (_, index) => use(`s${String(index)}`, "Skill", { skill: `${"n".repeat(MAX_STORED_TEXT_CHARS - SIX_DIGITS)}${String(index).padStart(SIX_DIGITS, "0")}` }));
    const full = fold(names);
    expect(full.cumulative.skills.overflowed).toBe(true);
    expect(fold([use("more", "Skill", { skill: "one more" })], full).cumulative.skills).toBe(full.cumulative.skills);
  });

  it("ignores a block that is not a tool call even when it carries a name", () => {
    const block = { type: "text", name: "Skill", input: { skill: "never" } };
    const state = fold([{ type: "assistant", message: { content: [block, { type: "tool_use", name: "Skill", input: { skill: "used" } }] } }]);
    expect(state.cumulative.skills.names).toEqual(["used"]);
  });

  it("reads back a result that failed before its call", () => {
    const state = fold([result("orphan", 1, true)]);
    expect(state.latest.unmatchedResults[0]?.failed).toBe(true);
    expect(ActivityStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
