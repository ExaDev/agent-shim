import { describe, expect, it } from "vitest";

import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "../usage/schema";
import { QUOTA_EXPIRING_EVENT_SOURCE, USAGE_EVENT_SOURCE, type DoorEvent } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import { createQuotaExpiringPublisher, FIVE_HOUR_WINDOW_MS, QUOTA_EXPIRING_WINDOW_FRACTION } from "./quotaExpiringEvents";

/** Where the fake clock starts, in epoch milliseconds, so reset instants are named as offsets from it. */
const NOW_MS = Date.parse("2026-10-07T12:00:00.000Z");

/** One second in milliseconds, the small offset that places a reset just inside or just outside a boundary. */
const ONE_SECOND_MS = 1_000;

/** The five-hour window's final span, the module's own fraction of its own span: the span inside which the check publishes. */
const FIVE_HOUR_FINAL_SPAN_MS = FIVE_HOUR_WINDOW_MS * QUOTA_EXPIRING_WINDOW_FRACTION;

/** One snapshot with one provider's unified windows, the fields the check reads. */
function snapshot(identity: string, fiveHour: Readonly<{ utilization: number; resetsAtMs: number }>): UsageSnapshot {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: new Date(NOW_MS).toISOString(),
    providers: {
      anthropic: {
        lastRequestAt: new Date(NOW_MS).toISOString(),
        lastStatus: 200,
        rateLimit: {
          observedAt: new Date(NOW_MS).toISOString(),
          headers: {},
          unified: {
            fiveHour: { utilization: fiveHour.utilization, resetsAt: new Date(fiveHour.resetsAtMs).toISOString(), status: "allowed" },
            ...(fiveHour.utilization >= 1 ? {} : {}),
          },
        },
      },
    },
  };
}

/** Creates the hub, the publisher over it, and a subscriber collecting the expiring-quota events; `seed` is the snapshot directory's stand-in. */
function world(seed: readonly UsageSnapshot[] = []) {
  const hub = createDoorEventHub();
  let now = NOW_MS;
  const received: DoorEvent[] = [];
  const detach = hub.subscribe([QUOTA_EXPIRING_EVENT_SOURCE], (event) => {
    received.push(event);
  });
  const publisher = createQuotaExpiringPublisher(hub, { seed, now: () => now });
  return {
    hub,
    publisher,
    received,
    detach,
    advanceTo: (ms: number) => {
      now = ms;
    },
    publishUsage: (updated: UsageSnapshot) => {
      hub.publisher(USAGE_EVENT_SOURCE).publish(updated);
    },
  };
}

describe("the expiring-quota publisher", () => {
  it("publishes once when an unspent window enters its final span, and stays silent on the ticks inside it", () => {
    const resettingAt = NOW_MS + FIVE_HOUR_FINAL_SPAN_MS - ONE_SECOND_MS;
    const w = world([snapshot("work", { utilization: 0.5, resetsAtMs: resettingAt })]);
    w.publisher.check();
    w.publisher.check();
    expect(w.received).toEqual([{ source: QUOTA_EXPIRING_EVENT_SOURCE, sequence: 1, payload: { identity: "work", provider: "anthropic", window: "fiveHour", utilization: 0.5, resetsAt: new Date(resettingAt).toISOString(), observedAt: NOW_MS } }]);
  });

  it("publishes nothing for a window outside its final span, one past its reset, or fully used", () => {
    const w = world([
      snapshot("far", { utilization: 0.5, resetsAtMs: NOW_MS + FIVE_HOUR_WINDOW_MS }),
      snapshot("past", { utilization: 0.5, resetsAtMs: NOW_MS - ONE_SECOND_MS }),
      snapshot("spent", { utilization: 1, resetsAtMs: NOW_MS + ONE_SECOND_MS }),
    ]);
    w.publisher.check();
    expect(w.received).toEqual([]);
  });

  it("re-notifies for the next window instance, whose reset instant is a new one", () => {
    const firstResetsAt = NOW_MS + FIVE_HOUR_FINAL_SPAN_MS / 2;
    const w = world([snapshot("work", { utilization: 0.5, resetsAtMs: firstResetsAt })]);
    w.publisher.check();
    const nextResetsAt = NOW_MS + FIVE_HOUR_WINDOW_MS + FIVE_HOUR_FINAL_SPAN_MS / 2;
    w.publishUsage(snapshot("work", { utilization: 0.4, resetsAtMs: nextResetsAt }));
    // The clock moves far enough that the next instance's final span is entered too.
    w.advanceTo(nextResetsAt - FIVE_HOUR_FINAL_SPAN_MS / 2);
    w.publisher.check();
    expect(w.received.map((event) => (event.payload as { resetsAt: string }).resetsAt)).toEqual([new Date(firstResetsAt).toISOString(), new Date(nextResetsAt).toISOString()]);
  });

  it("keeps its snapshots fresh from the usage source's own events, without a file read", () => {
    // Seeded with a window far from reset, then a written snapshot moves the reset to the final span: the next check publishes from the backbone-fed state alone.
    const w = world([snapshot("work", { utilization: 0.5, resetsAtMs: NOW_MS + FIVE_HOUR_WINDOW_MS })]);
    w.publisher.check();
    expect(w.received).toEqual([]);
    w.publishUsage(snapshot("work", { utilization: 0.6, resetsAtMs: NOW_MS + ONE_SECOND_MS }));
    w.publisher.check();
    expect(w.received).toHaveLength(1);
    expect(w.received[0]?.payload).toMatchObject({ identity: "work", utilization: 0.6 });
  });
});
