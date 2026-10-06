import { HTTP_STATUS } from "../codex/http";
import { isSuccessful, type RcPendingRequestSummary } from "./rcSessions";

/**
 * The Remote Control client-half writes: the payload builders, the write engine and one typed operation per control verb the door can send into an observed session, every one an event write to `/v1/code/sessions/{id}/events` over the door's interception-proof dials, authenticated by the observed bearer and protocol headers the tracker (`rcSessions.ts`) holds.
 *
 * Every request-shaped write goes through one envelope builder (`buildRcControlRequestPayload`) so the family cannot drift apart in shape, and one delivery engine (`deliverRcClientPayload`, module-local) so the two credential guards, the dial and the sequence-cursor advance exist exactly once. The fields each subtype carries are the SDK's own (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`) where it declares the subtype, and the CLI bundle's own request builders where it does not (`mcp_authenticate`, `mcp_oauth_callback_url`), each named in its builder's doc comment.
 *
 * A write that carried a `control_request` returns the request id it minted, because the worker's `control_response` echoes exactly that id on the stream the door already fans out: a consumer that wants the answer matches it there, and the id is surfaced by the result since only the door ever knew it.
 */

/**
 * Builds the user-message payload event for one injected prompt: the Agent SDK stream-json `user` message shape (`type`, `uuid`, `session_id`, `parent_tool_use_id`, `message` with a `user` role), the same envelope a claude.ai client sends as a turn. The content is the plain string form, which is the shape validated end to end against the real API by the third-party client survey that settled this protocol.
 */
export function buildRcUserMessagePayload(uuid: string, sessionId: string, text: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

/** Wraps payload event(s) in the write body the endpoint takes: `{"events": [{"payload": {...}}]}`. */
export function buildRcEventWriteBody(payload: Record<string, unknown>): Record<string, unknown> {
  return { events: [{ payload }] };
}

/** The headers a client-half write sends: the observed OAuth-kind credential and protocol values, replayed verbatim, never invented. */
export interface RcWriteHeaders {
  readonly authorization: string | undefined;
  readonly anthropicVersion: string | undefined;
  readonly anthropicClientPlatform: string | undefined;
}

/** One answer from the API host the write path dials: the status and the whole body. This dial only ever reads small JSON answers, never a stream, so the body needs no cap of its own. */
export interface RcDialAnswer {
  readonly status: number;
  readonly body: string;
}

/** The one network effect a client-half write performs, injected so the pure logic runs against fakes: POST the write body to the session's events endpoint. Production dials the real API host over the door's interception-proof agent; tests redirect to a local stand-in. */
export interface RcEventDial {
  readonly writeEvents: (sessionId: string, headers: Readonly<Record<string, string>>, body: string) => Promise<RcDialAnswer>;
}

/**
 * What one client-half write produced: the sequence numbers the real service assigned, or a verbose failure message ready to show a user. A write that carried a `control_request` also names the request id it minted, because the worker's `control_response` echoes exactly that id on the stream: a consumer that wants the answer matches it there, and the id is surfaced here since only the door ever knew it.
 */
export type RcEventWriteResult = { readonly ok: true; readonly sequenceNums: readonly number[]; readonly requestId?: string } | { readonly ok: false; readonly message: string };

/** Reads `results[].sequence_num` out of an accepted write answer: the numbers the real service assigned to the events, which every attached client's stream resumes from. */
function sequenceNumsOf(body: string): readonly number[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) {
    return undefined;
  }
  const sequenceNums: number[] = [];
  const results: readonly unknown[] = parsed.results;
  for (const result of results) {
    if (typeof result !== "object" || result === null || !("sequence_num" in result)) {
      return undefined;
    }
    const sequenceNum: unknown = result.sequence_num;
    // The real API returns the assigned number as a JSON string ("6"), observed live against a real write; accept either shape and normalise to the number it names, so a delivered event is never reported unconfirmed.
    if (typeof sequenceNum === "number") {
      sequenceNums.push(sequenceNum);
    } else if (typeof sequenceNum === "string" && /^[0-9]+$/.test(sequenceNum)) {
      sequenceNums.push(Number(sequenceNum));
    } else {
      return undefined;
    }
  }
  // An accepted write that assigned no sequence number at all confirms no delivery, so it is a failure to surface rather than an empty success.
  return sequenceNums.length === 0 ? undefined : sequenceNums;
}

/** Maps one dial answer to the write result: an accepted write yields its sequence numbers; anything else yields a verbose message, with the 401 case naming the stale observed bearer as the cause. */
export function rcEventWriteResultFromAnswer(answer: RcDialAnswer): RcEventWriteResult {
  if (!isSuccessful(answer.status)) {
    if (answer.status === HTTP_STATUS.unauthorized) {
      return { ok: false, message: `the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale after the door last saw the session's traffic. The session's own client refreshes it on its next call, which the door will observe, so retry once Remote Control has been active again. API answer: ${answer.body}` };
    }
    return { ok: false, message: `the API answered HTTP ${String(answer.status)} to the injected event: ${answer.body}` };
  }
  const sequenceNums = sequenceNumsOf(answer.body);
  if (sequenceNums === undefined) {
    return { ok: false, message: `the API accepted the injected event but its answer named no results[].sequence_num, so delivery cannot be confirmed: ${answer.body}` };
  }
  return { ok: true, sequenceNums };
}

/** The credential and protocol headers the tracker holds for one session, the client-half writes' accessor: present only while the session is tracked, and never surfaced anywhere a summary, log or capture goes. */
export type RcObservedCredential = RcWriteHeaders;

/** Everything one injection needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcInjectDeps {
  /** Reads the observed credential for a session: the tracker's accessor, in production. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Advances the session's sequence cursor: the tracker's accessor, in production, so a delivered write's numbers are what a stream resume continues after. */
  readonly noteSequenceNums: (sessionId: string, sequenceNums: readonly number[]) => void;
  /** The dial to the real API host. */
  readonly dial: RcEventDial;
  /** Mints the payload event's uuid: a v4 UUID or better in production. */
  readonly newUuid: () => string;
}

/** The failure every client-half write returns when the tracker holds no OAuth-kind bearer for the session: only worker calls were observed, and the worker JWT they carry does not authorise the client half. */
function noOAuthCredentialResult(sessionId: string): RcEventWriteResult {
  return { ok: false, message: `no claude.ai OAuth bearer has been observed for session ${sessionId}: only worker calls crossed this door, and the worker JWT they carry is answered 401 on the client half. Reconnect Remote Control through this door and the create's own bearer will be observed` };
}

/** The verbose refusal every surface answers a session it has not observed with, in one place so the routes, the typed API and the operations all name the same reason. */
export function rcSessionNotObservedMessage(sessionId: string): string {
  return `the front door has not observed Remote Control session ${sessionId}: it may never have passed through this door, or it ended or expired (an entry lives only a bounded idle period past its last observed traffic)`;
}

/** The headers every client-half write sends, from the observed credential: the observed values replayed verbatim. The authorization is present by construction, since every caller guards on it (the write refuses to go out unauthenticated rather than surface as a confusing 401). */
function rcWriteHeaders(credential: RcObservedCredential): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential.authorization !== undefined) {
    headers.authorization = credential.authorization;
  }
  if (credential.anthropicVersion !== undefined) {
    headers["anthropic-version"] = credential.anthropicVersion;
  }
  if (credential.anthropicClientPlatform !== undefined) {
    headers["anthropic-client-platform"] = credential.anthropicClientPlatform;
  }
  return headers;
}

/**
 * Injects one user-message prompt into an observed session: the documented client-half write, `POST /v1/code/sessions/{id}/events`, authenticated by the observed bearer and carrying the observed protocol headers. The result is the sequence numbers the real service assigned, or a verbose failure. A dial that cannot reach the API host is reported rather than thrown, so a caller with no exception handling still shows the user exactly what failed.
 */
export async function injectRcUserMessage(deps: RcInjectDeps, sessionId: string, text: string): Promise<RcEventWriteResult> {
  const credential = deps.credentialOf(sessionId);
  if (credential === undefined) {
    return { ok: false, message: rcSessionNotObservedMessage(sessionId) };
  }
  if (credential.authorization === undefined) {
    return noOAuthCredentialResult(sessionId);
  }
  const body = JSON.stringify(buildRcEventWriteBody(buildRcUserMessagePayload(deps.newUuid(), sessionId, text)));
  let answer: RcDialAnswer;
  try {
    answer = await deps.dial.writeEvents(sessionId, rcWriteHeaders(credential), body);
  } catch (error) {
    return { ok: false, message: `the door could not reach the API host to inject into session ${sessionId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = rcEventWriteResultFromAnswer(answer);
  if (result.ok) {
    deps.noteSequenceNums(sessionId, result.sequenceNums);
  }
  return result;
}

/** The decision an answer carries: approve or deny, with the message a denial shows the worker (the protocol's allow result has no text field, so an approval carries none). */
export interface RcAnswerDecision {
  readonly approve: boolean;
  /** The denial message; undefined means the protocol's empty default. Present only with a denial. */
  readonly message: string | undefined;
}

/**
 * Builds the `control_response` payload event for one answer: the SDK's response envelope, `subtype: "success"` with the request's id echoed in `request_id`, carrying the permission result the worker is waiting for (`behavior: "allow"`, or `"deny"` with its message).
 */
export function buildRcControlResponsePayload(requestId: string, decision: RcAnswerDecision): Record<string, unknown> {
  const result = decision.approve ? { behavior: "allow" } : { behavior: "deny", message: decision.message ?? "" };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: result } };
}

/**
 * The permission modes the SDK's own `set_permission_mode` control request accepts: exactly the strings its `PermissionMode` type declares (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`), nothing looser. A runtime list as well as a type, because the CLI and the control route both narrow untrusted strings through it before a write is ever attempted.
 */
export const RC_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

/** One permission mode the SDK's `set_permission_mode` control request accepts. */
export type RcPermissionMode = (typeof RC_PERMISSION_MODES)[number];

/** Whether a value is one of the SDK's own permission modes, the narrowing the CLI and the control route apply to untrusted input. */
export function isRcPermissionMode(value: unknown): value is RcPermissionMode {
  return RC_PERMISSION_MODES.some((mode) => mode === value);
}

/**
 * Builds the `control_request` payload event's envelope around one subtype's own request shape: the SDK's own envelope (`SDKControlRequest`: `type`, `request_id`, `request`), with the request id the caller minted, the id the worker's `control_response` echoes. Every client-originated control request below goes through this one envelope so the family cannot drift apart in shape.
 */
export function buildRcControlRequestPayload(requestId: string, request: Record<string, unknown>): Record<string, unknown> {
  return { type: "control_request", request_id: requestId, request };
}

/**
 * Builds the `control_request` payload event for one interrupt: the SDK's request envelope, carrying the `interrupt` subtype's own shape (`subtype` alone; its optional `cancel_queued` is absent, which the SDK reads as false, so queued commands survive the interrupt exactly as a plain stop button's would). The request id is the caller's minted uuid, the id the worker's `control_response` echoes.
 */
export function buildRcInterruptPayload(requestId: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "interrupt" });
}

/**
 * Builds the `control_request` payload event for one model switch: the SDK's request envelope carrying the `set_model` subtype's own shape, whose one field is the `model` id string (its omitted and null forms mean a reset to the session default, which this builder never sends; the operation refuses an empty id for the same reason).
 */
export function buildRcSetModelPayload(requestId: string, model: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "set_model", model });
}

/**
 * Builds the `control_request` payload event for one permission-mode change: the SDK's request envelope carrying the `set_permission_mode` subtype's own shape, whose one field is the `mode` from the SDK's own `PermissionMode` enum (`RC_PERMISSION_MODES`).
 */
export function buildRcSetPermissionModePayload(requestId: string, mode: RcPermissionMode): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "set_permission_mode", mode });
}

/**
 * Builds the `control_request` payload event for one session end: the SDK's request envelope carrying the `end_session` subtype's own shape, whose one field is the optional `reason` string (the CLI's own sender passes `reason: "session_not_found"` and its receiver logs `reason ?? "unspecified"`, both verified in the 2.1.267 bundle; an omitted reason is the protocol's own unnamed form, so the builder omits the field entirely rather than sending an empty string).
 */
export function buildRcEndSessionPayload(requestId: string, reason: string | undefined): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "end_session", ...(reason === undefined ? {} : { reason }) });
}

/**
 * Builds the `control_request` payload event for one usage query: the SDK's request envelope carrying the `get_usage` subtype's own shape, whose one field is the optional `skip_behaviors` boolean (the CLI's own client sends the field only when true, so this builder does the same; the SDK documents the field as skipping the local-transcript scan that fills the response's behaviours section).
 */
export function buildRcGetUsagePayload(requestId: string, skipBehaviors: boolean | undefined): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "get_usage", ...(skipBehaviors === true ? { skip_behaviors: true } : {}) });
}

/**
 * The detail levels the SDK's own `get_context_usage` control request accepts: exactly the strings its `detail` field declares (`'summary' | 'full'`), nothing looser. A runtime list as well as a type, because the CLI and the control route both narrow untrusted strings through it before a write is ever attempted.
 */
export const RC_CONTEXT_USAGE_DETAILS = ["summary", "full"] as const;

/** One detail level the SDK's `get_context_usage` control request accepts. */
export type RcContextUsageDetail = (typeof RC_CONTEXT_USAGE_DETAILS)[number];

/** Whether a value is one of the SDK's own context-usage detail levels, the narrowing the CLI and the control route apply to untrusted input. */
export function isRcContextUsageDetail(value: unknown): value is RcContextUsageDetail {
  return RC_CONTEXT_USAGE_DETAILS.some((detail) => detail === value);
}

/**
 * Builds the `control_request` payload event for one context-usage query: the SDK's request envelope carrying the `get_context_usage` subtype's own shape, whose one field is the optional `detail` level (`'summary'` or `'full'`, defaulting to `'full'` server-side when omitted, so the builder omits the field rather than restating the default).
 */
export function buildRcGetContextUsagePayload(requestId: string, detail: RcContextUsageDetail | undefined): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "get_context_usage", ...(detail === undefined ? {} : { detail }) });
}

/**
 * The encodings the SDK's own `read_file` control request accepts: exactly the strings its `encoding` field declares, nothing looser. A runtime list as well as a type, because the CLI and the control route both narrow untrusted strings through it before a write is ever attempted.
 */
export const RC_READ_FILE_ENCODINGS = ["utf-8", "base64"] as const;

/** One encoding the SDK's `read_file` control request accepts. */
export type RcReadFileEncoding = (typeof RC_READ_FILE_ENCODINGS)[number];

/** Whether a value is one of the SDK's own read-file encodings, the narrowing the CLI and the control route apply to untrusted input. */
export function isRcReadFileEncoding(value: unknown): value is RcReadFileEncoding {
  return RC_READ_FILE_ENCODINGS.some((encoding) => encoding === value);
}

/** The optional parts of one read-file request: the byte cap and the encoding the SDK's own fields name. */
export interface RcReadFileOptions {
  /** The `max_bytes` cap, a positive number of bytes. */
  readonly maxBytes?: number;
  /** The `encoding` the answer's `contents` carry; the SDK's own default is `utf-8`. */
  readonly encoding?: RcReadFileEncoding;
}

/**
 * Builds the `control_request` payload event for one file read: the SDK's request envelope carrying the `read_file` subtype's own shape, whose fields are the required `path` string and the optional `max_bytes` number and `encoding` level (`'utf-8' | 'base64'`), each sent only when the caller named it (the CLI's own client builds exactly this shape, verified in the 2.1.267 bundle).
 */
export function buildRcReadFilePayload(requestId: string, path: string, options: RcReadFileOptions | undefined): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "read_file", path, ...(options?.maxBytes === undefined ? {} : { max_bytes: options.maxBytes }), ...(options?.encoding === undefined ? {} : { encoding: options.encoding }) });
}

/**
 * Builds the `control_request` payload event for one file-suggestion query: the SDK's request envelope carrying the `file_suggestions` subtype's own shape, whose one required field is the `query` string (the partial path prefix the TUI's at-mention autocomplete fuzzy-matches; the SDK imposes no minimum, so an empty query is sent as the empty prefix it is).
 */
export function buildRcFileSuggestionsPayload(requestId: string, query: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "file_suggestions", query });
}

/**
 * Builds the `control_request` payload event for one MCP status query: the SDK's request envelope carrying the `mcp_status` subtype's own shape, which declares no fields of its own (the CLI's own client requests it the same way and reads its answer's `mcpServers`).
 */
export function buildRcMcpStatusPayload(requestId: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "mcp_status" });
}

/**
 * Builds the `control_request` payload event for one MCP server reconnect: the SDK's request envelope carrying the `mcp_reconnect` subtype's own shape, whose one field is the `serverName` string (the casing the SDK and the CLI's own client both use for this family, unlike the snake_case the older subtypes carry).
 */
export function buildRcMcpReconnectPayload(requestId: string, serverName: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "mcp_reconnect", serverName });
}

/**
 * Builds the `control_request` payload event for one MCP OAuth handshake start: the SDK's request envelope carrying the `mcp_authenticate` subtype's own shape, whose fields are the `serverName` and the `redirectUri` the server's OAuth flow redirects back to (the exact object the CLI's own `mcpAuthenticate` builds, verified in the 2.1.267 bundle; this subtype is absent from the published SDK types, so the bundle is the field's only source).
 */
export function buildRcMcpAuthenticatePayload(requestId: string, serverName: string, redirectUri: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "mcp_authenticate", serverName, redirectUri });
}

/**
 * Builds the `control_request` payload event for one MCP OAuth callback hand-in: the SDK's request envelope carrying the `mcp_oauth_callback_url` subtype's own shape, whose fields are the `serverName` and the `callbackUrl` the browser landed on (the exact object the CLI's own `mcpSubmitOAuthCallbackUrl` builds, verified in the 2.1.267 bundle; this subtype is absent from the published SDK types, so the bundle is the field's only source).
 */
export function buildRcMcpOAuthCallbackUrlPayload(requestId: string, serverName: string, callbackUrl: string): Record<string, unknown> {
  return buildRcControlRequestPayload(requestId, { subtype: "mcp_oauth_callback_url", serverName, callbackUrl });
}

/**
 * Builds the liveness payload event on its own, with no request envelope around it: the SDK's own `SDKKeepAliveMessage` is a top-level stream payload (`type` alone, no `request_id`, no `request`), which either side may send at any time and receivers must ignore, so this is the one client-half write that neither expects nor can receive an answer. The CLI's own transports write exactly this object into their event streams, verified in the 2.1.267 bundle.
 */
export function buildRcKeepAlivePayload(): Record<string, unknown> {
  return { type: "keep_alive" };
}

/** Everything one answer needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcAnswerDeps {
  /** Reads the observed credential for a session: the tracker's accessor, in production. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Reads the session's pending control requests: the tracker's accessor, in production, so an answer is refused unless the request is still waiting. */
  readonly pendingOf: (sessionId: string) => readonly RcPendingRequestSummary[];
  /** Retires a pending request as answered: the tracker's accessor, in production, called only once the write is confirmed delivered. */
  readonly completePending: (sessionId: string, requestId: string) => void;
  /** Advances the session's sequence cursor: the tracker's accessor, in production, so a delivered write's numbers are what a stream resume continues after. */
  readonly noteSequenceNums: (sessionId: string, sequenceNums: readonly number[]) => void;
  /** The dial to the real API host. */
  readonly dial: RcEventDial;
}

/**
 * Answers one pending control request on an observed session: the same documented client-half write the inject path performs, carrying a `control_response` that echoes the request's id, authenticated by the observed bearer and protocol headers. The request must still be pending (an answered or deadline-expired request is refused verbosely, since writing a response nothing waits for would mislead the caller), and a successful write retires it. A dial that cannot reach the API host is reported rather than thrown.
 */
export async function answerRcControlRequest(deps: RcAnswerDeps, sessionId: string, requestId: string, decision: RcAnswerDecision): Promise<RcEventWriteResult> {
  const credential = deps.credentialOf(sessionId);
  if (credential === undefined) {
    return { ok: false, message: rcSessionNotObservedMessage(sessionId) };
  }
  if (credential.authorization === undefined) {
    return noOAuthCredentialResult(sessionId);
  }
  if (!deps.pendingOf(sessionId).some((pending) => pending.requestId === requestId)) {
    return { ok: false, message: `the front door has not observed control request ${requestId} pending on session ${sessionId}: it was answered already (by this door or by an attached client), it passed its answer deadline (the protocol's permission round-trip bound), or it never passed through this door` };
  }
  const body = JSON.stringify(buildRcEventWriteBody(buildRcControlResponsePayload(requestId, decision)));
  let answer: RcDialAnswer;
  try {
    answer = await deps.dial.writeEvents(sessionId, rcWriteHeaders(credential), body);
  } catch (error) {
    return { ok: false, message: `the door could not reach the API host to answer on session ${sessionId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = rcEventWriteResultFromAnswer(answer);
  if (result.ok) {
    deps.completePending(sessionId, requestId);
    deps.noteSequenceNums(sessionId, result.sequenceNums);
  }
  return result;
}

/** Everything one client-originated control request needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcControlRequestDeps {
  /** Reads the observed credential for a session: the tracker's accessor, in production. */
  readonly credentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** Advances the session's sequence cursor: the tracker's accessor, in production, so a delivered write's numbers are what a stream resume continues after. */
  readonly noteSequenceNums: (sessionId: string, sequenceNums: readonly number[]) => void;
  /** The dial to the real API host. */
  readonly dial: RcEventDial;
  /** Mints the request's id: a v4 UUID or better in production, the id the worker's `control_response` echoes. */
  readonly newUuid: () => string;
}

/**
 * The one engine every client-half payload write runs through: the two credential guards (an unobserved session, and a session only worker calls crossed, whose JWT does not authorise the client half), the write itself, and the sequence-cursor advance on a confirmed delivery. `action` names the whole act in the unreachable-host message ("interrupt session cse_..."), so each operation's failure keeps its own words while the mechanics exist once. Not exported: every caller is one of the typed operations below, whose inputs are validated before this runs.
 */
async function deliverRcClientPayload(deps: RcControlRequestDeps, sessionId: string, payload: Record<string, unknown>, action: string): Promise<RcEventWriteResult> {
  const credential = deps.credentialOf(sessionId);
  if (credential === undefined) {
    return { ok: false, message: rcSessionNotObservedMessage(sessionId) };
  }
  if (credential.authorization === undefined) {
    return noOAuthCredentialResult(sessionId);
  }
  const body = JSON.stringify(buildRcEventWriteBody(payload));
  let answer: RcDialAnswer;
  try {
    answer = await deps.dial.writeEvents(sessionId, rcWriteHeaders(credential), body);
  } catch (error) {
    return { ok: false, message: `the door could not reach the API host to ${action}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = rcEventWriteResultFromAnswer(answer);
  if (result.ok) {
    deps.noteSequenceNums(sessionId, result.sequenceNums);
  }
  return result;
}

/**
 * Interrupts one observed session's running turn: the same documented client-half write the inject and answer paths perform, carrying the SDK's `control_request` envelope for the `interrupt` subtype, authenticated by the observed bearer and protocol headers. The result names the minted request id (the id the worker's `control_response` echoes on the stream) and the sequence numbers the real service assigned, or a verbose failure. A dial that cannot reach the API host is reported rather than thrown, so a caller with no exception handling still shows the user exactly what failed.
 */
export async function interruptRcSession(deps: RcControlRequestDeps, sessionId: string): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcInterruptPayload(requestId), `interrupt session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Sets the model one observed session's subsequent turns use: the same documented client-half write the inject and answer paths perform, carrying the SDK's `control_request` envelope for the `set_model` subtype with the model id its own field names. The id is validated only as non-empty, because the SDK's field gives the empty-free forms their own meaning (omitted or null resets to the session default) and this operation sends neither. The result names the minted request id and the sequence numbers the real service assigned, or a verbose failure.
 */
export async function setRcSessionModel(deps: RcControlRequestDeps, sessionId: string, model: string): Promise<RcEventWriteResult> {
  if (model === "") {
    return { ok: false, message: "a set-model write needs a non-empty model id: the SDK's own field treats an omitted or null value as a reset to the session default, which this operation never sends, and an empty string is neither" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcSetModelPayload(requestId, model), `set the model on session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Sets one observed session's permission mode: the same documented client-half write the inject and answer paths perform, carrying the SDK's `control_request` envelope for the `set_permission_mode` subtype with a mode from the SDK's own enum (`RC_PERMISSION_MODES`; the type accepts nothing looser, and the CLI and control route narrow untrusted strings through `isRcPermissionMode` before they ever reach this operation). The result names the minted request id and the sequence numbers the real service assigned, or a verbose failure.
 */
export async function setRcSessionPermissionMode(deps: RcControlRequestDeps, sessionId: string, mode: RcPermissionMode): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcSetPermissionModePayload(requestId, mode), `set the permission mode on session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Ends one observed session: the documented client-half write carrying the SDK's `control_request` envelope for the `end_session` subtype, the request whose receipt makes the worker abort its turn and shut down by its own rules (verified in the CLI's source: its print loop logs `end_session received` and ends the child). The reason is optional and sent only when non-empty, because the receiver reads an absent reason as its own "unspecified" form and an empty string is neither. The result names the minted request id and the sequence numbers the real service assigned, or a verbose failure.
 */
export async function endRcSession(deps: RcControlRequestDeps, sessionId: string, reason: string | undefined): Promise<RcEventWriteResult> {
  if (reason === "") {
    return { ok: false, message: "an end-session write needs either no reason or a non-empty one: the worker reads an absent reason as its own unspecified form, and an empty string is neither" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcEndSessionPayload(requestId, reason), `end session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker for its structured usage: the documented client-half write carrying the SDK's `control_request` envelope for the `get_usage` subtype. The worker's answer (session cost and usage totals plus the plan's rate-limit utilisation) arrives later as the `control_response` echoing the minted request id on the stream the door already fans out, which is why the result names that id; the door invents no usage state of its own.
 */
export async function getRcSessionUsage(deps: RcControlRequestDeps, sessionId: string, skipBehaviors: boolean | undefined): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcGetUsagePayload(requestId, skipBehaviors), `request the usage of session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker for its context-window breakdown: the documented client-half write carrying the SDK's `control_request` envelope for the `get_context_usage` subtype. The worker's answer (the per-category breakdown) arrives later as the `control_response` echoing the minted request id on the stream the door already fans out; the detail level is the SDK's own enum, narrowed by `isRcContextUsageDetail` before this operation is reached.
 */
export async function getRcSessionContextUsage(deps: RcControlRequestDeps, sessionId: string, detail: RcContextUsageDetail | undefined): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcGetContextUsagePayload(requestId, detail), `request the context usage of session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker to read one file from the session filesystem: the documented client-half write carrying the SDK's `control_request` envelope for the `read_file` subtype, the request the remote sidebar viewer rides. The path is resolved by the worker against its own cwd and gated by its own read-permission rules; the answer (the contents) arrives later as the `control_response` echoing the minted request id on the stream the door already fans out.
 */
export async function readRcSessionFile(deps: RcControlRequestDeps, sessionId: string, path: string, options: RcReadFileOptions | undefined): Promise<RcEventWriteResult> {
  if (path === "") {
    return { ok: false, message: "a read-file write needs a non-empty path: the SDK's own field names the file the worker resolves against the session's cwd, and an empty string names none" };
  }
  if (options?.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)) {
    return { ok: false, message: "a read-file write's max-bytes is a positive whole number of bytes: the SDK's own field caps the read, and a zero or negative cap reads nothing" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcReadFilePayload(requestId, path, options), `read ${path} from session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker for its at-mention file suggestions: the documented client-half write carrying the SDK's `control_request` envelope for the `file_suggestions` subtype, the request the TUI's own autocomplete rides, answered with the same fuzzy-matched results. The answer arrives later as the `control_response` echoing the minted request id on the stream the door already fans out; the query may be empty, because the SDK's own field imposes no minimum and an empty prefix is the autocomplete's root listing.
 */
export async function suggestRcSessionFiles(deps: RcControlRequestDeps, sessionId: string, query: string): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcFileSuggestionsPayload(requestId, query), `request file suggestions from session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker for the status of its MCP server connections: the documented client-half write carrying the SDK's `control_request` envelope for the `mcp_status` subtype, which declares no fields of its own. The answer arrives later as the `control_response` echoing the minted request id on the stream the door already fans out.
 */
export async function getRcSessionMcpStatus(deps: RcControlRequestDeps, sessionId: string): Promise<RcEventWriteResult> {
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcMcpStatusPayload(requestId), `request the MCP status of session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Asks one observed session's worker to reconnect one MCP server: the documented client-half write carrying the SDK's `control_request` envelope for the `mcp_reconnect` subtype, whose one field is the server name exactly as `mcp_status` reports it. The answer arrives later as the `control_response` echoing the minted request id on the stream the door already fans out.
 */
export async function reconnectRcSessionMcpServer(deps: RcControlRequestDeps, sessionId: string, serverName: string): Promise<RcEventWriteResult> {
  if (serverName === "") {
    return { ok: false, message: "an mcp-reconnect write needs a non-empty server name: the SDK's own field names the server as mcp_status reports it, and an empty string names none" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcMcpReconnectPayload(requestId, serverName), `reconnect MCP server ${serverName} on session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Starts one MCP server's OAuth handshake on an observed session: the documented client-half write carrying the `control_request` envelope for the `mcp_authenticate` subtype, whose fields name the server and the redirect URI its OAuth flow redirects back to. The answer arrives later as the `control_response` echoing the minted request id on the stream the door already fans out.
 */
export async function authenticateRcSessionMcpServer(deps: RcControlRequestDeps, sessionId: string, serverName: string, redirectUri: string): Promise<RcEventWriteResult> {
  if (serverName === "" || redirectUri === "") {
    return { ok: false, message: "an mcp-authenticate write needs a non-empty server name and redirect URI: the CLI's own request names the server and where its OAuth flow redirects back to, and an empty string names neither" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcMcpAuthenticatePayload(requestId, serverName, redirectUri), `authenticate MCP server ${serverName} on session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Hands one MCP server's OAuth callback to an observed session's worker: the documented client-half write carrying the `control_request` envelope for the `mcp_oauth_callback_url` subtype, whose fields name the server and the callback URL the browser landed on, completing the handshake `mcp_authenticate` started. The answer arrives later as the `control_response` echoing the minted request id on the stream the door already fans out.
 */
export async function submitRcSessionMcpOAuthCallbackUrl(deps: RcControlRequestDeps, sessionId: string, serverName: string, callbackUrl: string): Promise<RcEventWriteResult> {
  if (serverName === "" || callbackUrl === "") {
    return { ok: false, message: "an mcp-oauth-callback-url write needs a non-empty server name and callback URL: the CLI's own request names the server and the URL its OAuth flow landed on, and an empty string names neither" };
  }
  const requestId = deps.newUuid();
  const result = await deliverRcClientPayload(deps, sessionId, buildRcMcpOAuthCallbackUrlPayload(requestId, serverName, callbackUrl), `hand MCP server ${serverName}'s OAuth callback to session ${sessionId}`);
  return result.ok ? { ...result, requestId } : result;
}

/**
 * Sends one liveness heartbeat into an observed session: the documented client-half write carrying the `keep_alive` payload on its own, with no request envelope, because the SDK declares it a top-level stream message either side may send at any time and receivers must ignore. The minted sequence numbers confirm delivery and nothing else will ever answer, which is the payload's own contract; this write is how a door-driven client keeps its half of the stream warm without saying anything.
 */
export async function sendRcKeepAlive(deps: RcControlRequestDeps, sessionId: string): Promise<RcEventWriteResult> {
  return await deliverRcClientPayload(deps, sessionId, buildRcKeepAlivePayload(), `keep session ${sessionId} alive`);
}
