import { LAUNCH_EVENT_SOURCE, type LaunchLifecycleEvent } from "./eventSchemas";
import type { DoorEventHub } from "./eventHub";
import type { FrontDoorSessionSummary } from "./state";

/**
 * The launch lifecycle publisher: the door's first event source of its own, turning the session registry the supervisor already reads each tick into source-tagged backbone events. A launch registering, a capability pruned because its launcher died, and a session ending by its launcher's own exit hook are all registry facts before they are events, which is why the publisher emits nothing of its own: it is fed the tick's listing and the pids the prune removed, and publishes the diff against the previous tick.
 *
 * The first observation establishes the baseline and emits nothing, because a session the registry already held registered before this door generation began and the door never observed the moment; the backbone holds no replay in any case. Within one observation the departures publish before the arrivals (the prune the tick performs, then the ends the tick discovered, then the registrations), each group in the registry's own pid order, the one ordering the facts genuinely carry; anything finer happened between ticks and no claim about it would be honest.
 */

/** Everything the launch lifecycle publisher needs: the backbone it publishes on and the clock its events are observed at. */
export interface LaunchEventPublisher {
  /**
   * Reports one tick's registry facts: the sessions the tick's listing saw (taken before the prune, so a pruned launch's record is still there to name its start time) and the pids the tick's prune removed. Publishes the diff against the previous observation; the first observation is the baseline and publishes nothing.
   */
  readonly observe: (sessions: readonly FrontDoorSessionSummary[], pruned: readonly number[]) => void;
}

/** Creates the launch lifecycle publisher. One per door process, fed by the supervisor's tick. */
export function createLaunchEventPublisher(hub: DoorEventHub, now: () => number): LaunchEventPublisher {
  const publisher = hub.publisher(LAUNCH_EVENT_SOURCE);
  /** The previous observation's registry state as this publisher derived it (the listing minus what that same tick's prune removed), keyed by pid; undefined until the baseline observation. */
  let known: Map<number, FrontDoorSessionSummary> | undefined;
  return {
    observe: (sessions, pruned) => {
      const previous = known;
      const listed = new Map(sessions.map((session) => [session.pid, session]));
      const prunedSet = new Set(pruned);
      known = new Map([...listed].filter(([pid]) => !prunedSet.has(pid)));
      if (previous === undefined) {
        return;
      }
      const emit = (kind: LaunchLifecycleEvent["kind"], pid: number, startedAt: number): void => {
        publisher.publish({ kind, pid, startedAt, observedAt: now() } satisfies LaunchLifecycleEvent);
      };
      // The prune the tick performed: dead launches whose capabilities stopped being accepted. A launch whose record appeared and died between two ticks publishes here and only here, which is the honest statement (the registry never held it live).
      for (const pid of pruned) {
        const session = listed.get(pid);
        if (session !== undefined) {
          emit("pruned", pid, session.startedAt);
        }
      }
      // The ends the tick discovered: records the previous observation held that the listing no longer sees and the prune did not remove, which is the launcher's own exit hook having unregistered it.
      for (const [pid, session] of previous) {
        if (!listed.has(pid) && !prunedSet.has(pid)) {
          emit("ended", pid, session.startedAt);
        }
      }
      // The registrations: records the listing sees that no previous observation held and the prune did not just clear.
      for (const [pid, session] of listed) {
        if (!previous.has(pid) && !prunedSet.has(pid)) {
          emit("registered", pid, session.startedAt);
        }
      }
    },
  };
}
