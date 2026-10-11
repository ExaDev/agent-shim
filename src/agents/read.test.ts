import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { listSessions, readSessionAgentTree, type SessionRef } from "./read";
import { SessionAgentTreeSchema } from "./schema";

const CONFIG = "/cfg";
const PROJECT = "-work-repo";
const SESSION = "00000000-0000-4000-8000-000000000001";
const SESSION_DIR = `${CONFIG}/projects/${PROJECT}/${SESSION}`;
const REF: SessionRef = { project: PROJECT, sessionId: SESSION, superseded: false, entry: SESSION };

function meta(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}

/** The seed entries for one agent: its meta file and a transcript holding the given text. */
function agent(dir: string, id: string, metaValue: Readonly<Record<string, unknown>>, transcript = ""): Record<string, string> {
  return {
    [`${dir}/agent-${id}.meta.json`]: meta(metaValue),
    [`${dir}/agent-${id}.jsonl`]: transcript,
  };
}

describe("listSessions", () => {
  it("finds a session by its transcript, by an agents directory, and a superseded one, and ignores other directories", () => {
    const fs = createFakeFarmFs({
      [`${CONFIG}/projects/${PROJECT}/aaa.jsonl`]: "",
      [`${CONFIG}/projects/${PROJECT}/bbb/subagents/agent-x.meta.json`]: "{}",
      [`${CONFIG}/projects/${PROJECT}/ccc.superseded-1788265839607/workflows/wf_1.json`]: "{}",
      [`${CONFIG}/projects/${PROJECT}/memory/note.md`]: "",
    });
    expect(listSessions(fs, CONFIG)).toEqual([
      { project: PROJECT, sessionId: "aaa", superseded: false, entry: "aaa" },
      { project: PROJECT, sessionId: "bbb", superseded: false, entry: "bbb" },
      { project: PROJECT, sessionId: "ccc", superseded: true, entry: "ccc.superseded-1788265839607" },
    ]);
  });

  it("returns nothing when there is no projects directory", () => {
    expect(listSessions(createFakeFarmFs(), CONFIG)).toEqual([]);
  });
});

describe("archived copies", () => {
  it("lists a superseded or orphaned copy against the session it archives, flagged as archived", () => {
    const fs = createFakeFarmFs({
      [`${CONFIG}/projects/${PROJECT}/aaa.orphaned-1788265839607-1a2b3c.jsonl`]: "",
      [`${CONFIG}/projects/${PROJECT}/bbb.superseded-1788265839607/subagents/agent-x.meta.json`]: "{}",
    });
    expect(listSessions(fs, CONFIG)).toEqual([
      { project: PROJECT, sessionId: "aaa", superseded: true, entry: "aaa.orphaned-1788265839607-1a2b3c" },
      { project: PROJECT, sessionId: "bbb", superseded: true, entry: "bbb.superseded-1788265839607" },
    ]);
  });
});

describe("readSessionAgentTree", () => {
  it("reads an empty session as an empty tree", () => {
    const tree = readSessionAgentTree(createFakeFarmFs(), CONFIG, REF);
    expect(tree).toEqual({ project: PROJECT, sessionId: SESSION, superseded: false, agents: [], tasks: [], workflowRuns: [], problems: [] });
  });

  it("classifies kinds from the meta file and keeps the optional fields it has", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "a1", { agentType: "Explore", description: "look", spawnDepth: 1, toolUseId: "toolu_a", model: "sonnet", requestShape: "background" }),
      ...agent(sub, "a2", { agentType: "fork", isFork: true, name: "tidy", spawnDepth: 1 }),
      ...agent(sub, "a3", { agentType: "general-purpose", taskKind: "in_process_teammate", teamName: "t" }),
      ...agent(`${sub}/workflows/wf_run1`, "a4", { agentType: "workflow-subagent", spawnDepth: 1, workflowPhase: "plan" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toEqual([]);
    const byId = new Map(tree.agents.map((node) => [node.id, node]));
    expect(byId.get("a1")).toMatchObject({ kind: "subagent", agentType: "Explore", description: "look", toolUseId: "toolu_a", model: "sonnet", background: true });
    expect(byId.get("a2")).toMatchObject({ kind: "fork", name: "tidy" });
    expect(byId.get("a3")).toMatchObject({ kind: "teammate", teamName: "t" });
    expect(byId.get("a4")).toMatchObject({ kind: "workflow-agent", workflowRunId: "wf_run1", workflowPhase: "plan" });
    expect(byId.get("a1")?.transcript).toBe(`projects/${PROJECT}/${SESSION}/subagents/agent-a1.jsonl`);
  });

  it("nests an agent under the parentAgentId it names", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p", { agentType: "Plan", spawnDepth: 1 }),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, parentAgentId: "p" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.agents.map((node) => node.id)).toEqual(["p"]);
    expect(tree.agents[0]?.children.map((node) => node.id)).toEqual(["c"]);
  });

  it("finds the parent of a deeper agent from the transcript that recorded the spawning call", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p1", { agentType: "Plan", spawnDepth: 1 }, '{"type":"assistant","id":"toolu_other"}'),
      ...agent(sub, "p2", { agentType: "Plan", spawnDepth: 1 }, '{"type":"assistant","id":"toolu_child"}'),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, toolUseId: "toolu_child" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toEqual([]);
    expect(tree.agents.find((node) => node.id === "p2")?.children.map((node) => node.id)).toEqual(["c"]);
    expect(tree.agents.find((node) => node.id === "p1")?.children).toEqual([]);
  });

  it("leaves a deeper agent at the top and reports it when no transcript records its spawning call", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p", { agentType: "Plan", spawnDepth: 1 }, ""),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, toolUseId: "toolu_x" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.agents.map((node) => node.id).sort()).toEqual(["c", "p"]);
    expect(tree.problems).toEqual([{ path: `projects/${PROJECT}/${SESSION}/subagents/agent-c.meta.json`, reason: "no agent transcript records the call that spawned it" }]);
  });

  it("does not attach across workflow runs when matching a spawning call", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(`${sub}/workflows/wf_a`, "p", { agentType: "workflow-subagent", spawnDepth: 1 }, "toolu_c"),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, toolUseId: "toolu_c" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.agents).toHaveLength(2);
    expect(tree.problems).toHaveLength(1);
  });

  it("refuses a parent that would make a cycle", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "a", { agentType: "Plan", spawnDepth: 2, parentAgentId: "b" }),
      ...agent(sub, "b", { agentType: "Plan", spawnDepth: 2, parentAgentId: "a" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toHaveLength(1);
    expect(tree.problems[0]?.reason).toContain("cycle");
    expect(tree.agents).toHaveLength(1);
    expect(tree.agents[0]?.children).toHaveLength(1);
  });

  it("reports an unreadable meta file and still returns the others", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      [`${sub}/agent-bad.meta.json`]: "not json",
      [`${sub}/agent-notype.meta.json`]: "{}",
      ...agent(sub, "ok", { agentType: "Explore" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.agents.map((node) => node.id)).toEqual(["ok"]);
    expect(tree.problems.map((problem) => problem.path.split("/").pop() ?? "").sort((left, right) => left.localeCompare(right))).toEqual(["agent-bad.meta.json", "agent-notype.meta.json"]);
  });

  it("tolerates keys it has never seen", () => {
    const fs = createFakeFarmFs(agent(`${SESSION_DIR}/subagents`, "a", { agentType: "Explore", someFutureField: { nested: true } }));
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toEqual([]);
    expect(tree.agents).toHaveLength(1);
  });

  it("reads the task list, defaulting missing link lists and skipping bookkeeping files", () => {
    const dir = `${CONFIG}/tasks/${SESSION}`;
    const fs = createFakeFarmFs({
      [`${dir}/1.json`]: meta({ id: "1", subject: "first", description: "d", status: "completed", blocks: ["2"], blockedBy: [] }),
      [`${dir}/2.json`]: meta({ id: "2", subject: "second", status: "todo" }),
      [`${dir}/3.json`]: "[]",
      [`${dir}/.highwatermark`]: "3",
      [`${dir}/.lock`]: "",
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.tasks).toEqual([
      { id: "1", subject: "first", description: "d", status: "completed", blocks: ["2"], blockedBy: [] },
      { id: "2", subject: "second", status: "todo", blocks: [], blockedBy: [] },
    ]);
    expect(tree.problems).toEqual([{ path: `tasks/${SESSION}/3.json`, reason: "task file is not a task" }]);
  });

  it("reads a workflow run record down to its phase titles", () => {
    const fs = createFakeFarmFs({
      [`${SESSION_DIR}/workflows/wf_run1.json`]: meta({ runId: "wf_run1", workflowName: "review", status: "completed", startTime: 5, phases: [{ title: "Plan" }, { title: "Do" }], summary: "s", script: "x" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.workflowRuns).toEqual([{ runId: "wf_run1", workflowName: "review", status: "completed", startTime: 5, phases: ["Plan", "Do"], summary: "s" }]);
  });

  it("reads a superseded session under its own directory but reports the base session id", () => {
    const entry = `${SESSION}.superseded-1788265839607`;
    const fs = createFakeFarmFs(agent(`${CONFIG}/projects/${PROJECT}/${entry}/subagents`, "a", { agentType: "Explore" }));
    const tree = readSessionAgentTree(fs, CONFIG, { project: PROJECT, sessionId: SESSION, superseded: true, entry });
    expect(tree.sessionId).toBe(SESSION);
    expect(tree.superseded).toBe(true);
    expect(tree.agents).toHaveLength(1);
  });

  it("returns a tree that satisfies its own schema", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p", { agentType: "Plan", spawnDepth: 1 }),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, parentAgentId: "p" }),
      [`${CONFIG}/tasks/${SESSION}/1.json`]: meta({ id: "1", subject: "s", status: "pending" }),
    });
    expect(SessionAgentTreeSchema.safeParse(readSessionAgentTree(fs, CONFIG, REF)).success).toBe(true);
  });

  it("reports a file that cannot be read and still returns the rest of the tree", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const base = createFakeFarmFs({
      ...agent(sub, "ok", { agentType: "Explore" }),
      ...agent(sub, "locked", { agentType: "Plan" }),
      [`${CONFIG}/tasks/${SESSION}/1.json`]: meta({ id: "1", subject: "s", status: "pending" }),
    });
    const fs = {
      ...base,
      readFileUtf8: (candidate: string) => {
        if (candidate.endsWith("agent-locked.meta.json") || candidate.endsWith("/1.json")) {
          throw new Error("EACCES: permission denied");
        }
        return base.readFileUtf8(candidate);
      },
    };
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.agents.map((node) => node.id)).toEqual(["ok"]);
    expect(tree.tasks).toEqual([]);
    expect(tree.problems.map((problem) => problem.reason)).toEqual([expect.stringContaining("EACCES"), expect.stringContaining("EACCES")]);
  });

  it("infers a parent from the transcript when no depth was recorded, and leaves an unowned agent at the top without a problem", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p", { agentType: "Plan", toolUseId: "toolu_top" }, '{"id":"toolu_child"}'),
      ...agent(sub, "c", { agentType: "Explore", toolUseId: "toolu_child" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toEqual([]);
    expect(tree.agents.map((node) => node.id)).toEqual(["p"]);
    expect(tree.agents[0]?.children.map((node) => node.id)).toEqual(["c"]);
  });

  it("reads a team's shared task list beside the session's own, marking each task with its list", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "t", { agentType: "general-purpose", taskKind: "in_process_teammate", teamName: "squad" }),
      [`${CONFIG}/tasks/${SESSION}/1.json`]: meta({ id: "1", subject: "own", status: "pending" }),
      [`${CONFIG}/tasks/squad/1.json`]: meta({ id: "1", subject: "shared", status: "in_progress", taskList: "ignored" }),
    });
    expect(readSessionAgentTree(fs, CONFIG, REF).tasks).toEqual([
      { id: "1", subject: "own", status: "pending", blocks: [], blockedBy: [] },
      { id: "1", subject: "shared", status: "in_progress", blocks: [], blockedBy: [], taskList: "squad" },
    ]);
  });
  it("keeps a parent eligible when it recorded no spawn depth but the child did", () => {
    const sub = `${SESSION_DIR}/subagents`;
    const fs = createFakeFarmFs({
      ...agent(sub, "p", { agentType: "Plan" }, '{"id":"toolu_child"}'),
      ...agent(sub, "c", { agentType: "Explore", spawnDepth: 2, toolUseId: "toolu_child" }),
    });
    const tree = readSessionAgentTree(fs, CONFIG, REF);
    expect(tree.problems).toEqual([]);
    expect(tree.agents.map((node) => node.id)).toEqual(["p"]);
    expect(tree.agents[0]?.children.map((node) => node.id)).toEqual(["c"]);
  });

  it("reads a custom task list the caller names, once, tagged with its id", () => {
    const fs = createFakeFarmFs({
      [`${CONFIG}/tasks/${SESSION}/1.json`]: meta({ id: "1", subject: "own", status: "pending" }),
      [`${CONFIG}/tasks/shared-list/7.json`]: meta({ id: "7", subject: "custom", status: "pending" }),
    });
    expect(readSessionAgentTree(fs, CONFIG, REF, { taskListIds: ["shared-list", "shared-list", SESSION] }).tasks).toEqual([
      { id: "1", subject: "own", status: "pending", blocks: [], blockedBy: [] },
      { id: "7", subject: "custom", status: "pending", blocks: [], blockedBy: [], taskList: "shared-list" },
    ]);
  });
});
