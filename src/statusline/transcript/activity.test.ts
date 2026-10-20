import { describe, expect, it } from "vitest";

import { ESCAPE } from "../ansi";
import {
  activityFactsOf,
  ActivityStateSchema,
  EMPTY_ACTIVITY_FACTS,
  EMPTY_ACTIVITY_LATEST,
  EMPTY_ACTIVITY_STATE,
  foldActivity,
  foldActivityLatest,
  MAX_LIVE_AGENT_MS,
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  bashLiveLimitMs,
  MAX_REMEMBERED_CALLS,
  MAX_STORED_TEXT_CHARS,
  MAX_TRACKED_AGENTS,
  MAX_COUNTED_NAMES,
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
const STEP = { third: 3, fourth: 4, fifth: 5, sixth: 6, ninth: 9 } as const;
const LONG_COMMAND_CHARS = 40;
const MANY_TIMES_THE_LIMIT = 10;
const ONE_MEBIBYTE = 1_048_576;
const EXTRA_CALLS = 5;
const EXTRA_NAMES = 3;
const EXTRA_TODOS = 3;
const FEW_MINUTES = 5;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const use = (id: string, name: string, input: Record<string, unknown> = {}, ms = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (id: string, ms: number, isError = false, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "done" }] }, ...extra });

function fold(records: readonly Record<string, unknown>[], from: ActivityState = EMPTY_ACTIVITY_STATE): ActivityState {
  return records.reduce<ActivityState>((state, record) => {
    const parsed = parseTranscriptRecord(JSON.stringify(record));
    return parsed === undefined ? state : foldActivity(state, parsed);
  }, from);
}

const LIMITS = { bashMs: BASH_MAX_TIMEOUT_MS };
const factsAt = (records: readonly Record<string, unknown>[], nowMs = T0 + SECOND) => activityFactsOf(fold(records), nowMs, LIMITS);

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
    expect(target("Bash", { command: "a".repeat(LONG_COMMAND_CHARS) })).toBe("a".repeat(LONG_COMMAND_CHARS));
    expect(target("WebFetch", { url: "https://example.com" })).toBeUndefined();
    expect(target("Bash", {})).toBeUndefined();
  });

  it("treats a call with no result as running for as long as a live call can take, and then as neither running nor finished", () => {
    const records = [use("a", "Bash", { command: "sleep 1" })];
    expect(activityFactsOf(fold(records), T0 + BASH_MAX_TIMEOUT_MS, LIMITS).tools).toHaveLength(1);
    expect(activityFactsOf(fold(records), T0 + BASH_MAX_TIMEOUT_MS + 1, LIMITS).tools).toEqual([]);
  });

  it("keeps a call that has a result however long ago it ran", () => {
    const records = [use("a", "Read"), result("a", SECOND)];
    expect(activityFactsOf(fold(records), T0 + MANY_TIMES_THE_LIMIT * BASH_MAX_TIMEOUT_MS, LIMITS).tools).toHaveLength(1);
  });

  it("does not age a call whose timestamp is in the future of the clock", () => {
    expect(activityFactsOf(fold([use("a", "Read", {}, FEW_MINUTES * MINUTE)]), T0, LIMITS).tools).toHaveLength(1);
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
    expect(factsAt(records)).toEqual(EMPTY_ACTIVITY_FACTS);
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

describe("records that copy earlier ones", () => {
  const blob = (content: readonly unknown[], role: string): Record<string, unknown> => ({ type: "api-request-blob", sessionId: "s", hash: "h", message: { role, content } });
  const SESSION = [
    use("a", "Bash", { command: "ls" }),
    use("ag", "Agent", { subagent_type: "Explore", run_in_background: true }),
    result("a", SECOND),
    result("ag", SECOND, false, { toolUseResult: { isAsync: true, status: "async_launched" } }),
    { type: "queue-operation", operation: "enqueue", timestamp: at(MINUTE), content: "<task-id>t</task-id><tool-use-id>ag</tool-use-id>" },
  ];
  const copies = [
    blob([{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "ag", name: "Agent", input: { subagent_type: "Explore", run_in_background: true } }, { type: "tool_use", id: "s", name: "Skill", input: { skill: "copied" } }, { type: "tool_use", id: "m", name: "mcp__copied__tool", input: {} }], "assistant"),
    blob([{ type: "tool_result", tool_use_id: "a", content: "x" }], "user"),
  ];

  it("add no call, agent, skill or server, and leave a call's end and an agent's end as they are", () => {
    expect(factsAt([...SESSION, ...copies])).toEqual(factsAt(SESSION));
    expect(factsAt([...SESSION, ...copies]).tools).toEqual([{ name: "Bash", target: "ls", status: "completed" }]);
    expect(factsAt([...SESSION, ...copies]).agents).toMatchObject([{ type: "Explore", status: "completed" }]);
  });

  it("do not leave a call running when they come before the call's result", () => {
    expect(factsAt([use("a", "Bash", { command: "ls" }), copies[0] ?? {}, result("a", SECOND)]).tools.map((tool) => tool.status)).toEqual(["completed"]);
  });

  it("are no reason to track a call whose id is already tracked, in a record of the right kind", () => {
    expect(factsAt([use("a", "Read"), result("a", SECOND), use("a", "Read", {}, STEP.third)]).tools).toEqual([{ name: "Read", target: undefined, status: "completed" }]);
    expect(factsAt([use("g", "Agent", {}), use("g", "Agent", {}, STEP.third)]).agents).toHaveLength(1);
  });
});

describe("a result written to the file before its call", () => {
  it("finishes the call when the call arrives, however late the call is stamped", () => {
    const facts = factsAt([result("a", SECOND), use("a", "Edit", { file_path: "/x" }, 0)]);
    expect(facts.tools).toEqual([{ name: "Edit", target: "/x", status: "completed" }]);
    expect(activityFactsOf(fold([result("a", SECOND), use("a", "Edit")]), T0 + MANY_TIMES_THE_LIMIT * BASH_MAX_TIMEOUT_MS, LIMITS).tools).toHaveLength(1);
  });

  it("marks the call failed when the result was an error", () => {
    expect(factsAt([result("a", SECOND, true), use("a", "Edit")]).tools[0]?.status).toBe("error");
  });

  it("ends an agent, and tells a background one, from the result that came first", () => {
    const foreground = factsAt([result("g", SECOND, false, { toolUseResult: { resolvedModel: "claude-opus-4-8" } }), use("g", "Agent", { subagent_type: "x" })]).agents[0];
    expect(foreground).toMatchObject({ status: "completed", model: "claude-opus-4-8" });
    const background = factsAt([result("g", SECOND, false, { toolUseResult: { isAsync: true } }), use("g", "Agent", { subagent_type: "x" })]).agents[0];
    expect(background).toMatchObject({ status: "running" });
  });

  it("is forgotten once its call has arrived", () => {
    const state = fold([result("a", SECOND), use("a", "Edit")]);
    expect(state.latest.unmatchedResults).toEqual([]);
  });

  it("is kept in the state between folds, so a result from one refresh finishes a call of the next", () => {
    const first = fold([result("a", SECOND)]);
    expect(ActivityStateSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(activityFactsOf(fold([use("a", "Read")], first), T0 + SECOND, LIMITS).tools[0]?.status).toBe("completed");
  });

  it("keeps only the latest few results that have no call", () => {
    const records = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => result(`orphan${String(index)}`, SECOND));
    const { unmatchedResults } = fold(records).latest;
    expect(unmatchedResults).toHaveLength(MAX_TRACKED_TOOL_CALLS);
    expect(unmatchedResults[0]?.id).toBe(`orphan${String(EXTRA_CALLS)}`);
  });

  it("takes a record's outcome (the model, whether it was started in the background) only when the record holds one result", () => {
    const two = { type: "user", timestamp: at(SECOND), toolUseResult: { isAsync: true, resolvedModel: "claude-opus-4-8" }, message: { content: [{ type: "tool_result", tool_use_id: "g" }, { type: "tool_result", tool_use_id: "h" }] } };
    const facts = factsAt([use("g", "Agent", {}), use("h", "Agent", {}), two]);
    expect(facts.agents).toMatchObject([{ status: "completed", model: undefined }, { status: "completed", model: undefined }]);
  });
});

describe("whether a call is still running", () => {
  const THREE_HOURS = 10_800_000;
  const inResponse = (key: string, record: Record<string, unknown>): Record<string, unknown> => ({ ...record, message: { ...(isRecord(record.message) ? record.message : {}), id: key } });
  const names = (records: readonly Record<string, unknown>[], nowMs = T0 + SECOND): string[] => factsAt(records, nowMs).tools.map((tool) => `${tool.name}:${tool.status}`);

  it("keeps a call that waits for a person running for as long as the person takes", () => {
    for (const name of ["AskUserQuestion", "ExitPlanMode", "Edit", "Read", "Write", "WebFetch"]) {
      expect(names([use("a", name)], T0 + THREE_HOURS), name).toEqual([`${name}:running`]);
    }
  });

  it("takes a Bash call with no result for running until the longest a Bash call can run, and then for cut off", () => {
    expect(names([use("a", "Bash", { command: "sleep 1" })], T0 + BASH_MAX_TIMEOUT_MS)).toEqual(["Bash:running"]);
    expect(names([use("a", "Bash", { command: "sleep 1" })], T0 + BASH_MAX_TIMEOUT_MS + 1)).toEqual([]);
  });

  it("follows a Bash timeout the environment raises, and ignores one that is not a positive whole number", () => {
    const RAISED = 1_800_000;
    expect(bashLiveLimitMs({})).toBe(BASH_MAX_TIMEOUT_MS);
    expect(bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: String(RAISED) })).toBe(RAISED);
    expect(bashLiveLimitMs({ BASH_DEFAULT_TIMEOUT_MS: String(RAISED) })).toBe(RAISED);
    expect(bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: "1000" })).toBe(BASH_DEFAULT_TIMEOUT_MS);
    for (const bad of ["", "abc", "-5", "0", "1.5"]) {
      expect(bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: bad, BASH_DEFAULT_TIMEOUT_MS: bad }), bad).toBe(BASH_MAX_TIMEOUT_MS);
    }
    const state = fold([use("a", "Bash", { command: "sleep 1" })]);
    expect(activityFactsOf(state, T0 + 2 * BASH_MAX_TIMEOUT_MS, { bashMs: bashLiveLimitMs({ BASH_MAX_TIMEOUT_MS: String(RAISED) }) }).tools).toHaveLength(1);
  });

  it("forgets a call with no result once the session writes its next response, whatever the call is", () => {
    const records = [inResponse("r1", use("a", "AskUserQuestion")), inResponse("r1", use("b", "Edit")), inResponse("r2", { type: "assistant", timestamp: at(STEP.third), message: { content: [{ type: "text", text: "went on" }] } })];
    expect(names(records, T0 + THREE_HOURS)).toEqual([]);
  });

  it("keeps the calls of a response that are still waiting while that response's other records are written, and one that has its result", () => {
    const records = [inResponse("r1", use("a", "Read")), inResponse("r1", use("b", "Grep")), result("a", SECOND), inResponse("r1", use("c", "Edit", {}, 2))];
    expect(names(records)).toEqual(["Read:completed", "Grep:running", "Edit:running"]);
    expect(names([...records, inResponse("r2", use("d", "Bash", { command: "x" }, STEP.third))])).toEqual(["Read:completed", "Bash:running"]);
  });

  it("tells responses apart by the request when a record has no message id", () => {
    const withRequest = (requestId: string, record: Record<string, unknown>): Record<string, unknown> => ({ ...record, requestId });
    expect(names([withRequest("q1", use("a", "Read")), withRequest("q2", use("b", "Grep", {}, 2))])).toEqual(["Grep:running"]);
  });

  it("does not forget a call when records with no key come after it", () => {
    expect(names([inResponse("r1", use("a", "Read")), use("b", "Grep", {}, 2)])).toEqual(["Read:running", "Grep:running"]);
  });

  it("forgets a foreground agent with no result when the next response begins, and keeps one started in the background", () => {
    const records = [inResponse("r1", use("fg", "Agent", { subagent_type: "Plan" })), inResponse("r1", use("bg", "Agent", { subagent_type: "Explore", run_in_background: true })), inResponse("r2", use("x", "Read", {}, 2))];
    expect(factsAt(records).agents.map((agent) => `${agent.type ?? ""}:${agent.status}`)).toEqual(["Explore:running"]);
  });

  it("finishes a call, an agent and a task whose result is written after the next response, as results are not always written in order", () => {
    const next = inResponse("r2", use("x", "Read", {}, 2));
    const late = (id: string, content = "ok"): Record<string, unknown> => ({ type: "user", timestamp: at(STEP.third), message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
    const records = [inResponse("r1", use("a", "Edit")), inResponse("r1", use("g", "Agent", { subagent_type: "Plan" })), inResponse("r1", use("c", "TaskCreate", { subject: "x" })), next];
    expect(names(records)).toEqual(["Read:running"]);
    expect(factsAt(records).todos).toEqual([]);
    const answered = [...records, late("a"), late("g"), late("c", "Task #1 created successfully")];
    expect(names(answered)).toEqual(["Edit:completed", "Read:running"]);
    expect(factsAt(answered).agents).toMatchObject([{ type: "Plan", status: "completed" }]);
    expect(factsAt(answered).todos).toEqual([{ content: "x", status: "pending" }]);
  });

  it("applies to the facts of the end of a long transcript too: a call the state has with no result is forgotten when the end holds a later response", () => {
    const state = fold([inResponse("r1", use("a", "Read")), inResponse("r1", use("b", "Agent", { subagent_type: "x" }))]);
    const end = [inResponse("r9", use("c", "Grep", {}, STEP.ninth))].reduce<ActivityLatest>((latest, record) => {
      const parsed = parseTranscriptRecord(JSON.stringify(record));
      return parsed === undefined ? latest : foldActivityLatest(latest, parsed);
    }, EMPTY_ACTIVITY_LATEST);
    const facts = activityFactsOf(state, T0 + SECOND, LIMITS, end);
    expect(facts.tools.map((tool) => tool.name)).toEqual(["Grep"]);
    expect(facts.agents).toEqual([]);
  });

});

describe("history written again by a resumed session", () => {
  it("adds no call that left the tracked window and is written again, with its result, in the same order", () => {
    const history = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => [use(`h${String(index)}`, `Tool${String(index)}`, {}, index), result(`h${String(index)}`, index)]).flat();
    const once = factsAt(history).tools;
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2)]).tools).toEqual(once);
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2), use("new", "Fresh", {}, MINUTE)]).tools.at(-1)).toMatchObject({ name: "Fresh", status: "running" });
  });

  it("adds no agent that left the tracked window and is written again, as running", () => {
    const history = Array.from({ length: MAX_TRACKED_AGENTS + EXTRA_CALLS }, (_, index) => [use(`g${String(index)}`, "Agent", { subagent_type: `T${String(index)}`, run_in_background: true }, index), result(`g${String(index)}`, index, false, { toolUseResult: { isAsync: true } })]).flat();
    const once = factsAt(history).agents;
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2)]).agents).toEqual(once);
  });

  it("adds no task written again, so the list is not rebuilt from its own copy", () => {
    const history = [...Array.from({ length: 3 }, (_, index) => [use(`c${String(index)}`, "TaskCreate", { subject: `task ${String(index)}` }, index), { type: "user", timestamp: at(index), message: { content: [{ type: "tool_result", tool_use_id: `c${String(index)}`, content: `Task #${String(index + 1)} created` }] } }]).flat()];
    expect(factsAt([...history, ...history.slice(0, 2)]).todos).toEqual(factsAt(history).todos);
  });

  it("remembers the latest calls only, so a bounded number of them are kept in the state", () => {
    const records = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`s${String(index)}`, "Read", {}, index));
    const { rememberedCalls, forgottenUpToMs } = fold(records).latest;
    expect(rememberedCalls).toHaveLength(MAX_REMEMBERED_CALLS);
    expect(forgottenUpToMs).toBe(T0 + EXTRA_CALLS - 1);
  });

  it("adds no call written again after the memory has forgotten it, and leaves a newer todo list alone", () => {
    const list = (subject: string, ms: number): Record<string, unknown> => use(`w${subject}`, "TodoWrite", { todos: [{ content: subject, status: "pending", activeForm: subject }] }, ms);
    const history = [list("old", 0), ...Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`f${String(index)}`, "Read", {}, index + 1)), list("new", MAX_REMEMBERED_CALLS + EXTRA_CALLS + 1)];
    const once = factsAt(history);
    expect(once.todos.map((item) => item.content)).toEqual(["new"]);
    const again = factsAt([...history, list("old", 0), use("f0", "Read", {}, 1)]);
    expect(again.todos).toEqual(once.todos);
    expect(again.tools).toEqual(once.tools);
  });

  it("is not blinded by one call stamped far ahead of the rest: calls written after it are still new once it is forgotten", () => {
    const ahead = use("ahead", "Read", {}, MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS);
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const fresh = [use("fresh1", "Grep", {}, MAX_REMEMBERED_CALLS * SECOND + MINUTE), use("write", "TodoWrite", { todos: [{ content: "now", status: "in_progress" }] }, MAX_REMEMBERED_CALLS * SECOND + MINUTE + SECOND)];
    const state = fold([ahead, ...history]);
    expect(state.latest.forgottenUpToMs).toBeLessThan(T0 + MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS);
    const facts = activityFactsOf(fold(fresh, state), T0 + SECOND, LIMITS);
    expect(facts.tools.map((tool) => tool.name)).toContain("Grep");
    expect(facts.todos.map((todo) => todo.content)).toEqual(["now"]);
  });

  it("reads a call never written before as history when it is no newer than the newest call forgotten, and as new when it is newer", () => {
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Glob", {}, index));
    const newestForgotten = EXTRA_CALLS - 1;
    const names = (ms: number): string[] => activityFactsOf(fold([use("stray", "Grep", {}, ms)], fold(history)), T0 + SECOND, LIMITS).tools.map((tool) => tool.name);
    expect(names(newestForgotten)).not.toContain("Grep");
    expect(names(newestForgotten + 1)).toContain("Grep");
  });

  it("reads a call that was never written, and is no older than the newest forgotten, as new while the memory holds it", () => {
    const records = [use("a", "Read", {}, MINUTE), use("b", "Grep", {}, 0)];
    expect(factsAt(records).tools.map((tool) => tool.name)).toEqual(["Read", "Grep"]);
  });

  it("keeps no result for a call that was read and has left the tracked window, and applies every result waiting for a call", () => {
    const history = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Read", {}, index));
    expect(fold([...history, result("k0", STEP.fifth)]).latest.unmatchedResults).toEqual([]);
    const launch = result("j", 1, false, { toolUseResult: { isAsync: true } });
    const ended = { type: "queue-operation", operation: "enqueue", timestamp: at(STEP.third), content: "<task-notification><task-id>t</task-id><tool-use-id>j</tool-use-id></task-notification>" };
    const [agent] = factsAt([launch, ended, use("j", "Agent", { subagent_type: "x", run_in_background: true }, 0)]).agents;
    expect(agent).toMatchObject({ status: "completed", endedAtMs: T0 + STEP.third });
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
    expect(facts.skills).toEqual({ names: ["commit", "journal"], total: 2, exact: true });
    expect(facts.mcpServers).toEqual({ names: ["plugin_playwright_playwright", "github"], total: 2, exact: true });
  });

  it("takes a Skill call with no skill name, and a tool name that is not an MCP tool's, for neither", () => {
    const facts = factsAt([use("a", "Skill", {}), use("b", "mcp__only"), use("c", "Read")]);
    expect(facts.skills.names).toEqual([]);
    expect(facts.mcpServers.names).toEqual([]);
  });

  it("keeps the first names whole and counts every other one, once, by a digest", () => {
    const distinct = MAX_TRACKED_NAMES + EXTRA_NAMES;
    const records = [...Array.from({ length: distinct }, (_, index) => use(`s${String(index)}`, "Skill", { skill: `skill-${String(index)}` })), use("again", "Skill", { skill: "skill-0" }), use("later", "Skill", { skill: `skill-${String(distinct - 1)}` })];
    const { skills } = factsAt(records);
    expect(skills.names).toHaveLength(MAX_TRACKED_NAMES);
    expect(skills.names[0]).toBe("skill-0");
    expect(skills).toMatchObject({ total: distinct, exact: true });
  });

  it("counts the servers past the names kept whole too, and says when it can count no more", () => {
    const distinct = MAX_TRACKED_NAMES + MAX_COUNTED_NAMES + EXTRA_NAMES;
    const records = Array.from({ length: distinct }, (_, index) => use(`m${String(index)}`, `mcp__server${String(index)}__tool`));
    expect(factsAt(records.slice(0, MAX_TRACKED_NAMES + EXTRA_NAMES)).mcpServers).toMatchObject({ total: MAX_TRACKED_NAMES + EXTRA_NAMES, exact: true });
    expect(factsAt(records).mcpServers).toMatchObject({ total: MAX_TRACKED_NAMES + MAX_COUNTED_NAMES, exact: false });
  });

  it("reduces a name to the text a person would see, and counts two names that look the same as one", () => {
    expect(factsAt([use("a", "Skill", { skill: `co${ESCAPE}[31mmmit` }), use("b", "Skill", { skill: "commit" })]).skills.names).toEqual(["commit"]);
  });
});

describe("agents", () => {
  const launch = (extra: Record<string, unknown> = {}): Record<string, unknown> => use("ag", "Agent", { subagent_type: "Explore", description: "Find the thing", model: "opus", ...extra });

  it("tracks an agent as running until the result of its call, then as completed at the result's time", () => {
    expect(factsAt([launch()]).agents).toEqual([{ type: "Explore", model: "opus", description: "Find the thing", status: "running", startedAtMs: T0, endedAtMs: undefined }]);
    expect(factsAt([launch(), result("ag", STEP.third * SECOND)]).agents[0]).toMatchObject({ status: "completed", startedAtMs: T0, endedAtMs: T0 + STEP.third * SECOND });
  });

  it("reads a call to the Task tool as an agent too, and a missing type as none, which the row writes in the language's words", () => {
    expect(factsAt([use("t", "Task", {})]).agents).toMatchObject([{ type: undefined, status: "running" }]);
    expect(factsAt([use("t", "Task", { subagent_type: "Explore" })]).agents[0]?.type).toBe("Explore");
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

  it("keeps a teammate running after its call returns, and reads run_in_background written as the text true", () => {
    const spawned = result("ag", SECOND, false, { toolUseResult: { status: "teammate_spawned" } });
    expect(factsAt([launch(), spawned]).agents[0]).toMatchObject({ status: "running", endedAtMs: undefined });
    expect(factsAt([launch({ run_in_background: "true" }), result("ag", SECOND)]).agents[0]?.status).toBe("running");
    expect(factsAt([launch({ run_in_background: "false" }), result("ag", SECOND)]).agents[0]?.status).toBe("completed");
  });

  it("ends a background agent from an announcement queued ahead of the call that started it, however the result says it was started", () => {
    const announced = { type: "queue-operation", operation: "enqueue", timestamp: at(MINUTE), content: "<task-id>t</task-id><tool-use-id>ag</tool-use-id>" };
    const returned = result("ag", SECOND, false, { toolUseResult: { isAsync: true, status: "async_launched" } });
    expect(factsAt([announced, launch(), returned]).agents[0]).toMatchObject({ status: "completed", endedAtMs: T0 + MINUTE });
    expect(factsAt([announced, launch({ run_in_background: true }), returned]).agents[0]).toMatchObject({ status: "completed", endedAtMs: T0 + MINUTE });
  });

  it("does not end a foreground agent from an announcement, queued before or after", () => {
    const announced = { type: "queue-operation", operation: "enqueue", timestamp: at(MINUTE), content: "<task-id>t</task-id><tool-use-id>ag</tool-use-id>" };
    expect(factsAt([announced, launch(), result("ag", SECOND)]).agents[0]).toMatchObject({ status: "completed", endedAtMs: T0 + SECOND });
    expect(factsAt([announced, launch()]).agents[0]?.status).toBe("running");
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
    expect(activityFactsOf(fold([launch()]), T0 + MAX_LIVE_AGENT_MS, LIMITS).agents).toHaveLength(1);
    expect(activityFactsOf(fold([launch()]), T0 + MAX_LIVE_AGENT_MS + 1, LIMITS).agents).toEqual([]);
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

  /** A TaskCreate call and its result, which names the task: in the text, as the client writes it, and in the outcome stamped on the record. */
  const created = (callId: string, input: Record<string, unknown>, taskId: string, ms: number): Record<string, unknown>[] => [
    use(callId, "TaskCreate", input, ms),
    { type: "user", timestamp: at(ms), toolUseResult: { task: { id: taskId, subject: "x" } }, message: { content: [{ type: "tool_result", tool_use_id: callId, content: `Task #${taskId} created successfully: x` }] } },
  ];
  const update = (input: Record<string, unknown>, ms: number): Record<string, unknown> => use(`u${String(ms)}`, "TaskUpdate", input, ms);

  it("builds a list from TaskCreate calls, named by the identifiers their results give, and updates it by them", () => {
    const records = [...created("c1", { subject: "first" }, "1", 1), ...created("c2", { description: "second, in words" }, "2", 2), ...created("c3", {}, "3", STEP.third), update({ taskId: "1", status: "completed" }, STEP.fourth), update({ taskId: "2", status: "in_progress", subject: "second" }, STEP.fifth)];
    expect(factsAt(records).todos).toEqual([
      { content: "first", status: "completed" },
      { content: "second", status: "in_progress" },
      { content: undefined, status: "pending" },
    ]);
  });

  it("names a task from the outcome stamped on the record when the result's text does not say", () => {
    const stamped = { type: "user", timestamp: at(1), toolUseResult: { task: { id: 7 } }, message: { content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "ok" }] }] } };
    expect(factsAt([use("c", "TaskCreate", { subject: "a" }), stamped, update({ taskId: "7", status: "completed" }, 2)]).todos).toEqual([{ content: "a", status: "completed" }]);
  });

  it("does not take the stamped outcome for a record that holds several results", () => {
    const several = { type: "user", timestamp: at(1), toolUseResult: { task: { id: 7 } }, message: { content: [{ type: "tool_result", tool_use_id: "c", content: "ok" }, { type: "tool_result", tool_use_id: "d", content: "ok" }] } };
    expect(factsAt([use("c", "TaskCreate", { subject: "a" }), several]).todos).toEqual([]);
  });

  it("keeps the items in the order their calls were made when the results come back in another order", () => {
    const [useA = {}, resultA = {}] = created("ca", { subject: "A" }, "2", 1);
    const [useB = {}, resultB = {}] = created("cb", { subject: "B" }, "1", 2);
    const records = [useA, useB, resultB, resultA, update({ taskId: "1", status: "completed" }, STEP.third), update({ taskId: "2", status: "in_progress" }, STEP.fourth)];
    expect(factsAt(records).todos).toEqual([
      { content: "A", status: "in_progress" },
      { content: "B", status: "completed" },
    ]);
  });

  it("draws an item only once its result has named it", () => {
    expect(factsAt([use("c", "TaskCreate", { subject: "a" })]).todos).toEqual([]);
  });

  it("leaves no item for a call that failed, so the items after it keep their identifiers", () => {
    const failed = { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "bad", is_error: true, content: "InputValidationError" }] } };
    const records = [use("bad", "TaskCreate", {}, 0), failed, ...created("c2", { subject: "kept" }, "1", 2), update({ taskId: "1", status: "completed" }, STEP.third)];
    expect(factsAt(records).todos).toEqual([{ content: "kept", status: "completed" }]);
  });

  it("leaves no item for a call whose result is an error, whatever else the result says", () => {
    const failed = { type: "user", timestamp: at(1), toolUseResult: { task: { id: "9" } }, message: { content: [{ type: "tool_result", tool_use_id: "bad", is_error: true, content: "Task #9 created" }] } };
    expect(factsAt([use("bad", "TaskCreate", { subject: "x" }, 0), failed]).todos).toEqual([]);
  });

  it("removes a task whose status is set to deleted", () => {
    const records = [...created("c1", { subject: "a" }, "1", 1), ...created("c2", { subject: "b" }, "2", 2), update({ taskId: "1", status: "deleted" }, STEP.third)];
    expect(factsAt(records).todos).toEqual([{ content: "b", status: "pending" }]);
  });

  it("changes a task's title only with a subject: an update's description is a detail", () => {
    const first = [...created("c1", { subject: "title", description: "detail" }, "1", 1), update({ taskId: "1", description: "more detail" }, 2)];
    expect(factsAt(first).todos).toEqual([{ content: "title", status: "pending" }]);
    expect(factsAt([...first, update({ taskId: "1", subject: "new title" }, STEP.third)]).todos).toEqual([{ content: "new title", status: "pending" }]);
  });

  it("uses a TaskCreate's description for the title only when it has no subject", () => {
    expect(factsAt(created("c", { subject: "s", description: "d" }, "1", 1)).todos[0]?.content).toBe("s");
    expect(factsAt(created("c", { description: "d" }, "1", 1)).todos[0]?.content).toBe("d");
  });

  it("starts a new list when a task is made with an identifier the list already has, since the client numbers from one again once its list is empty", () => {
    const records = [...created("c1", { subject: "old one" }, "1", 1), ...created("c2", { subject: "old two" }, "2", 2), update({ taskId: "1", status: "completed" }, STEP.third), ...created("c3", { subject: "new one" }, "1", STEP.fourth), update({ taskId: "1", status: "in_progress" }, STEP.fifth), ...created("c4", { subject: "new two" }, "2", STEP.sixth)];
    expect(factsAt(records).todos).toEqual([
      { content: "new one", status: "in_progress" },
      { content: "new two", status: "pending" },
    ]);
  });

  it("does not find a task by its place in the list", () => {
    const records = [...created("c1", { subject: "a" }, "5", 1), update({ taskId: "1", status: "completed" }, 2)];
    expect(factsAt(records).todos).toEqual([{ content: "a", status: "pending" }]);
  });

  it("ignores an update to a task that is not there, or that names none, or that sets a status it does not know", () => {
    const records = [...created("c", { subject: "a" }, "1", 1), update({ taskId: "9", status: "completed" }, 2), update({}, STEP.third), update({ taskId: "1", status: "blocked" }, STEP.fourth)];
    expect(factsAt(records).todos).toEqual([{ content: "a", status: "pending" }]);
  });

  it("finishes an item from a result written before its call", () => {
    const [useC = {}, resultC = {}] = created("c", { subject: "a" }, "4", 1);
    expect(factsAt([resultC, useC]).todos).toEqual([{ content: "a", status: "pending" }]);
  });

  it("lets a later update name a task by the identifier it had before a TodoWrite wrote the list again", () => {
    const records = [...created("c1", { subject: "keep" }, "k", 1), todoWrite([{ content: "keep", status: "pending" }, { content: "new", status: "pending" }], 2), update({ taskId: "k", status: "completed" }, STEP.third)];
    expect(factsAt(records).todos.map((todo) => `${todo.content ?? ""}:${todo.status}`)).toEqual(["keep:completed", "new:pending"]);
  });

  it("gives two items with the same words each their own identifier when the list is written again", () => {
    const records = [...created("c1", { subject: "same" }, "a", 1), ...created("c2", { subject: "same" }, "b", 2), todoWrite([{ content: "same", status: "pending" }, { content: "same", status: "pending" }], STEP.third), update({ taskId: "b", status: "completed" }, STEP.fourth)];
    expect(factsAt(records).todos.map((todo) => todo.status)).toEqual(["pending", "completed"]);
  });

  it("keeps only the latest items of a very long list", () => {
    const records = Array.from({ length: MAX_TRACKED_TODOS + EXTRA_TODOS }, (_, index) => created(`c${String(index)}`, { subject: `task ${String(index)}` }, String(index), index)).flat();
    const { todos } = factsAt(records);
    expect(todos).toHaveLength(MAX_TRACKED_TODOS);
    expect(todos[0]?.content).toBe("task 3");
  });
});

describe("the text the state keeps", () => {
  const over = "x".repeat(MAX_STORED_TEXT_CHARS * MANY_TIMES_THE_LIMIT);
  const exactly = "y".repeat(MAX_STORED_TEXT_CHARS);

  it("is cut to the most characters the state keeps, for every text a call carries", () => {
    const facts = factsAt([
      use("r", "Read", { file_path: over }),
      use("g", "Agent", { subagent_type: over, description: over, model: over }),
      use("t", "TodoWrite", { todos: [{ content: over, status: "pending" }] }),
      use("c", "TaskCreate", { subject: over }),
      { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Task #1 created" }] } },
      use("s", "Skill", { skill: over }),
      use("m", `mcp__${over}__tool`),
    ]);
    expect(facts.tools[0]?.target).toHaveLength(MAX_STORED_TEXT_CHARS);
    expect(facts.agents[0]?.type).toHaveLength(MAX_STORED_TEXT_CHARS);
    expect(facts.agents[0]?.description).toHaveLength(MAX_STORED_TEXT_CHARS);
    expect(facts.agents[0]?.model).toHaveLength(MAX_STORED_TEXT_CHARS);
    expect(facts.todos.map((todo) => todo.content?.length)).toEqual([MAX_STORED_TEXT_CHARS, MAX_STORED_TEXT_CHARS]);
    expect(facts.skills.names[0]).toHaveLength(MAX_STORED_TEXT_CHARS);
    expect(facts.mcpServers.names[0]).toHaveLength(MAX_STORED_TEXT_CHARS);
  });

  it("keeps the state, which is rewritten to the cache file at every refresh, under a mebibyte when every list is full of texts far longer than any row draws", () => {
    const huge = "z".repeat(ONE_MEBIBYTE);
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < MAX_TRACKED_TODOS; index += 1) {
      records.push(use(`c${String(index)}`, "TaskCreate", { subject: huge }), { type: "user", timestamp: at(1), message: { content: [{ type: "tool_result", tool_use_id: `c${String(index)}`, content: `Task #${String(index)} created` }] } });
    }
    for (let index = 0; index < MAX_TRACKED_NAMES; index += 1) {
      records.push(use(`s${String(index)}`, "Skill", { skill: `${String(index)}${huge}` }), use(`m${String(index)}`, `mcp__${String(index)}${huge}__tool`));
    }
    for (let index = 0; index < MAX_TRACKED_TOOL_CALLS; index += 1) {
      records.push(use(`t${String(index)}`, `Read${huge}`, { file_path: huge }));
    }
    for (let index = 0; index < MAX_TRACKED_AGENTS; index += 1) {
      records.push(use(`g${String(index)}`, "Agent", { subagent_type: huge, description: huge, model: huge }));
    }
    expect(JSON.stringify(fold(records)).length).toBeLessThan(ONE_MEBIBYTE);
  });

  it("leaves a text of exactly that many characters whole", () => {
    expect(factsAt([use("r", "Read", { file_path: exactly })]).tools[0]?.target).toBe(exactly);
  });

  it("cuts between characters a person sees, never inside one", () => {
    const family = "\u{1F469}\u200D\u{1F4BB}";
    const cut = factsAt([use("r", "Read", { file_path: family.repeat(MAX_STORED_TEXT_CHARS) })]).tools[0]?.target ?? "";
    expect(cut.length % family.length).toBe(0);
    expect(cut.length).toBeGreaterThan(0);
  });
});

describe("the state", () => {
  it("is plain JSON that its schema reads back unchanged", () => {
    const state = fold([use("a", "Read", { file_path: "/x" }), result("a", SECOND), use("b", "Skill", { skill: "s" }), use("g", "Agent", { run_in_background: true }), use("t", "TaskCreate", { subject: "x" }), result("t", SECOND)]);
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
  const older = fold([use("a", "Read", {}, 1), result("a", 2), use("t", "TaskCreate", { subject: "old" }, STEP.third), { type: "user", timestamp: at(STEP.third), message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Task #1 created successfully: old" }] } }, use("s", "Skill", { skill: "early" }, STEP.fourth)]);
  const end = (records: readonly Record<string, unknown>[]) => records.reduce<ActivityLatest>((state, record) => {
    const parsed = parseTranscriptRecord(JSON.stringify(record));
    return parsed === undefined ? state : foldActivityLatest(state, parsed);
  }, EMPTY_ACTIVITY_LATEST);

  it("shows the end's calls alone, and none of the state's, which were made before records that were not read", () => {
    const newer = end([use("b", "Grep", {}, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, newer).tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["Grep:running"]);
  });

  it("shows the end's result of a call, not the state's", () => {
    const overlapping = end([use("a", "Read", {}, 1), result("a", 2)]);
    expect(activityFactsOf(fold([use("a", "Read", {}, 1)]), T0 + SECOND, LIMITS, overlapping).tools.map((tool) => tool.status)).toEqual(["completed"]);
  });

  it("shows the end's agents alone", () => {
    const state = fold([use("g", "Agent", { subagent_type: "Old" }, 1)]);
    const newer = end([use("h", "Agent", { subagent_type: "New" }, STEP.ninth)]);
    expect(activityFactsOf(state, T0 + SECOND, LIMITS, newer).agents.map((agent) => agent.type)).toEqual(["New"]);
  });

  it("draws no list unless the end holds a TodoWrite, since a list the state has is out of date and the end holds only a part of the new one", () => {
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, end([use("g", "Grep", {}, STEP.ninth)])).todos).toEqual([]);
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, end([use("c", "TaskCreate", { subject: "tail" }, STEP.ninth)])).todos).toEqual([]);
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, end([use("u", "TaskUpdate", { taskId: "9" }, STEP.ninth)])).todos).toEqual([]);
    const written = end([use("w", "TodoWrite", { todos: [{ content: "fresh", status: "in_progress" }] }, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, written).todos.map((todo) => todo.content)).toEqual(["fresh"]);
  });

  it("leaves the skills and servers to the state, since they add up over the whole transcript", () => {
    const newer = end([use("s", "Skill", { skill: "late" }, STEP.ninth)]);
    expect(activityFactsOf(older, T0 + SECOND, LIMITS, newer).skills.names).toEqual(["early"]);
  });
});

describe("a transcript read in growing steps", () => {
  /** A session with calls in parallel, an agent, a todo list written and then edited, and a skill. */
  const SESSION: readonly Record<string, unknown>[] = [
    use("r1", "Read", { file_path: "/a" }, 1),
    use("g1", "Grep", { pattern: "x" }, 1),
    result("g1", 2),
    result("r1", 2),
    use("w1", "TodoWrite", { todos: [{ content: "one", status: "in_progress" }, { content: "two", status: "pending" }] }, STEP.third),
    result("w1", STEP.third),
    use("ag", "Agent", { subagent_type: "Explore", description: "look" }, STEP.fourth),
    result("ag", STEP.fifth),
    use("e1", "Edit", { file_path: "/b" }, STEP.fifth),
    use("c1", "TaskCreate", { subject: "three" }, STEP.sixth),
    { type: "user", timestamp: at(STEP.sixth), message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Task #7 created successfully: three" }] } },
    result("e1", STEP.sixth),
    use("sk", "Skill", { skill: "commit" }, STEP.ninth),
    use("w2", "TodoWrite", { todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }] }, STEP.ninth + 1),
    use("b1", "Bash", { command: "ls" }, STEP.ninth + 2),
    result("b1", STEP.ninth + STEP.third),
  ].map((record, index) => inResponse(`resp${String(index)}`, record));

  function inResponse(key: string, record: Record<string, unknown>): Record<string, unknown> {
    return { ...record, message: { ...(isRecord(record.message) ? record.message : {}), id: key } };
  }

  const endOf = (records: readonly Record<string, unknown>[]): ActivityLatest =>
    records.reduce<ActivityLatest>((state, record) => {
      const parsed = parseTranscriptRecord(JSON.stringify(record));
      return parsed === undefined ? state : foldActivityLatest(state, parsed);
    }, EMPTY_ACTIVITY_LATEST);

  it("shows lists that end the way the whole transcript's do, whichever part of the end it has read", () => {
    const whole = activityFactsOf(fold(SESSION), T0 + SECOND, LIMITS);
    for (let start = 0; start < SESSION.length; start += 1) {
      const caught = activityFactsOf(fold(SESSION.slice(0, start)), T0 + SECOND, LIMITS, endOf(SESSION.slice(start)));
      expect(whole.tools.slice(whole.tools.length - caught.tools.length), `tools from record ${String(start)}`).toEqual(caught.tools);
      expect(whole.agents.slice(whole.agents.length - caught.agents.length), `agents from record ${String(start)}`).toEqual(caught.agents);
      expect([[], whole.todos], `todos from record ${String(start)}`).toContainEqual(caught.todos);
    }
  });

  it("shows the whole transcript's facts once the end is the whole transcript", () => {
    const whole = activityFactsOf(fold(SESSION), T0 + SECOND, LIMITS);
    expect(activityFactsOf(fold([]), T0 + SECOND, LIMITS, endOf(SESSION))).toEqual({ ...whole, skills: EMPTY_ACTIVITY_FACTS.skills, mcpServers: EMPTY_ACTIVITY_FACTS.mcpServers });
  });
});
