import { describe, expect, it } from "vitest";

import { DOOR_EVENT_SOURCE_RC, LAUNCH_EVENT_SOURCE, type DoorEvent } from "./eventSchemas";
import { DOOR_EVENT_BUFFER_EVENTS, createDoorEventHub, rcFanoutOnDoorHub, type DoorEventStream } from "./eventHub";
import { createRcEventFanout } from "./rcStream";
import type { RcStreamEvent } from "./rcSchemas";

/** Two source tags the tests publish under, so the filtering and per-source sequencing are asserted across sources rather than inferred from one. */
const FIRST_SOURCE = "first";
const SECOND_SOURCE = "second";
/** A source nothing publishes under, so a filtered subscriber's silence is asserted against a live hub rather than an empty one. */
const UNPUBLISHED_SOURCE = "unpublished";
/** One made-up RC stream event of the fan-out's own shape, the payload the wrap carries verbatim. */
const RC_EVENT: RcStreamEvent = { session: "cse_00000000-0000-4000-8000-000000000001", envelope: { event_type: "user", sequence_num: 5, source: "worker" } };
/** How many events past the bound the overflow case publishes, so the drop is larger than an off-by-one could hide. */
const EVENTS_PAST_THE_BOUND = 5;

/** Collects every event one listener receives, with the detach the hub returns. */
function collect(hub: ReturnType<typeof createDoorEventHub>, sources: readonly string[] | undefined): { readonly received: DoorEvent[]; readonly detach: () => void } {
  const received: DoorEvent[] = [];
  const detach = hub.subscribe(sources, (event) => {
    received.push(event);
  });
  return { received, detach };
}

/** Pulls the next `count` events from a stream, the serial loop the stream's contract serves. */
async function pull(stream: DoorEventStream, count: number): Promise<DoorEvent[]> {
  const events: DoorEvent[] = [];
  for (let pulled = 0; pulled < count; pulled += 1) {
    const next = await stream.next();
    if (next.done === true) {
      throw new Error("the stream ended before the events it was to deliver");
    }
    events.push(next.value);
  }
  return events;
}

describe("the door's event backbone", () => {
  it("delivers to two subscribers of one source and an every-source subscriber, and a detached one receives nothing further while the others keep receiving", () => {
    const hub = createDoorEventHub();
    const publisher = hub.publisher(FIRST_SOURCE);
    const first = collect(hub, [FIRST_SOURCE]);
    const second = collect(hub, [FIRST_SOURCE]);
    const every = collect(hub, undefined);
    publisher.publish({ step: 1 });
    first.detach();
    publisher.publish({ step: 2 });
    expect(first.received).toEqual([
      { source: FIRST_SOURCE, sequence: 1, payload: { step: 1 } },
    ]);
    expect(second.received).toEqual([
      { source: FIRST_SOURCE, sequence: 1, payload: { step: 1 } },
      { source: FIRST_SOURCE, sequence: 2, payload: { step: 2 } },
    ]);
    expect(every.received).toEqual(second.received);
    second.detach();
    every.detach();
  });

  it("delivers a source's events only to that source's subscribers, stamps each source's sequence independently and monotonically, and lists the registered sources", () => {
    const hub = createDoorEventHub();
    const firstPublisher = hub.publisher(FIRST_SOURCE);
    const secondPublisher = hub.publisher(SECOND_SOURCE);
    const firstOnly = collect(hub, [FIRST_SOURCE]);
    const secondOnly = collect(hub, [SECOND_SOURCE]);
    const silent = collect(hub, [UNPUBLISHED_SOURCE]);
    firstPublisher.publish("one");
    secondPublisher.publish("other");
    firstPublisher.publish("two");
    expect(firstOnly.received).toEqual([
      { source: FIRST_SOURCE, sequence: 1, payload: "one" },
      { source: FIRST_SOURCE, sequence: 2, payload: "two" },
    ]);
    expect(secondOnly.received).toEqual([{ source: SECOND_SOURCE, sequence: 1, payload: "other" }]);
    expect(silent.received).toEqual([]);
    expect(hub.sources()).toEqual([FIRST_SOURCE, SECOND_SOURCE]);
    firstOnly.detach();
    secondOnly.detach();
    silent.detach();
  });

  it("re-registering a source name publishes through the same sequence, so two handles of one source cannot split its ordering", () => {
    const hub = createDoorEventHub();
    const { received, detach } = collect(hub, [FIRST_SOURCE]);
    hub.publisher(FIRST_SOURCE).publish("one");
    hub.publisher(FIRST_SOURCE).publish("two");
    expect(received.map((event) => event.sequence)).toEqual([1, 2]);
    detach();
  });

  it("buffers at most the documented bound per stream subscriber, dropping the oldest, whose absence the surviving sequence gap shows", async () => {
    const hub = createDoorEventHub();
    const publisher = hub.publisher(FIRST_SOURCE);
    const stream = hub.stream([FIRST_SOURCE]);
    for (let step = 1; step <= DOOR_EVENT_BUFFER_EVENTS + EVENTS_PAST_THE_BOUND; step += 1) {
      publisher.publish({ step });
    }
    const survived = await pull(stream, DOOR_EVENT_BUFFER_EVENTS);
    // The oldest events are the ones a full buffer drops, so the first survivor's sequence names the gap exactly: everything before it was dropped, and the consumer can see that without the buffer's help.
    expect(survived[0]?.sequence).toBe(EVENTS_PAST_THE_BOUND + 1);
    expect(survived.at(-1)?.sequence).toBe(DOOR_EVENT_BUFFER_EVENTS + EVENTS_PAST_THE_BOUND);
    stream.close();
  });

  it("ends a closed stream's pull with done and delivers nothing published after the close", async () => {
    const hub = createDoorEventHub();
    const publisher = hub.publisher(FIRST_SOURCE);
    const stream = hub.stream(undefined);
    publisher.publish("held");
    const held = await pull(stream, 1);
    expect(held).toEqual([{ source: FIRST_SOURCE, sequence: 1, payload: "held" }]);
    stream.close();
    publisher.publish("after the close");
    const afterClose = await stream.next();
    expect(afterClose.done).toBe(true);
  });

  it("streams only the named sources to a filtered stream subscriber, and nothing to one whose source never publishes", async () => {
    const hub = createDoorEventHub();
    const firstPublisher = hub.publisher(FIRST_SOURCE);
    const secondPublisher = hub.publisher(SECOND_SOURCE);
    const firstStream = hub.stream([FIRST_SOURCE]);
    const silentStream = hub.stream([UNPUBLISHED_SOURCE]);
    firstPublisher.publish("one");
    secondPublisher.publish("other");
    firstPublisher.publish("two");
    expect(await pull(firstStream, 2)).toEqual([
      { source: FIRST_SOURCE, sequence: 1, payload: "one" },
      { source: FIRST_SOURCE, sequence: 2, payload: "two" },
    ]);
    firstStream.close();
    silentStream.close();
    // A pull on the silent stream would wait forever (that is the contract: no events, no wake), so its silence is asserted by closing it and reading done, never by waiting.
    const ended = await silentStream.next();
    expect(ended.done).toBe(true);
  });
});

describe("the Remote Control fan-out as the backbone's first publisher", () => {
  it("publishes every fan-out event onto the backbone beside the fan-out's own delivery, changing neither", () => {
    const hub = createDoorEventHub();
    const fanout = createRcEventFanout();
    const wrapped = rcFanoutOnDoorHub(fanout, hub);
    const ownSession: RcStreamEvent[] = [];
    const otherSession: RcStreamEvent[] = [];
    const detachOwn = fanout.subscribe(RC_EVENT.session, (event) => {
      ownSession.push(event);
    });
    const detachOther = fanout.subscribe("cse_00000000-0000-4000-8000-000000000002", (event) => {
      otherSession.push(event);
    });
    const launchOnly = collect(hub, [LAUNCH_EVENT_SOURCE]);
    const onBackbone = collect(hub, [DOOR_EVENT_SOURCE_RC]);
    const everyOnBackbone = collect(hub, undefined);
    wrapped.publish(RC_EVENT);
    // The fan-out's own behaviour is untouched: its subscriber for the event's session receives it verbatim, its subscriber for another session does not, and subscribing through the wrap is the fan-out's own subscribe.
    expect(ownSession).toEqual([RC_EVENT]);
    expect(otherSession).toEqual([]);
    const throughTheWrap: RcStreamEvent[] = [];
    const detachThroughWrap = wrapped.subscribe(undefined, (event) => {
      throughTheWrap.push(event);
    });
    wrapped.publish(RC_EVENT);
    // Subscribed through the wrap between the two publishes, the subscriber receives the later event exactly as a subscriber of the bare fan-out would.
    expect(throughTheWrap).toEqual([RC_EVENT]);
    // The backbone receives the same event source-tagged, sequenced by the backbone rather than the envelope's own per-session number (which rides inside the payload, verbatim).
    expect(onBackbone.received).toEqual([
      { source: DOOR_EVENT_SOURCE_RC, sequence: 1, payload: RC_EVENT },
      { source: DOOR_EVENT_SOURCE_RC, sequence: 2, payload: RC_EVENT },
    ]);
    expect(everyOnBackbone.received).toEqual(onBackbone.received);
    expect(launchOnly.received).toEqual([]);
    expect(hub.sources()).toContain(DOOR_EVENT_SOURCE_RC);
    detachOwn();
    detachOther();
    detachThroughWrap();
    launchOnly.detach();
    onBackbone.detach();
    everyOnBackbone.detach();
  });
});
