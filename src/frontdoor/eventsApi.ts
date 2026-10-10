import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";
import { eventIterator, withEventMeta } from "@orpc/server";

import { doorApiAuth } from "./rcApi";
import { DoorEventSchema, DoorEventSourceQuerySchema, type DoorEvent } from "./eventSchemas";
import type { DoorEventHub } from "./eventHub";

/**
 * The door-wide events surface of the typed API: `events.subscribe`, the generalisation of `rc.subscribe`'s pattern from one source to the backbone's every source. A consumer (a statusline, a watchdog, an automation) presents the same per-generation owner-only control token, asks for every source or names the ones it wants, and receives one stream of source-tagged events, SSE-framed by oRPC's event iterator with the backbone's per-source sequence as the SSE event id, so a slow consumer that had events dropped by its bounded bridge sees the gap in that number exactly as a Remote Control subscriber sees one in the envelope's own.
 *
 * The router this module builds is mounted by `controlApi.ts` beside the Remote Control and control-plane routers on the one prefix the provider listener already serves, so every surface of the door's typed API shares one token gate, one body cap and one transport.
 */

/** Everything the events surface needs: the token every typed door API procedure demands, and the backbone whose events the subscription yields. */
export interface DoorEventsApiDeps {
  /** This generation's control token: the same value the Remote Control router checks, since one mount serves both. */
  readonly expectedToken: string;
  /** The door's event backbone: the publisher registry every source registers on and this subscription reads. */
  readonly events: DoorEventHub;
}

/** The OpenAPI tag the events router groups under in the document. */
const EVENTS_API_TAG = "events";

/** Builds the events router: one streaming procedure behind the control-token middleware. */
export function createEventsApiRouter(deps: DoorEventsApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    events: {
      subscribe: authed
        .meta(openapi({ method: "GET", path: "/rest/events", summary: "Stream the door's every event source (SSE)", tags: [EVENTS_API_TAG] }))
        .input(DoorEventSourceQuerySchema)
        .output(eventIterator(DoorEventSchema))
        .handler(async function* ({ input, signal }) {
          // A filter naming a source the door does not publish is refused naming the live ones, for the same reason the Remote Control surfaces refuse an unobserved session id: a mistyped name answered as silence would read as "source quiet" forever.
          if (input.sources !== undefined) {
            const live = deps.events.sources();
            const unknown = input.sources.filter((source) => !live.includes(source));
            if (unknown.length > 0) {
              throw new ORPCError("NOT_FOUND", { message: `the door publishes no event source named ${unknown.map((source) => `"${source}"`).join(", ")}; the live sources are ${live.map((source) => `"${source}"`).join(", ")}` });
            }
          }
          // The bridge is the backbone's own: a bounded, drop-oldest buffer per subscriber. The abort wait races the next pull, so a disconnect (or a cancelled pull) ends the loop through the aborted signal rather than waiting for an event that will never come, and the finally closes the bridge, detaching it from the backbone.
          const stream = deps.events.stream(input.sources);
          const ended = new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              resolve();
            }, { once: true });
          });
          try {
            for (;;) {
              signal?.throwIfAborted();
              const next = await Promise.race([stream.next(), ended.then((): IteratorResult<DoorEvent> => ({ value: undefined, done: true }))]);
              if (next.done === true) {
                signal?.throwIfAborted();
                return;
              }
              // The backbone's per-source sequence becomes the SSE event id, the one number whose gaps are this stream's own drop signal.
              yield withEventMeta(next.value, { id: String(next.value.sequence) });
            }
          } finally {
            stream.close();
          }
        }),
    },
  };
}

/** The events router, as the merged mount's and a consumer's own types are derived from it. */
export type EventsApiRouter = ReturnType<typeof createEventsApiRouter>;
