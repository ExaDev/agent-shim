import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { RoutedRequest, RoutedResponse } from "./route";
import type { PresentationRefusal, SelfHostSession } from "./rcSelfHost";

/**
 * The serving half of the Remote Control endpoints nothing in the CLI drove before this module: the presence channel (every announced client registered, the clear retiring one), the read receipts (each client's mark_read fanned to the worker), the teleport channel (the write the door's own client half sends and the paged read the CLI's teleport-to-local hydration speaks), and the compatibility `/v1/sessions` family the CLI's claude.ai-side session manager uses. Split out of `rcSelfHost.ts` so each file stays a readable size, exactly as the client-half writes were split into `rcWrites.ts`.
 *
 * Every wire shape here was verified against the 2.1.289 CLI bundle before it was served, and each handler's comment names where its shape came from; the one shape no bundle could supply (how the real host hands a receipt to the worker) is this door's own design, named as such where it is served. The handlers are pure functions of an explicit context (the session, the request and response, and the surface's own closures threaded through), so this module imports no runtime value from the surface it serves and the two modules cannot cycle.
 */

/** The source string the protocol's envelopes carry for the CLI worker's own half. */
export const RC_SOURCE_WORKER = "worker";

/** The source string the protocol's envelopes carry for a client's events at large, the source a receipt with no named client rides. */
export const RC_SOURCE_CLIENT = "client";

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

/** A record's finite number field, accepting a numeric string too, because the real service has been observed serialising the protocol's numbers both ways (the write answer's `sequence_num` above all). */
function numberOf(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record === undefined ? undefined : record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * Pages one channel the door holds for the paginated GET readers (teleport-events and internal-events, whose readers share the `{data: [{...}], next_cursor}` shape, verified in the 2.1.289 bundle): rows after the anchor, the page capped by the reader's own `limit` when it named one, and `next_cursor` naming the last row of a non-empty page, because a reader stops exactly when a page names no cursor. The anchor is the reader's own vocabulary (`after_event_id`, or the `cursor` a previous page's `next_cursor` became), an opaque event id echoed back; an anchor this surface holds no row for is refused rather than silently restarting at the head, which would replay rows the reader has already consumed, and a malformed limit is refused the same way rather than read as absent.
 */
export function pageOfRcChannel<T>(url: string, rows: readonly T[], idOf: (row: T) => string, rowOf: (row: T) => Record<string, unknown>): { readonly error: string } | { readonly data: readonly Record<string, unknown>[]; readonly next_cursor?: string } {
  const query = new URL(url, "http://127.0.0.1").searchParams;
  const anchor = query.get("after_event_id") ?? query.get("cursor");
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? undefined : numberOf({ value: rawLimit }, "value");
  if (limit !== undefined && limit < 1) {
    return { error: "the limit names a whole number of rows of at least one" };
  }
  const from = anchor === null ? 0 : rows.findIndex((row) => idOf(row) === anchor) + 1;
  if (anchor !== null && from === 0) {
    return { error: `the anchor names an event id this surface holds no row for: ${anchor}` };
  }
  const page = limit === undefined ? rows.slice(from) : rows.slice(from, from + limit);
  const last = page[page.length - 1];
  return { data: page.map(rowOf), ...(last === undefined ? {} : { next_cursor: idOf(last) }) };
}

/** Everything the client-channel handlers need from the surface that serves them, threaded explicitly so the handlers stay pure functions of what they are handed. */
export interface RcClientChannelContext {
  readonly request: RoutedRequest;
  readonly response: RoutedResponse;
  readonly session: SelfHostSession;
  readonly answerJson: (response: RoutedResponse, status: number, body: unknown, extraHeaders?: Readonly<Record<string, string>>) => Promise<void>;
  readonly readBody: (request: IncomingMessage, capBytes: number) => Promise<string>;
  readonly publish: (session: SelfHostSession, source: string, payload: Record<string, unknown>, toWorker?: boolean) => { readonly sequenceNum: number; readonly eventId: string; readonly duplicate: boolean };
  readonly sweep: () => void;
  readonly now: () => number;
  /** The presence answer's own refresh hint, the surface's constant threaded so the answer names the value its own retention derives from. */
  readonly presenceRefreshSeconds: number;
  readonly log?: (line: string) => void;
}

/**
 * Serves the session's client-half channels: `client/presence`, `mark_read` and `teleport-events` (POST and GET). Answers each call itself and tells the caller whether the path was one of these, so the surface's own not-found answer is the only one left to give.
 */
export async function serveRcClientChannels(ctx: RcClientChannelContext, tail: string, method: string, maxBatchEvents: number): Promise<boolean> {
  const { request, response, session } = ctx;
  if (tail === "client/presence" && method === "POST") {
    const body = parseJsonObject(await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES));
    const clientId = nonEmptyString(body, "client_id");
    const clear = body?.clear;
    if (clientId === undefined || (clear !== undefined && typeof clear !== "boolean")) {
      await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a presence announcement is JSON naming a non-empty client_id, with clear only as a boolean or absent" } });
      return true;
    }
    if (clear === true) {
      session.clients.delete(clientId);
      ctx.log?.(`rc selfhost ${session.id}: client ${clientId} cleared its presence`);
    } else {
      session.clients.set(clientId, ctx.now());
      ctx.log?.(`rc selfhost ${session.id}: client ${clientId} announced its presence${session.clients.size === 1 ? "" : ` (${String(session.clients.size)} clients now announced)`}`);
    }
    await ctx.answerJson(response, HTTP_STATUS.ok, { refresh_after_seconds: ctx.presenceRefreshSeconds });
    return true;
  }
  if (tail === "mark_read" && method === "POST") {
    const body = parseJsonObject(await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES));
    const eventId = nonEmptyString(body, "event_id");
    const clientId = nonEmptyString(body, "client_id");
    if ((body !== undefined && "event_id" in body && eventId === undefined) || ("client_id" in (body ?? {}) && clientId === undefined)) {
      await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a read receipt is JSON naming the event_id it read or none for the whole session, and client_id only as a non-empty string or absent" } });
      return true;
    }
    // The receipt fans to the worker as a published event, sourced to the reading client, so the worker's held stream carries who read how far (this fan-out shape is this door's own: the CLI's own receipt sender never reads the channel, so the real host's worker-side delivery of a receipt is not in any bundle). The receipt is itself an event, so a reading client's own stream sees it; the door's attachment does not re-receipt it (rcStream skips receipt events by name, or the surface would echo itself forever).
    const receipt = ctx.publish(session, clientId ?? RC_SOURCE_CLIENT, { type: "mark_read", ...(eventId === undefined ? {} : { event_id: eventId }), ...(clientId === undefined ? {} : { client_id: clientId }) }, true);
    ctx.log?.(`rc selfhost ${session.id}: ${clientId === undefined ? "an unnamed client" : `client ${clientId}`} marked ${eventId === undefined ? "the session read" : `event ${eventId} read`} as sequence ${String(receipt.sequenceNum)}`);
    await ctx.answerJson(response, HTTP_STATUS.ok, {});
    return true;
  }
  if (tail === "teleport-events" && method === "POST") {
    // The teleport channel's write half. The CLI never POSTs here (verified in the 2.1.289 bundle: the teleport path's only sender is the GET reader below), so the door's own client half (`teleportRcSession`) is this path's one caller, and the body is the family's own write shape because the real host's POST shape is not in any bundle to copy.
    const body = parseJsonObject(await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES));
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > maxBatchEvents) {
      await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: `a teleport write is a non-empty array of at most ${String(maxBatchEvents)} events` } });
      return true;
    }
    const results: Record<string, unknown>[] = [];
    for (const event of events) {
      if (!isRecord(event) || !isRecord(event.payload)) {
        await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "every event in a teleport write is an object carrying one payload object" } });
        return true;
      }
      const published = ctx.publish(session, RC_SOURCE_CLIENT, event.payload);
      results.push({ sequence_num: String(published.sequenceNum), duplicate: published.duplicate });
    }
    ctx.sweep();
    ctx.log?.(`rc selfhost ${session.id}: teleport write published ${String(results.length)} marker event(s)`);
    await ctx.answerJson(response, HTTP_STATUS.ok, { results });
    return true;
  }
  if (tail === "teleport-events" && method === "GET") {
    // The teleport channel's read half, the teleport-to-local hydration's page source: paged rows of the session's own events in `{data: [{payload}], next_cursor}` (the exact shape the CLI's reader pages, verified in the 2.1.289 bundle), the cursor an opaque event id the reader echoes back and an empty page ending the walk by naming none.
    const page = pageOfRcChannel(request.url, session.events, (event) => event.eventId, (event) => ({ event_id: event.eventId, payload: event.payload }));
    if ("error" in page) {
      await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: page.error } });
      return true;
    }
    await ctx.answerJson(response, HTTP_STATUS.ok, page);
    return true;
  }
  return false;
}

/** One row of the compatibility family's list, read and update answers, in the shape the CLI's own session manager normalises (verified in the 2.1.289 bundle: it reads `session_status` or `status`, and takes the row's `id` with the addressed id as its fallback). */
const compatSessionRow = (session: SelfHostSession, now: () => number): Record<string, unknown> => ({ id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), updated_at: new Date(now()).toISOString(), session_status: "active" });

/** Everything the compatibility family needs from the surface that serves it. */
export interface RcCompatSessionContext {
  readonly request: RoutedRequest;
  readonly response: RoutedResponse;
  readonly sessions: Map<string, SelfHostSession>;
  readonly answerJson: (response: RoutedResponse, status: number, body: unknown, extraHeaders?: Readonly<Record<string, string>>) => Promise<void>;
  readonly readBody: (request: IncomingMessage, capBytes: number) => Promise<string>;
  readonly credentialRefusal: (headers: Readonly<IncomingHttpHeaders>) => PresentationRefusal | undefined;
  readonly unauthorized: (response: RoutedResponse, refusal: PresentationRefusal) => Promise<void>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

/**
 * Serves the compatibility `/v1/sessions` family the CLI's claude.ai-side session manager speaks under the `ccr-byoc-2025-07-29` beta (verified in the 2.1.289 bundle: the list, a per-session Get, an Update as PATCH on the v1 compat path and PUT on the v2 path, and Archive/Unarchive as empty-body POSTs), against this door's own sessions so the same manager works with no claude.ai behind it. The family addresses a session by its bare uuid (the cse shim's own mapping strips the `cse_` prefix the v2 family carries), so both that form and the door's full id resolve to the same record.
 */
export async function serveRcCompatSessions(ctx: RcCompatSessionContext, pathname: string, compatPath: string): Promise<void> {
  const { request, response } = ctx;
  const method = request.method.toUpperCase();
  if (pathname === compatPath) {
    if (method !== "GET") {
      await ctx.answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the compatibility session list is a GET" } });
      return;
    }
    const listRefusal = ctx.credentialRefusal(request.headers);
    if (listRefusal !== undefined) {
      await ctx.unauthorized(response, listRefusal);
      return;
    }
    await ctx.answerJson(response, HTTP_STATUS.ok, { data: [...ctx.sessions.values()].map((session) => compatSessionRow(session, ctx.now)) });
    return;
  }
  const rest = pathname.slice(`${compatPath}/`.length);
  const slash = rest.indexOf("/");
  const address = slash === -1 ? rest : rest.slice(0, slash);
  const compatTail = slash === -1 ? "" : rest.slice(slash + 1);
  const refusal = ctx.credentialRefusal(request.headers);
  if (refusal !== undefined) {
    await ctx.unauthorized(response, refusal);
    return;
  }
  const session = ctx.sessions.get(address) ?? ctx.sessions.get(`cse_${address}`);
  if (compatTail === "") {
    if (method === "GET") {
      if (session === undefined) {
        await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `Session not found: ${address}` } });
        return;
      }
      await ctx.answerJson(response, HTTP_STATUS.ok, compatSessionRow(session, ctx.now));
      return;
    }
    if (method === "PATCH" || method === "PUT") {
      if (session === undefined) {
        await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `Session not found: ${address}` } });
        return;
      }
      const body = parseJsonObject(await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES));
      const title = nonEmptyString(body, "title");
      if (title === undefined) {
        await ctx.answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a compatibility session update is JSON naming a non-empty title" } });
        return;
      }
      session.title = title;
      session.lastTrafficAt = ctx.now();
      ctx.log?.(`rc selfhost ${session.id}: retitled through the compatibility family`);
      await ctx.answerJson(response, HTTP_STATUS.ok, compatSessionRow(session, ctx.now));
      return;
    }
    await ctx.answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the compatibility session read is a GET and its update a PATCH or PUT" } });
    return;
  }
  if ((compatTail === "archive" || compatTail === "unarchive") && method === "POST") {
    await ctx.readBody(request.body, CONTROL_BODY_CAP_BYTES);
    if (session === undefined) {
      await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `Session not found: ${address}` } });
      return;
    }
    if (compatTail === "unarchive") {
      // The door's archive ends a session outright (the in-memory surface's own semantics, the same as the v2 family's archive), so an unarchive finds nothing archived: the honest answer for a live session is the idempotent success, not a refusal that would read as an error on a session that exists.
      await ctx.answerJson(response, HTTP_STATUS.ok, compatSessionRow(session, ctx.now));
      return;
    }
    for (const sink of [...session.workerStreams, ...session.clientStreams]) {
      sink.retire();
    }
    ctx.sessions.delete(session.id);
    ctx.log?.(`rc selfhost ${session.id}: archived through the compatibility family`);
    await ctx.answerJson(response, HTTP_STATUS.ok, {});
    return;
  }
  await ctx.answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the compatibility session family serves no path "${compatTail}"` } });
}
