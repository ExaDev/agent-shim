import { z } from "zod";

/**
 * The JSON `agent-shim usage --resets --json` prints and the front door's `usage.resets` procedure returns, as one schema definition so the type and the published JSON Schema (`schema/ResetSchedule.schema.json`) cannot drift.
 */

/** One quota window of one identity and provider, with when it resets. */
export const ResetRowSchema = z.strictObject({
  identity: z.string(),
  provider: z.string(),
  /** What the window is: `5h`, `7d` or `extra usage` for an Anthropic account, or the provider's own measure and period (`tokens 5h`). */
  window: z.string(),
  /** When the state the window comes from was observed, as an ISO instant. */
  observedAt: z.iso.datetime(),
  /** When the window resets, as an ISO instant; absent when the upstream reported none. */
  resetsAt: z.iso.datetime().optional(),
  /** True when the reset time has passed, so the recorded observation describes a window that no longer exists and its utilisation reads as 0. */
  reset: z.boolean(),
  /** The fraction used, as `effectiveWindow` reads it at the report's own clock. */
  utilization: z.number().optional(),
  /** The window's own status, for a window that has not reset yet. */
  status: z.string().optional(),
});
export type ResetRow = z.infer<typeof ResetRowSchema>;

/** Every window of every recorded identity: those still to reset soonest first, then those whose reset has passed, then those with no reset time. */
export const ResetScheduleSchema = z.strictObject({ resets: z.readonly(z.array(ResetRowSchema)) });
export type ResetSchedule = z.infer<typeof ResetScheduleSchema>;
