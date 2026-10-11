import { z } from "zod";

import { AgentNodeFields, SessionAgentTreeSchema, type AgentNode, type SessionAgentTree } from "./schema";

/**
 * The live half of the agent tree: what a Remote Control session's read stream says about its background tasks and subagents (`task_started`, `task_progress`, `task_updated`, `task_notification`, `background_tasks_changed`), and the merge of that with the tree read from disk. The event shapes are documented in `docs/rc-agent-events.md`. The stream exists only for sessions the door observes and only while they are live, so it is never the sole source: the disk tree is authoritative for every session and for completed content, and the stream supplies state the transcript has not flushed yet.
 */

/** How many tasks one session's book keeps. Past it the oldest-observed finished task is dropped first, so a long-lived session cannot grow the door's memory without bound; a running task is never dropped for a finished one. */
export const LIVE_TASK_CAP = 512;

/** The status a task has from its `task_started` until a patch or notification names another. */
const RUNNING_STATUS = "running";

/** The usage a `task_progress` or `task_notification` carries. */
const LiveTaskUsageSchema = z.strictObject({
  totalTokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
});

/** One task or subagent as the stream describes it. `status` is an open string: only `completed` has been observed beyond the running state. */
export const LiveTaskSchema = z.strictObject({
  /** The `task_id`: for an unnamed subagent the stem of its `agent-<id>` files on disk. */
  taskId: z.string(),
  /** The `cse_` session whose stream carried the task. */
  sessionId: z.string(),
  runId: z.string().optional(),
  /** The `tool_use` block in the spawning transcript, which is the meta file's `toolUseId`. */
  toolUseId: z.string().optional(),
  /** `local_agent` for a subagent, `local_bash` for a backgrounded command; open because other kinds may exist. */
  taskType: z.string().optional(),
  description: z.string().optional(),
  subagentType: z.string().optional(),
  spawnDepth: z.number().int().nonnegative().optional(),
  parentTaskId: z.string().optional(),
  backgrounded: z.boolean().optional(),
  status: z.string(),
  /** `<tmpdir>/<project-slug>/<local session id>/tasks/<task_id>.output`, which embeds the local session id. */
  outputFile: z.string().optional(),
  summary: z.string().optional(),
  lastToolName: z.string().optional(),
  usage: LiveTaskUsageSchema.optional(),
  /** When the door last observed an event for this task, in epoch milliseconds from its injected clock. */
  observedAt: z.number(),
});

export type LiveTask = z.output<typeof LiveTaskSchema>;

/** A session's live tasks by `task_id`. */
export type LiveTaskBook = ReadonlyMap<string, LiveTask>;

const SYSTEM_SUBTYPES = ["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function usageOf(record: Record<string, unknown>): LiveTask["usage"] {
  const raw = record.usage;
  if (!isRecord(raw)) {
    return undefined;
  }
  const totalTokens = numberField(raw, "total_tokens");
  const toolUses = numberField(raw, "tool_uses");
  const durationMs = numberField(raw, "duration_ms");
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined;
  }
  return { ...(totalTokens === undefined ? {} : { totalTokens }), ...(toolUses === undefined ? {} : { toolUses }), ...(durationMs === undefined ? {} : { durationMs }) };
}

/** Copies the defined entries of `fields` over `base`, so an event that omits a field never erases what an earlier one said. */
function overlay(base: LiveTask, fields: Readonly<Record<string, unknown>>): LiveTask {
  const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return LiveTaskSchema.parse({ ...base, ...defined });
}

/** Whether a status ends the task: anything other than the running state the stream starts it in. */
function isFinished(task: LiveTask): boolean {
  return task.status !== RUNNING_STATUS;
}

function bounded(book: Map<string, LiveTask>): Map<string, LiveTask> {
  if (book.size <= LIVE_TASK_CAP) {
    return book;
  }
  const evictable = [...book.values()].filter(isFinished).sort((left, right) => left.observedAt - right.observedAt);
  for (const task of evictable) {
    if (book.size <= LIVE_TASK_CAP) {
      break;
    }
    book.delete(task.taskId);
  }
  return book;
}

/**
 * Folds one stream payload into a session's book and returns the next book (the same one when the payload is not a task event). `task_started` births a task, `task_progress` and `task_notification` refine it, `task_updated` applies its patch, and `background_tasks_changed` fills in the tasks it lists without inventing a state for ones it omits: the snapshot says what is live, not that an unlisted task finished.
 *
 * A payload that does not match is ignored, never an error: the stream belongs to Claude Code and gains fields and subtypes between versions.
 */
export function applyAgentTaskEvent(book: LiveTaskBook, sessionId: string, payload: unknown, observedAt: number): LiveTaskBook {
  if (!isRecord(payload) || payload.type !== "system") {
    return book;
  }
  const subtype = payload.subtype;
  if (typeof subtype !== "string" || !SYSTEM_SUBTYPES.some((known) => known === subtype)) {
    return book;
  }
  const next = new Map(book);
  const upsert = (taskId: string, fields: Readonly<Record<string, unknown>>): void => {
    const existing = next.get(taskId);
    const base: LiveTask = existing ?? { taskId, sessionId, status: RUNNING_STATUS, observedAt };
    next.set(taskId, overlay(base, { ...fields, observedAt }));
  };
  if (subtype === "background_tasks_changed") {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    for (const raw of tasks) {
      const taskId = isRecord(raw) ? stringField(raw, "task_id") : undefined;
      if (isRecord(raw) && taskId !== undefined) {
        upsert(taskId, { runId: stringField(raw, "run_id"), taskType: stringField(raw, "task_type"), description: stringField(raw, "description") });
      }
    }
    return bounded(next);
  }
  const taskId = stringField(payload, "task_id");
  if (taskId === undefined) {
    return book;
  }
  const common = { runId: stringField(payload, "run_id"), toolUseId: stringField(payload, "tool_use_id"), description: stringField(payload, "description") };
  if (subtype === "task_started") {
    upsert(taskId, {
      ...common,
      taskType: stringField(payload, "task_type"),
      subagentType: stringField(payload, "subagent_type"),
      spawnDepth: numberField(payload, "spawn_depth"),
      parentTaskId: stringField(payload, "parent_task_id"),
      backgrounded: booleanField(payload, "is_backgrounded"),
    });
  } else if (subtype === "task_progress") {
    upsert(taskId, { ...common, subagentType: stringField(payload, "subagent_type"), lastToolName: stringField(payload, "last_tool_name"), usage: usageOf(payload) });
  } else if (subtype === "task_updated") {
    const patch = isRecord(payload.patch) ? payload.patch : {};
    upsert(taskId, { runId: stringField(payload, "run_id"), status: stringField(patch, "status") });
  } else {
    upsert(taskId, { ...common, status: stringField(payload, "status"), outputFile: stringField(payload, "output_file"), summary: stringField(payload, "summary"), usage: usageOf(payload) });
  }
  return bounded(next);
}

/** How a merged node relates to the stream: `disk` was only on disk, `both` was matched by a live task. A task only the stream knows is not a node but a member of `liveOnly`. */
const MergedProvenanceSchema = z.enum(["disk", "both"]);

/** An agent node of the merged tree: the disk node as read (it wins for everything the transcript holds), the stream's state beside it when a live task matched. */
export interface MergedAgentNode extends Omit<AgentNode, "children"> {
  readonly provenance: z.output<typeof MergedProvenanceSchema>;
  readonly live?: LiveTask;
  readonly children: readonly MergedAgentNode[];
}

/** The merged node schema, recursive through a lazy reference like the disk node's. */
export const MergedAgentNodeSchema: z.ZodType<MergedAgentNode> = z.lazy(() =>
  z.strictObject({
    ...AgentNodeFields,
    provenance: MergedProvenanceSchema,
    live: LiveTaskSchema.optional(),
    children: z.array(MergedAgentNodeSchema),
  }),
);

/** One session's agent tree with the stream's view merged in. */
export const MergedAgentTreeSchema = z.strictObject({
  ...SessionAgentTreeSchema.shape,
  agents: z.array(MergedAgentNodeSchema),
  /** The `cse_` sessions whose live tasks matched this session. Empty when the session is not live or the door has not observed it. */
  remoteSessions: z.array(z.string()),
  /** Live tasks of those sessions that match no disk agent (a backgrounded command, or an agent whose files have not appeared yet). */
  liveOnly: z.array(LiveTaskSchema),
});

export type MergedAgentTree = z.output<typeof MergedAgentTreeSchema>;

/**
 * Merges the live tasks into one session's disk tree.
 *
 * A live task belongs to the session when its `task_id` is a disk agent's id, its `tool_use_id` is a disk agent's `toolUseId`, or its `output_file` sits under the session's local id (the only place the stream states it). Matched agents keep every disk field and gain `live`; matched-by-session tasks that name no agent are `liveOnly`. Nothing is dropped from the disk tree and nothing the stream said overrides it.
 */
export function mergeLiveTasks(tree: SessionAgentTree, live: readonly LiveTask[]): MergedAgentTree {
  const byTaskId = new Map(live.map((task) => [task.taskId, task]));
  const byToolUseId = new Map(live.flatMap((task) => (task.toolUseId === undefined ? [] : [[task.toolUseId, task] as const])));
  const claimed = new Set<string>();
  const merge = (node: AgentNode): MergedAgentNode => {
    const task = byTaskId.get(node.id) ?? (node.toolUseId === undefined ? undefined : byToolUseId.get(node.toolUseId));
    if (task !== undefined) {
      claimed.add(task.taskId);
    }
    return { ...node, provenance: task === undefined ? "disk" : "both", ...(task === undefined ? {} : { live: task }), children: node.children.map(merge) };
  };
  const agents = tree.agents.map(merge);
  const sessionMarker = `/${tree.sessionId}/`;
  const liveOnly = live.filter((task) => !claimed.has(task.taskId) && task.outputFile?.includes(sessionMarker) === true);
  const remoteSessions = [...new Set([...claimed, ...liveOnly.map((task) => task.taskId)].flatMap((taskId) => byTaskId.get(taskId)?.sessionId ?? []))].sort();
  return { ...tree, agents, remoteSessions, liveOnly };
}
