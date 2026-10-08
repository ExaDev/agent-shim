import { DOOR_HEALTH_EVENT_SOURCE, type DoorHealthEvent } from "./eventSchemas";
import type { DoorEventHub } from "./eventHub";

/**
 * The door health publisher: the supervisor's own state transitions as backbone events, so a consumer of the door learns the door itself changed and not only its sessions. The publisher emits nothing of its own: the supervisor tells it the moments it already lives through (every listener bound, a start failure that ends the generation, the binary turnover, the idle shutdown), each published the moment it happens rather than at a tick, because these are process facts, not registry facts diffed between observations.
 */

/** Everything the door health publisher needs: the backbone it publishes on and the clock its events are observed at. */
export interface DoorHealthPublisher {
  /** Publishes the generation event: every listener bound, the state file naming this supervisor, the door fully serving. */
  readonly generation: (ports: { readonly providerPort: number; readonly connectPort: number; readonly directPort: number }) => void;
  /** Publishes the start failure that ends the generation, naming which listener and why. */
  readonly listenerFailed: (listener: "provider" | "connect" | "direct", message: string) => void;
  /** Publishes the binary turnover: the door retiring with an empty session registry because the installed binary changed, so the next launch serves from the new one. */
  readonly binaryTurnover: () => void;
  /** Publishes the idle shutdown: the door closing itself with an empty session registry. */
  readonly idleShutdown: () => void;
}

/** Creates the door health publisher. One per door process, fed by the supervisor. */
export function createDoorHealthPublisher(hub: DoorEventHub, now: () => number, pid: number): DoorHealthPublisher {
  const publisher = hub.publisher(DOOR_HEALTH_EVENT_SOURCE);
  return {
    generation: (ports) => {
      publisher.publish({ kind: "generation", pid, providerPort: ports.providerPort, connectPort: ports.connectPort, directPort: ports.directPort, observedAt: now() } satisfies DoorHealthEvent);
    },
    listenerFailed: (listener, message) => {
      publisher.publish({ kind: "listenerFailed", pid, listener, message, observedAt: now() } satisfies DoorHealthEvent);
    },
    idleShutdown: () => {
      publisher.publish({ kind: "idleShutdown", pid, observedAt: now() } satisfies DoorHealthEvent);
    },
    binaryTurnover: () => {
      publisher.publish({ kind: "binaryTurnover", pid, observedAt: now() } satisfies DoorHealthEvent);
    },
  };
}
