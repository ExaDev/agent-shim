import { z } from "zod";

import { RC_CONTEXT_USAGE_DETAILS, RC_PERMISSION_MODES, RC_READ_FILE_ENCODINGS } from "./rcWrites";

/**
 * The Zod schemas of the Remote Control surfaces: one definition each for the summaries, statuses and pending lists the tracker produces, the stream events the door's client attachment fans out, and every input and output the typed API accepts. The tracker's own TypeScript interfaces in `rcSessions.ts` stay the implementations' types; these schemas are what the oRPC contract validates through, and because the procedures wrap the very operations that produce those interfaces' values, a drift between a schema and its interface fails the API's own output validation (exercised by its tests) rather than shipping silently. This module deliberately imports nothing from oRPC: it is a plain Zod leaf, so the tracker and the stream half can share it without either depending on the API layer.
 */

/** The permission modes the SDK's own `set_permission_mode` control request accepts, as the input schema of the set-permission-mode operation and the subscribe-free vocabulary every surface narrows untrusted strings through. */
export const RcPermissionModeSchema = z.enum(RC_PERMISSION_MODES);

/** One observed session as the control surfaces list it: the identification and timing only, never the credential. */
const RcSessionSummarySchema = z.strictObject({
  id: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});

/** One observed fact about the worker, with the instant of the exchange that carried it. */
function workerFactSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({ value, observedAt: z.number() });
}

/** One pending control request as the control surfaces list it: identification, type, summary and timing, never any credential. */
const RcPendingRequestSummarySchema = z.strictObject({
  sessionId: z.string(),
  requestId: z.string(),
  type: z.string(),
  summary: z.string(),
  observedAt: z.number(),
});

/** One observed session as the status surface reports it: the list summary plus what the worker's own exchanges carried and the requests awaiting an answer. */
const RcSessionStatusSchema = z.strictObject({
  ...RcSessionSummarySchema.shape,
  workerState: workerFactSchema(z.string()).optional(),
  workerIdleSeconds: workerFactSchema(z.number()).optional(),
  pending: z.readonly(z.array(RcPendingRequestSummarySchema)),
});

/** One event off the client read stream, exactly as the door forwards it to subscribers: the envelope the API host sent, with the fields the door itself relies on typed and the rest (the payload above all) carried verbatim for the consumer to narrow. */
export const RcStreamEnvelopeSchema = z.looseObject({
  /** The envelope's own event id, when the host sent one. */
  event_id: z.string().optional(),
  /** The envelope's event type, the discriminator a consumer switches on (`control_request`, `user`, and kin). */
  event_type: z.string(),
  /** The sequence number the host assigned, the value a resume continues after. */
  sequence_num: z.int(),
  /** Who emitted the event (`worker` for the CLI's half, a client id for a client's). */
  source: z.string(),
  /** The event's payload, carried verbatim: its shape is the payload family's, narrowed by whichever consumer needs it. Optional in the schema's own type because the door forwards the host's envelope as it arrived, asserting only the fields it relies on itself. */
  payload: z.unknown().optional(),
  /** When the host created the event; the protocol's own type for this field is not established here, so it is forwarded rather than asserted. */
  created_at: z.unknown().optional(),
});

/** One fan-out event: the session the stream it rode belongs to, beside the envelope itself. */
export const RcStreamEventSchema = z.strictObject({
  session: z.string(),
  envelope: RcStreamEnvelopeSchema,
});

/** One event off the client read stream, as the TypeScript every in-process consumer of the fan-out handles it (the schema's own inferred type, so the two cannot drift). */
export type RcStreamEnvelope = z.output<typeof RcStreamEnvelopeSchema>;

/** One fan-out event, as the TypeScript every in-process consumer handles it. */
export type RcStreamEvent = z.output<typeof RcStreamEventSchema>;

/**
 * One subscription window inside a `rate_limit_event` payload's `unifiedWindows`: the fraction of the window used and when it resets, as the CLI read them from the `anthropic-ratelimit-unified-*` response headers. Loose because the payload family grows: the door asserts the two fields it renders and carries anything else verbatim.
 */
export const RcRateLimitWindowSchema = z.looseObject({
  /** The fraction of the window used, usually between 0 and 1, above 1 when usage legitimately runs past the window's cap (the CLI's own field description states both). */
  utilization: z.number().optional(),
  /** When the window resets, in unix epoch seconds: the unit is the CLI's own field description, stated in the 2.1.289 bundle's schema. */
  resetsAt: z.number().optional(),
});

/** One subscription window's usage, as the TypeScript the renderers handle it. */
export type RcRateLimitWindow = z.output<typeof RcRateLimitWindowSchema>;

/**
 * The `rate_limit_info` a worker's `rate_limit_event` payload carries: the SDK's own `SDKRateLimitInfo`, read through the 2.1.289 bundle's schema, which is the fuller source because it adds `unifiedWindows` (the published d.ts omits it). The top-level fields describe the currently limiting window, with `rateLimitType` naming which one it is, while `unifiedWindows` carries each subscription window beside them; every `resetsAt` is unix epoch seconds. The fields the door renders are typed here and the overage trio beside them because the watch line and the page summary state them; everything else the family carries rides through verbatim. Loose for the same reason the envelope is: the family grows, the door asserts the fields it renders, and a field it does not know still reaches consumers rather than being stripped. `status` is asserted present because it is the payload's own one required field, so a payload without it is not this family and is not filed.
 */
export const RcRateLimitInfoSchema = z.looseObject({
  /** The limiting window's own status (`allowed`, `allowed_warning`, `rejected`), asserted only as a string because the vocabulary grows with the CLI. */
  status: z.string(),
  /** When the limiting window resets, in unix epoch seconds. */
  resetsAt: z.number().optional(),
  /** Which window the top-level fields describe (`five_hour`, `seven_day`, and kin), the payload's own name for it. */
  rateLimitType: z.string().optional(),
  /** The fraction of the limiting window used, on the same scale the per-window utilizations carry. */
  utilization: z.number().optional(),
  /** Whether usage beyond the plan (extra usage) is currently covering the overflow, the payload's own flag for it. */
  isUsingOverage: z.boolean().optional(),
  /** The overage's own status, the same vocabulary the limiting window's `status` carries. */
  overageStatus: z.string().optional(),
  /** When the overage window resets, in unix epoch seconds. */
  overageResetsAt: z.number().optional(),
  /** Each subscription window the account's response headers carried: the session (five-hour), weekly (seven-day), and overage-included weekly windows, each present only when the account's responses carry it. */
  unifiedWindows: z.looseObject({ five_hour: RcRateLimitWindowSchema.optional(), seven_day: RcRateLimitWindowSchema.optional(), seven_day_overage_included: RcRateLimitWindowSchema.optional() }).optional(),
});

/** One rate-limit payload's facts, as the TypeScript the live usage state and the renderers handle it. */
export type RcRateLimitInfo = z.output<typeof RcRateLimitInfoSchema>;

/** One live rate-limit observation as the live usage surface reports it: the session whose stream filed it, when the door observed it (the door's own clock, epoch milliseconds), and the payload's `rate_limit_info`. */
export const RcLiveRateLimitSchema = z.strictObject({
  session: z.string(),
  observedAt: z.number(),
  rateLimit: RcRateLimitInfoSchema,
});

/** One live rate-limit observation, as the TypeScript every in-process consumer handles it. */
export type RcLiveRateLimit = z.output<typeof RcLiveRateLimitSchema>;

/** The query every session-filtered read takes: optionally one `cse_` session id, every tracked session when omitted. */
export const RcSessionQuerySchema = z.strictObject({
  session: z.string().min(1).optional(),
});

/** The send operation's input: one non-empty session id and prompt text. */
export const RcSendInputSchema = z.strictObject({
  session: z.string().min(1),
  text: z.string().min(1),
});

/**
 * The answer operation's input: one non-empty session id, the control request's id, the decision, and the denial message. An approval carries no text (the protocol's allow result has no message field), so the combination is refused at the schema exactly as the bespoke route refuses it, rather than silently dropping the caller's words.
 */
export const RcAnswerInputSchema = z
  .strictObject({
    session: z.string().min(1),
    request: z.string().min(1),
    approve: z.boolean(),
    text: z.string().optional(),
  })
  .refine((input) => !input.approve || input.text === undefined || input.text === "", { message: "an approval carries no text (the protocol's allow result has no message field); text is the denial message" });

/** The interrupt operation's input: one non-empty session id. */
export const RcInterruptInputSchema = z.strictObject({
  session: z.string().min(1),
});

/** The set-model operation's input: one non-empty session id and model id (the SDK's own field treats an omitted or null value as a reset to the session default, which this operation never sends, and an empty string is neither). */
export const RcSetModelInputSchema = z.strictObject({
  session: z.string().min(1),
  model: z.string().min(1),
});

/** The set-permission-mode operation's input: one non-empty session id and a mode from the SDK's own enum. */
export const RcSetPermissionModeInputSchema = z.strictObject({
  session: z.string().min(1),
  mode: RcPermissionModeSchema,
});

/** The end-session operation's input: one non-empty session id and the optional reason the worker's own log names (an omitted reason is the protocol's unspecified form, so an empty string is refused rather than sent). */
export const RcEndSessionInputSchema = z.strictObject({
  session: z.string().min(1),
  reason: z.string().min(1).optional(),
});

/** The get-usage operation's input: one non-empty session id and the optional flag that skips the worker's local-transcript scan for the response's behaviours section. */
export const RcGetUsageInputSchema = z.strictObject({
  session: z.string().min(1),
  skipBehaviors: z.boolean().optional(),
});

/** The get-context-usage operation's input: one non-empty session id and the optional detail level from the SDK's own enum. */
export const RcGetContextUsageInputSchema = z.strictObject({
  session: z.string().min(1),
  detail: z.enum(RC_CONTEXT_USAGE_DETAILS).optional(),
});

/** The read-file operation's input: one non-empty session id, the file's path as the worker resolves it, and the optional byte cap and encoding from the SDK's own fields. */
export const RcReadFileInputSchema = z.strictObject({
  session: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
  encoding: z.enum(RC_READ_FILE_ENCODINGS).optional(),
});

/** The file-suggestions operation's input: one non-empty session id and the query prefix; the query itself may be empty, because the SDK's own field imposes no minimum and an empty prefix is the autocomplete's root listing. */
export const RcFileSuggestionsInputSchema = z.strictObject({
  session: z.string().min(1),
  query: z.string(),
});

/** The keep-alive operation's input: one non-empty session id; the payload itself carries nothing, which is the SDK's own shape for it. */
export const RcKeepAliveInputSchema = z.strictObject({
  session: z.string().min(1),
});

/** The mcp-status operation's input: one non-empty session id; the request's own shape declares no fields. */
export const RcMcpStatusInputSchema = z.strictObject({
  session: z.string().min(1),
});

/** The mcp-reconnect operation's input: one non-empty session id and the server name exactly as mcp_status reports it. */
export const RcMcpReconnectInputSchema = z.strictObject({
  session: z.string().min(1),
  serverName: z.string().min(1),
});

/** The mcp-authenticate operation's input: one non-empty session id, the server name, and the redirect URI the server's OAuth flow redirects back to. */
export const RcMcpAuthenticateInputSchema = z.strictObject({
  session: z.string().min(1),
  serverName: z.string().min(1),
  redirectUri: z.string().min(1),
});

/** The mcp-oauth-callback-url operation's input: one non-empty session id, the server name, and the callback URL the browser landed on. */
export const RcMcpOAuthCallbackUrlInputSchema = z.strictObject({
  session: z.string().min(1),
  serverName: z.string().min(1),
  callbackUrl: z.string().min(1),
});

/** The teleport operation's input: one non-empty session id and the marker text the teleport relay anchors on (the CLI's own relay demands a line with a uuid and string content, so an empty marker names neither). */
export const RcTeleportInputSchema = z.strictObject({
  session: z.string().min(1),
  marker: z.string().min(1),
});

/** The session list's answer shape. */
export const RcListOutputSchema = z.strictObject({ sessions: z.readonly(z.array(RcSessionSummarySchema)) });

/** The status read's answer shape. */
export const RcStatusOutputSchema = z.strictObject({ statuses: z.readonly(z.array(RcSessionStatusSchema)) });

/** The pending read's answer shape. */
export const RcPendingOutputSchema = z.strictObject({ pending: z.readonly(z.array(RcPendingRequestSummarySchema)) });

/** The write operations' answer shape: the session the write went to and the sequence numbers the real service assigned. */
export const RcWriteOutputSchema = z.strictObject({
  session: z.string(),
  sequenceNums: z.readonly(z.array(z.number())),
});

/**
 * The control-request operations' answer shape: the write result plus the request id the operation minted, because the worker's `control_response` echoes exactly that id on the stream the door already fans out, and only the door ever knew it.
 */
export const RcControlWriteOutputSchema = z.strictObject({
  session: z.string(),
  request: z.string(),
  sequenceNums: z.readonly(z.array(z.number())),
});

/** The answer operation's answer shape: the write result plus the request id that was answered. */
export const RcAnswerOutputSchema = z.strictObject({
  session: z.string(),
  request: z.string(),
  sequenceNums: z.readonly(z.array(z.number())),
});
