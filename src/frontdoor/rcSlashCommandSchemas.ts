import { z } from "zod";

import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import { RC_GOAL_CONDITION_MAX_CHARS, RC_SESSION_COMMAND_MAX_WAIT_MS } from "./rcSessionCommands";

/**
 * The Zod schemas of the goal and compaction verbs' typed API (`rcSessionCommands.ts` holds the operations): the inputs each procedure accepts and the reports it answers with. Kept apart from `rcSchemas.ts` so the verbs' contract lives beside nothing else.
 */

/** The wait bound every verb accepts: a positive whole number of milliseconds no larger than Node's timers accept, or absent for the default. */
const WaitMsSchema = z.int().positive().max(RC_SESSION_COMMAND_MAX_WAIT_MS).optional();

/** The goal read's and clear's input: one non-empty session id and an optional wait bound. */
export const RcGoalSessionInputSchema = z.strictObject({
  session: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The goal set's input: one non-empty session id, the condition (as long as `/goal` accepts) and an optional wait bound. */
export const RcGoalSetInputSchema = z.strictObject({
  session: z.string().min(1),
  condition: z.string().min(1).max(RC_GOAL_CONDITION_MAX_CHARS).regex(/^[^\r\n]*$/u, "a goal condition is one line"),
  waitMs: WaitMsSchema,
});

/** The compaction's input: one non-empty session id and an optional wait bound. */
export const RcCompactInputSchema = z.strictObject({
  session: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The instructed compaction's input: the compaction's, plus the non-empty summarisation instructions that make it a directive, no longer than the control body cap every write the door makes into a session is held to. */
export const RcCompactWithInstructionsInputSchema = z.strictObject({
  session: z.string().min(1),
  instructions: z.string().trim().min(1).max(CONTROL_BODY_CAP_BYTES),
  waitMs: WaitMsSchema,
});

/** The fields every verb's answer carries: the session and the route that served it (the session's supervisor, or the door's own self-hosted surface). */
const commandAnswerShape = {
  session: z.string(),
  route: z.enum(["supervised", "self-hosted"]),
};

/** The goal read's answer: the active goal (condition, evaluated turns, the check's last reason when it gave one), or null when the session has none. */
export const RcGoalGetOutputSchema = z.strictObject({
  ...commandAnswerShape,
  goal: z.strictObject({ condition: z.string(), iterations: z.int().nonnegative(), lastCheck: z.string().optional() }).nullable(),
});

/** The goal set's answer: the condition now set and the one it replaced, or null when none was set. */
export const RcGoalSetOutputSchema = z.strictObject({
  ...commandAnswerShape,
  condition: z.string(),
  superseded: z.string().nullable(),
});

/** The goal clear's answer: the condition cleared, or null when there was none. */
export const RcGoalClearOutputSchema = z.strictObject({
  ...commandAnswerShape,
  cleared: z.string().nullable(),
});

/** The compaction's answer: the trigger as the session names it, and the token counts when the session recorded them. */
export const RcCompactOutputSchema = z.strictObject({
  ...commandAnswerShape,
  trigger: z.string(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
});
