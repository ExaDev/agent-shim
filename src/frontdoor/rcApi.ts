import type { IncomingHttpHeaders } from "node:http";

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { openapi, OpenAPIGenerator, type OpenAPIDocument } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { eventIterator, os, withEventMeta, type AnyRouter, type RouterClient } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { Agent, fetch as undiciFetch } from "undici";

import packageJson from "../../package.json";
import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { RcPendingRequestSummary, RcSessionStatus, RcSessionSummary } from "./rcSessions";
import { rcSessionNotObservedMessage, type RcAnswerDecision, type RcContextUsageDetail, type RcEventWriteResult, type RcPermissionMode, type RcReadFileOptions } from "./rcWrites";
import {
  RcAnswerInputSchema,
  RcAnswerOutputSchema,
  RcControlWriteOutputSchema,
  RcEndSessionInputSchema,
  RcFileSuggestionsInputSchema,
  RcGetContextUsageInputSchema,
  RcGetUsageInputSchema,
  RcInterruptInputSchema,
  RcKeepAliveInputSchema,
  RcListOutputSchema,
  RcMcpAuthenticateInputSchema,
  RcMcpOAuthCallbackUrlInputSchema,
  RcTeleportInputSchema,
  RcMcpReconnectInputSchema,
  RcMcpStatusInputSchema,
  RcPendingOutputSchema,
  RcReadFileInputSchema,
  RcSendInputSchema,
  RcSessionQuerySchema,
  RcSetModelInputSchema,
  RcSetPermissionModeInputSchema,
  RcStatusOutputSchema,
  RcStreamEventSchema,
  RcWriteOutputSchema,
  type RcStreamEvent,
} from "./rcSchemas";
import type { RcEventFanout } from "./rcStream";
import type { PrePipelineApi } from "./server";

/**
 * The Remote Control operations as a typed oRPC API, so programmatic consumers (automation, a mobile or web client, another of this user's tools) get a generated type-safe client instead of hand-rolled HTTP. One procedure per existing operation, each wrapping the same operation the bespoke token-gated routes wrap (the routes stay: the CLI uses them), with inputs and outputs validating through the Zod schemas of `rcSchemas.ts`, which the operations' own values must satisfy, so contract and behaviour share one schema source and cannot drift apart silently.
 *
 * Mounted on the provider listener beside the bespoke namespace, authenticated by the same per-generation owner-only control token as a Bearer credential: a fresh random value per door start, written owner-only under the front door's state directory, and checked in constant time like every other capability the door accepts. `rc.subscribe` streams the client attachment's fan-out: every event the door's held stream produced, SSE-framed by oRPC's event iterator, each carrying its sequence number as the SSE event id so a consumer's own reconnect can resume exactly as the door's does.
 *
 * This module also owns the mount's router-agnostic plumbing, which the control-plane routers (`controlApi.ts`) serve on the same prefix under the same token: the control-token middleware (`doorApiAuth`), the node-handler builder (`doorApiNodeHandlerOf`) and the TLS-pinned client link (`frontDoorApiLink`).
 *
 * Every procedure is route-annotated (method, path, summary, tags) under the mount's one REST namespace (`/rest/...`), so the mount serves the same operations twice over: as the oRPC RPC protocol the typed clients and the web client speak, and as plain REST for consumers with no TypeScript client (curl, scripts, other languages), with the OpenAPI document of the whole surface at `RC_OPENAPI_DOC_PATH` under the same token. The two share one router, one token middleware and one Zod schema source, so nothing can drift between them; an annotated (method, path) pair is served REST-shaped and everything else falls through to the RPC handler, and no RPC procedure path begins with `/rest`, so neither address space can ever capture the other.
 */

/** The one path prefix the typed API is mounted under, answered before the routed pipeline like the bespoke control routes are. */
export const RC_ORPC_PATH_PREFIX = "/__agent-shim/orpc";

/** Where the mount serves the OpenAPI document of every annotated route, under the same control token as the operations it describes. */
const RC_OPENAPI_DOC_PATH = "/openapi.json";

/**
 * How many events one subscriber's bridge holds while the consumer behind it has not pulled them. Not a fresh number: it is the bound oRPC's own `EventPublisher` documents as its default for exactly this slow-consumer case (a buffer without one grows without limit), and a full buffer drops the oldest event, whose absence a consumer detects by the gap it leaves in the sequence numbers, while the tracker keeps the authoritative record of everything the stream carried.
 */
const RC_SUBSCRIBER_BUFFER_EVENTS = 100;

/** Everything the typed API needs: the same operations the bespoke control routes take, the fan-out its subscription reads, and the token both surfaces demand. */
export interface RcApiDeps {
  /** This generation's control token: the value the door wrote owner-only for its callers to present. */
  readonly expectedToken: string;
  /** The observed sessions as the tracker lists them. */
  readonly list: () => readonly RcSessionSummary[];
  /** The observed sessions as the tracker reports their status, filtered to one when named. */
  readonly statusOf: (sessionId?: string) => readonly RcSessionStatus[];
  /** The control requests awaiting an answer, filtered to one session when named. */
  readonly pendingOf: (sessionId?: string) => readonly RcPendingRequestSummary[];
  /** The inject operation, already wired to the tracker and the door's API-host dial. */
  readonly inject: (sessionId: string, text: string) => Promise<RcEventWriteResult>;
  /** The answer operation, already wired to the tracker and the door's API-host dial. */
  readonly answer: (sessionId: string, requestId: string, decision: RcAnswerDecision) => Promise<RcEventWriteResult>;
  /** The interrupt operation, already wired to the tracker and the door's API-host dial. */
  readonly interrupt: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The set-model operation, already wired to the tracker and the door's API-host dial. */
  readonly setModel: (sessionId: string, model: string) => Promise<RcEventWriteResult>;
  /** The set-permission-mode operation, already wired to the tracker and the door's API-host dial. */
  readonly setPermissionMode: (sessionId: string, mode: RcPermissionMode) => Promise<RcEventWriteResult>;
  /** The end-session operation, already wired to the tracker and the door's API-host dial. */
  readonly endSession: (sessionId: string, reason: string | undefined) => Promise<RcEventWriteResult>;
  /** The get-usage operation, already wired to the tracker and the door's API-host dial. */
  readonly getUsage: (sessionId: string, skipBehaviors: boolean | undefined) => Promise<RcEventWriteResult>;
  /** The get-context-usage operation, already wired to the tracker and the door's API-host dial. */
  readonly getContextUsage: (sessionId: string, detail: RcContextUsageDetail | undefined) => Promise<RcEventWriteResult>;
  /** The read-file operation, already wired to the tracker and the door's API-host dial. */
  readonly readFile: (sessionId: string, path: string, options: RcReadFileOptions | undefined) => Promise<RcEventWriteResult>;
  /** The file-suggestions operation, already wired to the tracker and the door's API-host dial. */
  readonly fileSuggestions: (sessionId: string, query: string) => Promise<RcEventWriteResult>;
  /** The keep-alive operation, already wired to the tracker and the door's API-host dial. */
  readonly keepAlive: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The mcp-status operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpStatus: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The mcp-reconnect operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpReconnect: (sessionId: string, serverName: string) => Promise<RcEventWriteResult>;
  /** The mcp-authenticate operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpAuthenticate: (sessionId: string, serverName: string, redirectUri: string) => Promise<RcEventWriteResult>;
  /** The mcp-oauth-callback-url operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpOAuthCallbackUrl: (sessionId: string, serverName: string, callbackUrl: string) => Promise<RcEventWriteResult>;
  /** The teleport operation, already wired to the tracker and the door's API-host dial. */
  readonly teleport: (sessionId: string, marker: string) => Promise<RcEventWriteResult>;
  /** The client attachment's fan-out, whose events the subscription yields. */
  readonly fanout: RcEventFanout;
}

/** The context every procedure on the door's typed API runs in: the request's own headers, which the control-token middleware reads the Bearer credential from. */
export interface DoorApiContext {
  readonly headers: IncomingHttpHeaders;
  /** Registers an action that runs once the response has been fully written, so a procedure whose effect ends the process serving the call (a door restart) never cuts its own answer off. */
  readonly afterResponse: (action: () => void) => void;
}

/** Reads the Bearer credential a request presents, whichever surface it arrived on; undefined when nothing is presented in that form. */
function doorApiBearer(headers: IncomingHttpHeaders): string | undefined {
  const presented = headers.authorization;
  const bearerPrefix = "bearer ".length;
  return typeof presented === "string" && presented.slice(0, bearerPrefix).toLowerCase() === "bearer " ? presented.slice(bearerPrefix) : undefined;
}

/** Builds the middleware every procedure on the door's typed API sits behind, whichever router it belongs to: the per-generation owner-only control token, presented as a Bearer credential and checked in constant time like every other capability the door accepts. */
export function doorApiAuth(expectedToken: string) {
  return os
    .$context<DoorApiContext>()
    .use(({ context, next }) => {
      const token = doorApiBearer(context.headers);
      if (token === undefined || !isLiveCapability(token, [expectedToken])) {
        throw new ORPCError("UNAUTHORIZED", { message: "the front door's typed API demands this generation's control token as a Bearer credential" });
      }
      return next();
    });
}

/** The one OpenAPI tag every Remote Control procedure carries, so the document groups the door's Remote Control surface as one section. */
const RC_API_TAG = "remote-control";

/** Builds the typed API's router: one procedure per operation, every one behind the control-token middleware. */
export function createRcApiRouter(deps: RcApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  // A write the operation could not deliver becomes the same verbose message the bespoke routes answer 502 with, carried as an oRPC error a typed client reads as a thrown value.
  const delivered = (sessionId: string, result: RcEventWriteResult): readonly number[] => {
    if (!result.ok) {
      throw new ORPCError("BAD_GATEWAY", { message: result.message });
    }
    return result.sequenceNums;
  };
  // The same refusal for a control-request write, whose answer also names the minted request id the worker's `control_response` echoes, so a consumer of `rc.subscribe` can match the answer to the ask.
  const deliveredControl = (sessionId: string, result: RcEventWriteResult): { readonly request: string; readonly sequenceNums: readonly number[] } => {
    if (!result.ok) {
      throw new ORPCError("BAD_GATEWAY", { message: result.message });
    }
    if (result.requestId === undefined) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "the control request was delivered but the door cannot name the request id it minted, so the worker's answer cannot be matched" });
    }
    return { request: result.requestId, sequenceNums: result.sequenceNums };
  };
  return {
    rc: {
      list: authed
        .meta(openapi({ method: "GET", path: "/rest/rc/sessions", summary: "List the observed Remote Control sessions", tags: [RC_API_TAG] }))
        .output(RcListOutputSchema)
        .handler(() => ({ sessions: deps.list() })),
      status: authed
        .meta(openapi({ method: "GET", path: "/rest/rc/status", summary: "Read session status, one session's when named", tags: [RC_API_TAG] }))
        .input(RcSessionQuerySchema)
        .output(RcStatusOutputSchema)
        .handler(({ input }) => {
          const statuses = deps.statusOf(input.session);
          // A named session that is not tracked is refused rather than answered as empty, so a mistyped id never reads as "observed, nothing pending" (the bespoke route's own rule).
          if (input.session !== undefined && !statuses.some((entry) => entry.id === input.session)) {
            throw new ORPCError("NOT_FOUND", { message: rcSessionNotObservedMessage(input.session) });
          }
          return { statuses };
        }),
      pending: authed
        .meta(openapi({ method: "GET", path: "/rest/rc/pending", summary: "Read the control requests awaiting an answer", tags: [RC_API_TAG] }))
        .input(RcSessionQuerySchema)
        .output(RcPendingOutputSchema)
        .handler(({ input }) => {
          const pending = deps.pendingOf(input.session);
          if (input.session !== undefined && deps.statusOf(input.session).length === 0) {
            throw new ORPCError("NOT_FOUND", { message: rcSessionNotObservedMessage(input.session) });
          }
          return { pending };
        }),
      send: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/send", summary: "Send one message into a session", tags: [RC_API_TAG] }))
        .input(RcSendInputSchema)
        .output(RcWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, sequenceNums: delivered(input.session, await deps.inject(input.session, input.text)) })),
      answer: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/answer", summary: "Answer one pending control request", tags: [RC_API_TAG] }))
        .input(RcAnswerInputSchema)
        .output(RcAnswerOutputSchema)
        .handler(async ({ input }) => {
          const decision: RcAnswerDecision = { approve: input.approve, message: input.approve || input.text === undefined ? undefined : input.text };
          return { session: input.session, request: input.request, sequenceNums: delivered(input.session, await deps.answer(input.session, input.request, decision)) };
        }),
      interrupt: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/interrupt", summary: "Interrupt a session's running turn", tags: [RC_API_TAG] }))
        .input(RcInterruptInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.interrupt(input.session)) })),
      setModel: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/set-model", summary: "Switch a session's model", tags: [RC_API_TAG] }))
        .input(RcSetModelInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.setModel(input.session, input.model)) })),
      setPermissionMode: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/set-permission-mode", summary: "Switch a session's permission mode", tags: [RC_API_TAG] }))
        .input(RcSetPermissionModeInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.setPermissionMode(input.session, input.mode)) })),
      endSession: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/end-session", summary: "End a session", tags: [RC_API_TAG] }))
        .input(RcEndSessionInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.endSession(input.session, input.reason)) })),
      getUsage: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/get-usage", summary: "Ask a session for its usage snapshot", tags: [RC_API_TAG] }))
        .input(RcGetUsageInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.getUsage(input.session, input.skipBehaviors)) })),
      getContextUsage: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/get-context-usage", summary: "Ask a session for its context usage", tags: [RC_API_TAG] }))
        .input(RcGetContextUsageInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.getContextUsage(input.session, input.detail)) })),
      readFile: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/read-file", summary: "Ask a session to read one file", tags: [RC_API_TAG] }))
        .input(RcReadFileInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.readFile(input.session, input.path, { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(input.encoding === undefined ? {} : { encoding: input.encoding }) })) })),
      fileSuggestions: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/file-suggestions", summary: "Ask a session for file-path suggestions", tags: [RC_API_TAG] }))
        .input(RcFileSuggestionsInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.fileSuggestions(input.session, input.query)) })),
      keepAlive: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/keep-alive", summary: "Keep a session's bridge alive", tags: [RC_API_TAG] }))
        .input(RcKeepAliveInputSchema)
        .output(RcWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, sequenceNums: delivered(input.session, await deps.keepAlive(input.session)) })),
      mcpStatus: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/mcp-status", summary: "Ask a session for its MCP servers' status", tags: [RC_API_TAG] }))
        .input(RcMcpStatusInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpStatus(input.session)) })),
      mcpReconnect: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/mcp-reconnect", summary: "Ask a session to reconnect one MCP server", tags: [RC_API_TAG] }))
        .input(RcMcpReconnectInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpReconnect(input.session, input.serverName)) })),
      mcpAuthenticate: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/mcp-authenticate", summary: "Start OAuth for one MCP server on a session", tags: [RC_API_TAG] }))
        .input(RcMcpAuthenticateInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpAuthenticate(input.session, input.serverName, input.redirectUri)) })),
      mcpOAuthCallbackUrl: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/mcp-oauth-callback-url", summary: "Hand a completed MCP OAuth callback to a session", tags: [RC_API_TAG] }))
        .input(RcMcpOAuthCallbackUrlInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpOAuthCallbackUrl(input.session, input.serverName, input.callbackUrl)) })),
      teleport: authed
        .meta(openapi({ method: "POST", path: "/rest/rc/teleport", summary: "Teleport a session to a conversation marker", tags: [RC_API_TAG] }))
        .input(RcTeleportInputSchema)
        .output(RcWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, sequenceNums: delivered(input.session, await deps.teleport(input.session, input.marker)) })),
      subscribe: authed
        .meta(openapi({ method: "GET", path: "/rest/rc/events", summary: "Stream a session's Remote Control events (SSE)", tags: [RC_API_TAG] }))
        .input(RcSessionQuerySchema)
        .output(eventIterator(RcStreamEventSchema))
        .handler(async function* ({ input, signal }) {
          // The bridge from the fan-out's synchronous publish to the subscription's pull: events that arrive between pulls queue here, bounded, and the loop wakes the moment one lands. The wake is registered before the queue is checked, so an event published in between can never be slept past.
          const queue: RcStreamEvent[] = [];
          let wake: (() => void) | undefined;
          const detach = deps.fanout.subscribe(input.session, (event) => {
            if (queue.length >= RC_SUBSCRIBER_BUFFER_EVENTS) {
              queue.shift();
            }
            queue.push(event);
            wake?.();
          });
          // The idle wait also ends when the caller's signal aborts (a disconnect, or a cancelled pull): the race resolves, and the loop's next turn throws out through the aborted signal rather than waiting for an event that will never come.
          const ended = new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              resolve();
            }, { once: true });
          });
          try {
            for (;;) {
              signal?.throwIfAborted();
              const event = queue.shift();
              if (event !== undefined) {
                // The sequence number becomes the SSE event id, so a consumer that reconnects with the protocol's own last-event-id rule resumes exactly where this stream left it.
                yield withEventMeta(event, { id: String(event.envelope.sequence_num) });
                continue;
              }
              await Promise.race([
                new Promise<void>((resolve) => {
                  wake = resolve;
                }),
                ended,
              ]);
            }
          } finally {
            detach();
          }
        }),
    },
  };
}

/** The typed API's router, as the CLI-side client's own type is derived from it. */
export type RcApiRouter = ReturnType<typeof createRcApiRouter>;

/**
 * Builds the node handler that serves one router of the door's typed API under the mount's one prefix, twice over: the OpenAPI handler answers every route-annotated (method, path) pair as plain REST (every annotation under `/rest`, which no RPC procedure path begins with, so the RPC protocol's own POSTs always fall through untouched), and everything else falls to the RPC handler, which answers the oRPC protocol the typed clients and the web client speak. The OpenAPI document of the annotated routes is served at `RC_OPENAPI_DOC_PATH`, behind the same per-generation control token the procedures demand, so a consumer with no TypeScript client reads the whole surface from the mount itself. The pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`, answering with `matched: false` for a path under the prefix that names no route and no procedure (which the listener itself answers as a 404). Request bodies are bounded by the same protocol cap the bespoke routes apply, on both handlers. Every router the mount serves (Remote Control and the control plane) goes through this one builder, so the prefix, the context and the cap are stated once.
 */
export function doorApiNodeHandlerOf(router: AnyRouter, expectedToken: string): PrePipelineApi {
  const plugins = [new BodyLimitPlugin({ maxBodySize: CONTROL_BODY_CAP_BYTES })];
  const rpcHandler = new RPCHandler(router, { plugins });
  const restHandler = new OpenAPIHandler(router, { plugins });
  // Generated from the same router the two handlers serve, on the first request that asks for it and never again: the router cannot change after the mount is built, and the memoised promise (success or failure) is what later requests read, so a schema that cannot convert surfaces on every read of the document rather than flapping between attempts.
  let document: Promise<OpenAPIDocument<"3.2.0">> | undefined;
  const documentOf = async () => (document ??= new OpenAPIGenerator().generate(router, { base: { info: { title: "agent-shim front door API", version: packageJson.version } } }));
  return {
    pathPrefix: RC_ORPC_PATH_PREFIX,
    handle: async (request, response) => {
      if (request.method === "GET" && request.url === `${RC_ORPC_PATH_PREFIX}${RC_OPENAPI_DOC_PATH}`) {
        const token = doorApiBearer(request.headers);
        if (token === undefined || !isLiveCapability(token, [expectedToken])) {
          // The same error convention the procedures answer with (an oRPC error's own JSON), so a consumer sees one error shape across the whole mount.
          const refusal = new ORPCError("UNAUTHORIZED", { message: "the front door's OpenAPI document demands this generation's control token as a Bearer credential" });
          response.writeHead(HTTP_STATUS.unauthorized, { "content-type": "application/json" });
          response.end(JSON.stringify(refusal.toJSON()));
          return { matched: true };
        }
        try {
          const doc = await documentOf();
          response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
          response.end(JSON.stringify(doc));
        } catch (error: unknown) {
          const refusal = new ORPCError("INTERNAL_SERVER_ERROR", { message: `the OpenAPI document could not be generated from the door's own router: ${error instanceof Error ? error.message : String(error)}` });
          response.writeHead(HTTP_STATUS.internalServerError, { "content-type": "application/json" });
          response.end(JSON.stringify(refusal.toJSON()));
        }
        return { matched: true };
      }
      const rest = await restHandler.handle(request, response, { context: { headers: request.headers, afterResponse: (action: () => void) => { response.once("finish", action); } }, prefix: RC_ORPC_PATH_PREFIX });
      if (rest.matched) {
        return rest;
      }
      return await rpcHandler.handle(request, response, { context: { headers: request.headers, afterResponse: (action: () => void) => { response.once("finish", action); } }, prefix: RC_ORPC_PATH_PREFIX });
    },
  };
}

/**
 * Builds the typed API's node handler for the Remote Control router alone: the pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`.
 */
export function createRcApiNodeHandler(deps: RcApiDeps): PrePipelineApi {
  return doorApiNodeHandlerOf(createRcApiRouter(deps), deps.expectedToken);
}

/** The typed API's client as the `frontdoor rc` verbs use it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type RcApiClient = RouterClient<RcApiRouter>;

/** Builds the link every client of the door's typed API dials through: the door's address under the mount prefix, the per-generation control token on every call, and TLS trusting only the CA the door's own state names. */
export function frontDoorApiLink(port: number, ca: string, token: string) {
  // One dispatcher for the link's lifetime, trusting only the door's CA, so a process merely holding the port cannot answer as the door (the same trust rule the bespoke transport applies).
  const dispatcher = new Agent({ connect: { ca } });
  return new RPCLink({
    origin: `https://127.0.0.1:${String(port)}`,
    url: RC_ORPC_PATH_PREFIX,
    headers: { authorization: `Bearer ${token}` },
    // undici's own Request and Response types and the global ones are distinct declarations of the same standard shapes (the package's bundled types sit beside @types/node's own), and its fetch refuses the global Request instance outright, so the call is rebuilt from the request's parts and the answer re-wrapped through the global constructors, never cast between the two. The request body is one bounded JSON object (the same protocol cap the handler enforces), so reading it whole costs nothing; it is the answer that streams.
    fetch: async (url, init, options) => {
      const request = new Request(url, init);
      const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
      const answered = await undiciFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        ...(body === undefined ? {} : { body }),
        dispatcher,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return new Response(answered.body, { status: answered.status, statusText: answered.statusText, headers: [...answered.headers] });
    },
  });
}

/** Fetches the OpenAPI document of the door's whole typed surface over TLS trusting only the CA the door's own state names, presenting the per-generation control token. Resolves to the parsed JSON, whose shape the caller validates. */
export async function fetchFrontDoorOpenApiDocument(port: number, ca: string, token: string): Promise<unknown> {
  const dispatcher = new Agent({ connect: { ca } });
  try {
    const answered = await undiciFetch(`https://127.0.0.1:${String(port)}${RC_ORPC_PATH_PREFIX}${RC_OPENAPI_DOC_PATH}`, { headers: { authorization: `Bearer ${token}` }, dispatcher });
    if (!answered.ok) {
      throw new Error(`the front door refused its OpenAPI document with HTTP ${String(answered.status)}`);
    }
    return await answered.json();
  } finally {
    await dispatcher.close();
  }
}

/** Builds the typed API's client for the door's provider listener: the same address, CA and per-generation control token the bespoke control client uses. */
export function frontDoorRcApiClient(port: number, ca: string, token: string): RcApiClient {
  return createORPCClient(frontDoorApiLink(port, ca, token));
}
