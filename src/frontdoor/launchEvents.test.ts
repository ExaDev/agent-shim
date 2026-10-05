import { describe, expect, it } from "vitest";

import { LAUNCH_EVENT_SOURCE, LaunchLifecycleEventSchema, type DoorEvent } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import { createLaunchEventPublisher } from "./launchEvents";
import type { FrontDoorSessionSummary } from "./state";

/** Where the fake clock starts and how it steps, so each observation's `observedAt` is a number the assertions name rather than a coincidence of scheduling. */
const CLOCK_START_MS = 1_000;
const CLOCK_STEP_MS = 1_000;
/** When each observed change lands on the stepping clock, one named instant per observation, in the order the test drives them. */
const FIRST_CHANGE_AT_MS = CLOCK_START_MS + CLOCK_STEP_MS;
const SECOND_CHANGE_AT_MS = FIRST_CHANGE_AT_MS + CLOCK_STEP_MS;
const THIRD_CHANGE_AT_MS = SECOND_CHANGE_AT_MS + CLOCK_STEP_MS;
/** Four launch pids, so the publisher's grouping and pid order are asserted across entries rather than inferred from one. */
const FIRST_PID = 301;
const SECOND_PID = 302;
const THIRD_PID = 303;
const FOURTH_PID = 304;
/** The start times the registry records, one per launch, distinct from every observedAt so a swapped field cannot pass. */
const FIRST_STARTED_AT = 100;
const SECOND_STARTED_AT = 200;
const THIRD_STARTED_AT = 300;
const FOURTH_STARTED_AT = 400;

/** One registry entry as the listing hands it to the publisher. */
function entry(pid: number, startedAt: number): FrontDoorSessionSummary {
  return { pid, startedAt };
}

/** A publisher over a hub that collects everything it emits, with a clock the test steps by hand. */
function observedPublisher(): { readonly observe: ReturnType<typeof createLaunchEventPublisher>["observe"]; readonly received: DoorEvent[]; readonly step: () => void; readonly detach: () => void } {
  const hub = createDoorEventHub();
  const received: DoorEvent[] = [];
  const detach = hub.subscribe(undefined, (event) => {
    received.push(event);
  });
  let clock = CLOCK_START_MS;
  const publisher = createLaunchEventPublisher(hub, () => clock);
  return {
    observe: publisher.observe,
    received,
    step: () => {
      clock += CLOCK_STEP_MS;
    },
    detach,
  };
}

describe("the launch lifecycle publisher", () => {
  it("establishes the baseline without publishing, because a session the registry already held registered before this generation began", () => {
    const world = observedPublisher();
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT)], []);
    expect(world.received).toEqual([]);
    world.detach();
  });

  it("publishes a registration, an end and a prune as the registry changes between observations, each carrying the registry's own start time and the observing clock", () => {
    const world = observedPublisher();
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT), entry(SECOND_PID, SECOND_STARTED_AT)], []);
    world.step();
    // A third launch registers.
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT), entry(SECOND_PID, SECOND_STARTED_AT), entry(THIRD_PID, THIRD_STARTED_AT)], []);
    world.step();
    // The second launch's own exit hook removed its record.
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT), entry(THIRD_PID, THIRD_STARTED_AT)], []);
    world.step();
    // The first launch died, so the tick's prune removed its record (and the listing still names it, because the listing precedes the prune).
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT), entry(THIRD_PID, THIRD_STARTED_AT)], [FIRST_PID]);
    expect(world.received).toEqual([
      { source: LAUNCH_EVENT_SOURCE, sequence: 1, payload: { kind: "registered", pid: THIRD_PID, startedAt: THIRD_STARTED_AT, observedAt: FIRST_CHANGE_AT_MS } },
      { source: LAUNCH_EVENT_SOURCE, sequence: 2, payload: { kind: "ended", pid: SECOND_PID, startedAt: SECOND_STARTED_AT, observedAt: SECOND_CHANGE_AT_MS } },
      { source: LAUNCH_EVENT_SOURCE, sequence: 3, payload: { kind: "pruned", pid: FIRST_PID, startedAt: FIRST_STARTED_AT, observedAt: THIRD_CHANGE_AT_MS } },
    ]);
    for (const event of world.received) {
      expect(LaunchLifecycleEventSchema.safeParse(event.payload).success).toBe(true);
    }
    world.detach();
  });

  it("publishes the departures before the arrivals of one observation, each group in the registry's own pid order, and a launch dead on arrival is pruned and never registered", () => {
    const world = observedPublisher();
    world.observe([entry(SECOND_PID, SECOND_STARTED_AT)], []);
    world.step();
    // One tick where the second launch ended, a third launch's record appeared and died between the two observations (the listing still names it, because the listing precedes the prune that removes it), and a first and fourth launch registered. The observed order is the prune, then the end, then the registrations ascending by pid, and the pid order across groups is deliberately not ascending, so the group precedence is what the assertion proves rather than a sort that either rule would satisfy.
    world.observe([entry(FIRST_PID, FIRST_STARTED_AT), entry(THIRD_PID, THIRD_STARTED_AT), entry(FOURTH_PID, FOURTH_STARTED_AT)], [THIRD_PID]);
    const published = world.received.map((event) => LaunchLifecycleEventSchema.parse(event.payload));
    expect(published.map((payload) => ({ kind: payload.kind, pid: payload.pid }))).toEqual([
      { kind: "pruned", pid: THIRD_PID },
      { kind: "ended", pid: SECOND_PID },
      { kind: "registered", pid: FIRST_PID },
      { kind: "registered", pid: FOURTH_PID },
    ]);
    world.detach();
  });
});
