import { z } from "zod";

/**
 * The Zod schemas of the door's event backbone: the envelope every source-tagged event carries, the source filter the subscription takes, and the launch lifecycle's own payload family. The backbone's TypeScript shapes in `eventHub.ts` and `launchEvents.ts` stay the implementations' types; these schemas are what the typed API's contract validates through, and because the backbone's publishers produce those interfaces' values, a drift between a schema and its interface fails the API's own output validation (exercised by its tests) rather than shipping silently. This module deliberately imports nothing from oRPC: it is a plain Zod leaf, so the backbone and its publishers can share it without depending on the API layer.
 */

/** The source tag the Remote Control client stream's events carry on the backbone: the first publisher, wrapped rather than rewritten, so its own surfaces keep their shapes untouched. */
export const DOOR_EVENT_SOURCE_RC = "rc";

/** The source tag every launch lifecycle event carries: the registry's own register, prune and end moments, the first publisher the door itself owns. */
export const LAUNCH_EVENT_SOURCE = "launch";

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
