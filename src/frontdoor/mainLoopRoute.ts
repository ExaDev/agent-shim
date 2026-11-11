import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { RouteResolution } from "./pipeline";
import { RequestClassSchema, type RequestClass } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, internalHeaderValue, parseProviderPath, type RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";
import { topLevelModel } from "./topLevelModel";
import { claudeNameTier } from "../models/tiers";
import { MAX_CONTEXT_TEXT_LENGTH, launchKeyOf, type FrontDoorLaunch, type MainLoopRouteStore, type RouteContext } from "./state";

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
  readonly record: (launch: Readonly<FrontDoorLaunch>, route: RouteContext) => void;
  /** Where `launch`'s latest main-loop request was served, or undefined when none has been recorded. */
  readonly routeOf: (launch: Readonly<FrontDoorLaunch>) => RouteContext | undefined;
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

/** Whether two contexts say the same: the same route and the same credential and model names, so a context is written again only when one of them changed. */
function sameContext(a: RouteContext, b: RouteContext): boolean {
  return a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.provider === b.provider)) && a.credential === b.credential && a.requestedModel === b.requestedModel && a.servedModel === b.servedModel;
}

/**
 * Builds the record, bounded by the door's session registry: an entry lives exactly as long as the registry holds its launch. A launch's entry is dropped when a later write or first lookup of another launch finds it ended, so the record never holds more launches than the registry did since then, and a launch is only ever named by a request that presented its live capability.
 *
 * A lookup reads the durable copy once and keeps the answer, a miss included, and then watches the copy's identity (its modification time and size, one stat per lookup, on the door's thread) instead of re-reading it: a copy another door rewrote, as the door replacing this one does while this one drains, changes identity, and only then is it read again. A route this door wrote or has in memory unwritten is its own and is not compared. A copy that exists and cannot be read (corrupt, or written by a newer door) is reported and counts as a miss until its identity changes. An identity the store cannot tell (no file, or a stat that failed) never forces a read. A copy that failed to write is retried on the next lookup as well as the next write, one attempt each, so a helper does not wait for a main-loop request to see the store mended.
 */
export function createMainLoopRouteRecord(ports: MainLoopRoutePorts): MainLoopRouteRecord {
  // `route` is undefined for a cached miss. `persisted` is what the durable copy holds, which differs from `route` after a failed write and until a later write succeeds. `identity` is the copy's identity when this door last wrote or read it.
  interface Entry {
    readonly launch: FrontDoorLaunch;
    readonly route: RouteContext | undefined;
    readonly persisted: RouteContext | undefined;
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
  const persist = (launch: Readonly<FrontDoorLaunch>, key: string, route: RouteContext, persisted: RouteContext | undefined): RouteContext | undefined => {
    if (persisted !== undefined && sameContext(persisted, route)) {
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
    let stored: RouteContext | undefined;
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
      const written = persisted !== undefined && sameContext(persisted, route) && (before?.persisted === undefined || !sameContext(before.persisted, route));
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
      if (entry.route !== undefined && (entry.persisted === undefined || !sameContext(entry.persisted, entry.route))) {
        // This door's own main loop is newer than the copy, which it could not write: it keeps its route and tries the write again.
        const persisted = persist(launch, key, entry.route, entry.persisted);
        const written = persisted !== undefined && sameContext(persisted, entry.route);
        routes.set(key, { ...entry, persisted, identity: written ? ports.stored.identity(launch) : entry.identity });
        return entry.route;
      }
      // An identity that cannot be told (undefined: no file, or a stat that failed) is never a reason to read, so a stat that keeps failing cannot turn every helper into a read.
      const current = ports.stored.identity(launch);
      if (current !== undefined && current !== entry.identity) {
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

/** What a provider does with a Claude model name a session asks for while its main loop is on that provider: serves it as it is, serves it under another name, or has no model for it and the request is refused with the reason. */
export type MappedModel = { readonly kind: "as-is" } | { readonly kind: "mapped"; readonly model: string } | { readonly kind: "refused"; readonly message: string };

/** The route a context names, without the facts about it. */
type RouteOf = { readonly kind: "anthropic" } | { readonly kind: "provider"; readonly provider: string };

/** What `followingMainLoop` reads besides the record. */
export interface MainLoopRoutingDeps {
  readonly record: MainLoopRouteRecord;
  /** What `provider` does with a requested Claude `model`, through that provider's own tier mapping, and the credential it uses, from the provider's file read once for this request: `as-is` for a provider that serves the name as it is (a translator that maps a Claude name by tier itself, or an `http` provider whose `env` names no model for the tier and that has no default model to serve it by) or a name that selects no tier, `refused` for a provider that routes by name and has no model for the tier. The credential is named by what describes it (a variable name, a path, a program, a reference, a Keychain service), never by its value, and is undefined when the provider has none to name. */
  readonly providerMapping: (provider: string, session: RoutedRequest["session"], requested: string) => { readonly model: MappedModel; readonly credential: string | undefined };
  /** The login the Anthropic route uses for `session`, by name: the identity whose login it is, or the launch's own. */
  readonly loginOf: (session: RoutedRequest["session"]) => string;
  /** Whether a provider file defines `name`: `anthropic/<model>` names the Anthropic route only when no provider is called `anthropic`. */
  readonly definesProvider: (name: string) => boolean;
}

/** The provider a served request target names, or undefined for a bare target (the Anthropic route, or a path the session's launch provider scoped). */
function servedProviderOf(url: string): string | undefined {
  return parseProviderPath(new URL(url, "http://127.0.0.1").pathname)?.provider;
}

/** The prefix by which a person selects an Anthropic model by name once their session is on a provider: `/model anthropic/claude-sonnet-5-5`. */
const ANTHROPIC_PREFIX = "anthropic/";

/** Whether a model name is a bare Claude name (`claude-sonnet-5-5`, `opus`): one that selects a tier and names no provider. */
function isBareClaudeName(model: string): boolean {
  return !model.includes("/") && claudeNameTier(model) !== undefined;
}

/** The text of a model or credential name, or none when it is too long to keep in the context: a name is a fact about the route, never worth a rejected file. */
function boundedName(text: string | undefined): string | undefined {
  return text === undefined || text === "" || text.length > MAX_CONTEXT_TEXT_LENGTH ? undefined : text;
}

/**
 * Decides, from the route context of a provider-less session, where each of its inference requests goes, and keeps the context current. A session launched on a provider carries the provider header on every request and routes exactly as `resolve` does. A session launched without one picks a provider by model name (`/model <provider>/<model>`), after which its context names that provider; the context is where the Anthropic route is chosen too (the launch default, or `/model anthropic/<model>`).
 *
 * The one decision, for every request class: a bare Claude model name (`claude-sonnet-5-5`, `opus`), which no provider claims, follows the context. On a provider it is sent to that provider under the provider's own tier mapping, so the main loop and every helper (hook judge, title, compaction summary, subagent, side reply) reach the provider the session switched to, and none of them the Anthropic account the session was launched under. On the Anthropic route it goes there as it is. A provider that maps no model for the tier serves the name as asked or, if it routes by name, refuses it with the reason; the launch's account is never the fallback. A name that carries its own route (a qualified name, a virtual model, a family, `anthropic/<model>`) decides the route itself.
 *
 * A main-loop request (class `main`, or no class at all, and no agent id) is resolved first, and where it was served is recorded with the credential and model names; one the resolver left on the Anthropic route is placed by the context as above. Any other class is placed by the context without resolving first. With no context the session has never left the route it was launched on, so its requests go there: Claude Code sends helpers (the startup quota check, a model validation) before its first main-loop request, and they belong to the launch's own account.
 */
export function followingMainLoop(resolve: (request: RoutedRequest) => Promise<RouteResolution>, deps: MainLoopRoutingDeps): (request: RoutedRequest) => Promise<RouteResolution> {
  /** The context recorded for a request served on `route`, with the facts about it. */
  const contextOf = (route: RouteOf, credentialName: string | undefined, requested: string | undefined, served: string | undefined): RouteContext => {
    const credential = boundedName(credentialName);
    const facts = { ...(credential === undefined ? {} : { credential }), ...(boundedName(requested) === undefined ? {} : { requestedModel: boundedName(requested) }), ...(boundedName(served) === undefined ? {} : { servedModel: boundedName(served) }) };
    return { ...route, ...facts };
  };

  /** `base` placed on the Anthropic route under its bare model name, for a request that asked for `requested` as `anthropic/<model>`. */
  const toAnthropic = async (base: RoutedRequest, requested: string): Promise<{ readonly resolution: RouteResolution; readonly served: string }> => {
    const served = requested.slice(ANTHROPIC_PREFIX.length);
    const scan = await scanRequestHead(base);
    const rewritten = withModelInHead(scan.replayed, scan.headBytes, requested, served);
    const resolution = await resolve({ ...rewritten, url: base.url });
    return { resolution: resolution.ok ? { ...resolution, requestedModel: requested } : resolution, served };
  };

  /** `base` placed on `provider`, scoped under its path, with its model name mapped through the provider's tier mapping; the head is all the mapping needs, and the rest of the body, a whole conversation for a compaction or a subagent, streams through unread. */
  const toProvider = async (base: RoutedRequest, provider: string, session: RoutedRequest["session"]): Promise<{ readonly resolution: RouteResolution; readonly requested: string | undefined; readonly served: string | undefined; readonly credential: string | undefined }> => {
    // A body already read to its end (an empty one the resolver scanned) has no head to read again and nothing to rewrite.
    const scan = base.body.readableEnded ? { model: undefined, headBytes: 0, replayed: undefined } : await scanRequestHead(base);
    const requested = scan.model;
    const { model: choice, credential } = deps.providerMapping(provider, session, requested ?? "");
    if (choice.kind === "refused") {
      return { resolution: { ok: false, status: HTTP_STATUS.badRequest, message: choice.message }, requested, served: undefined, credential };
    }
    const replayed = scan.replayed ?? base;
    const body = choice.kind === "as-is" || requested === undefined ? replayed : withModelInHead(replayed, scan.headBytes, requested, choice.model);
    const scoped: RoutedRequest = { ...body, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}${base.url}` };
    const resolution = await resolve(scoped);
    if (!resolution.ok) {
      return { resolution, requested, served: undefined, credential };
    }
    // The pipeline serves and hops with the request it received, which names no provider, unless the resolution carries the request it served: the provider resolver always does for the body-carrying request this is, and a resolver that does not breaks the contract this routing stands on, so it is refused rather than served the unscoped request.
    if (resolution.request === undefined) {
      return { resolution: { ok: false, status: HTTP_STATUS.internalServerError, message: "the provider resolver served a request without saying which request it served" }, requested, served: undefined, credential };
    }
    return { resolution: { ...resolution, request: resolution.request, ...(requested === undefined ? {} : { requestedModel: requested }) }, requested, served: choice.kind === "mapped" ? choice.model : requested, credential };
  };

  return async (request) => {
    const { launch, provider } = request.session;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (launch === undefined || provider !== undefined || !isInferencePath(path)) {
      return await resolve(request);
    }
    const requestClass = requestClassOf(request.headers);
    const current = deps.record.routeOf(launch);
    if (requestClass !== undefined && requestClass !== MAIN_REQUEST_CLASS) {
      // A helper is placed by the context before anything resolves it.
      const scan = await scanRequestHead(request);
      const helper = scan.replayed;
      if (scan.model?.startsWith(ANTHROPIC_PREFIX) === true && !deps.definesProvider("anthropic")) {
        return (await toAnthropic(helper, scan.model)).resolution;
      }
      if (current === undefined || current.kind === "anthropic") {
        return await resolve(helper);
      }
      return (await toProvider(helper, current.provider, request.session)).resolution;
    }
    const resolution = await resolve(request);
    if (!resolution.ok) {
      return resolution;
    }
    const requested = resolution.requestedModel;
    const served = servedProviderOf(resolution.request?.url ?? request.url);
    if (served === undefined) {
      // The resolver left the request on the Anthropic route, which a request that chose it by `anthropic/<model>` is entitled to; any other goes where the context says. Under a provider context that is the provider, whatever the request names (a name no provider claims and that is no Claude name, a name with a typo, no model at all, a body that is no JSON): it is served as asked, and never by the launch's account.
      const base = resolution.request ?? request;
      if (requested?.startsWith(ANTHROPIC_PREFIX) === true && !deps.definesProvider("anthropic")) {
        const placed = await toAnthropic(base, requested);
        if (placed.resolution.ok) {
          deps.record.record(launch, contextOf({ kind: "anthropic" }, deps.loginOf(request.session), requested, placed.served));
        }
        return placed.resolution;
      }
      if (current?.kind === "provider") {
        const placed = await toProvider(base, current.provider, request.session);
        // Only a Claude name asked for on the main loop is a fact about it worth recording, and the route stays what it was: a request that chose no route moves nothing.
        if (placed.resolution.ok && requested !== undefined && isBareClaudeName(requested)) {
          deps.record.record(launch, contextOf({ kind: "provider", provider: current.provider }, placed.credential, requested, placed.served));
        }
        return placed.resolution;
      }
    }
    // Served where the resolver put it. A virtual model's or a family's served name is the member's, which the resolution does not carry, so only a model the resolution says it served (a qualified name, a bare provider name's default, the live model of `auto`) or an unchanged name is recorded as served.
    const route: RouteOf = served === undefined ? { kind: "anthropic" } : { kind: "provider", provider: served };
    const qualified = served !== undefined && requested?.startsWith(`${served}/`) === true ? requested.slice(served.length + 1) : undefined;
    const servedModel = resolution.servedModel ?? qualified ?? (served === undefined ? requested : undefined);
    // The credential is named from the provider's file as read for this request, which is read for every request anyway, so an edited credential block shows its new name at the next one.
    const credential = served === undefined ? deps.loginOf(request.session) : deps.providerMapping(served, request.session, "").credential;
    deps.record.record(launch, contextOf(route, credential, requested, servedModel));
    return resolution;
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
  // The head's bytes viewed one character each: `topLevelModel` looks only at ASCII structure, so the offsets it finds are byte offsets.
  const rewriteHead = (head: Buffer): Buffer => {
    const text = head.toString("latin1");
    const found = topLevelModel(text);
    return found?.value === asBytes(from) ? Buffer.from(`${text.slice(0, found.start)}${asBytes(JSON.stringify(to))}${text.slice(found.end)}`, "latin1") : head;
  };
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
  const found = topLevelModel(text);
  const rewritten = found?.value === from ? `${text.slice(0, found.start)}${JSON.stringify(to)}${text.slice(found.end)}` : text;
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
  return { ...request, headers, body: Readable.from([Buffer.from(rewritten, "utf8")]) };
}
