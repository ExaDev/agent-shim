# Agent transcripts on disk

How Claude Code lays out the forks, subagents, workflows, tasks and teams of a session inside an identity's configuration directory. It is the reference the agent-tree reader is written against, and the disk half of the picture [rc-agent-events.md](rc-agent-events.md) joins to. The layout belongs to Claude Code, not this project: it has changed across versions, so every field below except the ones named as always present is optional, and a reader must tolerate absence rather than assume it.

All paths are relative to an identity's configuration directory. `projects` is a shared-history entry the farm links, so a reader follows symlinks.

## Sessions and subagents

A session's transcript is `projects/<project-slug>/<session-id>.jsonl`. Everything its agents produced sits in a sibling directory named for the session id:

```
projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.meta.json
projects/<project-slug>/<session-id>/subagents/workflows/wf_<run-id>/agent-<agent-id>.{jsonl,meta.json}
projects/<project-slug>/<session-id>/workflows/wf_<run-id>.json
```

A session that was superseded keeps its directory under `<session-id>.superseded-<epoch-ms>`. A replaced transcript may also be archived as `<session-id>.orphaned-<epoch-ms>-<hash>.jsonl` (reported upstream in [anthropics/claude-code#85404](https://github.com/anthropics/claude-code/issues/85404)); the reader treats both as archived copies of the session they name, not as live sessions.

The stem after `agent-` is the agent id, and for an unnamed agent it equals the `task_id` of the matching `task_started` event on the Remote Control read stream. An agent spawned with a name has a longer stem, the name and a hash, whose correspondence to the stream's `task_id` has not been observed.

### The meta file

One JSON object. Always present: `agentType`. Everything else is optional and appears only for the agent kinds and versions that write it.

| Field | Meaning |
|---|---|
| `agentType` | The subagent type, such as `general-purpose`, `Explore`, `Plan`, a plugin-namespaced type, `workflow-subagent` for an agent a workflow spawned, or `fork`. |
| `isFork` | `true` for a fork, which inherits the parent's context. Present beside `agentType: "fork"`. |
| `description`, `name` | The spawn call's short description and the agent's addressable name. |
| `toolUseId` | The id of the `tool_use` block in the parent transcript that spawned it. The parent link. |
| `spawnDepth` | Nesting depth, where 1 is spawned by the session itself. |
| `parentAgentId` | The spawning agent, when that is another subagent. |
| `model` | The model the agent ran on, or `inherit`. |
| `requestShape`, `requestNonInteractive` | `foreground` or `background`, and whether the request was non-interactive. |
| `workflowPhase` | The workflow phase title an agent belongs to. |
| `taskKind`, `teamName` | `in_process_teammate` and the team, for a teammate. |
| `worktreePath`, `worktreeBranch`, `spawnedWithWorktree`, `inheritedWorktreePath`, `worktreeCleanlyRemoved` | Worktree isolation facts. |
| `stoppedByUser` | The user stopped it. |

A workflow agent's meta may hold nothing but `agentType` and `spawnDepth`; its run is identified by the `wf_<run-id>` directory it sits in, and its phase by `workflowPhase` where present.

### The agent transcript

JSON lines in the same shape as a session transcript: `type` (`user`, `assistant`, `attachment`), `message`, `uuid`, `parentUuid`, `timestamp`, `isSidechain: true`, `agentId`, `sessionId`, `cwd`, `version`. The first user message is the prompt the parent handed it.

## Workflow runs

`workflows/wf_<run-id>.json` is the run's record: `runId`, `workflowName`, `status`, `startTime`, `durationMs`, `phases` (titles), `workflowProgress`, `defaultModel`, `agentCount`, `totalTokens`, `totalToolCalls`, `summary`, `result`, `script`, `scriptPath` and `taskId`. `~/.claude/workflows/` itself holds workflow scripts, not runs.

## Tasks, todos, teams and jobs

- `tasks/<session-id>/<n>.json`, and for a session with teammates `tasks/<team-name>/<n>.json`, the team's shared list: one file per task: `id`, `subject`, `description`, `status`, `blocks`, `blockedBy`. Status values seen include `pending`, `in_progress`, `completed`, and a few non-standard ones (`todo`, `done`), so treat it as an open string. A `.highwatermark` and a `.lock` file sit beside them. A session pointed at a shared list with `CLAUDE_CODE_TASK_LIST_ID` writes to `tasks/<that-id>` instead; the variable belongs to the process environment and appears in no session file, so a reader can only be told the id.
- `todos/<session-id>-agent-<agent-id>.json`: a per-agent todo array, empty when unused.
- `teams/<team>/config.json`: `name`, `createdAt`, `leadAgentId`, `leadSessionId` and `members` (`agentId`, `name`, `agentType`, `joinedAt`, `cwd`, `backendType`, `subscriptions`). Messages live in `teams/<team>/inboxes/<member>.json`, an array of `from`, `text`, `timestamp`, `color`, `read`.
- `jobs/<id>/state.json`: a background job's `state` (`running`, `working`, `blocked`, `done`, `failed`, `stopped` seen), `detail`, `inFlight`, `sessionId`, `resumeSessionId`, `cwd`, `createdAt` and `updatedAt`; `timeline.jsonl` beside it holds `at`, `state`, `detail`, `text` rows.

## Joining to a live session

The session transcript's `bridge-session` entries carry `sessionId` (local) and `bridgeSessionId` (the `cse_` id) with `lastSequenceNum`, which is the join to Remote Control. See [rc-agent-events.md](rc-agent-events.md#joining-to-disk).
