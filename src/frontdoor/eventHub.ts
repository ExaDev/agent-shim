import { DOOR_EVENT_SOURCE_RC, type DoorEvent } from "./eventSchemas";
import type { RcStreamEvent } from "./rcSchemas";
import type { RcEventFanout } from "./rcStream";

/**
 * The door's event backbone: the publisher/subscriber machinery the Remote Control client stream's fan-out first proved, generalised so any door-wide source can publish and any consumer can subscribe once instead of each source growing its own channel. A publisher registers under a source tag and publishes payloads; the backbone stamps each event with its source's own monotonic sequence and delivers to every matching subscriber synchronously, in publication order. A source that carries its own ordering on the wire (the Remote Control envelope's per-session `sequence_num`, the number its resume rule resumes after) keeps it inside the payload, verbatim: the backbone's sequence is deliberately not any protocol's number.
 *
 * The Remote Control client stream is the first publisher, through `rcFanoutOnDoorHub` below: the wrap publishes every event the fan-out is handed onto the backbone beside the fan-out's own delivery, and moves nothing about how Remote Control events flow, so the fan-out's existing subscribers (the tracker's filing rides the same publish, the typed API's subscription and the watch verb read the same subscribe) never know the backbone exists. The launch lifecycle is the first publisher the door itself owns (see `launchEvents.ts`).
 *
 * Slow consumers are bounded where the backbone bridges its synchronous publish to a pull: `stream` holds at most `DOOR_EVENT_BUFFER_EVENTS` events per subscriber and drops the oldest past that, whose absence the consumer detects by the gap it leaves in the source's sequence, the same contract the Remote Control subscription's bridge keeps. Everything here is in memory only and dies with the door process; the backbone holds no replay, so a subscriber that arrives late simply does not see earlier events.
 */

/**
 * How many events one stream subscriber's bridge holds while the consumer behind it has not pulled them. Not a fresh number: it is the bound oRPC's own `EventPublisher` documents as its default for exactly this slow-consumer case (a buffer without one grows without limit), and a full buffer drops the oldest event, whose absence a consumer detects by the gap it leaves in the sequence numbers.
 */
export const DOOR_EVENT_BUFFER_EVENTS = 100;

/** One registered source: the tag its events carry and the publish call the source owns. */
export interface DoorEventPublisher {
  /** The source's tag, the name a subscriber's filter names. */
  readonly source: string;
  /** Publishes one event: stamps the source's next sequence and delivers it to every matching subscriber synchronously, in publication order. */
  readonly publish: (payload: unknown) => void;
}

/** The pull side of one subscription: a bounded bridge from the backbone's synchronous publish to a consumer that asks for events one at a time. */
export interface DoorEventStream {
  /**
   * Resolves the next event the bridge holds, waiting for one to arrive when it holds none, and resolves done once the stream is closed and drained. Serves one pull at a time: a caller that pulls concurrently forfeits the earlier pull's wake, so the contract is a serial loop (the shape every consumer of this type, the typed API's subscription included, already has).
   */
  readonly next: () => Promise<IteratorResult<DoorEvent>>;
  /** Stops the delivery: detaches from the backbone and resolves a waiting pull (or the next one) with done. The buffer's contents are abandoned, not delivered. */
  readonly close: () => void;
}

/** The door's event backbone. One per door process; everything it holds dies with it. */
export interface DoorEventHub {
  /**
   * Registers one source and returns its publisher. Idempotent in the tag: a second registration of the same name publishes through the same sequence counter, so two handles of one source cannot split its ordering. The set of registered names is fixed when the door's assembly finishes, which is what the subscription's filter validation reads.
   */
  readonly publisher: (source: string) => DoorEventPublisher;
  /** Adds one listener, told every event whose source it matches; `undefined` listens to every source. Returns the detach function. */
  readonly subscribe: (sources: readonly string[] | undefined, listener: (event: DoorEvent) => void) => () => void;
  /** Opens one pull subscription over the backbone with the bounded drop-oldest bridge; `undefined` subscribes to every source. */
  readonly stream: (sources: readonly string[] | undefined) => DoorEventStream;
  /** Every registered source tag, sorted, as the subscription's filter validation names them. */
  readonly sources: () => readonly string[];
}

/** Creates the backbone: plain synchronous listener sets, one per source plus one for every-source listeners, and a monotonic sequence counter per source. */
export function createDoorEventHub(): DoorEventHub {
  const sequences = new Map<string, number>();
  const registered = new Set<string>();
  const every = new Set<(event: DoorEvent) => void>();
  const bySource = new Map<string, Set<(event: DoorEvent) => void>>();
  /** Delivers one stamped event to every listener its source matches. Synchronous so every subscriber observes publication order; a subscriber that cannot keep up is bounded where it is bridged to a pull (`stream`), not here. */
  const deliver = (event: DoorEvent): void => {
    for (const listener of every) {
      listener(event);
    }
    for (const listener of bySource.get(event.source) ?? []) {
      listener(event);
    }
  };
  const publish = (source: string, payload: unknown): void => {
    const sequence = (sequences.get(source) ?? 0) + 1;
    sequences.set(source, sequence);
    deliver({ source, sequence, payload });
  };
  /** Adds one listener to the sets its sources own, returning the detach that removes it from all of them; the hub's own subscribe and every stream bridge are built on it. */
  const addListener = (sources: readonly string[] | undefined, listener: (event: DoorEvent) => void): (() => void) => {
    if (sources === undefined) {
      every.add(listener);
      return () => {
        every.delete(listener);
      };
    }
    const listenersFor = (source: string): Set<(event: DoorEvent) => void> => {
      const listeners = bySource.get(source) ?? new Set();
      bySource.set(source, listeners);
      return listeners;
    };
    const detachers = sources.map((source) => {
      const listeners = listenersFor(source);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          bySource.delete(source);
        }
      };
    });
    return () => {
      for (const detach of detachers) {
        detach();
      }
    };
  };
  return {
    publisher: (source) => {
      registered.add(source);
      return {
        source,
        publish: (payload) => {
          publish(source, payload);
        },
      };
    },
    subscribe: addListener,
    stream: (sources) => {
      const queue: DoorEvent[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const detach = addListener(sources, (event) => {
        if (queue.length >= DOOR_EVENT_BUFFER_EVENTS) {
          queue.shift();
        }
        queue.push(event);
        wake?.();
      });
      return {
        next: async () => {
          for (;;) {
            const event = queue.shift();
            if (event !== undefined) {
              return { value: event, done: false as const };
            }
            if (closed) {
              return { value: undefined, done: true as const };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        close: () => {
          closed = true;
          detach();
          wake?.();
        },
      };
    },
    sources: () => [...registered].sort(),
  };
}

/**
 * Wraps one Remote Control fan-out so the client read stream becomes the backbone's first publisher: the stream hub the wrap is handed to publishes through it, every event reaching the fan-out exactly as before (its subscribers, the tracker's filing included, are served first) and the backbone beside it, source-tagged `rc` with the backbone's own sequence while the envelope's per-session `sequence_num` rides inside the payload verbatim. Subscribing through the wrap is the fan-out's own subscribe, untouched, so the Remote Control surfaces that read it keep their session filtering and their shapes.
 */
export function rcFanoutOnDoorHub(fanout: RcEventFanout, hub: DoorEventHub): RcEventFanout {
  const publisher = hub.publisher(DOOR_EVENT_SOURCE_RC);
  return {
    publish: (event: RcStreamEvent) => {
      fanout.publish(event);
      publisher.publish(event);
    },
    subscribe: (session, listener) => fanout.subscribe(session, listener),
  };
}
