# Remote Control session events

One subscription across every Remote Control session the front door observes, for a supervisor of many sessions that would otherwise poll `frontdoor rc status` or hold one `frontdoor rc watch` per session. Where `watch` relays each session's client read stream as the service sent it, this stream carries the door's own record of what changed: a session appearing or ending, its worker state changing, and a control request awaiting an answer being born or retired, each tagged with its session and stamped with a cursor a reconnect resumes after.

## What the stream carries

Every event has `kind`, `session` (the `cse_` id), `at` (when the door filed it, epoch milliseconds), `sequence` (rising by one per event within one door process, so a gap is visible) and `cursor` (the opaque value a resume names).

| `kind` | Fields beyond the common ones | When |
|---|---|---|
| `session-appeared` | none | The tracker begins describing a session: its accepted create, or the first accepted call of a session it never saw created. A refused call (a 401 or 404 for any `cse_` id, a worker still calling after an archive) never brings a session into being, and a session already tracked is refreshed, never appears twice; every appearance is matched by one `session-ended`. |
| `session-ended` | `reason`: `expired`, `archived` or `conflict` | The session's liveness bound passed with no traffic, an archive was accepted, or the service closed the worker with a conflict header. Its outstanding requests are retired (`session-ended`) first. |
| `worker-state` | `state`, and `previous` once a state was already known | A worker registration named a state other than the one the door last saw (`idle`, `running`, `requires_action`, carried as the worker's own string). A re-registration of the same state is not an event. |
| `pending-born` | `requestId`, `type`, `summary` | A control request (a `can_use_tool` approval above all) began awaiting an answer. The same request seen on the worker's event write and on the client read stream is one birth. |
| `pending-retired` | `requestId`, `reason`: `answered`, `expired` or `session-ended` | A `control_response` answered it (whoever sent it), its answer deadline passed, or its session ended. |

The events are fed from the session tracker (`src/frontdoor/rcSessions.ts`) through an injected sink as it files each fact, never by polling, so their order is the order the door observed things in. A deadline expiry is noticed by the tracker's sweep, which runs at the shorter of the answer deadline and the session liveness bound, and by every status read.

## Cursors, resume and expiry

The log is in memory, bounded, and dies with the door process. It retains the newest `RC_SESSION_EVENT_LOG_CAPACITY` events: its memory budget (the protocol's own cap on one event batch, which the door already buffers for one control request) divided by the largest event's size, `RC_SESSION_EVENT_MAX_BYTES`. That bound holds because every field an observed value controls is stored cut to a cap, marked with a trailing `...`: ids, the request type and worker states to `RC_SESSION_EVENT_TOKEN_MAX_CHARS`, and a pending summary to `RC_SESSION_EVENT_SUMMARY_MAX_CHARS` (its tool name plus the tracker's input excerpt). A protocol id is far shorter than its cap, so a cut id is one no `control_response` could echo. Closing the tracker (`RcSessionTracker.close`) ends every follower; the recorded events stay readable.

A cursor names one door generation and one position in it. Resuming after a cursor replays every retained event after it, then continues live. A cursor the log cannot honour fails loudly, never by skipping: its following events were evicted, it was issued by a previous door process (a restart mints a new generation), or it is not a cursor at all. The answer says `cursor expired, resync from status` and names the head; the recovery is to read `frontdoor rc status` (or `rc.status`) for every session's present state, then resume after that head. A follower whose consumer falls further behind than the log retains gets the same refusal rather than a silent gap.

To start without missing anything, read the head first (every page answer names it as `head`), read the status, then follow from that head: events between the two reads replay, and applying a transition the status already reflects is harmless.

## Surfaces

- **REST, Server-Sent Events:** `GET /__agent-shim/orpc/rest/rc/session-events`, behind the door's control token as a Bearer credential. Each event is one SSE message whose `id` is its cursor, so a reconnecting `EventSource` resumes through `Last-Event-ID`; the `since` query names a cursor too, and the header outranks it, being the fresher statement of what the consumer saw. `session` filters to one session. An expired cursor arrives as an SSE `error` event on the stream's 200 response (oRPC's event-iterator framing, not an HTTP 410), whose data carries the oRPC error code `GONE` and `head`; the stream then closes.
- **REST, pages:** `POST /__agent-shim/orpc/rest/rc/session-events/page` with a JSON body of `since`, `session` and `limit`, each optional. With no `since` it reads the retained window from its oldest. A page carries at most `DOOR_EVENT_BUFFER_EVENTS` events (the door's per-consumer event buffer), which is also the default `limit`, and a larger `limit` is refused as a bad request: a page lands whole in its reader (an agent's context, through the MCP tool), so a reader takes one consumer buffer at a time and pages on with the cursor. It answers `{status: "ok", events, cursor, more, head}`, where `cursor` is where the next page resumes and `head` names the newest event, or `{status: "expired", message, head}`. It is a POST only because the page size is a number; it changes nothing, and the OpenAPI document marks it read-only.
- **Typed client:** `rcSessions.events` and `rcSessions.eventsPage` on the whole-door client (`frontDoorApiClient`, `frontDoorApiFromState`).
- **MCP:** `agent-shim mcp` derives `rcSessions_eventsPage` from the page read, a read tool available without any opt-in like `rc_status` and `rc_pending`, which expose the same facts. The stream itself is not a tool, because the MCP adapter skips streaming operations; an agent pages with the returned cursor instead.
- **CLI:** `agent-shim frontdoor rc events [<cse_id> | --all] [--since <cursor>] [--json]` follows the stream until Ctrl-C, one line per event (cursor, instant, session, kind, detail) or one JSON object per line. An expired cursor fails naming the head to resume after. It does not reconnect: when the stream ends or fails, or Ctrl-C leaves it, it names the last cursor printed, to pass as `--since` (a door restart starts a new generation, whose answer to that cursor is the expiry and its head).
- **Library:** `createRcSessionEventLog` builds the log, `createRcSessionTracker`'s `onTransition` feeds it, `followRcSessionEvents` follows it as an async iterator (throwing `RcSessionEventCursorExpiredError`), and `createRcSessionEventsApiRouter` serves it; the schemas are `RcSessionEventSchema`, `RcSessionTransitionSchema` and the read and stream input and output schemas.

## Which sessions it covers

A Remote Control session reaches the door in one of three ways, and the stream is fed by the one tracker every Remote Control exchange crosses, whichever backend serves it:

1. **An Anthropic OAuth login, inference on Anthropic.** The session's Remote Control calls ride the door's `/v1/` pass-through to the real service, where the tracker observes them, and the door's own writes reach the real service with the observed credential.
2. **An Anthropic OAuth login, inference on a provider.** The door routes inference by the provider header and leaves Remote Control on the same pass-through as kind 1, so the tracker sees what it sees for kind 1. This is inferred from the routing, not tested: no test drives a provider-routed session's Remote Control traffic.
3. **A third-party provider with no Anthropic login (self-hosted mode).** With `AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1` the door serves the CCR session family itself (see [rc-interception-rig.md](rc-interception-rig.md#the-self-hosted-proof-no-login-at-all)), mounted as a route on the same resolver the tracker wraps, so its exchanges are observed as the real service's are.

What covers each event, per backend. "Connect surface" is `src/frontdoor/connect.rc.test.ts`, a session against a stand-in for the real service. "Self-hosted" is `src/frontdoor/rcSelfHost.e2e.test.ts`, a session through the self-hosted surface's real assembly. "Tracker" is `src/frontdoor/rcEventLog.test.ts`, exchanges driven straight into the tracker, which does not depend on the backend.

| Event | Real service (kinds 1 and 2) | Self-hosted (kind 3) |
|---|---|---|
| `session-appeared` | Connect surface | Self-hosted |
| `worker-state` | Tracker | Self-hosted (`idle`, `running`) |
| `pending-born`, `pending-retired` `answered` | Connect surface (an approval delivered only on the client read stream) | Self-hosted |
| `pending-retired` `expired` | Tracker | Tracker |
| `session-ended` `archived` | Tracker | Self-hosted |
| `session-ended` `conflict` | Tracker | Tracker (the surface answers a stale-epoch write with the protocol's conflict header) |
| `session-ended` `expired` | Tracker | Tracker |
| Resume after a cursor, expiry of an evicted or foreign cursor | Log tests, independent of the backend | Self-hosted (resume), log tests |

A door that starts while a session is already running sees it appear at its first accepted call through that door, and reports no `worker-state` until the worker's next registration, exactly as `rc status` shows no worker state for it until then.

A retired request is remembered for one answer deadline (`RC_PENDING_DEADLINE_MS`, swept at the tracker's sweep cadence), so a copy of it that arrives on the other channel inside that window is not born again. A copy arriving later, or a request the tracker never saw pending, is born as a new request.
