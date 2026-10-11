import path from "node:path";
import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import {
  AgentMetaSchema,
  TaskItemSchema,
  type AgentKind,
  type AgentMeta,
  type AgentNode,
  type AgentTreeProblem,
  type SessionAgentTree,
  type TaskItem,
  type WorkflowRun,
} from "./schema";

/**
 * The agent tree reader: pure over an injected filesystem, so the CLI, the library surface and tests read the same way, and nothing here writes. The layout it reads is documented in `docs/agent-transcripts.md`.
 */

/** The filesystem reads the agent tree reader needs. */
export type AgentReadFs = Pick<FarmFs, "readFileUtf8" | "readdir" | "lstat">;

/** The directory under an identity's configuration directory that holds every project's transcripts. */
const PROJECTS_DIR = "projects";
const TASKS_DIR = "tasks";
const SUBAGENTS_DIR = "subagents";
const WORKFLOWS_DIR = "workflows";
const AGENT_FILE_PREFIX = "agent-";
const META_SUFFIX = ".meta.json";
const TRANSCRIPT_SUFFIX = ".jsonl";
/** Current Claude Code names a session's own list `session-` plus this many leading characters of its id. */
const SHORT_SESSION_ID_LENGTH = 8;
const SHORT_SESSION_LIST_PREFIX = "session-";
const JSON_SUFFIX = ".json";
const WORKFLOW_RUN_PREFIX = "wf_";
/** The suffix of an archived copy: a resume appends `.superseded-<epoch ms>` to the session directory it replaced, and Claude Code archives a replaced transcript as `.orphaned-<epoch ms>-<hash>`. */
const ARCHIVED_RE = /^(.+)\.(?:superseded|orphaned)-.+$/;
const FORK_AGENT_TYPE = "fork";
const WORKFLOW_AGENT_TYPE = "workflow-subagent";
const TEAMMATE_TASK_KIND = "in_process_teammate";
const BACKGROUND_REQUEST_SHAPE = "background";
/** A spawn depth of 1 is an agent the session itself spawned. */
const SESSION_SPAWN_DEPTH = 1;

/** One session found under a project: its directory name split into the session id and whether the entry is an archived copy (superseded by a resume, or orphaned) rather than the live session. */
export interface SessionRef {
  readonly project: string;
  readonly sessionId: string;
  readonly superseded: boolean;
  /** The directory (and transcript stem) name exactly as on disk, which differs from `sessionId` for an archived copy. */
  readonly entry: string;
}

function parseEntry(project: string, entry: string): SessionRef {
  const match = ARCHIVED_RE.exec(entry);
  const base = match?.[1];
  return base === undefined ? { project, sessionId: entry, superseded: false, entry } : { project, sessionId: base, superseded: true, entry };
}

/** Lists every session under every project: a transcript file, or a directory holding agents or workflow runs. Sorted by project then entry so output is stable. */
export function listSessions(fs: AgentReadFs, configDir: string): readonly SessionRef[] {
  const found: SessionRef[] = [];
  for (const project of fs.readdir(path.join(configDir, PROJECTS_DIR))) {
    const projectDir = path.join(configDir, PROJECTS_DIR, project);
    const entries = new Set<string>();
    for (const name of fs.readdir(projectDir)) {
      if (name.endsWith(TRANSCRIPT_SUFFIX)) {
        entries.add(name.slice(0, -TRANSCRIPT_SUFFIX.length));
        continue;
      }
      const children = fs.readdir(path.join(projectDir, name));
      if (children.includes(SUBAGENTS_DIR) || children.includes(WORKFLOWS_DIR)) {
        entries.add(name);
      }
    }
    for (const entry of entries) {
      found.push(parseEntry(project, entry));
    }
  }
  return found.sort((left, right) => left.project.localeCompare(right.project) || left.entry.localeCompare(right.entry));
}

/** One session in a listing: the cheap facts read from directory listings and one stat, without parsing any agent. */
export interface SessionSummary extends SessionRef {
  /** How many agent meta files the session has, across its top-level agents and every workflow run. */
  readonly agentCount: number;
  /** How many workflow run records the session has. */
  readonly workflowRunCount: number;
  /** When the session's transcript was last written, as an ISO instant; absent when there is no transcript file. */
  readonly updatedAt?: string;
}

/** A meta file located on disk, before it is read. */
interface LocatedAgent {
  readonly id: string;
  /** Relative to the configuration directory. */
  readonly metaPath: string;
  readonly transcriptPath: string;
  readonly workflowRunId: string | undefined;
}

function locateAgents(fs: AgentReadFs, configDir: string, relativeDir: string, workflowRunId: string | undefined, report: ReportProblem): LocatedAgent[] {
  const located: LocatedAgent[] = [];
  for (const name of listDirOrReport(fs, configDir, relativeDir, report)) {
    if (!name.startsWith(AGENT_FILE_PREFIX) || !name.endsWith(META_SUFFIX)) {
      continue;
    }
    const id = name.slice(AGENT_FILE_PREFIX.length, -META_SUFFIX.length);
    located.push({
      id,
      metaPath: path.join(relativeDir, name),
      transcriptPath: path.join(relativeDir, `${AGENT_FILE_PREFIX}${id}${TRANSCRIPT_SUFFIX}`),
      workflowRunId,
    });
  }
  return located;
}

function kindOf(meta: AgentMeta, workflowRunId: string | undefined): AgentKind {
  if (meta.isFork === true || meta.agentType === FORK_AGENT_TYPE) {
    return "fork";
  }
  if (workflowRunId !== undefined || meta.agentType === WORKFLOW_AGENT_TYPE) {
    return "workflow-agent";
  }
  if (meta.taskKind === TEAMMATE_TASK_KIND || meta.teamName !== undefined) {
    return "teammate";
  }
  return "subagent";
}

/** An agent as read from its meta file, before it is placed in the tree. */
interface ReadAgent {
  readonly located: LocatedAgent;
  readonly meta: AgentMeta;
}

function toNode(read: ReadAgent, children: readonly AgentNode[]): AgentNode {
  const { located, meta } = read;
  return {
    id: located.id,
    kind: kindOf(meta, located.workflowRunId),
    agentType: meta.agentType,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(meta.name === undefined ? {} : { name: meta.name }),
    ...(meta.toolUseId === undefined ? {} : { toolUseId: meta.toolUseId }),
    ...(meta.spawnDepth === undefined ? {} : { spawnDepth: meta.spawnDepth }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.requestShape === undefined ? {} : { background: meta.requestShape === BACKGROUND_REQUEST_SHAPE }),
    ...(located.workflowRunId === undefined ? {} : { workflowRunId: located.workflowRunId }),
    ...(meta.workflowPhase === undefined ? {} : { workflowPhase: meta.workflowPhase }),
    ...(meta.teamName === undefined ? {} : { teamName: meta.teamName }),
    ...(meta.stoppedByUser === undefined ? {} : { stoppedByUser: meta.stoppedByUser }),
    transcript: located.transcriptPath,
    children,
  };
}

/** Receives one unusable file's report. */
type ReportProblem = (problem: Readonly<AgentTreeProblem>) => void;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a file, reporting a failure (permissions, a transient I/O error) against its configuration-relative path and returning undefined, so one inaccessible file costs the tree that file and nothing else. A file that simply is not there is undefined without a report. */
function readFileOrReport(fs: AgentReadFs, configDir: string, relative: string, report: ReportProblem): string | undefined {
  try {
    return fs.readFileUtf8(path.join(configDir, relative));
  } catch (error: unknown) {
    report({ path: relative, reason: `could not be read: ${describeFailure(error)}` });
    return undefined;
  }
}

/** Lists a directory with the same contract as `readFileOrReport`. */
function listDirOrReport(fs: AgentReadFs, configDir: string, relative: string, report: ReportProblem): readonly string[] {
  try {
    return fs.readdir(path.join(configDir, relative));
  } catch (error: unknown) {
    report({ path: relative, reason: `could not be listed: ${describeFailure(error)}` });
    return [];
  }
}

/** Parses JSON text to `unknown`, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** The task file's own shape: unknown keys are stripped, and the link lists default to empty because older writers omitted them. */
const TaskFileSchema = z.object({ ...TaskItemSchema.omit({ taskList: true }).shape, blocks: z.array(z.string()).default([]), blockedBy: z.array(z.string()).default([]) });

/** The workflow run file's own shape, narrowed to what the tree reports. */
const WorkflowRunFileSchema = z.object({
  runId: z.string(),
  workflowName: z.string().optional(),
  status: z.string().optional(),
  startTime: z.number().optional(),
  phases: z.array(z.object({ title: z.string() })).default([]),
  summary: z.string().optional(),
});

/** What a caller knows about a session that the disk does not record. */
export interface ReadSessionOptions {
  /** Task lists the session was pointed at with `CLAUDE_CODE_TASK_LIST_ID`, which is a property of the process environment and is written nowhere in the session's files. Each is read from `tasks/<id>` and its tasks carry the id as `taskList`. */
  readonly taskListIds?: readonly string[];
}

/** Summarises one session without reading any agent file: listings and one stat only, so it is cheap over every session an identity has. */
export function summariseSession(fs: AgentReadFs, configDir: string, ref: Readonly<SessionRef>): SessionSummary {
  const sessionRelative = path.join(PROJECTS_DIR, ref.project, ref.entry);
  const subagentsRelative = path.join(sessionRelative, SUBAGENTS_DIR);
  const workflowsUnderSubagents = path.join(subagentsRelative, WORKFLOWS_DIR);
  const isMeta = (name: string): boolean => name.startsWith(AGENT_FILE_PREFIX) && name.endsWith(META_SUFFIX);
  let agentCount = fs.readdir(path.join(configDir, subagentsRelative)).filter(isMeta).length;
  for (const runDir of fs.readdir(path.join(configDir, workflowsUnderSubagents))) {
    if (runDir.startsWith(WORKFLOW_RUN_PREFIX)) {
      agentCount += fs.readdir(path.join(configDir, workflowsUnderSubagents, runDir)).filter(isMeta).length;
    }
  }
  const workflowRunCount = fs.readdir(path.join(configDir, sessionRelative, WORKFLOWS_DIR)).filter((name) => name.startsWith(WORKFLOW_RUN_PREFIX) && name.endsWith(JSON_SUFFIX)).length;
  const transcript = fs.lstat(path.join(configDir, PROJECTS_DIR, ref.project, `${ref.entry}${TRANSCRIPT_SUFFIX}`));
  return { ...ref, agentCount, workflowRunCount, ...(transcript === undefined ? {} : { updatedAt: new Date(transcript.mtimeMs).toISOString() }) };
}

/**
 * Reads one session's agents, task list and workflow runs. Every file that cannot be used is listed in `problems` with the reason; a missing directory is simply an empty section, because a session that never spawned an agent has none.
 */
export function readSessionAgentTree(fs: AgentReadFs, configDir: string, ref: SessionRef, options: Readonly<ReadSessionOptions> = {}): SessionAgentTree {
  const problems: AgentTreeProblem[] = [];
  const report: ReportProblem = (problem) => {
    problems.push(problem);
  };
  const sessionRelative = path.join(PROJECTS_DIR, ref.project, ref.entry);

  const subagentsRelative = path.join(sessionRelative, SUBAGENTS_DIR);
  const workflowsUnderSubagents = path.join(subagentsRelative, WORKFLOWS_DIR);
  const located: LocatedAgent[] = locateAgents(fs, configDir, subagentsRelative, undefined, report);
  for (const runDir of listDirOrReport(fs, configDir, workflowsUnderSubagents, report)) {
    if (runDir.startsWith(WORKFLOW_RUN_PREFIX)) {
      located.push(...locateAgents(fs, configDir, path.join(workflowsUnderSubagents, runDir), runDir, report));
    }
  }

  const agents = new Map<string, ReadAgent>();
  for (const candidate of located) {
    const text = readFileOrReport(fs, configDir, candidate.metaPath, report);
    if (text === undefined) {
      continue;
    }
    const parsed = AgentMetaSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      report({ path: candidate.metaPath, reason: "meta file is not a JSON object with an agentType" });
      continue;
    }
    agents.set(candidate.id, { located: candidate, meta: parsed.data });
  }

  const teamNames = [...new Set([...agents.values()].flatMap((agent) => (agent.meta.teamName === undefined ? [] : [agent.meta.teamName])))].sort();
  const parentOf = resolveParents(fs, configDir, agents, report);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of agents.keys()) {
    const parent = parentOf.get(id);
    if (parent === undefined) {
      roots.push(id);
    } else {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
    }
  }
  const build = (id: string): AgentNode => {
    const read = agents.get(id);
    if (read === undefined) {
      throw new Error(`agent ${id} is in the tree but was never read`);
    }
    return toNode(read, (childrenOf.get(id) ?? []).sort().map(build));
  };

  return {
    project: ref.project,
    sessionId: ref.sessionId,
    superseded: ref.superseded,
    agents: roots.sort().map(build),
    tasks: readTasks(fs, configDir, ownTaskLists(ref.sessionId), [...new Set([...teamNames, ...(options.taskListIds ?? [])])].filter((id) => !ownTaskLists(ref.sessionId).includes(id)), report),
    workflowRuns: readWorkflowRuns(fs, configDir, path.join(sessionRelative, WORKFLOWS_DIR), report),
    problems,
  };
}

/**
 * Decides each agent's parent. An explicit `parentAgentId` wins. An agent the session spawned itself (depth 1, or no depth recorded) has none. A deeper agent without one is placed under the agent one level up whose transcript contains its `toolUseId`, the only record of who made the call; when that is ambiguous or absent it is left at the top and reported. A parent that would make a cycle is refused and reported.
 */
function resolveParents(fs: AgentReadFs, configDir: string, agents: ReadonlyMap<string, ReadAgent>, report: ReportProblem): Map<string, string> {
  const parentOf = new Map<string, string>();
  const transcriptCache = new Map<string, string>();
  const transcriptOf = (agent: ReadAgent): string => {
    const cached = transcriptCache.get(agent.located.id);
    if (cached !== undefined) {
      return cached;
    }
    const text = readFileOrReport(fs, configDir, agent.located.transcriptPath, report) ?? "";
    transcriptCache.set(agent.located.id, text);
    return text;
  };
  const wouldCycle = (child: string, parent: string): boolean => {
    for (let cursor: string | undefined = parent; cursor !== undefined; cursor = parentOf.get(cursor)) {
      if (cursor === child) {
        return true;
      }
    }
    return false;
  };
  const attach = (child: ReadAgent, parent: string): void => {
    if (wouldCycle(child.located.id, parent)) {
      report({ path: child.located.metaPath, reason: `parent ${parent} would make a cycle` });
      return;
    }
    parentOf.set(child.located.id, parent);
  };

  for (const agent of agents.values()) {
    const { meta, located } = agent;
    if (meta.parentAgentId !== undefined && agents.has(meta.parentAgentId)) {
      attach(agent, meta.parentAgentId);
      continue;
    }
    const depth = meta.spawnDepth;
    if ((depth !== undefined && depth <= SESSION_SPAWN_DEPTH) || meta.toolUseId === undefined) {
      if (meta.parentAgentId !== undefined) {
        report({ path: located.metaPath, reason: `parentAgentId ${meta.parentAgentId} names no agent in this session` });
      }
      continue;
    }
    const toolUseId = meta.toolUseId;
    // A recorded depth narrows the candidates to the level above, but a candidate that recorded no depth (formats that never wrote it) stays eligible. Without a depth on the child every other agent in the same workflow scope is a candidate, and finding no owner then means the session itself spawned it, which is not a problem.
    const owners = [...agents.values()].filter(
      (candidate) =>
        candidate.located.id !== located.id &&
        (depth === undefined || candidate.meta.spawnDepth === undefined || candidate.meta.spawnDepth === depth - 1) &&
        candidate.located.workflowRunId === located.workflowRunId &&
        transcriptOf(candidate).includes(toolUseId),
    );
    const owner = owners[0];
    if (owners.length === 1 && owner !== undefined) {
      attach(agent, owner.located.id);
    } else if (owners.length > 1) {
      report({ path: located.metaPath, reason: "more than one agent transcript records the call that spawned it" });
    } else if (depth !== undefined) {
      report({ path: located.metaPath, reason: "no agent transcript records the call that spawned it" });
    }
  }
  return parentOf;
}

/** The `tasks` directory name Claude Code derives from a session id: the full id in older versions, `session-` and the id's first eight characters in current ones. */
function ownTaskLists(sessionId: string): readonly string[] {
  return [sessionId, `${SHORT_SESSION_LIST_PREFIX}${sessionId.slice(0, SHORT_SESSION_ID_LENGTH)}`];
}

/**
 * Reads the task lists a session can see: its own (see `ownTaskLists`), and each shared list (`tasks/<list-id>`): a team's, named by its teammates' meta, or one the caller names. Shared tasks carry the list id.
 */
function readTasks(fs: AgentReadFs, configDir: string, ownLists: readonly string[], sharedLists: readonly string[], report: ReportProblem): TaskItem[] {
  const tasks: TaskItem[] = [];
  [...ownLists, ...sharedLists].forEach((scope, index) => {
    const relativeDir = path.join(TASKS_DIR, scope);
    for (const name of [...listDirOrReport(fs, configDir, relativeDir, report)].sort()) {
      if (name.startsWith(".") || !name.endsWith(JSON_SUFFIX)) {
        continue;
      }
      const relative = path.join(relativeDir, name);
      const text = readFileOrReport(fs, configDir, relative, report);
      const parsed = TaskFileSchema.safeParse(text === undefined ? undefined : parseJson(text));
      if (parsed.success) {
        // The leading scopes are the session's own; every later one is a shared list.
        tasks.push(index < ownLists.length ? parsed.data : { ...parsed.data, taskList: scope });
      } else if (text !== undefined) {
        report({ path: relative, reason: "task file is not a task" });
      }
    }
  });
  return tasks;
}

function readWorkflowRuns(fs: AgentReadFs, configDir: string, relativeDir: string, report: ReportProblem): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  for (const name of [...listDirOrReport(fs, configDir, relativeDir, report)].sort()) {
    if (!name.startsWith(WORKFLOW_RUN_PREFIX) || !name.endsWith(JSON_SUFFIX)) {
      continue;
    }
    const relative = path.join(relativeDir, name);
    const text = readFileOrReport(fs, configDir, relative, report);
    const parsed = WorkflowRunFileSchema.safeParse(text === undefined ? undefined : parseJson(text));
    if (!parsed.success) {
      if (text !== undefined) {
        report({ path: relative, reason: "workflow run file is not a run record" });
      }
      continue;
    }
    const { phases, ...rest } = parsed.data;
    runs.push({ ...rest, phases: phases.map((phase) => phase.title) });
  }
  return runs;
}
