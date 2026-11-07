import { z } from "zod";

/**
 * The Zod schemas of the goal and compaction verbs' typed API (`rcSlashCommands.ts` holds the operations): the inputs each procedure accepts and the reports it answers with. A plain Zod leaf, like `rcSchemas.ts`, kept apart from it so the verbs' contract lives beside nothing else.
 */

/** The wait bound every verb accepts: a positive whole number of milliseconds, or absent for the default. */
const WaitMsSchema = z.int().positive().optional();

/** The goal read's and clear's input: one non-empty session id and an optional wait bound. */
export const RcGoalSessionInputSchema = z.strictObject({
  session: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The goal set's input: one non-empty session id, the condition and an optional wait bound. */
export const RcGoalSetInputSchema = z.strictObject({
  session: z.string().min(1),
  condition: z.string().min(1),
  waitMs: WaitMsSchema,
});

/** The compaction's input: one non-empty session id, optional summarisation instructions and an optional wait bound. */
export const RcCompactInputSchema = z.strictObject({
  session: z.string().min(1),
  instructions: z.string().optional(),
  waitMs: WaitMsSchema,
});

/** The fields every verb's answer carries: the session and the sequence numbers the command's own write was assigned. */
const commandAnswerShape = {
  session: z.string(),
  sequenceNums: z.readonly(z.array(z.number())),
};

/** The goal read's answer: the active goal (condition, evaluated turns, the check's last reason when it gave one), or null when the session has none. */
export const RcGoalGetOutputSchema = z.strictObject({
  ...commandAnswerShape,
  goal: z.strictObject({ condition: z.string(), iterations: z.int().nonnegative(), lastCheck: z.string().optional() }).nullable(),
});

/** The goal set's answer: the condition the worker confirmed. */
export const RcGoalSetOutputSchema = z.strictObject({
  ...commandAnswerShape,
  condition: z.string(),
});

/** The goal clear's answer: the condition cleared, or null when there was none. */
export const RcGoalClearOutputSchema = z.strictObject({
  ...commandAnswerShape,
  cleared: z.string().nullable(),
});

/** The compaction's answer: the trigger and the token counts the compact boundary named. */
export const RcCompactOutputSchema = z.strictObject({
  ...commandAnswerShape,
  trigger: z.string(),
  preTokens: z.number(),
  postTokens: z.number(),
});
