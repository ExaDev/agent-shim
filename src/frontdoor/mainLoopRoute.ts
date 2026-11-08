import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { RouteResolution } from "./pipeline";
import { RequestClassSchema, type RequestClass } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, internalHeaderValue, parseProviderPath, type FrontDoorRoute, type RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";
import { launchKeyOf, type FrontDoorLaunch, type MainLoopRoute } from "./state";

/**
 * The header Claude Code names each request's class in. Read from the strings of Claude Code 2.1.319, which sets it on every API request whose query source it knows, with one of the classes in `REQUEST_CLASSES`; the query source itself is never sent, only this class derived from it (and, for an agent's requests, the agent type in `x-claude-code-agent-type`).
 */
const REQUEST_CLASS_HEADER = "x-claude-code-request-class";

/**
 * The header Claude Code 2.1.319 names the requesting agent's id in. It is attached to every request made from a non-main agent context (a subagent, a workflow's agent, a teammate) whatever `CLAUDE_CODE_GATEWAY_HINT_HEADERS` says, since only the class and agent-type headers sit behind that gate, and never to a request made from the main thread's own context. So it identifies a subagent request for a session launched without the class header.
 */
const AGENT_ID_HEADER = "x-claude-code-agent-id";

/** The class of a request on the conversation's own loop: the turns the person drives, which are what `/model` changes. */
const MAIN_REQUEST_CLASS = "main";

/**
 * The request's class as the client stated it: one of the classes Claude Code sends, `unknown` for any other value (a repeated header, which Node joins into one string, included, so a client-chosen string is neither logged nor echoed). With no class stated (a launch whose child was not asked for the header, or a request whose query source Claude Code does not know) a request that carries an agent id is `subagent`, the class Claude Code gives an agent's own requests, and any other is undefined. The headers are found whatever their case, like every internal header.
 */
export function requestClassOf(headers: Readonly<IncomingHttpHeaders>): RequestClass | undefined {
  const value = internalHeaderValue(headers, REQUEST_CLASS_HEADER);
  if (value === undefined) {
    const agentId = internalHeaderValue(headers, AGENT_ID_HEADER);
    return agentId === undefined || agentId === "" ? undefined : "subagent";
  }
  const parsed = RequestClassSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * What the door remembers about each launch's main loop: where its most recent main-loop request was served, so the launch's helper requests (hook judges, titles, compaction summaries, subagents, side replies) follow it there. Keyed on the launch carrying the session id (its pid and start time), not on the session id alone: a `--resume` or an account-move relaunch carries the same session id, and must start with nothing recorded. Persisted beside the launch's registry record, so a restarted or replacing door keeps a session's helpers on the provider its main loop is on.
 */
export interface MainLoopRouteRecord {
  /** Records where `sessionId`'s launch's latest main-loop request was served; nothing is recorded for a session id no live launch carries. */
  readonly record: (sessionId: string, route: MainLoopRoute) => void;
  /** Where `sessionId`'s launch's latest main-loop request was served, or undefined when none has been recorded, or no live launch carries the id. */
  readonly routeOf: (sessionId: string) => MainLoopRoute | undefined;
}

/** What `createMainLoopRouteRecord` reads the registry through. */
export interface MainLoopRoutePorts {
  /** The live launch carrying a session id, or undefined when the registry holds none. */
  readonly launchOfSession: (sessionId: string) => FrontDoorLaunch | undefined;
  /** Whether a launch is still registered. */
  readonly holdsLaunch: (launch: Readonly<FrontDoorLaunch>) => boolean;
  /** The durable copy, which lives and dies with the launch's registry entry: where a launch's main loop last went, as an earlier door process wrote it. */
  readonly stored: {
    readonly read: (launch: Readonly<FrontDoorLaunch>) => MainLoopRoute | undefined;
    readonly write: (launch: Readonly<FrontDoorLaunch>, route: MainLoopRoute) => void;
  };
}

/** Whether two routes name the same destination. */
function sameRoute(a: MainLoopRoute, b: MainLoopRoute): boolean {
  return a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.provider === b.provider));
}

/**
 * Builds the record, bounded by the door's session registry: an entry lives exactly as long as the registry holds its launch. Every write drops the entries of launches that have ended, and a read of an ended launch's entry drops it, so the record never holds more launches than the registry did since the last write.
 */
export function createMainLoopRouteRecord(ports: MainLoopRoutePorts): MainLoopRouteRecord {
  const routes = new Map<string, { readonly launch: FrontDoorLaunch; readonly route: MainLoopRoute }>();
  return {
    record: (sessionId, route) => {
      const launch = ports.launchOfSession(sessionId);
      if (launch === undefined) {
        return;
      }
      const key = launchKeyOf(launch);
      for (const [held, entry] of routes) {
        if (held !== key && !ports.holdsLaunch(entry.launch)) {
          routes.delete(held);
        }
      }
      const held = routes.get(key)?.route;
      routes.set(key, { launch, route });
      // Written only when it changes: the main loop's every request records, and the route rarely moves.
      if (held === undefined || !sameRoute(held, route)) {
        ports.stored.write(launch, route);
      }
    },
    routeOf: (sessionId) => {
      const launch = ports.launchOfSession(sessionId);
      const key = launch === undefined ? undefined : launchKeyOf(launch);
      const entry = key === undefined ? undefined : routes.get(key);
      if (entry !== undefined || launch === undefined || key === undefined) {
        return entry?.route;
      }
      // Nothing in memory: this door has not served the launch's main loop, or is not the process that did.
      const stored = ports.stored.read(launch);
      if (stored !== undefined) {
        routes.set(key, { launch, route: stored });
      }
      return stored;
    },
  };
}

/** Whether a path is a Messages API inference call (`/v1/messages` or one of its sub-resources, `count_tokens` among them): the only requests a session's model choice governs, and so the only ones that record or follow it. */
function isInferencePath(path: string): boolean {
  return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

/** What a provider does with a helper's Claude model name: serves it as it is, serves it under another name, or has no model for it and the helper is refused with the reason. */
export type HelperModel = { readonly kind: "as-is" } | { readonly kind: "mapped"; readonly model: string } | { readonly kind: "refused"; readonly message: string };

/** What `followingMainLoop` reads besides the record. */
export interface MainLoopRoutingDeps {
  readonly record: MainLoopRouteRecord;
  /** What `provider` does with a helper's requested `model`, through that provider's own tier mapping: `as-is` for a provider that serves the name as it is (a translator that maps a Claude name by tier itself) or a name that selects no tier the provider maps, `refused` for a provider that maps the name's tier but has no model for it. */
  readonly helperModel: (provider: string, session: RoutedRequest["session"], requested: string) => HelperModel;
}

/** The provider a served request target names, or undefined for a bare target (the Anthropic route, or a path the session's launch provider scoped). */
function servedProviderOf(url: string): string | undefined {
  return parseProviderPath(new URL(url, "http://127.0.0.1").pathname)?.provider;
}

/** `route` serving `rewritten` in place of whatever request the pipeline hands it: the request the helper routing chose, scoped under its provider. */
function serving(route: FrontDoorRoute, rewritten: RoutedRequest): FrontDoorRoute {
  return {
    ...route,
    serve: async (request, response) => {
      await route.serve({ ...request, url: rewritten.url, headers: rewritten.headers, body: rewritten.body }, response);
    },
  };
}

/**
 * Makes a provider-less session's helper requests follow its main loop. A session launched on a provider carries the provider header on every request, helpers included, so it routes exactly as `resolve` does. A session launched without one picks a provider by model name (`/model <provider>/<model>`), which only its main-loop requests carry: its helpers ask for a Claude model name, which no provider claims, and would otherwise reach the Anthropic account the session was launched under.
 *
 * So, for a bare Messages API request from a session that names no provider: a main-loop request (class `main`, or no class at all) is resolved as before and where it was served is recorded; any other class (`subagent`, `workflow`, `compaction`, `auxiliary`, `side_reply`, or one a later client adds) is sent where the session's latest main-loop request went. To a provider, it is scoped under that provider's path with its model name mapped through the provider's tier mapping; to the Anthropic route, it is resolved as before. With nothing recorded the session has never left the route it was launched on, so its helpers go there, which for a launch with no provider is the Anthropic route: Claude Code sends helpers (the startup quota check, a model validation) before its first main-loop request, and they belong to the launch's own account, not to a provider the session never chose.
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
    if (route === undefined || route.kind === "anthropic") {
      return await resolve(request);
    }
    // The head is all the mapping needs: the model field sits in it, and the rest of the body, a whole conversation for a compaction or a subagent, streams through unread.
    const scan = await scanRequestHead(request);
    const requested = scan.model;
    const choice: HelperModel = requested === undefined ? { kind: "as-is" } : deps.helperModel(route.provider, request.session, requested);
    if (choice.kind === "refused") {
      return { ok: false, status: HTTP_STATUS.badRequest, message: choice.message };
    }
    const replayed = scan.replayed ?? request;
    const body = choice.kind === "as-is" || requested === undefined ? replayed : withModelInHead(replayed, scan.headBytes, requested, choice.model);
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

/** The text of `value` as the bytes of its UTF-8 encoding, one character per byte, so a pattern over it matches bytes and a rewrite can be turned back into exactly the bytes it came from. */
function asBytes(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

/**
 * `request` with the model field in the first `headBytes` bytes of its body changed from `from` to `to`, and every other byte, the head's and the rest's, passed through exactly as it came: the rest streams on under the replay's backpressure and is never held. Unlike `withModel` it needs no copy of the body, which is what lets a helper that carries a whole conversation be rewritten without reading it. The framing header goes, because the new name is a different length.
 */
export function withModelInHead(request: RoutedRequest, headBytes: number, from: string, to: string): RoutedRequest {
  const pattern = new RegExp('"model"\\s*:\\s*"' + asBytes(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"');
  const rewriteHead = (head: Buffer): Buffer => Buffer.from(head.toString("latin1").replace(pattern, () => `"model":${asBytes(JSON.stringify(to))}`), "latin1");
  async function* rewritten(): AsyncGenerator<Buffer> {
    let held = Buffer.alloc(0);
    let headDone = false;
    const chunks: AsyncIterable<unknown> = request.body;
    for await (const piece of chunks) {
      if (!Buffer.isBuffer(piece)) {
        throw new TypeError("a request body chunk is not a Buffer");
      }
      if (headDone) {
        yield piece;
        continue;
      }
      held = Buffer.concat([held, piece]);
      if (held.length >= headBytes) {
        headDone = true;
        yield rewriteHead(held.subarray(0, headBytes));
        yield held.subarray(headBytes);
      }
    }
    if (!headDone) {
      yield rewriteHead(held);
    }
  }
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
  return { ...request, headers, body: Readable.from(rewritten()) };
}

/**
 * `request` with its body's model field changed from `from` to `to`, rewritten in the one copy of the body a whole-body scan holds (`text`), exactly one field changed. The framing header goes, because the new name is a different length and the forward re-frames the body itself.
 */
export function withModel(request: RoutedRequest, text: string, from: string, to: string): RoutedRequest {
  // A function replacement, so nothing in the new name is read as a replacement pattern.
  const rewritten = text.replace(new RegExp('"model"\\s*:\\s*"' + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), () => `"model":${JSON.stringify(to)}`);
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
  return { ...request, headers, body: Readable.from([Buffer.from(rewritten, "utf8")]) };
}
