import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { RouteResolution } from "./pipeline";
import { RequestClassSchema, type RequestClass } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, internalHeaderValue, parseProviderPath, type RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";
import { launchKeyOf, type FrontDoorLaunch, type MainLoopRoute, type MainLoopRouteStore } from "./state";

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
 * The request's class as the client stated it: one of the classes Claude Code sends, `unknown` for any other value (a repeated header, which Node joins into one string, included, so a client-chosen string is neither logged nor echoed). A request that carries an agent id is never the main loop, whatever class it states, because Claude Code attaches the id to every request made from a non-main agent context: stated as `main` it is `subagent`, the class Claude Code gives an agent's own requests, so it follows the main loop and never moves it, and with no class stated it is `subagent` as well. Any other stated class stands. With neither a class nor an agent id the request is undefined, which is the main loop's. An empty agent id is no agent id. The headers are found whatever their case, like every internal header.
 */
export function requestClassOf(headers: Readonly<IncomingHttpHeaders>): RequestClass | undefined {
  const agentId = internalHeaderValue(headers, AGENT_ID_HEADER);
  const hasAgentId = agentId !== undefined && agentId !== "";
  const value = internalHeaderValue(headers, REQUEST_CLASS_HEADER);
  if (value === undefined) {
    return hasAgentId ? "subagent" : undefined;
  }
  const parsed = RequestClassSchema.safeParse(value);
  const stated: RequestClass = parsed.success ? parsed.data : "unknown";
  return hasAgentId && stated === MAIN_REQUEST_CLASS ? "subagent" : stated;
}

/**
 * What the door remembers about each launch's main loop: where its most recent main-loop request was served, so the launch's helper requests (hook judges, titles, compaction summaries, subagents, side replies) follow it there. Keyed on the launch (its pid and start time) that the request's capability identifies, never on the session id: a `--resume` or an account-move relaunch carries the same session id, and two launches can be live under one id (`--resume` or `--continue` twice in one directory), each with its own main loop. Persisted beside the launch's registry record, so a restarted or replacing door keeps a session's helpers on the provider its main loop is on.
 */
export interface MainLoopRouteRecord {
  /** Records where `launch`'s latest main-loop request was served. */
  readonly record: (launch: Readonly<FrontDoorLaunch>, route: MainLoopRoute) => void;
  /** Where `launch`'s latest main-loop request was served, or undefined when none has been recorded. */
  readonly routeOf: (launch: Readonly<FrontDoorLaunch>) => MainLoopRoute | undefined;
}

/** What `createMainLoopRouteRecord` reads the registry through. */
export interface MainLoopRoutePorts {
  /** Whether a launch is still registered. */
  readonly holdsLaunch: (launch: Readonly<FrontDoorLaunch>) => boolean;
  /** The durable copy, which lives and dies with the launch's registry entry: where a launch's main loop last went, as an earlier door process wrote it. */
  readonly stored: MainLoopRouteStore;
  /** Where a failure of the durable copy is reported: the record is best-effort state, so a failed write never reaches the request that recorded it. */
  readonly log: (line: string) => void;
}

/** Whether two routes name the same destination. */
function sameRoute(a: MainLoopRoute, b: MainLoopRoute): boolean {
  return a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.provider === b.provider));
}

/**
 * Builds the record, bounded by the door's session registry: an entry lives exactly as long as the registry holds its launch. A launch's entry is dropped when a later write or first lookup of another launch finds it ended, so the record never holds more launches than the registry did since then, and a launch is only ever named by a request that presented its live capability.
 *
 * A lookup reads the durable copy once and keeps the answer, a miss included, and then watches the copy's identity (its modification time and size, one stat per lookup, on the door's thread) instead of re-reading it: a copy another door rewrote, as the door replacing this one does while this one drains, changes identity, and only then is it read again. A route this door wrote or has in memory unwritten is its own and is not compared. A copy that exists and cannot be read (corrupt, or written by a newer door) is reported and counts as a miss until its identity changes. A copy that failed to write is retried on the next lookup as well as the next write, one attempt each, so a helper does not wait for a main-loop request to see the store mended.
 */
export function createMainLoopRouteRecord(ports: MainLoopRoutePorts): MainLoopRouteRecord {
  // `route` is undefined for a cached miss. `persisted` is what the durable copy holds, which differs from `route` after a failed write and until a later write succeeds. `identity` is the copy's identity when this door last wrote or read it.
  interface Entry {
    readonly launch: FrontDoorLaunch;
    readonly route: MainLoopRoute | undefined;
    readonly persisted: MainLoopRoute | undefined;
    readonly identity: string | undefined;
  }
  const routes = new Map<string, Entry>();
  // The launches whose durable copy failed to write, so a store that keeps failing is reported once per launch until a write succeeds, not once per request. A failure to read is reported once per identity of the copy by the read itself.
  const failed = new Set<string>();
  const dropEnded = (except: string): void => {
    for (const [held, entry] of routes) {
      if (held !== except && !ports.holdsLaunch(entry.launch)) {
        routes.delete(held);
        failed.delete(held);
      }
    }
  };
  // Writes `route` when the durable copy differs from it, and returns what the copy holds afterwards: a failed write leaves it as it was, to be tried again.
  const persist = (launch: Readonly<FrontDoorLaunch>, key: string, route: MainLoopRoute, persisted: MainLoopRoute | undefined): MainLoopRoute | undefined => {
    if (persisted !== undefined && sameRoute(persisted, route)) {
      return persisted;
    }
    try {
      ports.stored.write(launch, route);
      failed.delete(key);
      return route;
    } catch (error) {
      if (!failed.has(key)) {
        failed.add(key);
        ports.log(`front door: could not record where launch ${String(launch.pid)}'s main loop went, so a door restart would send its helpers to the route last stored: ${error instanceof Error ? error.message : String(error)}`);
      }
      return persisted;
    }
  };
  // Reads the durable copy afresh, reporting one that cannot be read and counting it as a miss.
  const load = (launch: Readonly<FrontDoorLaunch>): Entry => {
    // The identity is taken before the read, so a copy rewritten in between is read again at the next lookup, never missed.
    const identity = ports.stored.identity(launch);
    let stored: MainLoopRoute | undefined;
    try {
      stored = ports.stored.read(launch);
    } catch (error) {
      ports.log(`front door: could not read where launch ${String(launch.pid)}'s main loop went (${error instanceof Error ? error.message : String(error)}), so its helpers go the route the launch was launched on until its next main-loop request`);
    }
    return { launch, route: stored, persisted: stored, identity };
  };
  return {
    record: (launch, route) => {
      const key = launchKeyOf(launch);
      dropEnded(key);
      // Written only when the durable copy differs: the main loop's every request records, and the route rarely moves.
      const before = routes.get(key);
      const persisted = persist(launch, key, route, before?.persisted);
      const written = persisted !== undefined && sameRoute(persisted, route) && (before?.persisted === undefined || !sameRoute(before.persisted, route));
      routes.set(key, { launch, route, persisted, identity: written ? ports.stored.identity(launch) : before?.identity });
    },
    routeOf: (launch) => {
      const key = launchKeyOf(launch);
      const entry = routes.get(key);
      if (entry === undefined) {
        // Nothing in memory: this door has not served the launch's main loop, or is not the process that did.
        dropEnded(key);
        const loaded = load(launch);
        routes.set(key, loaded);
        return loaded.route;
      }
      if (entry.route !== undefined && (entry.persisted === undefined || !sameRoute(entry.persisted, entry.route))) {
        // This door's own main loop is newer than the copy, which it could not write: it keeps its route and tries the write again.
        const persisted = persist(launch, key, entry.route, entry.persisted);
        const written = persisted !== undefined && sameRoute(persisted, entry.route);
        routes.set(key, { ...entry, persisted, identity: written ? ports.stored.identity(launch) : entry.identity });
        return entry.route;
      }
      if (ports.stored.identity(launch) !== entry.identity) {
        const loaded = load(launch);
        routes.set(key, loaded);
        return loaded.route;
      }
      return entry.route;
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

/**
 * Makes a provider-less session's helper requests follow its main loop. A session launched on a provider carries the provider header on every request, helpers included, so it routes exactly as `resolve` does. A session launched without one picks a provider by model name (`/model <provider>/<model>`), which only its main-loop requests carry: its helpers ask for a Claude model name, which no provider claims, and would otherwise reach the Anthropic account the session was launched under.
 *
 * So, for a bare Messages API request from a session that names no provider: a main-loop request (class `main`, or no class at all) is resolved as before and where it was served is recorded; any other class (`subagent`, `workflow`, `compaction`, `auxiliary`, `side_reply`, or one a later client adds) is sent where the session's latest main-loop request went. To a provider, it is scoped under that provider's path with its model name mapped through the provider's tier mapping; to the Anthropic route, it is resolved as before. With nothing recorded the session has never left the route it was launched on, so its helpers go there, which for a launch with no provider is the Anthropic route: Claude Code sends helpers (the startup quota check, a model validation) before its first main-loop request, and they belong to the launch's own account, not to a provider the session never chose.
 */
export function followingMainLoop(resolve: (request: RoutedRequest) => Promise<RouteResolution>, deps: MainLoopRoutingDeps): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    const { launch, provider } = request.session;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (launch === undefined || provider !== undefined || !isInferencePath(path)) {
      return await resolve(request);
    }
    const requestClass = requestClassOf(request.headers);
    if (requestClass === undefined || requestClass === MAIN_REQUEST_CLASS) {
      const resolution = await resolve(request);
      if (resolution.ok) {
        const served = servedProviderOf(resolution.request?.url ?? request.url);
        deps.record.record(launch, served === undefined ? { kind: "anthropic" } : { kind: "provider", provider: served });
      }
      return resolution;
    }
    const route = deps.record.routeOf(launch);
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
    // The pipeline serves and hops with the request it received, which names no provider, unless the resolution carries the request it served: the provider resolver always does for the body-carrying request a helper is, and a resolver that does not breaks the contract this routing stands on, so it is refused rather than served the unscoped request.
    if (resolution.request === undefined) {
      return { ok: false, status: HTTP_STATUS.internalServerError, message: "the provider resolver served a helper request without saying which request it served" };
    }
    return { ...resolution, request: resolution.request, ...(requested === undefined ? {} : { requestedModel: requested }) };
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
