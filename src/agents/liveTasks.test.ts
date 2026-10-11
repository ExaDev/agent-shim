import { describe, expect, it } from "vitest";

import { LIVE_TASK_CAP, applyAgentTaskEvent, mergeLiveTasks, type LiveTask, type LiveTaskBook } from "./liveTasks";
import type { SessionAgentTree } from "./schema";

const CSE = "cse_00000000-0000-4000-8000-000000000001";
const LOCAL = "11111111-2222-4333-8444-555555555555";

const FIRST = 1;
const SECOND = 2;
const THIRD = 3;
const FOURTH = 4;

function apply(book: LiveTaskBook, payload: unknown, observedAt = FIRST): LiveTaskBook {
  return applyAgentTaskEvent(book, CSE, payload, observedAt);
}

describe("applyAgentTaskEvent", () => {
  it("births a task from task_started and refines it from progress, a patch and the notification", () => {
    let book: LiveTaskBook = new Map();
    book = apply(
      book,
      { type: "system", subtype: "task_started", task_id: "a1", run_id: "r", tool_use_id: "toolu_1", description: "look", task_type: "local_agent", subagent_type: "Explore", spawn_depth: 1, is_backgrounded: true },
      FIRST,
    );
    expect(book.get("a1")).toEqual({ taskId: "a1", sessionId: CSE, runId: "r", toolUseId: "toolu_1", description: "look", taskType: "local_agent", subagentType: "Explore", spawnDepth: 1, backgrounded: true, status: "running", observedAt: FIRST });

    book = apply(book, { type: "system", subtype: "task_progress", task_id: "a1", last_tool_name: "Read", usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 } }, SECOND);
    expect(book.get("a1")).toMatchObject({ lastToolName: "Read", usage: { totalTokens: 5, toolUses: 1, durationMs: 9 }, status: "running", observedAt: SECOND, description: "look" });

    book = apply(book, { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "completed", end_time: 99 } }, THIRD);
    expect(book.get("a1")).toMatchObject({ status: "completed", observedAt: THIRD });

    book = apply(book, { type: "system", subtype: "task_notification", task_id: "a1", status: "completed", output_file: `/tmp/proj/${LOCAL}/tasks/a1.output`, summary: "done" }, FOURTH);
    expect(book.get("a1")).toMatchObject({ outputFile: `/tmp/proj/${LOCAL}/tasks/a1.output`, summary: "done", subagentType: "Explore" });
  });

  it("keeps what an earlier event said when a later one omits the field", () => {
    let book = apply(new Map(), { type: "system", subtype: "task_started", task_id: "t", description: "keep", parent_task_id: "p" });
    book = apply(book, { type: "system", subtype: "task_progress", task_id: "t" }, SECOND);
    expect(book.get("t")).toMatchObject({ description: "keep", parentTaskId: "p" });
  });

  it("fills in tasks a snapshot lists without finishing the ones it omits", () => {
    let book = apply(new Map(), { type: "system", subtype: "task_started", task_id: "old", task_type: "local_bash" });
    book = apply(book, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "new", run_id: "r", task_type: "local_agent", description: "d" }] });
    expect(book.get("new")).toMatchObject({ taskType: "local_agent", description: "d", status: "running" });
    expect(book.get("old")).toMatchObject({ status: "running" });
  });

  it("ignores payloads that are not task events, and leaves the book untouched", () => {
    const book: LiveTaskBook = new Map();
    expect(apply(book, { type: "assistant" })).toBe(book);
    expect(apply(book, { type: "system", subtype: "init" })).toBe(book);
    expect(apply(book, { type: "system", subtype: "task_started" })).toBe(book);
    expect(apply(book, "text")).toBe(book);
  });

  it("evicts finished tasks past the cap, oldest first, and never a running one", () => {
    let book: LiveTaskBook = new Map();
    book = apply(book, { type: "system", subtype: "task_started", task_id: "running" }, 0);
    for (let index = 0; index < LIVE_TASK_CAP; index += 1) {
      book = apply(book, { type: "system", subtype: "task_started", task_id: `t${String(index)}` }, index + 1);
      book = apply(book, { type: "system", subtype: "task_updated", task_id: `t${String(index)}`, patch: { status: "completed" } }, index + 1);
    }
    expect(book.size).toBe(LIVE_TASK_CAP);
    expect(book.has("running")).toBe(true);
    expect(book.has("t0")).toBe(false);
  });
});

const TREE: SessionAgentTree = {
  project: "-p",
  sessionId: LOCAL,
  superseded: false,
  agents: [
    {
      id: "a1",
      kind: "subagent",
      agentType: "Explore",
      transcript: "t1",
      children: [{ id: "named-hash", kind: "subagent", agentType: "Plan", toolUseId: "toolu_named", transcript: "t2", children: [] }],
    },
    { id: "a3", kind: "fork", agentType: "fork", transcript: "t3", children: [] },
  ],
  tasks: [],
  workflowRuns: [],
  problems: [],
};

function live(fields: Partial<LiveTask> & { taskId: string }): LiveTask {
  return { sessionId: CSE, status: "running", observedAt: 1, ...fields };
}

describe("mergeLiveTasks", () => {
  it("attaches a live task to the disk agent by task id or by tool use id and marks provenance", () => {
    const merged = mergeLiveTasks(TREE, [live({ taskId: "a1" }), live({ taskId: "other", toolUseId: "toolu_named", status: "completed" })]);
    expect(merged.agents[0]).toMatchObject({ id: "a1", provenance: "both", live: { taskId: "a1" } });
    expect(merged.agents[0]?.children[0]).toMatchObject({ id: "named-hash", provenance: "both", live: { taskId: "other", status: "completed" } });
    expect(merged.agents[1]).toMatchObject({ id: "a3", provenance: "disk" });
    expect(merged.agents[1]).not.toHaveProperty("live");
    expect(merged.remoteSessions).toEqual([CSE]);
    expect(merged.liveOnly).toEqual([]);
  });

  it("keeps the disk fields as they are", () => {
    const merged = mergeLiveTasks(TREE, [live({ taskId: "a1", description: "from the stream" })]);
    expect(merged.agents[0]).toMatchObject({ id: "a1", kind: "subagent", agentType: "Explore", transcript: "t1" });
    expect(merged.agents[0]).not.toHaveProperty("description");
  });

  it("lists a live task that matches no agent only when its output file sits under this session", () => {
    const own = live({ taskId: "bg", taskType: "local_bash", outputFile: `/tmp/p/${LOCAL}/tasks/bg.output` });
    const foreign = live({ taskId: "elsewhere", outputFile: "/tmp/p/99999999-0000-4000-8000-000000000000/tasks/e.output" });
    const merged = mergeLiveTasks(TREE, [own, foreign]);
    expect(merged.liveOnly).toEqual([own]);
    expect(merged.remoteSessions).toEqual([CSE]);
  });

  it("is the plain disk tree with no remote sessions when nothing is live", () => {
    const merged = mergeLiveTasks(TREE, []);
    expect(merged.remoteSessions).toEqual([]);
    expect(merged.liveOnly).toEqual([]);
    expect(merged.agents.map((node) => node.provenance)).toEqual(["disk", "disk"]);
  });
});
