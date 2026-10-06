import { z } from "zod";

import { PlanClassSchema } from "./plan";

/**
 * The JSON `claude-use pool pick --json` prints and `collectPoolPick` returns, as one schema definition so the type and the published JSON Schema (`schema/PoolPickReport.schema.json`) cannot drift.
 */

/** One ranked member as `pool pick --json` prints it. */
const PoolPickCandidateViewSchema = z.strictObject({
  identity: z.string(),
  /** In pick order: `scored` has usable quota data, `unknown` has none, `pay-per-use` bills by use, `ineligible` is refused right now. */
  class: z.enum(["scored", "unknown", "pay-per-use", "ineligible"]),
  /** Plan-size-weighted remaining quota per hour until its reset; present for `scored` only. */
  score: z.number().optional(),
  /** False when the five-hour window would run dry, at the observed pace, before it resets. */
  feasible: z.boolean(),
  /** When an `ineligible` member can be used again, as an ISO instant. */
  blockedUntil: z.iso.datetime().optional(),
  plan: PlanClassSchema,
  /** The facts behind the class and score, in the order they matter. */
  reasons: z.array(z.string()),
});

/** What `pool pick` reports: the ranking a launch from `directory` would act on right now. */
export const PoolPickReportSchema = z.strictObject({
  pool: z.string(),
  directory: z.string(),
  /** The member a launch would run as, absent when every member is refused. */
  pick: z.string().optional(),
  candidates: z.array(PoolPickCandidateViewSchema),
  /** Identity members anywhere in the pool's graph that do not exist; a launch skips them. */
  missing: z.array(z.string()),
  /** When nothing can be picked, the soonest any member returns. */
  earliestReturn: z.strictObject({ identity: z.string(), at: z.iso.datetime() }).optional(),
  /** Why the last-pick record could not be read, when that is the case. */
  stickyProblem: z.string().optional(),
});
export type PoolPickReport = z.infer<typeof PoolPickReportSchema>;
