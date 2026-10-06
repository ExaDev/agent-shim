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

/** The context-usage detail levels the SDK's own `get_context_usage` field declares, as the input schema's enum. */
export const RcContextUsageDetailSchema = z.enum(RC_CONTEXT_USAGE_DETAILS);

/** The get-context-usage operation's input: one non-empty session id and the optional detail level from the SDK's own enum. */
export const RcGetContextUsageInputSchema = z.strictObject({
  session: z.string().min(1),
  detail: RcContextUsageDetailSchema.optional(),
});

/** The read-file encodings the SDK's own `encoding` field declares, as the input schema's enum. */
export const RcReadFileEncodingSchema = z.enum(RC_READ_FILE_ENCODINGS);

/** The read-file operation's input: one non-empty session id, the file's path as the worker resolves it, and the optional byte cap and encoding from the SDK's own fields. */
export const RcReadFileInputSchema = z.strictObject({
  session: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
  encoding: RcReadFileEncodingSchema.optional(),
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
