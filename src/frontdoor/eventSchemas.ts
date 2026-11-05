import { z } from "zod";

import { UsageSnapshotSchema, type UsageSnapshot } from "../usage/schema";

/**
 * The Zod schemas of the door's event backbone: the envelope every source-tagged event carries, the source filter the subscription takes, and the launch lifecycle's own payload family. The backbone's TypeScript shapes in `eventHub.ts` and `launchEvents.ts` stay the implementations' types; these schemas are what the typed API's contract validates through, and because the backbone's publishers produce those interfaces' values, a drift between a schema and its interface fails the API's own output validation (exercised by its tests) rather than shipping silently. This module deliberately imports nothing from oRPC: it is a plain Zod leaf, so the backbone and its publishers can share it without depending on the API layer.
 */

/** The source tag the Remote Control client stream's events carry on the backbone: the first publisher, wrapped rather than rewritten, so its own surfaces keep their shapes untouched. */
export const DOOR_EVENT_SOURCE_RC = "rc";

/** The source tag every launch lifecycle event carries: the registry's own register, prune and end moments, the first publisher the door itself owns. */
export const LAUNCH_EVENT_SOURCE = "launch";

/** The source tag every usage change event carries: one event per usage snapshot the door writes, the durable fact a quota consumer diffs or reads windows from. */
export const USAGE_EVENT_SOURCE = "usage";

/** The source tag every door health event carries: the supervisor's own state transitions, the moments a consumer of the door needs to know the door itself changed. */
export const DOOR_HEALTH_EVENT_SOURCE = "door";

/** The source tag every expiring-quota event carries: an identity whose unused window allowance is about to reset, computed from the same snapshots the usage source keeps fresh. */
export const QUOTA_EXPIRING_EVENT_SOURCE = "quota-expiring";

/** One event on the door's backbone, exactly as the subscription yields it: the source that published it, the sequence the backbone assigned that source, and the publisher's own payload carried verbatim for the consumer to narrow. */
export const DoorEventSchema = z.strictObject({
  source: z.string().min(1),
  /** A positive integer because the backbone's counters start at one and only ever increase. */
  sequence: z.number().int().positive(),
  payload: z.unknown(),
});

/** One event on the backbone, as the TypeScript every in-process consumer handles it (the schema's own inferred type, so the two cannot drift). */
export type DoorEvent = z.output<typeof DoorEventSchema>;

/**
 * The query the backbone's subscription takes: optionally named sources, every source when omitted. An empty list is refused rather than read as "everything" or as "nothing", because a caller building it programmatically has almost certainly failed to append, and silently streaming no events at all is the one answer that would never be noticed.
 */
export const DoorEventSourceQuerySchema = z.strictObject({
  sources: z.array(z.string().min(1)).min(1).optional(),
});

/**
 * One launch lifecycle event: what the session registry already records (a launch registering, a capability pruned because its launcher died, a session ending by its launcher's own exit hook), observed at the tick that saw it. `startedAt` is the registry record's own value; `observedAt` is when the door observed the change, which is the tick, not the change itself.
 */
export const LaunchLifecycleEventSchema = z.strictObject({
  kind: z.enum(["registered", "pruned", "ended"]),
  pid: z.number().int().positive(),
  startedAt: z.number(),
  observedAt: z.number(),
});

/** One launch lifecycle event, as the TypeScript the publisher emits and its consumers handle. */
export type LaunchLifecycleEvent = z.output<typeof LaunchLifecycleEventSchema>;

/**
 * One door health event: the supervisor's own state transitions, observed at the moment they happened in this process. `generation` is the door fully serving (every listener bound and the state file naming it); `listenerFailed` is a start failure that ends the generation, naming which listener and why; `binaryTurnover` is the door retiring because the installed binary changed and no session is live, so the next launch serves from the new one; `idleShutdown` is the door closing itself with an empty session registry; `superseded` is the state file coming to name another live supervisor, `ownerPid`, after which this door takes no new sessions; `drained` is a superseded door closing itself because every session it served has ended.
 */
export const DoorHealthEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("generation"), pid: z.number().int().positive(), providerPort: z.number().int().positive(), connectPort: z.number().int().positive(), directPort: z.number().int().positive(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("listenerFailed"), pid: z.number().int().positive(), listener: z.enum(["provider", "connect", "direct"]), message: z.string(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("binaryTurnover"), pid: z.number().int().positive(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("idleShutdown"), pid: z.number().int().positive(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("superseded"), pid: z.number().int().positive(), ownerPid: z.number().int().positive(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("drained"), pid: z.number().int().positive(), observedAt: z.number() }),
]);

/** One door health event, as the TypeScript the publisher emits and its consumers handle. */
export type DoorHealthEvent = z.output<typeof DoorHealthEventSchema>;

/**
 * One expiring-quota event: an identity's window with allowance still unspent that is about to reset, published once when the window enters its final span (so a scheduler can spend what would otherwise be lost, the moment spending it is still possible). `resetsAt` is the window's own reset instant; `observedAt` is when the door's tick saw it cross.
 */
export const QuotaExpiringEventSchema = z.strictObject({
  /** The id of the identity whose window it is: what its usage is filed under, which a rename keeps. */
  id: z.string().min(1),
  /** The identity's name when the event was published, absent for an identity no longer stored under the id. */
  name: z.string().min(1).optional(),
  provider: z.string().min(1),
  window: z.enum(["fiveHour", "sevenDay"]),
  /** The fraction of the window already used when it was seen expiring, always below one because a fully used window has nothing left to spend. */
  utilization: z.number().min(0).max(1),
  resetsAt: z.iso.datetime(),
  observedAt: z.number(),
});

/** One expiring-quota event, as the TypeScript the publisher emits and its consumers handle. */
export type QuotaExpiringEvent = z.output<typeof QuotaExpiringEventSchema>;

/**
 * The usage source's payload: the snapshot the door just wrote, verbatim, so a consumer sees a quota change or a reset in the payload itself rather than the door guessing what the two writes were, with the identity it belongs to named both ways. A snapshot is filed by the identity's id, which its `identity` field also holds; `id` repeats it under the name every event uses, and `name` is the identity's name when the door wrote it, absent for a snapshot of an identity no longer stored under that id.
 */
export const UsageChangeEventSchema = UsageSnapshotSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});

/** One usage change event, as the TypeScript the publisher emits and its consumers handle (the schema's own inferred type). */
export type UsageChangeEvent = z.output<typeof UsageChangeEventSchema>;

/** What publishes the usage change event for each snapshot the door writes, naming the identity through `nameOf` (the door's `createIdentityNameReader`). */
export function usageEventPublisher(publish: (event: UsageChangeEvent) => void, nameOf: (id: string) => string | undefined): (snapshot: Readonly<UsageSnapshot>) => void {
  return (snapshot) => {
    publish(usageChangeEventOf(snapshot, nameOf(snapshot.identity)));
  };
}

/** The usage change event for a snapshot the door wrote: the snapshot, its id (the `identity` it is filed under) and, when an identity is stored under that id, its `name`. Pure, so what the door publishes is what a subscriber's `UsageChangeEventSchema.parse` accepts. */
export function usageChangeEventOf(snapshot: Readonly<UsageSnapshot>, name: string | undefined): UsageChangeEvent {
  return { ...snapshot, id: snapshot.identity, ...(name === undefined ? {} : { name }) };
}
