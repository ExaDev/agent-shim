import { z } from "zod";

/** The schema of the runtime route overrides file (`route-overrides.json`), kept apart from its store so the published JSON Schema is generated from it alone. */

/** One scope's table: a Claude name or class to the name it is routed by. */
const OverrideTableSchema = z.record(z.string().min(1), z.string().min(1));
export type OverrideTable = z.infer<typeof OverrideTableSchema>;

export const RouteOverridesSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  /** Every session with no entry of its own for the name. */
  global: OverrideTableSchema.optional(),
  /** By provider name: the sessions whose request would reach that provider. */
  providers: z.record(z.string().min(1), OverrideTableSchema).optional(),
  /** By identity name: the sessions running as that identity. */
  identities: z.record(z.string().min(1), OverrideTableSchema).optional(),
  /** By launch session id: one session. */
  sessions: z.record(z.string().min(1), OverrideTableSchema).optional(),
});
export type RouteOverrides = z.infer<typeof RouteOverridesSchema>;

