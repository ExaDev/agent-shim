import { z } from "zod";

/**
 * The agent tree of one session as the reader returns it, and the shape of the meta file it reads. One definition each, so the type, the validator and the published JSON Schema (`schema/AgentTree.schema.json`) cannot drift. The on-disk layout is documented in `docs/agent-transcripts.md`; it belongs to Claude Code and has changed across versions, which is why the meta file is read leniently and the tree this module returns is strict.
 */

/**
 * One subagent's `.meta.json`. `agentType` is the one field every version writes; the rest appear only for the kinds and versions that write them, and a version this schema has never seen may add more, so unknown keys are kept rather than rejected.
 */
export const AgentMetaSchema = z.looseObject({
  agentType: z.string(),
  isFork: z.boolean().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  toolUseId: z.string().optional(),
  spawnDepth: z.number().int().nonnegative().optional(),
  parentAgentId: z.string().optional(),
  model: z.string().optional(),
  requestShape: z.string().optional(),
  requestNonInteractive: z.boolean().optional(),
  workflowPhase: z.string().optional(),
  taskKind: z.string().optional(),
  teamName: z.string().optional(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  stoppedByUser: z.boolean().optional(),
});

/** What kind of agent a node is, derived from its meta file: a fork inherits its parent's context, a workflow agent was spawned by a workflow run, a teammate belongs to a team. */
export const AgentKindSchema = z.enum(["subagent", "fork", "workflow-agent", "teammate"]);

/** One agent in a session's tree. `children` holds the agents it spawned. */
export interface AgentNode {
  /** The stem after `agent-` in its file names, which for an unnamed agent is the `task_id` Remote Control reports for it. */
  readonly id: string;
  readonly kind: z.infer<typeof AgentKindSchema>;
  readonly agentType: string;
  readonly description?: string;
  readonly name?: string;
  /** The `tool_use` block in the parent's transcript that spawned this agent. */
  readonly toolUseId?: string;
  readonly spawnDepth?: number;
  /** The model the spawn recorded: an alias or `inherit` as often as a concrete id, and not necessarily the model that served the agent's requests. */
  readonly model?: string;
  readonly background?: boolean;
  /** The workflow run this agent belongs to, when it was spawned by one. */
  readonly workflowRunId?: string;
  readonly workflowPhase?: string;
  readonly teamName?: string;
  readonly stoppedByUser?: boolean;
  /** The agent's transcript, relative to the identity's configuration directory. */
  readonly transcript: string;
  readonly children: readonly AgentNode[];
}

/** The node schema, written out so the recursive `children` field has a lazy reference to itself. */
export const AgentNodeSchema: z.ZodType<AgentNode> = z.lazy(() =>
  z.strictObject({
    id: z.string(),
    kind: AgentKindSchema,
    agentType: z.string(),
    description: z.string().optional(),
    name: z.string().optional(),
    toolUseId: z.string().optional(),
    spawnDepth: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
    background: z.boolean().optional(),
    workflowRunId: z.string().optional(),
    workflowPhase: z.string().optional(),
    teamName: z.string().optional(),
    stoppedByUser: z.boolean().optional(),
    transcript: z.string(),
    children: z.array(AgentNodeSchema),
  }),
);

/** One entry of a task list: the session's own (`tasks/<session-id>/<n>.json`, or `tasks/session-<first-eight-characters>/<n>.json` in current versions) or a shared one (`tasks/<list-id>/<n>.json`), a team's or one named by `CLAUDE_CODE_TASK_LIST_ID`. `status` is an open string: non-standard values occur. */
export const TaskItemSchema = z.strictObject({
  id: z.string(),
  subject: z.string(),
  description: z.string().optional(),
  status: z.string(),
  /** What a spinner shows while the task runs. */
  activeForm: z.string().optional(),
  /** The teammate or agent name the task is assigned to, as Agent Teams writes it. */
  owner: z.string().optional(),
  /** Free-form data the harness attaches to a task, kept as written. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  /** The id of the shared task list this task belongs to (a team's name, or a custom list id), absent for the session's own list. */
  taskList: z.string().optional(),
});

/** One workflow run's record (`workflows/wf_<run-id>.json`), narrowed to what identifies and summarises it. */
export const WorkflowRunSchema = z.strictObject({
  runId: z.string(),
  workflowName: z.string().optional(),
  status: z.string().optional(),
  startTime: z.number().optional(),
  phases: z.array(z.string()),
  summary: z.string().optional(),
});

/** A file the reader met and could not use: reported with the reason, never silently dropped. */
const AgentTreeProblemSchema = z.strictObject({
  /** Relative to the identity's configuration directory. */
  path: z.string(),
  reason: z.string(),
});

/** One session in a listing: the cheap facts read from directory listings and one stat, and every identity whose configuration exposes it. */
export const SessionSummarySchema = z.strictObject({
  project: z.string(),
  sessionId: z.string(),
  superseded: z.boolean(),
  /** The directory and transcript stem exactly as on disk, which differs from `sessionId` for a superseded session. */
  entry: z.string(),
  agentCount: z.number().int().nonnegative(),
  workflowRunCount: z.number().int().nonnegative(),
  /** When the transcript was last written, as an ISO instant; absent when there is no transcript file. */
  updatedAt: z.iso.datetime().optional(),
  identities: z.array(z.string()),
});

/** The whole picture of one session's agents, tasks and workflow runs. */
export const SessionAgentTreeSchema = z.strictObject({
  project: z.string(),
  sessionId: z.string(),
  /** True for a session directory a resume superseded (`<session-id>.superseded-<epoch-ms>`). */
  superseded: z.boolean(),
  /** The agents the session itself spawned, each with its descendants. */
  agents: z.array(AgentNodeSchema),
  tasks: z.array(TaskItemSchema),
  workflowRuns: z.array(WorkflowRunSchema),
  problems: z.array(AgentTreeProblemSchema),
});

export type AgentMeta = z.output<typeof AgentMetaSchema>;
export type AgentKind = z.output<typeof AgentKindSchema>;
export type TaskItem = z.output<typeof TaskItemSchema>;
export type WorkflowRun = z.output<typeof WorkflowRunSchema>;
export type AgentTreeProblem = z.output<typeof AgentTreeProblemSchema>;
export type SessionAgentTree = z.output<typeof SessionAgentTreeSchema>;
export type SessionSummaryView = z.output<typeof SessionSummarySchema>;
