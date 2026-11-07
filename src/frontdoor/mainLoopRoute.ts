import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { RouteResolution } from "./pipeline";
import { PROVIDER_PATH_PREFIX, parseProviderPath, type FrontDoorRoute, type RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";

/**
 * The header Claude Code names each request's class in. Read from the strings of Claude Code 2.1.319, which sets it on every API request whose query source it knows, with one of `REQUEST_CLASSES`; the query source itself is never sent, only this class derived from it (and, for an agent's requests, the agent type in `x-claude-code-agent-type`).
 */
const REQUEST_CLASS_HEADER = "x-claude-code-request-class";

/** The class of a request on the conversation's own loop: the turns the person drives, which are what `/model` changes. */
const MAIN_REQUEST_CLASS = "main";

/** The request's class as the client stated it, or undefined when it sent none (an older client, or a request whose query source it does not know) or sent more than one. */
export function requestClassOf(headers: Readonly<IncomingHttpHeaders>): string | undefined {
  const value = headers[REQUEST_CLASS_HEADER];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Where one session's main loop last went: the Anthropic route (Claude Code's own API) or a provider by name. */
type MainLoopRoute = { readonly kind: "anthropic" } | { readonly kind: "provider"; readonly provider: string };

/**
 * What the door remembers about each session's main loop: where its most recent main-loop request was served, so the session's helper requests (hook judges, titles, compaction summaries, subagents, side replies) follow it there. Held in the door process's memory only, so a restarted door knows nothing until each session's next main-loop request.
 */
export interface MainLoopRouteRecord {
  /** Records where `sessionId`'s latest main-loop request was served. */
  readonly record: (sessionId: string, route: MainLoopRoute) => void;
  /** Where `sessionId`'s latest main-loop request was served, or undefined when none has been recorded since this door started, or the session's launch has ended. */
  readonly routeOf: (sessionId: string) => MainLoopRoute | undefined;
}

/**
 * Builds the record, bounded by the door's session registry: an entry lives exactly as long as a live launch carries its session id, which `holdsSession` answers (the registry view's own lookup, refreshed by the supervisor's tick). Every write drops the entries of launches that have ended, and a read of an ended launch's entry drops it, so the record never holds more sessions than the registry did since the last write.
 */
export function createMainLoopRouteRecord(ports: { readonly holdsSession: (sessionId: string) => boolean }): MainLoopRouteRecord {
  const routes = new Map<string, MainLoopRoute>();
  return {
    record: (sessionId, route) => {
      for (const held of routes.keys()) {
        if (held !== sessionId && !ports.holdsSession(held)) {
          routes.delete(held);
        }
      }
      routes.set(sessionId, route);
    },
    routeOf: (sessionId) => {
      const route = routes.get(sessionId);
      if (route !== undefined && !ports.holdsSession(sessionId)) {
        routes.delete(sessionId);
        return undefined;
      }
      return route;
    },
  };
}

/** Whether a path is a Messages API inference call (`/v1/messages` or one of its sub-resources, `count_tokens` among them): the only requests a session's model choice governs, and so the only ones that record or follow it. */
function isInferencePath(path: string): boolean {
  return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

/** What `followingMainLoop` reads besides the record. */
export interface MainLoopRoutingDeps {
  readonly record: MainLoopRouteRecord;
  /** The model name a helper's requested `model` is sent to `provider` under, through that provider's own tier mapping; undefined when the provider serves the name as it is (a translator that maps a Claude name by tier itself) or the name selects no tier the provider maps. */
  readonly helperModel: (provider: string, session: RoutedRequest["session"], requested: string) => string | undefined;
}

/** The provider a served request target names, or undefined for a bare target (the Anthropic route, or a path the session's launch provider scoped). */
function servedProviderOf(url: string): string | undefined {
  return parseProviderPath(new URL(url, "http://127.0.0.1").pathname)?.provider;
}

/** `route` serving `rewritten` in place of whatever request the pipeline hands it: the request the helper routing chose, scoped under its provider. */
function serving(route: FrontDoorRoute, rewritten: RoutedRequest): FrontDoorRoute {
  return {
    name: route.name,
    headroomEligible: route.headroomEligible,
    headroomUpstream: route.headroomUpstream,
    serve: async (request, response) => {
      await route.serve({ ...request, url: rewritten.url, headers: rewritten.headers, body: rewritten.body }, response);
    },
  };
}

/**
 * Makes a provider-less session's helper requests follow its main loop. A session launched on a provider carries the provider header on every request, helpers included, so it routes exactly as `resolve` does. A session launched without one picks a provider by model name (`/model <provider>/<model>`), which only its main-loop requests carry: its helpers ask for a Claude model name, which no provider claims, and would otherwise reach the Anthropic account the session was launched under.
 *
 * So, for a bare Messages API request from a session that names no provider: a main-loop request (class `main`, or no class at all) is resolved as before and where it was served is recorded; any other class (`subagent`, `workflow`, `compaction`, `auxiliary`, `side_reply`, or one a later client adds) is sent where the session's latest main-loop request went. To a provider, it is scoped under that provider's path with its model name mapped through the provider's tier mapping; to the Anthropic route, it is resolved as before. With nothing recorded (no main-loop request yet, or a door restarted since) it is refused with the reason, never sent to the Anthropic account on a guess.
 */
export function followingMainLoop(resolve: (request: RoutedRequest) => Promise<RouteResolution>, deps: MainLoopRoutingDeps): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    const { sessionId, provider } = request.session;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (sessionId === undefined || provider !== undefined || !isInferencePath(path)) {
      return await resolve(request);
    }
    const requestClass = requestClassOf(request.headers);
    if (requestClass === undefined || requestClass === MAIN_REQUEST_CLASS) {
      const resolution = await resolve(request);
      if (resolution.ok) {
        const served = servedProviderOf(resolution.request?.url ?? request.url);
        deps.record.record(sessionId, served === undefined ? { kind: "anthropic" } : { kind: "provider", provider: served });
      }
      return resolution;
    }
    const route = deps.record.routeOf(sessionId);
    if (route === undefined) {
      return {
        ok: false,
        status: HTTP_STATUS.badRequest,
        message: `agent-shim front door: this ${requestClass} request follows its session's main loop, and the door has seen no main-loop request from this session since it started; it is not sent to the account the session was launched under. Send the session's next prompt, and its helpers follow wherever that goes.`,
      };
    }
    if (route.kind === "anthropic") {
      return await resolve(request);
    }
    const scan = await scanRequestHead(request, true);
    const requested = scan.model;
    const mapped = requested === undefined ? undefined : deps.helperModel(route.provider, request.session, requested);
    const replayed = scan.replayed ?? request;
    const body = mapped === undefined || requested === undefined || scan.text === undefined ? replayed : withModel(replayed, scan.text, requested, mapped);
    const helper: RoutedRequest = { ...body, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(route.provider)}${request.url}` };
    const resolution = await resolve(helper);
    if (!resolution.ok) {
      return resolution;
    }
    // The pipeline serves and hops with the request it received, which names no provider; the scoped helper is substituted for it, both at the route and for the hop, unless resolving it rewrote it again (a provider's own `routes`), whose rewrite then stands.
    const served = resolution.request ?? helper;
    return { ...resolution, route: resolution.request === undefined ? serving(resolution.route, helper) : resolution.route, request: served, ...(requested === undefined ? {} : { requestedModel: requested }) };
  };
}

/**
 * `request` with its body's model field changed from `from` to `to`, rewritten in the one copy of the body a whole-body scan holds (`text`), exactly one field changed. The framing header goes, because the new name is a different length and the forward re-frames the body itself.
 */
export function withModel(request: RoutedRequest, text: string, from: string, to: string): RoutedRequest {
  // A function replacement, so nothing in the new name is read as a replacement pattern.
  const rewritten = text.replace(new RegExp('"model":\\s*"' + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), () => `"model":${JSON.stringify(to)}`);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
  return { ...request, headers, body: Readable.from([Buffer.from(rewritten, "utf8")]) };
}
