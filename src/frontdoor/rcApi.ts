import type { IncomingHttpHeaders } from "node:http";

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { eventIterator, os, withEventMeta, type AnyRouter, type RouterClient } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { Agent, fetch as undiciFetch } from "undici";

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
 */

/** The one path prefix the typed API is mounted under, answered before the routed pipeline like the bespoke control routes are. */
export const RC_ORPC_PATH_PREFIX = "/__agent-shim/orpc";

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
  /** The client attachment's fan-out, whose events the subscription yields. */
  readonly fanout: RcEventFanout;
}

/** The context every procedure on the door's typed API runs in: the request's own headers, which the control-token middleware reads the Bearer credential from. */
export interface DoorApiContext {
  readonly headers: IncomingHttpHeaders;
}

/** Builds the middleware every procedure on the door's typed API sits behind, whichever router it belongs to: the per-generation owner-only control token, presented as a Bearer credential and checked in constant time like every other capability the door accepts. */
export function doorApiAuth(expectedToken: string) {
  return os
    .$context<DoorApiContext>()
    .use(({ context, next }) => {
      const presented = context.headers.authorization;
      const bearerPrefix = "bearer ".length;
      const token = typeof presented === "string" && presented.slice(0, bearerPrefix).toLowerCase() === "bearer " ? presented.slice(bearerPrefix) : undefined;
      if (token === undefined || !isLiveCapability(token, [expectedToken])) {
        throw new ORPCError("UNAUTHORIZED", { message: "the front door's typed API demands this generation's control token as a Bearer credential" });
      }
      return next();
    });
}

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
      list: authed.output(RcListOutputSchema).handler(() => ({ sessions: deps.list() })),
      status: authed
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
        .input(RcSendInputSchema)
        .output(RcWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, sequenceNums: delivered(input.session, await deps.inject(input.session, input.text)) })),
      answer: authed
        .input(RcAnswerInputSchema)
        .output(RcAnswerOutputSchema)
        .handler(async ({ input }) => {
          const decision: RcAnswerDecision = { approve: input.approve, message: input.approve || input.text === undefined ? undefined : input.text };
          return { session: input.session, request: input.request, sequenceNums: delivered(input.session, await deps.answer(input.session, input.request, decision)) };
        }),
      interrupt: authed
        .input(RcInterruptInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.interrupt(input.session)) })),
      setModel: authed
        .input(RcSetModelInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.setModel(input.session, input.model)) })),
      setPermissionMode: authed
        .input(RcSetPermissionModeInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.setPermissionMode(input.session, input.mode)) })),
      endSession: authed
        .input(RcEndSessionInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.endSession(input.session, input.reason)) })),
      getUsage: authed
        .input(RcGetUsageInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.getUsage(input.session, input.skipBehaviors)) })),
      getContextUsage: authed
        .input(RcGetContextUsageInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.getContextUsage(input.session, input.detail)) })),
      readFile: authed
        .input(RcReadFileInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.readFile(input.session, input.path, { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(input.encoding === undefined ? {} : { encoding: input.encoding }) })) })),
      fileSuggestions: authed
        .input(RcFileSuggestionsInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.fileSuggestions(input.session, input.query)) })),
      keepAlive: authed
        .input(RcKeepAliveInputSchema)
        .output(RcWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, sequenceNums: delivered(input.session, await deps.keepAlive(input.session)) })),
      mcpStatus: authed
        .input(RcMcpStatusInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpStatus(input.session)) })),
      mcpReconnect: authed
        .input(RcMcpReconnectInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpReconnect(input.session, input.serverName)) })),
      mcpAuthenticate: authed
        .input(RcMcpAuthenticateInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpAuthenticate(input.session, input.serverName, input.redirectUri)) })),
      mcpOAuthCallbackUrl: authed
        .input(RcMcpOAuthCallbackUrlInputSchema)
        .output(RcControlWriteOutputSchema)
        .handler(async ({ input }) => ({ session: input.session, ...deliveredControl(input.session, await deps.mcpOAuthCallbackUrl(input.session, input.serverName, input.callbackUrl)) })),
      subscribe: authed
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
 * Builds the node handler that serves one router of the door's typed API under the mount's one prefix: the pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`, answering with `matched: false` for a path under the prefix that names no procedure (which the listener itself answers as a 404). Request bodies are bounded by the same protocol cap the bespoke routes apply. Every router the mount serves (Remote Control and the control plane) goes through this one builder, so the prefix, the context and the cap are stated once.
 */
export function doorApiNodeHandlerOf(router: AnyRouter): PrePipelineApi {
  const handler = new RPCHandler(router, { plugins: [new BodyLimitPlugin({ maxBodySize: CONTROL_BODY_CAP_BYTES })] });
  return {
    pathPrefix: RC_ORPC_PATH_PREFIX,
    handle: async (request, response) => await handler.handle(request, response, { context: { headers: request.headers }, prefix: RC_ORPC_PATH_PREFIX }),
  };
}

/**
 * Builds the typed API's node handler for the Remote Control router alone: the pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`.
 */
export function createRcApiNodeHandler(deps: RcApiDeps): PrePipelineApi {
  return doorApiNodeHandlerOf(createRcApiRouter(deps));
}

/** The typed API's client as the `frontdoor rc` verbs use it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type RcApiClient = RouterClient<RcApiRouter>;

/** Builds the link every client of the door's typed API dials through: the door's address under the mount prefix, the per-generation control token on every call, and TLS trusting only the CA the door's own state names. */
export function frontDoorApiLink(port: number, ca: string, token: string) {
  // One dispatcher for the link's lifetime, trusting only the door's CA, so a process merely holding the port cannot answer as the door (the same trust rule the bespoke transport applies).
  const dispatcher = new Agent({ connect: { ca } });
  return new RPCLink({
    url: `https://127.0.0.1:${String(port)}${RC_ORPC_PATH_PREFIX}`,
    headers: { authorization: `Bearer ${token}` },
    // undici's own Request and Response types and the global ones are distinct declarations of the same standard shapes (the package's bundled types sit beside @types/node's own), and its fetch refuses the global Request instance outright, so the call is rebuilt from the request's parts and the answer re-wrapped through the global constructors, never cast between the two. The request body is one bounded JSON object (the same protocol cap the handler enforces), so reading it whole costs nothing; it is the answer that streams.
    fetch: async (request, _init, options) => {
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

/** Builds the typed API's client for the door's provider listener: the same address, CA and per-generation control token the bespoke control client uses. */
export function frontDoorRcApiClient(port: number, ca: string, token: string): RcApiClient {
  return createORPCClient(frontDoorApiLink(port, ca, token));
}
