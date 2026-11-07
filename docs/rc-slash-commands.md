# Slash commands, goals and compaction over Remote Control

This page covers what a prompt starting with `/` does when the door delivers it into a Remote Control session, and the verbs that read, set and clear a session's goal and compact its conversation without typing into a terminal.

## Supported versions

The goal and compaction verbs are verified on Claude Code 2.1.319 (`RC_SLASH_COMMAND_VERIFIED_VERSIONS` in `src/frontdoor/rcSlashCommands.ts`). Each verb reads the version from the session's own `system/init` event on the stream. It refuses a session that reports any other version, or that has not reported one yet, and the refusal names the version. To support a new version, repeat the checks below on it and add it to the list.

## What `send` does with a slash command

`frontdoor rc send` writes a user message under the `anthropic-client-platform` value the door observed on the session, which for a CLI-launched session is `claude_code_cli`. The service stamps that value onto the event as its `client_platform`. The worker uses that field to decide who wrote an inbound message: on 2.1.319 the bridge treats `ios`, `android`, `web_claude_ai` and `desktop_app` as a person, and demotes every other value to a peer message.

So a slash command sent through `send` is not run as a command. The worker wraps it as "Another Claude session sent a message: /goal ..." and passes it to the model as text. This is deliberate in the CLI and `send` keeps it: a prompt an agent sends is framed to the model as a peer's, not as the user's.

The same text written under a person's platform runs as a command. In a live 2.1.319 session:

| Prompt | Result on the stream |
|---|---|
| `/goal` (no goal) | a synthetic assistant message, `local_command_run: {command: "goal", args: ""}`, text `No goal set. Usage: /goal <condition>` |
| `/goal <condition>` | text `Goal set: <condition>`; the goal check then runs whenever the session would stop |
| `/goal` (goal active) | text `Goal active: <condition> (not yet evaluated)`, or `(N turns)` plus a `Last check:` line once evaluated |
| `/goal clear` | text `Goal cleared: <condition>`, or `No goal set` when there was none; `stop`, `off`, `reset`, `none` and `cancel` clear too |
| `/compact [instructions]` | `system` `status` `compacting`, then `status` with `compact_result: success` and a `compact_boundary` naming `pre_tokens` and `post_tokens`; on a conversation too short to compact, `compact_result: failed` with `compact_error: Not enough messages to compact.` |
| `/model` | text naming the current model and the accepted names |
| `/model <name>` | text `Set model to ... and saved as your default for new sessions`, and the next `system/init` names the new model |

`/model <name>` saves the model as the identity's default for new sessions, which `set-model` (the `set_model` control request) does not, so prefer `set-model` for a per-session switch.

## Why the verbs use slash commands

The 2.1.319 bridge's inbound control-request handler has no goal or compaction subtype. Anything outside its list is answered `REPL bridge does not handle control_request subtype: <name>`. The SDK's own `active_goal` message is never forwarded to a Remote Control client. Both `/goal` and `/compact` declare `thinClientDispatch: "post-text"`, the CLI's own statement that a thin client runs them by posting their text. The verbs therefore post the command as a person's message, writing under `web_claude_ai` (the app the door's own browser client is), and read the outcome off the stream.

Nothing the CLI exposes reads a goal without running `/goal`. The goal read runs the command with no argument and parses its one line, and the command and its answer are recorded in the session's transcript, as they are when a person types it.

## The verbs

Each verb waits for the worker's answer, up to `--wait-ms` (default ten minutes, the default request timeout of the Anthropic SDK the CLI uses, which bounds the one summary request a compaction makes). A command queued behind a running turn is answered when the turn ends.

| CLI | REST (under `/__agent-shim/orpc`) | Library | Answer |
|---|---|---|---|
| `frontdoor rc goal get --session <id>` | `POST /rest/rc/goal/get` | `getRcSessionGoal` | `goal`: `{condition, iterations, lastCheck?}` or `null` |
| `frontdoor rc goal set --session <id> --condition <text>` | `POST /rest/rc/goal/set` | `setRcSessionGoal` | `condition` as the worker stored it |
| `frontdoor rc goal clear --session <id>` | `POST /rest/rc/goal/clear` | `clearRcSessionGoal` | `cleared`: the condition, or `null` |
| `frontdoor rc compact --session <id> [--instructions <text>]` | `POST /rest/rc/compact` | `compactRcSession` | `trigger`, `preTokens`, `postTokens` |

Every answer also names the `session` and the `sequenceNums` the command's write was assigned. The MCP server exposes the same procedures as tools under `--allow-remote-control`, since they carry the `remote-control` tag.

A failure is returned in the worker's own words: an unverified version, an undelivered write, a goal the worker refused (the 4000-character condition limit), a compaction that did not run, or no answer within the wait. A condition that `/goal` would read as a clear is refused before anything is sent.

## Self-hosted mode

The real service stamps `client_platform` from the writer's header. The door's self-hosted surface does the same, so the verbs behave the same against it.
