import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { RoutedRequest, RoutedResponse } from "./route";
import type { PresentationRefusal, RcEventWriter, SelfHostConversation, StoredEvent } from "./rcSelfHost";
import { RC_SOURCE_CLIENT, serveRcClientChannels } from "./rcSelfHostEndpoints";

/**
 * The conversation family of the self-hosted Remote Control surface (`/v1/code/conversations...`), the door's own sessionless half: a client that joins a live conversation without creating a `cse_` session of its own reads, writes, streams and announces through it, sharing the one event log and sequence space the attached sessions already write into. Split out of `rcSelfHost.ts` so each file stays a readable size, exactly as the client channels and the compatibility family were split into `rcSelfHostEndpoints.ts`.
 *
 * The whole family is this door's design (no observed wire shape names a conversation; see `rcSelfHost.ts`'s module comment): there is no create here, because a conversation is born from a session's create (which mints one or attaches to a named one), and the family is otherwise the client half's own vocabulary, address-shaped exactly as the session family is.
 *
 * The handlers are pure functions of an explicit context (the conversations the surface holds, the request and response, and the surface's own closures threaded through), so this module imports no runtime value from the surface it serves and the two modules cannot cycle.
 */

/** The path prefix of the conversation family, the door's own sessionless surface for a client that joins a live conversation without creating a `cse_` session of its own. */
export const RC_CONVERSATIONS_PATH_PREFIX = "/v1/code/conversations";

/** The id prefix this door's own conversation ids carry, minted beside the session prefix so the two families never address one another's rows. */
const RC_CONVERSATION_ID_PREFIX = "conv_";

/** The guard every parsed-body narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses JSON, yielding undefined for anything that is not one JSON object. */
function parseJsonObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A record's string field when it is a non-empty string, else undefined. */
function nonEmptyString(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record === undefined ? undefined : record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Mints one fresh conversation, empty and unattached: the object a session's create builds when its body names no conversation to join. */
export function newRcSelfHostConversation(newUuid: () => string, now: () => number): SelfHostConversation {
  return { id: `${RC_CONVERSATION_ID_PREFIX}${newUuid()}`, createdAt: now(), sequenceNum: 0, events: [], seenPayloadUuids: new Set<string>(), workerStreams: new Set(), clientStreams: new Set(), clients: new Map<string, number>(), sessionIds: new Set<string>(), lastTrafficAt: now() };
}

/** The conversation row the family's read and list answers carry, its attachments named by their live session ids. */
function conversationRow(conversation: SelfHostConversation): Record<string, unknown> {
  return { id: conversation.id, created_at: new Date(conversation.createdAt).toISOString(), updated_at: new Date(conversation.lastTrafficAt).toISOString(), sessions: [...conversation.sessionIds] };
}

/** Everything the conversation family needs from the surface that serves it. */
export interface RcConversationContext {
  readonly request: RoutedRequest;
  readonly response: RoutedResponse;
  /** The conversations the surface holds, keyed by id, exactly as the create's mint or attach left them. */
  readonly conversations: Map<string, SelfHostConversation>;
  readonly answerJson: (response: RoutedResponse, status: number, body: unknown, extraHeaders?: Readonly<Record<string, string>>) => Promise<void>;
  readonly readBody: (request: Readable, capBytes: number) => Promise<string>;
  readonly credentialRefusal: (headers: Readonly<IncomingHttpHeaders>) => PresentationRefusal | undefined;
  readonly unauthorized: (response: RoutedResponse, refusal: PresentationRefusal) => Promise<void>;
  /** The surface's publish, whose conversation-keyed sequence space the family's writes join. */
  readonly publish: (conversation: SelfHostConversation, writer: RcEventWriter, source: string, payload: Record<string, unknown>) => { readonly sequenceNum: number; readonly eventId: string; readonly duplicate: boolean };
  /** The surface's stream hold, which the family's stream paths hand the resolved conversation to. */
  readonly holdStream: (conversation: SelfHostConversation, owner: string, which: "workerStreams" | "clientStreams", wantsReplay: (event: StoredEvent) => boolean, request: RoutedRequest, response: RoutedResponse) => Promise<void>;
  readonly sweep: () => void;
  readonly now: () => number;
  /** The presence answer's own refresh hint, the surface's constant threaded so the answer names the value its own retention derives from. */
  readonly presenceRefreshSeconds: number;
  /** The protocol's own batch cap, threaded so the family's write validation names the same bound the session family's does. */
  readonly maxBatchEvents: number;
  readonly log?: (line: string) => void;
}

/**
 * Serves the whole conversation family: the collection (a list, and no create, because a conversation is born from a session's create), the per-conversation read, the client event write and read, the client stream, and the client channels (`client/presence`, `mark_read`, `teleport-events`) through the same split-out handlers the sessions serve theirs with. Owns the family's authentication (the minted credential, like every client half) and its not-found answers.
 */
export async function serveRcConversations(ctx: RcConversationContext, pathname: string, method: string): Promise<void> {
  const { request, response, conversations } = ctx;
  const refusal = ctx.credentialRefusal(request.headers);
  if (refusal !== undefined) {
    await ctx.unauthorized(response, refusal);
    return;
  }
  if (pathname === RC_CONVERSATIONS_PATH_PREFIX) {
    if (method !== "GET") {
      await ctx.answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the conversation collection is a GET; a conversation is born from a session create, never here" } });
      return;
    }
    await ctx.answerJson(response, HTTP_STATUS.ok, { data: [...conversations.values()].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1)).map(conversationRow) });
    return;
  }
  const rest = pathname.slice(`${RC_CONVERSATIONS_PATH_PREFIX}/`.length);
  const slash = rest.indexOf("/");
  const conversationId = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash + 1);
  if (!conversationId.startsWith(RC_CONVERSATION_ID_PREFIX)) {
    await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: "the conversation family names one conv_-prefixed conversation id" } });
    return;
  }
  const conversation = conversations.get(conversationId);
  if (conversation === undefined) {
    await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: "no such Remote Control conversation on this door" } });
    return;
  }
  conversation.lastTrafficAt = ctx.now();
  if (tail === "" && method === "GET") {
    await ctx.answerJson(response, HTTP_STATUS.ok, { conversation: conversationRow(conversation) });
    return;
  }
  if (tail === "events" && method === "POST") {
    const body = parseJsonObject(await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES));
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > ctx.maxBatchEvents) {
      await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: `a client event write is a non-empty array of at most ${String(ctx.maxBatchEvents)} events` } });
      return;
    }
    const results: Record<string, unknown>[] = [];
    for (const event of events) {
      if (!isRecord(event) || !isRecord(event.payload)) {
        await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "every event in a write is an object carrying one payload object" } });
        return;
      }
      const published = ctx.publish(conversation, { session: undefined, half: "client" }, RC_SOURCE_CLIENT, event.payload);
      results.push({ sequence_num: String(published.sequenceNum), duplicate: published.duplicate });
    }
    ctx.sweep();
    ctx.log?.(`rc selfhost ${conversation.id}: a conversation client wrote ${String(results.length)} event(s) into the shared space`);
    await ctx.answerJson(response, HTTP_STATUS.ok, { results });
    return;
  }
  if (tail === "events" && method === "GET") {
    await ctx.answerJson(response, HTTP_STATUS.ok, { data: conversation.events.map((event) => ({ event_id: event.eventId, event_type: nonEmptyString(event.payload, "type") ?? "event", sequence_num: event.sequenceNum, source: event.source, payload: event.payload, created_at: event.createdAt })) });
    return;
  }
  if (tail === "events/stream" && method === "GET") {
    await ctx.holdStream(conversation, conversation.id, "clientStreams", () => true, request, response);
    return;
  }
  if (await serveRcClientChannels({ request, response, host: { id: conversation.id, clients: conversation.clients, conversation, writer: { session: undefined, half: "client" } }, answerJson: ctx.answerJson, readBody: ctx.readBody, publish: ctx.publish, sweep: ctx.sweep, now: ctx.now, presenceRefreshSeconds: ctx.presenceRefreshSeconds, ...(ctx.log === undefined ? {} : { log: ctx.log }) }, tail, method, ctx.maxBatchEvents)) {
    return;
  }
  await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the conversation family serves no path "${tail}"` } });
}
