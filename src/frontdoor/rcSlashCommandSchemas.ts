import { z } from "zod";

import { RC_COMPACT_INSTRUCTIONS_MAX_CHARS, RC_GOAL_CONDITION_MAX_CHARS, RC_SESSION_COMMAND_MAX_WAIT_MS, RC_TURN_TEXT_MAX_CHARS } from "./rcSessionCommands";

/**
 * The Zod schemas of the goal, compaction and turn verbs' typed API (`rcSessionCommands.ts` holds the operations): the inputs each procedure accepts and the reports it answers with. Kept apart from `rcSchemas.ts` so the verbs' contract lives beside nothing else.
 */

/** The wait bound every verb accepts: a positive whole number of milliseconds no larger than Node's timers accept, or absent for the default. */
const WaitMsSchema = z.int().positive().max(RC_SESSION_COMMAND_MAX_WAIT_MS).optional();

/** The goal read's and clear's input: one non-empty session id and an optional wait bound. */
export const RcGoalSessionInputSchema = z.strictObject({
  session: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The goal set's input: one non-empty session id, the condition (trimmed before it is measured, then as long as `/goal` accepts) and an optional wait bound. */
export const RcGoalSetInputSchema = z.strictObject({
  session: z.string().min(1),
  condition: z.string().trim().min(1).max(RC_GOAL_CONDITION_MAX_CHARS).regex(/^[^\r\n]*$/u, "a goal condition is one line"),
  waitMs: WaitMsSchema,
});

/** The compaction's input: one non-empty session id and an optional wait bound. */
export const RcCompactInputSchema = z.strictObject({
  session: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The instructed compaction's input: the compaction's, plus the non-empty summarisation instructions that make it a directive, no longer than fits in one request body under the door's control body cap however it encodes. */
export const RcCompactWithInstructionsInputSchema = z.strictObject({
  session: z.string().min(1),
  instructions: z.string().trim().min(1).max(RC_COMPACT_INSTRUCTIONS_MAX_CHARS),
  waitMs: WaitMsSchema,
});

/** The turn's input: one non-empty session id, the text as the person typed it (not trimmed, since it is their words; refused when it is only whitespace or starts with `/`, which the router explains), no longer than fits in one request body under the door's control body cap however it encodes, and an optional wait bound. */
export const RcTurnInputSchema = z.strictObject({
  session: z.string().min(1),
  text: z.string().min(1).max(RC_TURN_TEXT_MAX_CHARS),
  waitMs: WaitMsSchema,
});

/** The fields every verb's answer carries: the session and the route that served it (the control plugin of a supervised or an unsupervised launch, or the door's own self-hosted surface). */
const commandAnswerShape = {
  session: z.string(),
  route: z.enum(["supervised", "launched", "self-hosted"]),
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

/** The turn's answer: the uuid of the user entry the session recorded for the turn. */
export const RcTurnOutputSchema = z.strictObject({
  ...commandAnswerShape,
  uuid: z.string(),
});

/** The compaction's answer: the trigger as the session names it, and the token counts when the session recorded them. */
export const RcCompactOutputSchema = z.strictObject({
  ...commandAnswerShape,
  trigger: z.string(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
});
