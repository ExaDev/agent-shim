# Remote Control agent and task events

What a Remote Control session's read stream carries about background tasks and subagents, and how those events join to the transcripts Claude Code writes to disk. Everything here was observed on a rig session against the door's self-hosted surface (see [rc-interception-rig.md](rc-interception-rig.md)), driven by the mock provider's `RC_MOCK_SUBAGENT=1` walk. The protocol is the CLI's, not this project's: it is pinned to the Claude Code version the rig installs and must be re-verified when that moves.

## Where the events are

They arrive as ordinary worker events on the client read stream, so `agent-shim frontdoor rc watch --json` prints them with no door change. Each envelope has `event_type: "system"`, `source: "worker"` and a payload with `type: "system"`, a `subtype`, a `session_id` (the `cse_` id) and a `uuid`.

| `subtype` | Fields beyond the common ones |
|---|---|
| `task_started` | `task_id`, `run_id`, `tool_use_id`, `description`, `task_type`, `is_backgrounded`. For `task_type: "local_agent"` also `subagent_type`, `spawn_depth` and `prompt`. Present when nested: `parent_task_id`. A task a subagent started carries `owned_by_subagent`. |
| `task_progress` | `task_id`, `run_id`, `tool_use_id`, `description`, `subagent_type`, `usage` (`total_tokens`, `tool_uses`, `duration_ms`), `last_tool_name`. |
| `task_updated` | `task_id`, `run_id`, `patch` (`status`, `end_time` observed). |
| `task_notification` | `task_id`, `run_id`, `tool_use_id`, `status`, `output_file`, `summary`, optional `usage`. |
| `background_tasks_changed` | `tasks`: the live background tasks, each `task_id`, `run_id`, `task_type`, `description`. A snapshot, not a delta. |

`task_type` values observed are `local_bash` (a backgrounded command) and `local_agent` (a subagent). A subagent is a task of the second kind, so one vocabulary covers both.

## Joining to disk

- `task_id` of a `local_agent` task is the stem of the transcript's `subagents/agent-<task_id>.jsonl` and `.meta.json`.
- `tool_use_id` equals the meta file's `toolUseId`, and the spawning `tool_use` block in the parent transcript.
- `spawn_depth` equals the meta file's `spawnDepth`; `parent_task_id` carries the nesting the meta file expresses only through depth.
- `output_file` is `<tmpdir>/<project-slug>/<local session id>/tasks/<task_id>.output`, which embeds the local session id.
- The session join is in the transcript: its `bridge-session` entries carry `sessionId` (local), `bridgeSessionId` (the `cse_` id) and `lastSequenceNum`. The stream's own `session_id` is always the `cse_` id and never the local one.

## Not observed

- Whether a subagent's own assistant and user turns appear on the stream: every assistant and user event seen had `parent_tool_use_id: null`.
- Workflow progress and forks: neither was exercised.
- The bodies the worker writes to `worker/internal-events` on the real API host. The self-hosted surface stores them and refuses agent-scoped reads; the real host's shape is unverified.
- Task `status` values other than `completed`.
