import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";
import { eventIterator, withEventMeta } from "@orpc/server";

import { doorApiAuth, READ_ONLY_OPERATION_EXTENSION } from "./rcApi";
import {
  RcSessionEventCursorExpiredError,
  RcSessionEventSchema,
  RcSessionEventsReadInputSchema,
  RcSessionEventsReadOutputSchema,
  RcSessionEventsStreamInputSchema,
  followRcSessionEvents,
  type RcSessionEventLog,
} from "./rcEventLog";

/**
 * The typed API's surface over the door's session event log (`rcEventLog.ts`): one subscription across every observed Remote Control session, so a supervisor of many sessions follows their appearances and endings, worker state changes and pending-request births and retirements without polling `rc.status` or holding one subscription per session.
 *
 * `rcSessions.events` streams the log as Server-Sent Events, each event's cursor its SSE id, so a consumer's reconnect resumes with the protocol's own `Last-Event-ID` rule (or the `since` query, which the header outranks because it is the fresher statement of what the consumer saw). `rcSessions.eventsPage` reads the same log as cursor-paged JSON, the form a consumer that cannot hold a stream open uses (an MCP tool above all, since the MCP adapter skips streaming operations). Either way a cursor the log can no longer honour fails loudly: the stream refuses with `GONE`, the page answers `status: "expired"`, each naming the head to resume after once `rc.status` has restated the present.
 *
 * Mounted by `controlApi.ts` beside the Remote Control router on the one prefix and token every typed door procedure shares, and tagged `remote-control` so the OpenAPI document groups it with the rest of that surface.
 */

/** Everything the session events surface needs: the token every typed door procedure demands, and the log it reads. */
export interface RcSessionEventsApiDeps {
  /** This generation's control token: the same value the Remote Control router checks, since one mount serves both. */
  readonly expectedToken: string;
  /** The door's session event log, fed by the tracker's transitions. */
  readonly sessionEvents: RcSessionEventLog;
}

/** The OpenAPI tag the Remote Control procedures share, so these group with them in the document and the MCP adapter treats them as that surface. */
const RC_API_TAG = "remote-control";

/** The oRPC error code an expired cursor is refused with: the resource the cursor named is gone for good, which is HTTP 410's own meaning, and a retry with the same cursor can never succeed. */
const CURSOR_EXPIRED_CODE = "GONE";

/** Builds the session events router: one stream and one page read, behind the control-token middleware. */
export function createRcSessionEventsApiRouter(deps: RcSessionEventsApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    rcSessions: {
      events: authed
        .meta(openapi({ method: "GET", path: "/rest/rc/session-events", summary: "Stream every observed session's state transitions, pending requests and endings (SSE), resumable by cursor", tags: [RC_API_TAG] }))
        .input(RcSessionEventsStreamInputSchema)
        .output(eventIterator(RcSessionEventSchema))
        .handler(async function* ({ input, signal, lastEventId }) {
          const follower = followRcSessionEvents(deps.sessionEvents, { since: lastEventId ?? input.since, session: input.session }, signal);
          try {
            for await (const event of follower) {
              yield withEventMeta(event, { id: event.cursor });
            }
          } catch (error: unknown) {
            if (error instanceof RcSessionEventCursorExpiredError) {
              throw new ORPCError(CURSOR_EXPIRED_CODE, { message: error.message, data: { head: error.head } });
            }
            throw error;
          }
        }),
      eventsPage: authed
        .meta(
          openapi({
            method: "POST",
            path: "/rest/rc/session-events/page",
            summary: "Read every observed session's state transitions, pending requests and endings after a cursor, one page at a time",
            tags: [RC_API_TAG],
            // A POST because the page size is a number a query string cannot type, but the answer changes nothing.
            spec: (current) => ({ ...current, [READ_ONLY_OPERATION_EXTENSION]: true }),
          }),
        )
        .input(RcSessionEventsReadInputSchema)
        .output(RcSessionEventsReadOutputSchema)
        .handler(({ input }) => deps.sessionEvents.read(input)),
    },
  };
}

/** The session events router, as the merged mount's and a consumer's own types are derived from it. */
export type RcSessionEventsApiRouter = ReturnType<typeof createRcSessionEventsApiRouter>;
