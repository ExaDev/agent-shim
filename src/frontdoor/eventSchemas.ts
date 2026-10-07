import { z } from "zod";

import type { UsageSnapshot } from "../usage/schema";

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
 * One door health event: the supervisor's own state transitions, observed at the moment they happened in this process. `generation` is the door fully serving (every listener bound and the state file naming it); `listenerFailed` is a start failure that ends the generation, naming which listener and why; `idleShutdown` is the door closing itself with an empty session registry.
 */
export const DoorHealthEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("generation"), pid: z.number().int().positive(), providerPort: z.number().int().positive(), connectPort: z.number().int().positive(), directPort: z.number().int().positive(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("listenerFailed"), pid: z.number().int().positive(), listener: z.enum(["provider", "connect", "direct"]), message: z.string(), observedAt: z.number() }),
  z.strictObject({ kind: z.literal("idleShutdown"), pid: z.number().int().positive(), observedAt: z.number() }),
]);

/** One door health event, as the TypeScript the publisher emits and its consumers handle. */
export type DoorHealthEvent = z.output<typeof DoorHealthEventSchema>;

/**
 * One expiring-quota event: an identity's window with allowance still unspent that is about to reset, published once when the window enters its final span (so a scheduler can spend what would otherwise be lost, the moment spending it is still possible). `resetsAt` is the window's own reset instant; `observedAt` is when the door's tick saw it cross.
 */
export const QuotaExpiringEventSchema = z.strictObject({
  identity: z.string().min(1),
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
 * The usage source's payload: the snapshot the door just wrote, verbatim, so a consumer sees the quota change or reset in the payload itself rather than the door guessing which of the two a write was. The snapshot schema is the payload schema (identity, observed instant, every provider's state with its windows), the one definition `usage --json` readers already share.
 */
/** One usage change event, as the TypeScript the publisher emits and its consumers handle: the written snapshot itself, so the snapshot's own schema (`UsageSnapshotSchema`) is this payload's schema rather than a renamed copy. */
export type UsageChangeEvent = UsageSnapshot;
