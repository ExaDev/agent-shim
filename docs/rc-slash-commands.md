# Slash commands, goals and compaction over Remote Control

This page covers what a prompt starting with `/` does when the door delivers it into a Remote Control session, and the verbs that read, set and clear a session's goal and compact its conversation without typing into a terminal.

## Supported versions

The goal and compaction verbs are verified on Claude Code 2.1.319 (`RC_SESSION_COMMAND_VERIFIED_VERSIONS` in `src/frontdoor/rcSessionCommands.ts`). Each verb reads the version from the running binary itself: for a supervised session, the version the control plugin reported from `$.session.version()` when it loaded; on the self-hosted surface, the `claude_code_version` of the worker's own `system/init` on the stream (an event a client wrote is never taken for it). A session on any other version, or one whose version is not known yet, is refused, and the refusal names the version. To support a new version, repeat the checks below on it and add it to the list.

## What `send` does with a slash command

`frontdoor rc send` writes a user message under the `anthropic-client-platform` value the door observed on the session, `claude_code_cli` for a CLI-launched session. The service stamps that header onto the event as its `client_platform` (the CLI's own schema describes the field as injected server-side by the ingress from the request header), and the worker decides from it who wrote an inbound message. On 2.1.319 the bridge treats `ios`, `android`, `web_claude_ai` and `desktop_app` as a person and demotes every other value to a peer message.

An ordinary prompt is framed the same way, so whether it reaches the model at all is the receiving session's `crossSessionInbound` decision; [What `frontdoor rc send` delivers](cli-reference.md#what-frontdoor-rc-send-delivers) covers the hold a session that bypasses permission prompts applies to it.

So a slash command sent through `send` is never run. The worker wraps it as "Another Claude session sent a message: /goal ..." and passes it to the model as text, which is the CLI's deliberate framing of a message an agent sends, and `send` keeps it.

Written by a person's app, the same text runs as a command. Observed in a live 2.1.319 session on the door's self-hosted surface:

| Prompt | Result on the stream |
|---|---|
| `/goal` (no goal) | a synthetic assistant message, `local_command_run: {command: "goal", args: ""}`, text `No goal set. Usage: /goal <condition>` |
| `/goal <condition>` | text `Goal set: <condition>`; the goal check then runs whenever the session would stop |
| `/goal` (goal active) | text `Goal active: <condition> (not yet evaluated)`, or `(N turns)` plus a `Last check:` line once evaluated |
| `/goal clear` | text `Goal cleared: <condition>`, or `No goal set` when there was none; `stop`, `off`, `reset`, `none` and `cancel` clear too |
| `/compact [instructions]` | `system` `status` `compacting`, then a `compact_boundary` with `trigger: "manual"` and `pre_tokens`/`post_tokens`; on a conversation too short to compact, the local command's output `Not enough messages to compact.` |
| `/model` | text naming the current model and the accepted names |
| `/model <name>` | text `Set model to ... and saved as your default for new sessions`, and the next `system/init` names the new model |

`/model <name>` saves the model as the identity's default for new sessions, which `set-model` (the `set_model` control request) does not, so prefer `set-model` for a per-session switch.

## What the CLI exposes

The 2.1.319 bridge's inbound control-request handler serves `initialize`, `set_model`, `set_max_thinking_tokens`, `set_permission_mode`, `rename_session`, `set_color`, `file_suggestions`, `read_file`, `get_workspace_diff`, `get_context_usage`, `get_usage` (answered as not supported), `mcp_status`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_reconnect`, `interrupt`, `apply_flag_settings`, `mcp_set_servers`, `stop_task`, `background_tasks`, `cancel_async_message`, `side_question` and `fork_conversation`, and answers any other subtype `REPL bridge does not handle control_request subtype: <name>`. None reads or changes a goal or compacts, and the SDK's `active_goal` message is never forwarded to a Remote Control client.

An in-process plugin can do more. The 2.1.319 plugin API gives a plugin `$.session.compact({ instructions })`, the call `/compact` makes, and `$.command.run({ command, args })`, which runs a slash command as if the person typed it (the transcript records it with `origin: { kind: "plugin" }`). Observed through a probe plugin in a 2.1.319 session:

| Plugin call | Result |
|---|---|
| `$.command.run({ command: "goal", args: "<condition>" })` | the goal is set: the transcript gains a `goal_status` row `{ met: false, sentinel: true, condition }` and the session's goal check starts; the call resolves with `context` holding the directive the model receives |
| `$.command.run({ command: "goal", args: "clear" })` | the goal is cleared: a `goal_status` row `{ met: true, sentinel: true, condition }` |
| `$.command.run({ command: "goal", args: "" })` | in an interactive session it opens the goal panel and the call does not resolve until a person dismisses it, so it cannot read a goal |
| `$.session.compact({})`, `$.session.compact({ instructions })` | the conversation is compacted; resolves with `tokensBefore` and `tokensAfter` |

No plugin call reads the goal. The transcript does: every goal change is a `goal_status` attachment row (set, each evaluation that finds it not yet met with its `reason`, met, failed, cleared), which is also what the CLI's own resume restores a goal from.

## The verbs and their routes

| CLI | REST (under `/__agent-shim/orpc`) | Library | Answer |
|---|---|---|---|
| `frontdoor rc goal get --session <id>` | `POST /rest/rc/goal/get` | `createRcSessionCommands(...).goalGet` | `goal`: `{condition, iterations, lastCheck?}` or `null` |
| `frontdoor rc goal set --session <id> --condition <text>` | `POST /rest/rc/goal/set` | `.goalSet` | `condition` now set and `superseded`, the goal it replaced or `null` |
| `frontdoor rc goal clear --session <id>` | `POST /rest/rc/goal/clear` | `.goalClear` | `cleared`: the condition, or `null` |
| `frontdoor rc compact --session <id>` | `POST /rest/rc/compact` | `.compact` | `trigger`, and `preTokens`/`postTokens` when the session recorded them |
| `frontdoor rc compact --session <id> --instructions <text>` | `POST /rest/rc/compact-with-instructions` | `.compact` with `instructions` | the same |

Every answer names the `session` and the `route` that served it. The MCP server exposes the same procedures as tools: `rc_goalGet`, `rc_goalClear` and `rc_compact` under `--allow-remote-control`, and `rc_goalSet` and `rc_compactWithInstructions` only under `--allow-remote-control-directives` together with it (see the trust boundary below).

Each verb picks its route per session:

- **Supervised** (`route: "supervised"`): the session was launched under an agent-shim supervisor (a pool with `resumeOnLimit`). Every supervised launch loads a private control plugin, and the launcher records where it listens beside the session's registry entry. The door finds the launch by the `bridge-session` row Claude Code writes into the session's own transcript (`bridgeSessionId` is the `cse_` id; the join is run live only in the isolated self-hosted lab, and that a real-service session writes the same row rests on a transcript of one such session, not a lab run), then writes a request file the plugin runs: `$.session.compact` for a compaction, `/goal <condition>` or `/goal clear` through `$.command.run` for a goal. The goal is read from the transcript, with no effect on the session, and a set or clear is confirmed from it.
- **Self-hosted** (`route: "self-hosted"`): the door serves Remote Control itself and no supervisor owns the session. The door is the service there, so it writes the slash command into its own conversation as a person's app (`web_claude_ai`, the app its own browser page is) and reads the worker's answer off the stream, matched by command and exact arguments and by the first manual compaction's `compact_boundary` after the write (by order: the answer names nothing the door wrote, so a person typing the same command at the same moment can answer in its place). It fails at once if the worker passes the command to its model as a peer's message.
- **Neither**: refused, naming the reason. The door has no in-process channel into the session, and the real service delivers the door's writes as a peer's, which the door will not change by claiming to be a person's app on a service it does not run.

A goal condition is one line, at most 4000 characters, and not a word `/goal` reads as a clear; compaction instructions are bounded by the door's control body cap. Verbs on one session run one at a time, in the order they were asked. Each waits for the session's answer up to `--wait-ms` (`waitMs`) in all, however many commands it runs: by default the supervisor's own bound on one compaction, and at most 2147483647 ms, the largest delay Node's timers accept; the typed API's client waits for a verb's response headers for that wait plus undici's own five-minute default (capped at the same limit), and keeps the default for every other procedure. A caller that disconnects aborts the wait.

## Which sessions get which

The route depends on two things: whether the session was launched under an agent-shim supervisor, and the door's mode. Self-hosting is a mode of the whole door (`AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1` when it starts): with it on, the door serves every Remote Control session that reaches it itself, whatever the account (an Anthropic OAuth login, a provider session, or no Anthropic login at all); with it off, every such session is on the real claude.ai service. The provider a session sends its inference to makes no difference.

| Verb | Supervised, either mode | Not supervised, self-hosting with its surface bound | Not supervised, self-hosting without `AGENT_SHIM_TRANSPARENT_SURFACE` | Not supervised, door not self-hosting |
|---|---|---|---|---|
| goal get | yes, from the transcript | yes, `/goal` on the door's own surface | refused: the door has no surface of its own to write to | refused: no in-process channel, and the real service treats the door's writes as a peer's |
| goal set | yes, through the plugin | yes, on the door's own surface | refused, the same | refused, the same |
| goal clear | yes, through the plugin | yes, on the door's own surface | refused, the same | refused, the same |
| compact | yes, through the plugin | yes, on the door's own surface | refused, the same | refused, the same |
| a slash command through `send` | delivered as a peer's message, never run | the same | the same | the same |

Self-hosting needs its transparent surface bound before it writes a command as a person's app: that write rides a dial that reaches only the door's own loopback surface and refuses while none is bound, so it can never fall back to the real API host. A refusal names its reason, and a session two live supervised launches both claim is refused rather than guessed at.

## The trust boundary

A goal's condition and a compaction's instructions are directives to the receiving session's model as if its user had given them. On 2.1.319 a `/goal <condition>` installs a persistent Stop hook and reaches the model as "A session-scoped Stop hook is now active with condition: "<text>". ... treat the condition itself as your directive and do not pause to ask the user what to do"; the CLI's own auto-mode classifier has a rule titled "Cross-session messages are never user intent", which is exactly the line these verbs step over. So whoever can call `goal set` or `compact` with instructions can direct another session as its user.

The MCP server exposes `rc_goalSet` and `rc_compactWithInstructions` only under `--allow-remote-control-directives` (or `agent-shim mcp permissions allow remote-control-directives`), which `--allow-remote-control` does not imply, so an agent whose only reach into other sessions is the MCP server's tools cannot direct them unless that grant was given too. The grant takes effect only beside the Remote Control one, so an agent that can set a goal can always read and clear it.

That grant limits which tools the MCP server lists, and nothing else. It is not a boundary against anything that runs as the same operating-system user: a session with a shell can read the door's control token (an owner-only file, and the same user owns it) and call `POST /rest/rc/goal/set` itself, or write a request file straight into another supervised launch's control plugin directory. The boundary between the person and the agents they run is that user account; a session that must not direct others needs to run without a shell, or as another user.

## Verified end to end

On Claude Code 2.1.319 in the isolated self-hosted lab (`scripts/rc-self-host-lab.mts`, whose leak check found nothing forwarded upstream and no blind tunnel beyond the CLI's updater and marketplace dials), through the lab door's `frontdoor rc` verbs:

- A supervised Remote Control session (a pool with `resumeOnLimit`, launched with `--remote-control`) was found by its `bridge-session` row, and every verb took the supervised route: goal get with none set, goal set, goal get with the goal, a second goal set naming the goal it replaced, goal clear, compact, and compact with instructions. A goal set starts a turn (its directive reaches the model); a request that arrives while that turn waits on a permission prompt is answered only once the session is idle, which is why every request is bounded by the wait.
- On the same door, a session no supervisor owns took the self-hosted route for goal set, get and clear and for compact, which ended on a `trigger: "manual"` boundary.
- `send "/goal <condition>"` with the session's own platform left no goal set: the worker read it as a peer's message.
- The worker reads its inbound events over SSE at `GET /v1/code/sessions/{id}/worker/events/stream` (its debug log names `SSETransport`), and the user, assistant and `compact_boundary` events it writes carry the uuids of the transcript rows they mirror; `system` `init` and `status` events and the `result` have no transcript row.

## Inbound platform rewriting (rejected)

One more route was considered and rejected. For a session on the real service, the door relays the worker's inbound stream, so it could write its command honestly (`claude_code_cli`, as `send` writes it) and then change `client_platform` to `web_claude_ai` on the relayed copy of the events it wrote itself, identified by the payload uuids it minted. That would work mechanically: the worker reads its inbound events over SSE at `GET /v1/code/sessions/{id}/worker/events/stream`, takes `client_platform` from each event's payload, and runs a slash command whose payload names a person's app. The SSE framing carries no length, and the sequence numbers and keepalives would pass through untouched.

It is rejected because the worker would then trust a value the service never stated: the service's own record of the event still says `claude_code_cli`, so the change defeats the bridge's peer-versus-person boundary from inside the stream instead of at the service. The plugin route already reaches every supervised session without it, so an unsupervised session on the real service is refused rather than reached this way. It was never built, and so never run against a real-service relay; the isolated lab has no such relay.

## Self-hosted mode

The real service sets `client_platform` from the writer's header. The door's self-hosted surface does the same on every client write it serves (the session's event writes, the conversation's, and the teleport channel's): the header's value, and nothing a writer put into the payload itself.
