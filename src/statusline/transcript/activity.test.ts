import { describe, expect, it } from "vitest";

import { ESCAPE } from "../ansi";
import {
  activityFactsOf,
  ActivityStateSchema,
  EMPTY_ACTIVITY_LATEST,
  EMPTY_ACTIVITY_STATE,
  foldActivity,
  foldActivityLatest,
  MAX_LIVE_AGENT_MS,
  MAX_LIVE_TOOL_CALL_MS,
  MAX_TRACKED_AGENTS,
  MAX_TRACKED_NAMES,
  MAX_TRACKED_TODOS,
  MAX_TRACKED_TOOL_CALLS,
  type ActivityLatest,
  type ActivityState,
} from "./activity";
import { parseTranscriptRecord } from "./record";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTE = SECONDS_PER_MINUTE * SECOND;
/** Times after T0 that records are stamped, named by their order and not by how long they are. */
const STEP = { third: 3, fourth: 4, fifth: 5, ninth: 9 } as const;
const COMMAND_TARGET_CHARS = 30;
const LONG_COMMAND_CHARS = 40;
const MANY_TIMES_THE_LIMIT = 10;
const EXTRA_CALLS = 5;
const EXTRA_NAMES = 3;
const EXTRA_TODOS = 3;
const FEW_MINUTES = 5;
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const use = (id: string, name: string, input: Record<string, unknown> = {}, ms = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (id: string, ms: number, isError = false, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "done" }] }, ...extra });

function fold(records: readonly Record<string, unknown>[], from: ActivityState = EMPTY_ACTIVITY_STATE): ActivityState {
  return records.reduce<ActivityState>((state, record) => {
    const parsed = parseTranscriptRecord(JSON.stringify(record));
    return parsed === undefined ? state : foldActivity(state, parsed);
  }, from);
}

const factsAt = (records: readonly Record<string, unknown>[], nowMs = T0 + SECOND) => activityFactsOf(fold(records), nowMs);

describe("tool calls", () => {
  it("tracks a call as running until its result, then as completed", () => {
    expect(factsAt([use("a", "Read", { file_path: "/x/y.ts" })]).tools).toEqual([{ name: "Read", target: "/x/y.ts", status: "running" }]);
    expect(factsAt([use("a", "Read", { file_path: "/x/y.ts" }), result("a", SECOND)]).tools).toEqual([{ name: "Read", target: "/x/y.ts", status: "completed" }]);
  });

  it("tracks a failed call as an error", () => {
    expect(factsAt([use("a", "Bash", { command: "false" }), result("a", SECOND, true)]).tools[0]?.status).toBe("error");
  });

  it("pairs a result with its call by id, whatever else falls between them", () => {
    const tools = factsAt([use("a", "Read"), use("b", "Grep"), result("b", SECOND), result("a", 2 * SECOND)]).tools;
    expect(tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["Read:completed", "Grep:completed"]);
  });

  it("names what a call acts on, by the tool", () => {
    const target = (name: string, input: Record<string, unknown>): string | undefined => factsAt([use("a", name, input)]).tools[0]?.target;
    expect(target("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(target("Edit", { path: "/a/c.ts" })).toBe("/a/c.ts");
    expect(target("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(target("Grep", { pattern: "needle" })).toBe("needle");
    expect(target("Skill", { skill: "commit" })).toBe("commit");
    expect(target("Bash", { command: "git   status \n --short" })).toBe("git status --short");
    expect(target("Bash", { command: "a".repeat(LONG_COMMAND_CHARS) })).toBe(`${"a".repeat(COMMAND_TARGET_CHARS)}...`);
    expect(target("WebFetch", { url: "https://example.com" })).toBeUndefined();
    expect(target("Bash", {})).toBeUndefined();
  });

  it("treats a call with no result as running for as long as a live call can take, and then as neither running nor finished", () => {
    const records = [use("a", "Bash", { command: "sleep 1" })];
    expect(activityFactsOf(fold(records), T0 + MAX_LIVE_TOOL_CALL_MS).tools).toHaveLength(1);
    expect(activityFactsOf(fold(records), T0 + MAX_LIVE_TOOL_CALL_MS + 1).tools).toEqual([]);
  });

  it("keeps a call that has a result however long ago it ran", () => {
    const records = [use("a", "Read"), result("a", SECOND)];
    expect(activityFactsOf(fold(records), T0 + MANY_TIMES_THE_LIMIT * MAX_LIVE_TOOL_CALL_MS).tools).toHaveLength(1);
  });

  it("does not age a call whose timestamp is in the future of the clock", () => {
    expect(activityFactsOf(fold([use("a", "Read", {}, FEW_MINUTES * MINUTE)]), T0).tools).toHaveLength(1);
  });

  it("keeps only the latest calls", () => {
    const records = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => use(`id${String(index)}`, `Tool${String(index)}`));
    const { tools } = factsAt(records);
    expect(tools).toHaveLength(MAX_TRACKED_TOOL_CALLS);
    expect(tools[0]?.name).toBe("Tool5");
  });

  it("leaves out the tools that start an agent or edit the todo list, which have lines of their own", () => {
    const records = [use("a", "Agent", { subagent_type: "x" }), use("b", "Task", { subagent_type: "y" }), use("c", "TodoWrite", { todos: [] }), use("d", "TaskCreate", { subject: "s" }), use("e", "TaskUpdate", { taskId: "1" }), use("f", "Read")];
    expect(factsAt(records).tools.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("reads nothing from the records of a subagent", () => {
    const records = [use("a", "Read", {}, 0, { isSidechain: true }), result("a", SECOND, false, { isSidechain: true }), use("b", "Skill", { skill: "s" }, 0, { isSidechain: true }), use("c", "mcp__srv__tool", {}, 0, { isSidechain: true }), use("d", "TaskCreate", { subject: "s" }, 0, { isSidechain: true }), use("e", "Agent", {}, 0, { isSidechain: true })];
    expect(factsAt(records)).toEqual({ tools: [], skills: [], mcpServers: [], agents: [], todos: [] });
  });

  it("leaves out a call whose name is nothing once sanitised", () => {
    expect(factsAt([use("a", `${ESCAPE}[31m`)]).tools).toEqual([]);
    expect(factsAt([use("a", "Read", { file_path: `/x/${ESCAPE}[2Jy` }), use("b", `Gr${ESCAPE}[31mep`)]).tools).toEqual([
      { name: "Read", target: "/x/y", status: "running" },
      { name: "Grep", target: undefined, status: "running" },
    ]);
  });

  it("ignores a tool_result with no id, and a tool_use with no id or name", () => {
    const records = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", id: "z" }, { type: "tool_result" }] } }];
    expect(factsAt(records).tools).toEqual([]);
  });
});

describe("skills and MCP servers", () => {
  it("collects each skill and each server once, in the order first used", () => {
    const records = [
      use("a", "Skill", { skill: "commit" }),
      use("b", "mcp__plugin_playwright_playwright__browser_navigate"),
      use("c", "Skill", { skill: "journal" }),
      use("d", "mcp__plugin_playwright_playwright__browser_click"),
      use("e", "Skill", { skill: "commit" }),
      use("f", "mcp__github__create_issue"),
    ];
    const facts = factsAt(records);
    expect(facts.skills).toEqual(["commit", "journal"]);
    expect(facts.mcpServers).toEqual(["plugin_playwright_playwright", "github"]);
  });

  it("takes a Skill call with no skill name, and a tool name that is not an MCP tool's, for neither", () => {
    const facts = factsAt([use("a", "Skill", {}), use("b", "mcp__only"), use("c", "Read")]);
    expect(facts.skills).toEqual([]);
    expect(facts.mcpServers).toEqual([]);
  });

  it("keeps the names it has been given after it is full, and no more", () => {
    const records = Array.from({ length: MAX_TRACKED_NAMES + EXTRA_NAMES }, (_, index) => use(`s${String(index)}`, "Skill", { skill: `skill-${String(index)}` }));
    const { skills } = factsAt(records);
    expect(skills).toHaveLength(MAX_TRACKED_NAMES);
    expect(skills[0]).toBe("skill-0");
  });

  it("reduces a name to the text a person would see, and counts two names that look the same as one", () => {
    expect(factsAt([use("a", "Skill", { skill: `co${ESCAPE}[31mmmit` }), use("b", "Skill", { skill: "commit" })]).skills).toEqual(["commit"]);
  });
});

describe("agents", () => {
  const launch = (extra: Record<string, unknown> = {}): Record<string, unknown> => use("ag", "Agent", { subagent_type: "Explore", description: "Find the thing", model: "opus", ...extra });

  it("tracks an agent as running until the result of its call, then as completed at the result's time", () => {
    expect(factsAt([launch()]).agents).toEqual([{ type: "Explore", model: "opus", description: "Find the thing", status: "running", startedAtMs: T0, endedAtMs: undefined }]);
    expect(factsAt([launch(), result("ag", STEP.third * SECOND)]).agents[0]).toMatchObject({ status: "completed", startedAtMs: T0, endedAtMs: T0 + STEP.third * SECOND });
  });

  it("reads a call to the Task tool as an agent too, and a missing type as agent", () => {
    expect(factsAt([use("t", "Task", {})]).agents[0]?.type).toBe("agent");
  });

  it("takes the model the result says the agent ran on over the one it asked for", () => {
    const resolved = result("ag", SECOND, false, { toolUseResult: { resolvedModel: "claude-opus-4-8[1m]" } });
    expect(factsAt([launch(), resolved]).agents[0]?.model).toBe("claude-opus-4-8[1m]");
  });

  it("keeps an agent started in the background running after its call returns, until the client announces it finished", () => {
    const returned = result("ag", SECOND, false, { toolUseResult: { isAsync: true, status: "async_launched" } });
    expect(factsAt([launch(), returned]).agents[0]).toMatchObject({ status: "running", endedAtMs: undefined });
    const announced = { type: "queue-operation", operation: "enqueue", timestamp: at(FEW_MINUTES * MINUTE), content: "<task-notification><task-id>t1</task-id><tool-use-id>ag</tool-use-id></task-notification>" };
    expect(factsAt([launch(), returned, announced]).agents[0]).toMatchObject({ status: "completed", endedAtMs: T0 + FEW_MINUTES * MINUTE });
  });

  it("takes the input's run_in_background for a background agent before its call returns", () => {
    const records = [launch({ run_in_background: true }), result("ag", SECOND)];
    expect(factsAt(records).agents[0]?.status).toBe("running");
  });

  it("ignores an announcement that names no task or no tool call, one for a call that is not a background agent, and one of another kind", () => {
    const base = [launch(), result("ag", SECOND)];
    const before = factsAt(base).agents;
    const announce = (content: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "queue-operation", operation: "enqueue", timestamp: at(MINUTE), content, ...extra });
    expect(factsAt([...base, announce("<tool-use-id>ag</tool-use-id>")]).agents).toEqual(before);
    expect(factsAt([...base, announce("<task-id>t</task-id>")]).agents).toEqual(before);
    expect(factsAt([...base, announce("<task-id>t</task-id><tool-use-id>ag</tool-use-id>", { operation: "dequeue" })]).agents).toEqual(before);
    expect(factsAt([...base, announce("<task-id>t</task-id><tool-use-id>other</tool-use-id>")]).agents).toEqual(before);
  });

  it("drops an agent that has had no end for longer than a live one can run", () => {
    expect(activityFactsOf(fold([launch()]), T0 + MAX_LIVE_AGENT_MS).agents).toHaveLength(1);
    expect(activityFactsOf(fold([launch()]), T0 + MAX_LIVE_AGENT_MS + 1).agents).toEqual([]);
  });

  it("keeps only the latest agents", () => {
    const records = Array.from({ length: MAX_TRACKED_AGENTS + 2 }, (_, index) => use(`a${String(index)}`, "Agent", { subagent_type: `type${String(index)}` }));
    const { agents } = factsAt(records);
    expect(agents).toHaveLength(MAX_TRACKED_AGENTS);
    expect(agents[0]?.type).toBe("type2");
  });

  it("reduces an agent's texts to what a person would see", () => {
    const agent = factsAt([use("a", "Agent", { subagent_type: `Ex${ESCAPE}[31mplore`, description: `a\nb` })]).agents[0];
    expect(agent).toMatchObject({ type: "Explore", description: "ab" });
  });
});

describe("the todo list", () => {
  const todoWrite = (todos: unknown, ms = 0): Record<string, unknown> => use(`w${String(ms)}`, "TodoWrite", { todos }, ms);

  it("is replaced whole by each TodoWrite", () => {
    const first = todoWrite([{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }], 1);
    const second = todoWrite([{ content: "three", status: "pending" }], 2);
    expect(factsAt([first]).todos).toEqual([{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }]);
    expect(factsAt([first, second]).todos).toEqual([{ content: "three", status: "pending" }]);
  });

  it("reads a spelling of a status it does not know as pending, and leaves out an item with no words", () => {
    const todos = factsAt([todoWrite([{ content: "a", status: "weird" }, { content: "b" }, { status: "completed" }, "text", null])]).todos;
    expect(todos).toEqual([{ content: "a", status: "pending" }, { content: "b", status: "pending" }]);
  });

  it("ignores a TodoWrite with no list", () => {
    expect(factsAt([todoWrite([{ content: "a", status: "pending" }]), use("x", "TodoWrite", {}, STEP.fifth)]).todos).toHaveLength(1);
  });

  it("builds a list from TaskCreate calls and updates it by the task's number", () => {
    const records = [
      use("c1", "TaskCreate", { subject: "first" }, 1),
      use("c2", "TaskCreate", { description: "second, in words" }, 2),
      use("c3", "TaskCreate", {}, STEP.third),
      use("u1", "TaskUpdate", { taskId: "1", status: "completed" }, STEP.fourth),
      use("u2", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "second" }, STEP.fifth),
    ];
    expect(factsAt(records).todos).toEqual([
      { content: "first", status: "completed" },
      { content: "second", status: "in_progress" },
      { content: "Untitled task", status: "pending" },
    ]);
  });

  it("finds a task by the identifier it was created with before it counts places", () => {
    const records = [use("c1", "TaskCreate", { subject: "a", taskId: "7" }, 1), use("c2", "TaskCreate", { subject: "b", taskId: 8 }, 2), use("u", "TaskUpdate", { taskId: 8, status: "done" }, STEP.third)];
    expect(factsAt(records).todos.map((todo) => todo.status)).toEqual(["pending", "completed"]);
  });

  it("ignores an update to a task that is not there, or that names none, or that sets a status it does not know", () => {
    const records = [use("c", "TaskCreate", { subject: "a" }, 1), use("u1", "TaskUpdate", { taskId: "9", status: "completed" }, 2), use("u2", "TaskUpdate", {}, STEP.third), use("u3", "TaskUpdate", { taskId: "1", status: "deleted" }, STEP.fourth)];
    expect(factsAt(records).todos).toEqual([{ content: "a", status: "pending" }]);
  });

  it("lets a later update name a task by the identifier it had before a TodoWrite wrote the list again", () => {
    const records = [
      use("c1", "TaskCreate", { subject: "keep", taskId: "k" }, 1),
      todoWrite([{ content: "keep", status: "pending" }, { content: "new", status: "pending" }], 2),
      use("u", "TaskUpdate", { taskId: "k", status: "completed" }, STEP.third),
    ];
    expect(factsAt(records).todos.map((todo) => `${todo.content}:${todo.status}`)).toEqual(["keep:completed", "new:pending"]);
  });

  it("gives two items with the same words each their own identifier when the list is written again", () => {
    const records = [
      use("c1", "TaskCreate", { subject: "same", taskId: "a" }, 1),
      use("c2", "TaskCreate", { subject: "same", taskId: "b" }, 2),
      todoWrite([{ content: "same", status: "pending" }, { content: "same", status: "pending" }], STEP.third),
      use("u", "TaskUpdate", { taskId: "b", status: "completed" }, STEP.fourth),
    ];
    expect(factsAt(records).todos.map((todo) => todo.status)).toEqual(["pending", "completed"]);
  });

  it("keeps only the latest items of a very long list", () => {
    const records = Array.from({ length: MAX_TRACKED_TODOS + EXTRA_TODOS }, (_, index) => use(`c${String(index)}`, "TaskCreate", { subject: `task ${String(index)}` }, index));
    const { todos } = factsAt(records);
    expect(todos).toHaveLength(MAX_TRACKED_TODOS);
    expect(todos[0]?.content).toBe("task 3");
  });
});

describe("the state", () => {
  it("is plain JSON that its schema reads back unchanged", () => {
    const state = fold([use("a", "Read", { file_path: "/x" }), result("a", SECOND), use("b", "Skill", { skill: "s" }), use("g", "Agent", { run_in_background: true }), use("t", "TaskCreate", { subject: "x" })]);
    expect(ActivityStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("is not changed by the records it folds", () => {
    const before = JSON.stringify(EMPTY_ACTIVITY_STATE);
    fold([use("a", "Read"), use("s", "Skill", { skill: "x" })]);
    expect(JSON.stringify(EMPTY_ACTIVITY_STATE)).toBe(before);
  });

  it("is carried on from a state folded earlier as if it were folded in one go", () => {
    const records = [use("a", "Read", {}, 1), result("a", 2), use("b", "Skill", { skill: "s" }, STEP.third), use("c", "TaskCreate", { subject: "x" }, STEP.fourth)];
    const split = fold(records.slice(2), fold(records.slice(0, 2)));
    expect(split).toEqual(fold(records));
  });
});

describe("activityFactsOf with the facts folded from the end of the transcript", () => {
  const older = fold([use("a", "Read", {}, 1), result("a", 2), use("t", "TaskCreate", { subject: "old" }, STEP.third), use("s", "Skill", { skill: "early" }, STEP.fourth)]);
  const end = (records: readonly Record<string, unknown>[]) => records.reduce<ActivityLatest>((state, record) => {
    const parsed = parseTranscriptRecord(JSON.stringify(record));
    return parsed === undefined ? state : foldActivityLatest(state, parsed);
  }, EMPTY_ACTIVITY_LATEST);

  it("puts the end's calls after the state's, and keeps a call that both hold once", () => {
    const newer = end([use("b", "Grep", {}, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, newer).tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["Read:completed", "Skill:running", "Grep:running"]);
  });

  it("takes a result the state read over the end's fold of the same call, which began after the call", () => {
    const overlapping = end([use("a", "Read", {}, 1), use("b", "Grep", {}, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, overlapping).tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["Skill:running", "Read:completed", "Grep:running"]);
  });

  it("takes the end's result of a call over the state's, which has none", () => {
    const behind = fold([use("a", "Read", {}, 1)]);
    const overlapping = end([use("a", "Read", {}, 1), result("a", 2)]);
    expect(activityFactsOf(behind, T0 + SECOND, overlapping).tools.map((tool) => tool.status)).toEqual(["completed"]);
  });

  it("keeps the state's todo list while the end holds no TodoWrite, whatever tasks it creates, and replaces it once it does", () => {
    const created = end([use("c", "TaskCreate", { subject: "tail" }, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, created).todos.map((todo) => todo.content)).toEqual(["old"]);
    const written = end([use("w", "TodoWrite", { todos: [{ content: "fresh", status: "in_progress" }] }, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, written).todos.map((todo) => todo.content)).toEqual(["fresh"]);
  });

  it("leaves the skills and servers to the state, since they add up over the whole transcript", () => {
    const newer = end([use("s", "Skill", { skill: "late" }, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, newer).skills).toEqual(["early"]);
  });
});
