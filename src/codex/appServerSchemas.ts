import { z } from "zod";

/**
 * The Codex release whose app-server protocol these schemas were written against. The shapes are the stable surface of `codex app-server generate-json-schema` (the `account/read` and `account/rateLimits/read` methods and the `initialize` handshake), checked against that release's output. A different installed release is not refused for being different: the answer is validated against these schemas, and a mismatch is reported naming both versions.
 */
export const CODEX_APP_SERVER_GENERATED_AGAINST = "0.160.0";

/** One rate-limit window: how much of it is used, when it resets (Unix seconds) and how long it is. */
const RateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullish(),
  windowDurationMins: z.number().nullish(),
});

/** One metered bucket's windows. `primary` and `secondary` are the short and long windows, told apart by `windowDurationMins`. */
const RateLimitSnapshotSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  planType: z.string().nullish(),
  primary: RateLimitWindowSchema.nullish(),
  secondary: RateLimitWindowSchema.nullish(),
  rateLimitReachedType: z.string().nullish(),
  spendControlReached: z.boolean().nullish(),
});

/** One banked reset credit: a grant that resets a rate-limit window when consumed. */
const RateLimitResetCreditSchema = z.object({
  id: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number().nullish(),
  resetType: z.string(),
  status: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

/** The login behind a Codex home: an API key, a ChatGPT sign-in (with its email and plan) or an Amazon Bedrock account. Never carries a token. */
const CodexAccountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.string() }),
  z.object({ type: z.literal("amazonBedrock"), usesCodexManagedCredentials: z.boolean().default(false) }),
]);

/** The answer to `account/read`: the login, or none, and whether Codex needs one before it can serve requests. */
export const CodexAccountReadSchema = z.object({
  account: CodexAccountSchema.nullable(),
  requiresOpenaiAuth: z.boolean(),
});

/** The answer to `account/rateLimits/read`: the windows (the single-bucket view and the view by metered limit id) and the banked reset credits. */
export const CodexRateLimitsReadSchema = z.object({
  rateLimits: RateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotSchema).nullish(),
  rateLimitResetCredits: z.object({ availableCount: z.number(), credits: z.array(RateLimitResetCreditSchema).nullish() }).nullish(),
  accountId: z.string().nullish(),
  ordinaryUsageAllowed: z.boolean().nullish(),
});

/** The part of the `initialize` answer the reader uses: the user agent, which carries the installed Codex version. */
export const CodexInitializeResultSchema = z.object({ userAgent: z.string() });

export type CodexAccountRead = z.infer<typeof CodexAccountReadSchema>;
export type CodexRateLimitsRead = z.infer<typeof CodexRateLimitsReadSchema>;
