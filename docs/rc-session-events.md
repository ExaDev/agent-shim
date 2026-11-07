# Remote Control session events

One subscription across every Remote Control session the front door observes, for a supervisor of many sessions that would otherwise poll `frontdoor rc status` or hold one `frontdoor rc watch` per session. Where `watch` relays each session's client read stream as the service sent it, this stream carries the door's own record of what changed: a session appearing or ending, its worker state changing, and a control request awaiting an answer being born or retired, each tagged with its session and stamped with a cursor a reconnect resumes after.

## What the stream carries

Every event has `kind`, `session` (the `cse_` id), `at` (when the door filed it, epoch milliseconds), `sequence` (rising by one per event within one door process, so a gap is visible) and `cursor` (the opaque value a resume names).

| `kind` | Fields beyond the common ones | When |
|---|---|---|
| `session-appeared` | none | The tracker begins describing a session: its create exchange, or the first call of a session it never saw created. |
| `session-ended` | `reason`: `expired`, `archived` or `conflict` | The session's liveness bound passed with no traffic, an archive was accepted, or the service closed the worker with a conflict header. Its outstanding requests are retired (`session-ended`) first. |
| `worker-state` | `state`, and `previous` once a state was already known | A worker registration named a state other than the one the door last saw (`idle`, `running`, `requires_action`, carried as the worker's own string). A re-registration of the same state is not an event. |
| `pending-born` | `requestId`, `type`, `summary` | A control request (a `can_use_tool` approval above all) began awaiting an answer. The same request seen on the worker's event write and on the client read stream is one birth. |
| `pending-retired` | `requestId`, `reason`: `answered`, `expired` or `session-ended` | A `control_response` answered it (whoever sent it), its answer deadline passed, or its session ended. |

The events are fed from the session tracker (`src/frontdoor/rcSessions.ts`) through an injected sink as it files each fact, never by polling, so their order is the order the door observed things in. A deadline expiry is noticed by the tracker's sweep, which runs at the shorter of the answer deadline and the session liveness bound, and by every status read.

## Cursors, resume and expiry

The log is in memory, bounded, and dies with the door process. It retains the newest `RC_SESSION_EVENT_LOG_CAPACITY` events, a bound derived from the tracker's own parse budget divided by the pending summary's excerpt budget (see the constant's doc comment in `src/frontdoor/rcEventLog.ts`).

A cursor names one door generation and one position in it. Resuming after a cursor replays every retained event after it, then continues live. A cursor the log cannot honour fails loudly, never by skipping: its following events were evicted, it was issued by a previous door process (a restart mints a new generation), or it is not a cursor at all. The answer says `cursor expired, resync from status` and names the head; the recovery is to read `frontdoor rc status` (or `rc.status`) for every session's present state, then resume after that head. A follower whose consumer falls further behind than the log retains gets the same refusal rather than a silent gap.

To start without missing anything, read the head first (every page answer names it as `head`), read the status, then follow from that head: events between the two reads replay, and applying a transition the status already reflects is harmless.

## Surfaces

- **REST, Server-Sent Events:** `GET /__agent-shim/orpc/rest/rc/session-events`, behind the door's control token as a Bearer credential. Each event is one SSE message whose `id` is its cursor, so a reconnecting `EventSource` resumes through `Last-Event-ID`; the `since` query names a cursor too, and the header outranks it, being the fresher statement of what the consumer saw. `session` filters to one session. An expired cursor is refused with the oRPC error code `GONE`, its data carrying `head`.
- **REST, pages:** `POST /__agent-shim/orpc/rest/rc/session-events/page` with a JSON body of `since`, `session` and `limit`, each optional. With no `since` it reads the retained window from its oldest. It answers `{status: "ok", events, cursor, more, head}`, where `cursor` is where the next page resumes and `head` names the newest event, or `{status: "expired", message, head}`. It is a POST only because the page size is a number; it changes nothing, and the OpenAPI document marks it read-only.
- **Typed client:** `rcSessions.events` and `rcSessions.eventsPage` on the whole-door client (`frontDoorApiClient`, `frontDoorApiFromState`).
- **MCP:** `agent-shim mcp` derives `rcSessions_eventsPage` from the page read, a read tool available without any opt-in like `rc_status` and `rc_pending`, which expose the same facts. The stream itself is not a tool, because the MCP adapter skips streaming operations; an agent pages with the returned cursor instead.
- **CLI:** `agent-shim frontdoor rc events [<cse_id> | --all] [--since <cursor>] [--json]` follows the stream until Ctrl-C, one line per event (cursor, instant, session, kind, detail) or one JSON object per line. An expired cursor fails naming the head to resume after.
- **Library:** `createRcSessionEventLog` builds the log, `createRcSessionTracker`'s `onTransition` feeds it, `followRcSessionEvents` follows it as an async iterator (throwing `RcSessionEventCursorExpiredError`), and `createRcSessionEventsApiRouter` serves it; the schemas are `RcSessionEventSchema`, `RcSessionTransitionSchema` and the read and stream input and output schemas.
