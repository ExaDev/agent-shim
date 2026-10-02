import { z } from "zod";

/**
 * The usage store's one schema definition: every record the front door appends to the usage log, the per-identity snapshot other tools read, and the account metadata both carry. Each is a strict object, so a field not named here can never be written (the store validates every record and snapshot before it touches disk) and the published JSON Schemas (`schema/UsageRecord.schema.json`, `schema/UsageSnapshot.schema.json`) describe exactly what a reader can find.
 *
 * Metadata only, by construction: nothing here can hold a prompt, a response, tool content, or a credential. Rate-limit headers are kept by name from an allow-list of quota headers (`isRateLimitHeader`), never wholesale.
 */

/** The version of the record and snapshot shapes below. A reader checks it before trusting a document; a change that is not purely additive bumps it. */
export const USAGE_SCHEMA_VERSION = 1;

const VersionSchema = z.literal(USAGE_SCHEMA_VERSION);

/** An ISO-8601 instant, always written in UTC by `Date.prototype.toISOString`. */
const InstantSchema = z.iso.datetime();

const TokenCountSchema = z.number().int().nonnegative();

/** Token counts from a response body's `usage` object, renamed to this project's casing. Each field is present only when the response reported it. */
export const TokenUsageSchema = z.strictObject({
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  cacheReadInputTokens: TokenCountSchema.optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** The two kinds of refusal a consumer acts on differently: a short rate limit is worth retrying on the same credential once its wait has passed, an exhausted quota means moving to the next credential until the reset. */
const LIMIT_KINDS = ["rate-limited", "quota-exhausted"] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** A 429 (or 402) classified, with the wait or reset the upstream announced and the signals the classification rests on. */
export const LimitClassificationSchema = z.strictObject({
  kind: z.enum(LIMIT_KINDS),
  /** Seconds to wait before retrying, from the response's `retry-after`. */
  retryAfterSeconds: z.number().nonnegative().optional(),
  /** When the limiting window resets, from the upstream's own reset header. */
  resetAt: InstantSchema.optional(),
  /** The window the upstream named as the binding one (`anthropic-ratelimit-unified-representative-claim`), such as `five_hour` or `seven_day`. */
  window: z.string().optional(),
  /** The signals the classification rests on, each `<name>=<value>` from a response header or the error body's `type` or `code`. Never the error message. */
  evidence: z.array(z.string()),
});
export type LimitClassification = z.infer<typeof LimitClassificationSchema>;

/** One routed request, appended to the usage log when its response has finished. */
export const UsageRecordSchema = z.strictObject({
  schemaVersion: VersionSchema,
  /** When the front door received the request. */
  at: InstantSchema,
  /** The launching identity, when the launch resolved one. */
  identity: z.string().optional(),
  /** `anthropic` for an OAuth session's request to Claude Code's own API, otherwise the provider's name. */
  provider: z.string(),
  /** The launch's session id, generated per launch. */
  sessionId: z.string().optional(),
  /** The project the launch ran in (its git repository root), when the launch sent one: headroom launches do. */
  project: z.string().optional(),
  /** The front-door route that served the request. */
  route: z.string(),
  method: z.string(),
  /** The API path as the upstream sees it (`/v1/messages`), without the provider prefix or a query string. */
  endpoint: z.string(),
  /** The model the response named. */
  model: z.string().optional(),
  status: z.number().int(),
  /** Milliseconds from the request's arrival to its response head. */
  latencyMs: z.number().int().nonnegative(),
  /** Milliseconds from the request's arrival to the end of its response body. */
  durationMs: z.number().int().nonnegative(),
  /** Whether the client received the whole body. */
  outcome: z.enum(["completed", "aborted"]),
  usage: TokenUsageSchema.optional(),
  /** The response's quota and rate-limit headers, by name (see `isRateLimitHeader`). */
  rateLimitHeaders: z.record(z.string(), z.string()).optional(),
  limit: LimitClassificationSchema.optional(),
  /** The upstream's request id (`request-id`), for matching a record to the provider's own logs. */
  requestId: z.string().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** One quota window from Anthropic's unified rate-limit headers. */
const QuotaWindowSchema = z.strictObject({
  /** The fraction of the window used, as the upstream reports it (0 to 1). */
  utilization: z.number().nonnegative().optional(),
  resetsAt: InstantSchema.optional(),
  /** The window's own status (`allowed`, `allowed_warning`, `rejected`). */
  status: z.string().optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/** Anthropic's unified subscription rate-limit state, parsed from the `anthropic-ratelimit-unified-*` headers (which the in-process Codex route also derives from the Codex backend's own quota headers). */
export const UnifiedRateLimitSchema = z.strictObject({
  /** The overall status: `allowed`, `allowed_warning` or `rejected`. */
  status: z.string().optional(),
  fiveHour: QuotaWindowSchema.optional(),
  sevenDay: QuotaWindowSchema.optional(),
  /** The window that currently binds. */
  representativeClaim: z.string().optional(),
  /** When the binding window resets. */
  resetAt: InstantSchema.optional(),
  /** Whether usage beyond the plan (extra usage) is available: `allowed` or `rejected`. */
  overageStatus: z.string().optional(),
});
export type UnifiedRateLimit = z.infer<typeof UnifiedRateLimitSchema>;

/** The latest rate-limit state an upstream reported on any response. */
const RateLimitStateSchema = z.strictObject({
  observedAt: InstantSchema,
  /** Every quota and rate-limit header on that response, by name. */
  headers: z.record(z.string(), z.string()),
  unified: UnifiedRateLimitSchema.optional(),
});
export type RateLimitState = z.infer<typeof RateLimitStateSchema>;

/** A classified refusal, with when it was seen and its status. */
const LimitEventSchema = LimitClassificationSchema.extend({
  observedAt: InstantSchema,
  status: z.number().int(),
});
export type LimitEvent = z.infer<typeof LimitEventSchema>;

/** One quota window a provider reports through its own usage endpoint (as opposed to headers on a response): how much of it is used and when it resets. */
const ProviderQuotaWindowSchema = z.strictObject({
  /** What the window measures, in the provider's terms (`tokens`, `tool-calls`). */
  measures: z.string(),
  /** The window's length in milliseconds, when the provider's unit is one this project knows; absent for an unrecognised unit, with `period` carrying the raw code. */
  periodMs: z.number().int().positive().optional(),
  /** The provider's own description of the period when `periodMs` could not be derived, such as `unit 4 x 1`. */
  period: z.string().optional(),
  /** The fraction of the window used (0 to 1). */
  utilization: z.number().nonnegative(),
  resetsAt: InstantSchema.optional(),
  /** Absolute counts, when the provider reports them for this window. */
  limit: z.number().nonnegative().optional(),
  used: z.number().nonnegative().optional(),
  remaining: z.number().nonnegative().optional(),
});
export type ProviderQuotaWindow = z.infer<typeof ProviderQuotaWindowSchema>;

/** A provider's quota as its usage endpoint last reported it. Pulled, not observed on a request, so it carries its own observation time. */
export const ProviderQuotaSchema = z.strictObject({
  observedAt: InstantSchema,
  /** Which usage endpoint produced it (`z.ai`). */
  source: z.string(),
  /** The subscription level the endpoint reports, when it does. */
  level: z.string().optional(),
  windows: z.array(ProviderQuotaWindowSchema),
});
export type ProviderQuota = z.infer<typeof ProviderQuotaSchema>;

/** One provider's latest state under one identity. */
const ProviderUsageStateSchema = z.strictObject({
  lastRequestAt: InstantSchema,
  lastStatus: z.number().int(),
  lastModel: z.string().optional(),
  /** The latest rate-limit state, from the last response that carried any rate-limit header. */
  rateLimit: RateLimitStateSchema.optional(),
  /** The latest classified refusal. It stays after later successes, so a reader compares its `resetAt` (or `observedAt` plus `retryAfterSeconds`) with the current time. */
  lastLimit: LimitEventSchema.optional(),
  /** The latest quota the provider's usage endpoint reported, for providers whose quota is not visible in response headers. */
  quota: ProviderQuotaSchema.optional(),
});
export type ProviderUsageState = z.infer<typeof ProviderUsageStateSchema>;

/**
 * The account fields copied from an identity's stored Claude login (`oauthAccount` in the identity's `.claude.json`): who the account is and which plan and tier it is on. Never the token, which Claude Code keeps elsewhere. Each field is present only when the stored login has it; a setup-token identity has no profile scope and so none of them (see issue #44).
 */
export const AccountMetadataSchema = z.strictObject({
  accountUuid: z.string().optional(),
  emailAddress: z.string().optional(),
  displayName: z.string().optional(),
  organizationUuid: z.string().optional(),
  organizationName: z.string().optional(),
  organizationType: z.string().optional(),
  organizationRole: z.string().optional(),
  workspaceRole: z.string().optional(),
  billingType: z.string().optional(),
  seatTier: z.string().optional(),
  organizationRateLimitTier: z.string().optional(),
  userRateLimitTier: z.string().optional(),
  hasExtraUsageEnabled: z.boolean().optional(),
  subscriptionCreatedAt: z.string().optional(),
  accountCreatedAt: z.string().optional(),
});
export type AccountMetadata = z.infer<typeof AccountMetadataSchema>;

/**
 * The latest state for one identity, rewritten atomically after each recorded response: the snapshot file other tools read (`~/.claude-use/usage/snapshots/<identity>.json`) without shelling out to `claude-use`.
 */
export const UsageSnapshotSchema = z.strictObject({
  schemaVersion: VersionSchema,
  identity: z.string(),
  updatedAt: InstantSchema,
  /** The identity's account metadata as of `updatedAt`. */
  account: AccountMetadataSchema.optional(),
  /** Latest state per provider, keyed by provider name (`anthropic` for OAuth sessions). */
  providers: z.record(z.string(), ProviderUsageStateSchema),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/**
 * Whether a response header is one the store keeps: the quota and rate-limit families the upstreams claude-use routes to send (Anthropic's `anthropic-ratelimit-*`, the IETF draft's `ratelimit*`, the common `x-ratelimit-*`, the Codex backend's `x-codex-*` quota headers, which the Codex route forwards) and `retry-after`. Every one of these carries a number, a time or a status word; none carries a credential or content.
 */
export function isRateLimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "retry-after" || lower.startsWith("anthropic-ratelimit-") || lower.startsWith("x-ratelimit-") || lower.startsWith("ratelimit") || lower.startsWith("x-codex-");
}
