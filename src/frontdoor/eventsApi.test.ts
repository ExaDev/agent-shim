import { beforeAll, describe, expect, it } from "vitest";

import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS, settle } from "./connectTestWorld";
import { DOOR_EVENT_SOURCE_RC, type DoorEvent } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import { createEventsApiRouter, type EventsApiRouter } from "./eventsApi";
import { createLaunchEventPublisher } from "./launchEvents";
import { doorApiNodeHandlerOf, frontDoorApiLink } from "./rcApi";
import type { RcStreamEvent } from "./rcSchemas";
import { createFrontDoorServer } from "./server";
import { listFrontDoorSessions, writeFrontDoorSession } from "./state";

/** The token the mount and its clients share in these tests, standing in for the door's per-generation file-backed token; long, because the secret-redaction clean filter is what a real bearer must survive. */
const CONTROL_TOKEN = "events-api-control-token-with-length";
/** The launch pid and start time the registry mutation writes, so the wire assertion names the registry's own values. */
const DEMO_PID = 301;
const DEMO_STARTED_AT = 100;
/** The observing clock's fixed value: the door observes a registry change at the tick, and a fixed clock makes that observable. */
const DEMO_NOW_MS = 1_000;
/** One RC stream event of the fan-out's own shape, the payload whose arrival a source-filtered subscriber sees (and a launch event must not reach it). */
const RC_EVENT: RcStreamEvent = { session: "cse_00000000-0000-4000-8000-000000000001", envelope: { event_type: "user", sequence_num: 5, source: "worker" } };
/**
 * How long a subscriber may wait for a condition the test drives (the subscription request landing, an event crossing the wire). Loopback TLS and the bridge run in milliseconds; the bound exists only so an overloaded machine fails visibly instead of hanging the suite.
 */
const WAIT_BUDGET_MS = 5_000;

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

let ca: CaMaterial;

/** Waits until the condition holds, polling at the world's own settle cadence, failing loudly at the budget rather than hanging. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("the door did not reach the awaited state within the test's wait budget");
    }
    await settle();
  }
}

/** The client over the events router alone, built on the same TLS-pinned link every typed door API client rides. */
function eventsApiClient(port: number, caPem: string, token: string): RouterClient<EventsApiRouter> {
  return createORPCClient(frontDoorApiLink(port, caPem, token));
}

/** Serves the events router on the door's real listener shape through the shared node-handler builder, recording every request URL that reaches it, and resolves the bound port. */
async function serveApi(doorEvents: ReturnType<typeof createDoorEventHub>): Promise<{ readonly port: number; readonly requests: string[]; readonly close: () => Promise<void> }> {
  const api = doorApiNodeHandlerOf(createEventsApiRouter({ expectedToken: CONTROL_TOKEN, events: doorEvents }));
  const requests: string[] = [];
  const server = createFrontDoorServer(
    async () => {
      await Promise.resolve();
    },
    () => undefined,
    mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
    undefined,
    [{ ...api, handle: async (request, response) => { requests.push(request.url ?? ""); return await api.handle(request, response); } }],
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return {
    port: address.port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

beforeAll(() => {
  ca = generateCa(new Date());
}, KEYGEN_TIMEOUT_MS);

describe("the door's typed events surface", () => {
  it(
    "streams a live launch lifecycle event to a typed subscriber over the door's real listener, the registry mutation driving it",
    async () => {
      // The door's own wiring in miniature: a backbone, a launch lifecycle publisher over it, and the events router mounted through the shared node-handler builder on the real listener shape with the same token the door mints per generation (the merged mount itself is proven in the control plane's e2e).
      const fs = createFakeFarmFs({});
      const doorEvents = createDoorEventHub();
      const launch = createLaunchEventPublisher(doorEvents, () => DEMO_NOW_MS);
      // The baseline observation a door's first tick performs: a registry this empty publishes nothing, so the event the subscriber later receives is the registry mutation's own, not a baseline echo.
      launch.observe(listFrontDoorSessions(fs, paths.frontdoorSessionsDir), []);
      const listener = await serveApi(doorEvents);
      try {
        const client = eventsApiClient(listener.port, ca.certPem, CONTROL_TOKEN);
        const received: DoorEvent[] = [];
        const stop = new AbortController();
        const watching = (async () => {
          for await (const event of await client.events.subscribe({}, { signal: stop.signal })) {
            received.push(event);
          }
        })().catch(() => {
          // Leaving the subscription aborts its request; the iterator ending on that abort is the expected shape, not a failure to surface.
        });
        await until(() => listener.requests.some((url) => url.includes("/events/subscribe")));

        // The registry mutation itself, through the registry's own writer: a launch registers.
        writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEMO_PID, startedAt: DEMO_STARTED_AT, token: "launch-capability" });
        // The tick that observes it, exactly as the supervisor's loop feeds the publisher.
        launch.observe(listFrontDoorSessions(fs, paths.frontdoorSessionsDir), []);
        await until(() => received.length === 1);
        expect(received[0]).toEqual({ source: "launch", sequence: 1, payload: { kind: "registered", pid: DEMO_PID, startedAt: DEMO_STARTED_AT, observedAt: DEMO_NOW_MS } });

        stop.abort();
        await watching;
      } finally {
        await listener.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "refuses a caller without this generation's token, and a filter naming a source the door does not publish",
    async () => {
      const doorEvents = createDoorEventHub();
      const launch = createLaunchEventPublisher(doorEvents, () => DEMO_NOW_MS);
      launch.observe([], []);
      const listener = await serveApi(doorEvents);
      try {
        const client = eventsApiClient(listener.port, ca.certPem, CONTROL_TOKEN);
        const wrongToken = eventsApiClient(listener.port, ca.certPem, "not-the-control-token");
        // Both refusals are asserted to have delivered no event either, not only to have thrown: a refusal that streamed first would be a broken gate, not a refused one.
        const seenFromWrongToken: DoorEvent[] = [];
        await expect(
          (async () => {
            for await (const event of await wrongToken.events.subscribe({})) {
              seenFromWrongToken.push(event);
            }
          })(),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(seenFromWrongToken).toEqual([]);
        const seenFromUnknownSource: DoorEvent[] = [];
        await expect(
          (async () => {
            for await (const event of await client.events.subscribe({ sources: ["no-such-source"] })) {
              seenFromUnknownSource.push(event);
            }
          })(),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(seenFromUnknownSource).toEqual([]);
      } finally {
        await listener.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "delivers to a source-filtered subscriber only the source it named, over the same wire",
    async () => {
      const fs = createFakeFarmFs({});
      const doorEvents = createDoorEventHub();
      const launch = createLaunchEventPublisher(doorEvents, () => DEMO_NOW_MS);
      const rcPublisher = doorEvents.publisher(DOOR_EVENT_SOURCE_RC);
      launch.observe(listFrontDoorSessions(fs, paths.frontdoorSessionsDir), []);
      const listener = await serveApi(doorEvents);
      try {
        const client = eventsApiClient(listener.port, ca.certPem, CONTROL_TOKEN);
        const received: DoorEvent[] = [];
        const stop = new AbortController();
        const watching = (async () => {
          for await (const event of await client.events.subscribe({ sources: [DOOR_EVENT_SOURCE_RC] }, { signal: stop.signal })) {
            received.push(event);
          }
        })().catch(() => {
          // Leaving the subscription aborts its request; the iterator ending on that abort is the expected shape, not a failure to surface.
        });
        await until(() => listener.requests.some((url) => url.includes("/events/subscribe")));

        // A launch registers and an RC event crosses the fan-out's publisher in the same breath; the subscriber named one source and receives only it.
        writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEMO_PID, startedAt: DEMO_STARTED_AT, token: "launch-capability" });
        launch.observe(listFrontDoorSessions(fs, paths.frontdoorSessionsDir), []);
        rcPublisher.publish(RC_EVENT);
        await until(() => received.length === 1);
        expect(received[0]).toEqual({ source: DOOR_EVENT_SOURCE_RC, sequence: 1, payload: RC_EVENT });
        await settle();
        expect(received).toHaveLength(1);

        stop.abort();
        await watching;
      } finally {
        await listener.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
