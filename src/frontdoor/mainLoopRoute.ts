import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { RouteResolution, ServedModelReport } from "./pipeline";
import { RequestClassSchema, type RequestClass } from "../usage/schema";
import { AUTO_MODEL } from "../models/reservedModelNames";
import { PROVIDER_PATH_PREFIX, internalHeaderValue, parseProviderPath, type RoutedRequest } from "./route";
import { abandonBody } from "./cappedBody";
import { declaredLength, withoutContentLength } from "./contentLength";
import { REQUEST_SCAN_CAP_BYTES, type RequestScan, scanRequestHead } from "./requestScan";
import { isMessagesInferencePath, isMessagesRequest } from "./messagesBodyLimit";
import { AMBIGUOUS_MODEL_MESSAGE, topLevelModel } from "./topLevelModel";
import { withoutContextMarker } from "../models/identity";
import { claudeNameTier, isBareClaudeName } from "../models/tiers";
import type { ClaudeTier } from "../config/schema";
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
  /** Records where `launch`'s latest main-loop request was served; a launch that is not registered records nothing. */
  readonly record: (launch: Readonly<FrontDoorLaunch>, route: RouteContext, ticket?: number) => void;
  /** Starts a main-loop request of `launch`: the ticket it records under. Tickets rise in the order requests start, and a record under a ticket lower than the latest one recorded is dropped, so a request that started earlier and finishes later never overwrites a newer request's context. */
  readonly begin: (launch: Readonly<FrontDoorLaunch>) => number;
  /** Where `launch`'s latest main-loop request was served, or undefined when none has been recorded. */
  readonly routeOf: (launch: Readonly<FrontDoorLaunch>) => RouteContext | undefined;
  /** Notes a bare Claude model name `launch` sent (main loop or helper): the model id its Claude Code resolved that name's tier to, which is what `/model <tier>` would send. A launch that is not registered notes nothing. */
  readonly noteClaudeName: (launch: Readonly<FrontDoorLaunch>, model: string) => void;
  /** The Claude model id `launch` last sent for `tier`, or undefined when it has sent none this door saw. Held in memory only: a door that replaced the one that saw it starts with none. */
  readonly claudeNameOf: (launch: Readonly<FrontDoorLaunch>, tier: ClaudeTier) => string | undefined;
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
  return a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.provider === b.provider)) && a.credential === b.credential && a.requestedModel === b.requestedModel && a.servedModel === b.servedModel && a.movedBy === b.movedBy;
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
  // `issued` holds the latest ticket handed out for each launch, with the launch it was handed to (which is what tells that it has ended): its entry appears when the launch's first request begins, before any route is recorded. `recordedUnder` holds the latest ticket a route was recorded under: its entry appears at the first record, so a launch whose requests all began and none recorded has no entry. Both go together, when a request of another launch finds the launch no longer registered.
  const issued = new Map<string, { readonly launch: FrontDoorLaunch; readonly ticket: number }>();
  const recordedUnder = new Map<string, number>();
  // The launches whose durable copy failed to write, so a store that keeps failing is reported once per launch until a write succeeds, not once per request. A failure to read is reported once per identity of the copy by the read itself.
  const failed = new Set<string>();
  // The Claude model id each launch last sent per tier, bounded like the routes: a launch's entry goes when it is no longer registered.
  const claudeNames = new Map<string, { readonly launch: FrontDoorLaunch; readonly byTier: Map<ClaudeTier, string> }>();
  const dropEnded = (except: string): void => {
    for (const [held, entry] of claudeNames) {
      if (held !== except && !ports.holdsLaunch(entry.launch)) {
        claudeNames.delete(held);
      }
    }
    for (const [held, entry] of routes) {
      if (held !== except && !ports.holdsLaunch(entry.launch)) {
        routes.delete(held);
        failed.delete(held);
      }
    }
    for (const [held, entry] of issued) {
      if (held !== except && !ports.holdsLaunch(entry.launch)) {
        issued.delete(held);
        recordedUnder.delete(held);
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
    noteClaudeName: (launch, model) => {
      // A name with a provider part is no id the session's Claude Code resolved a tier to, even one whose last part reads as a Claude name (`claude-haiku-5-5/x`).
      const tier = isBareClaudeName(model) ? claudeNameTier(model) : undefined;
      if (tier === undefined || !ports.holdsLaunch(launch)) {
        return;
      }
      const key = launchKeyOf(launch);
      dropEnded(key);
      const entry = claudeNames.get(key) ?? { launch: { pid: launch.pid, startedAt: launch.startedAt }, byTier: new Map<ClaudeTier, string>() };
      // A bare tier alias (`sonnet`) names no model id, so it is never what a tier resolves to.
      const id = withoutContextMarker(model);
      if (id.toLowerCase() !== tier) {
        entry.byTier.set(tier, id);
      }
      claudeNames.set(key, entry);
    },
    claudeNameOf: (launch, tier) => claudeNames.get(launchKeyOf(launch))?.byTier.get(tier),
    begin: (launch) => {
      const key = launchKeyOf(launch);
      dropEnded(key);
      const ticket = (issued.get(key)?.ticket ?? 0) + 1;
      issued.set(key, { launch: { pid: launch.pid, startedAt: launch.startedAt }, ticket });
      return ticket;
    },
    record: (launch, route, ticket) => {
      // A launch that has ended holds no slot: a late write, such as the report of a request that outlived it, must not make an entry or a context file for it.
      if (!ports.holdsLaunch(launch)) {
        return;
      }
      const key = launchKeyOf(launch);
      dropEnded(key);
      if (ticket !== undefined) {
        if (ticket < (recordedUnder.get(key) ?? 0)) {
          return;
        }
        recordedUnder.set(key, ticket);
      }
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
  /** Replaces a Messages request's model name with the one it is routed by before anything else reads it (a selector's expansion, a route override's target), or leaves it, for a body no longer than `bodyLimitBytes` declares (a body that declares more is left to the resolver, which refuses it before reading any of it). Absent, no name is replaced. */
  readonly rename?: { readonly model: RenameModel; readonly bodyLimitBytes: number };
}

/** What a renaming knows of the request whose model it may replace. */
export interface RenameContext {
  readonly session: RoutedRequest["session"];
  /** Whether the request is the main loop's (class `main`, or no class and no agent id). */
  readonly main: boolean;
  /** Whether the request's path names no provider: the session's own request, as against one a routing layer or the headroom hop scoped. */
  readonly unscoped: boolean;
  /** The provider the request would reach before any renaming: the launch's own, else the provider the launch's main loop was last served on; undefined on the Anthropic route. Asked only when needed, since it reads the route context. */
  readonly routeProvider: () => string | undefined;
  /** The Claude model id this launch last sent for a tier (see `MainLoopRouteRecord.claudeNameOf`), which a class on the Anthropic route is sent as. */
  readonly claudeNameOf: (tier: ClaudeTier) => string | undefined;
}

/** Replaces one model name: the name to route by, a refusal the request is answered with (a 400), or undefined to leave the name as it is. */
export type RenameModel = (model: string, context: Readonly<RenameContext>) => { readonly name: string; /** Set when a route override, not the request's own name, chose the name: what the context records as the reason the main loop moved. */ readonly overridden?: true } | { readonly refusal: string } | undefined;

/** The provider a served request target names, or undefined for a bare target (the Anthropic route, or a path the session's launch provider scoped). */
function servedProviderOf(url: string): string | undefined {
  return parseProviderPath(new URL(url, "http://127.0.0.1").pathname)?.provider;
}

/** The provider part that names the Anthropic route in a qualified name, unless a provider file of that name claims it. */
export const ANTHROPIC_ROUTE_NAME = "anthropic";
/** The prefix by which a person selects an Anthropic model by name once their session is on a provider: `/model anthropic/claude-sonnet-5-5`. */
export const ANTHROPIC_PREFIX = `${ANTHROPIC_ROUTE_NAME}/`;

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
  const contextOf = (route: RouteOf, credentialName: string | undefined, requested: string | undefined, served: string | undefined, overridden = false): RouteContext => {
    const credential = boundedName(credentialName);
    const facts = { ...(credential === undefined ? {} : { credential }), ...(boundedName(requested) === undefined ? {} : { requestedModel: boundedName(requested) }), ...(boundedName(served) === undefined ? {} : { servedModel: boundedName(served) }), ...(overridden ? { movedBy: "override" as const } : {}) };
    return { ...route, ...facts };
  };

  /**
   * Records the context of a main-loop request served by `resolution` under the request's `ticket`, and keeps it true of what the route finally sends: a route that learns the model it sends only when it serves (the model `auto` read from the server's list, a retry under the model a refreshed list names) reports it through `resolution.servedModelReport`, and the context is recorded again with it. Every record goes under the ticket the request took when it started, so neither a late report nor a request that finishes late overwrites the context of a request that started after it, and a launch that has ended records nothing. Every main-loop record of a request that can send a model through the editing wrapper goes through here, so none can be left reporting to nobody.
   */
  const recordServing = (launch: Readonly<FrontDoorLaunch>, ticket: number, resolution: Readonly<{ readonly servedModelReport?: ServedModelReport }>, contextFor: (servedModel: string | undefined) => RouteContext, servedModel: string | undefined): void => {
    deps.record.record(launch, contextFor(servedModel), ticket);
    if (resolution.servedModelReport !== undefined) {
      resolution.servedModelReport.listener = (sent) => {
        deps.record.record(launch, contextFor(sent), ticket);
      };
    }
  };

  /** The model a provider route is recorded as sent before the route has reported one: `auto` asks the server to name the model, so it is no model that was sent, and nothing is recorded until the route says which. */
  const unlessAuto = (model: string | undefined): string | undefined => (model === AUTO_MODEL ? undefined : model);

  /** `base` placed on the Anthropic route under its bare model name, for a request that asked for `requested` as `anthropic/<model>`. */
  const toAnthropic = async (base: RoutedRequest, requested: string): Promise<{ readonly resolution: RouteResolution; readonly served: string }> => {
    const served = requested.slice(ANTHROPIC_PREFIX.length);
    // The rewrite below changes only the first of two model fields, so the head is inspected for a second one first: this site always rewrites, so it always inspects those bytes (the whole body when it ends sooner).
    const found = await scanRequestHead(base);
    const scan = await scanRequestHead(found.replayed, false, REQUEST_SCAN_CAP_BYTES);
    if (scan.hasSeveralModelFields()) {
      return { resolution: { ok: false, status: HTTP_STATUS.badRequest, message: AMBIGUOUS_MODEL_MESSAGE }, served };
    }
    const rewritten = withModelInHead(scan.replayed, scan.headBytes, requested, served);
    const resolution = await resolve({ ...rewritten, url: base.url });
    return { resolution: resolution.ok ? { ...resolution, requestedModel: requested } : resolution, served };
  };

  /** `base` placed on `provider`, scoped under its path, with its model name mapped through the provider's tier mapping; the head is all the mapping needs, and the rest of the body, a whole conversation for a compaction or a subagent, streams through unread. */
  const toProvider = async (base: RoutedRequest, provider: string, session: RoutedRequest["session"]): Promise<{ readonly resolution: RouteResolution; readonly requested: string | undefined; readonly served: string | undefined; readonly credential: string | undefined }> => {
    // Only a Messages request carries a model to map, and only its head is read: any other request on a Messages sub-resource (a batch, its results, a listing, a GET) is placed on the provider with its body untouched, as it arrived. A body already read to its end (an empty one the resolver scanned) has no head to read again and nothing to rewrite.
    const carriesModel = isMessagesRequest(base.method, new URL(base.url, "http://127.0.0.1").pathname);
    const scan: RequestScan = base.body.readableEnded || !carriesModel ? { model: undefined, headBytes: 0, hasSeveralModelFields: () => false, replayed: undefined } : await scanRequestHead(base);
    const requested = scan.model;
    const { model: choice, credential } = deps.providerMapping(provider, session, requested ?? "");
    if (choice.kind === "refused") {
      return { resolution: { ok: false, status: HTTP_STATUS.badRequest, message: choice.message }, requested, served: undefined, credential };
    }
    // A request that is forwarded as it is never waits for more of its body than the scan needed to find its model. A rewrite changes only the first of two model fields, so before it the head is inspected for a second one: only a rewrite waits for those bytes, and a request that names the field twice is refused where it would be rewritten.
    const rewriting = choice.kind === "mapped" && requested !== undefined;
    const inspected = rewriting && scan.replayed !== undefined ? await scanRequestHead(scan.replayed, false, REQUEST_SCAN_CAP_BYTES) : scan;
    if (rewriting && inspected.hasSeveralModelFields()) {
      return { resolution: { ok: false, status: HTTP_STATUS.badRequest, message: AMBIGUOUS_MODEL_MESSAGE }, requested, served: undefined, credential };
    }
    const replayed = inspected.replayed ?? base;
    const body = choice.kind === "as-is" || requested === undefined ? replayed : withModelInHead(replayed, inspected.headBytes, requested, choice.model);
    const scoped: RoutedRequest = { ...body, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}${base.url}` };
    const resolution = await resolve(scoped);
    if (!resolution.ok) {
      return { resolution, requested, served: undefined, credential };
    }
    // The pipeline serves and hops with the request it received, which names no provider, unless the resolution carries the request it served: the provider resolver always does, for a request whose body it scanned (the replay) and for any other (the scoped request, its body untouched), and a resolver that does not breaks the contract this routing stands on, so it is refused rather than served the unscoped request.
    if (resolution.request === undefined) {
      return { resolution: { ok: false, status: HTTP_STATUS.internalServerError, message: "the provider resolver served a request without saying which request it served" }, requested, served: undefined, credential };
    }
    return { resolution: { ...resolution, request: resolution.request, ...(requested === undefined ? {} : { requestedModel: requested }) }, requested, served: choice.kind === "mapped" ? choice.model : requested, credential };
  };

  /**
   * `request` with its model renamed by `deps.rename`, and the name it asked for, when the rename replaced it: only a Messages request carries a model, and only its head is read and rewritten, the rest streaming through unread. A request that names the model field twice is refused where it would be rewritten, since only the first field would change. A request the rename leaves alone goes on as the scan's replay, its bytes as they came.
   */
  const renamed = async (request: RoutedRequest, rename: RenameModel, bodyLimitBytes: number): Promise<{ readonly request: RoutedRequest; readonly asked?: string; readonly overridden?: true } | { readonly refused: RouteResolution }> => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    // A body that declares more than the limit is refused by the resolver from its declared length before any of it is read, so it is not read here either.
    if (!isMessagesRequest(request.method, path) || declaredLength(request.headers) > bodyLimitBytes) {
      return { request };
    }
    const found = await scanRequestHead(request);
    const asked = found.model;
    const requestClass = requestClassOf(request.headers);
    const { launch } = request.session;
    if (launch !== undefined && asked !== undefined) {
      deps.record.noteClaudeName(launch, asked);
    }
    const decided = asked === undefined ? undefined : rename(asked, {
      session: request.session,
      main: requestClass === undefined || requestClass === MAIN_REQUEST_CLASS,
      unscoped: parseProviderPath(path) === undefined,
      routeProvider: () => {
        if (request.session.provider !== undefined) {
          return request.session.provider;
        }
        const context = launch === undefined ? undefined : deps.record.routeOf(launch);
        return context?.kind === "provider" ? context.provider : undefined;
      },
      claudeNameOf: (tier) => (launch === undefined ? undefined : deps.record.claudeNameOf(launch, tier)),
    });
    if (decided === undefined || asked === undefined) {
      return { request: found.replayed };
    }
    if ("refusal" in decided) {
      abandonBody(found.replayed.body);
      return { refused: { ok: false, status: HTTP_STATUS.badRequest, message: decided.refusal } };
    }
    const scan = await scanRequestHead(found.replayed, false, REQUEST_SCAN_CAP_BYTES);
    if (scan.hasSeveralModelFields()) {
      abandonBody(scan.replayed.body);
      return { refused: { ok: false, status: HTTP_STATUS.badRequest, message: AMBIGUOUS_MODEL_MESSAGE } };
    }
    return { request: withModelInHead(scan.replayed, scan.headBytes, asked, decided.name), asked, ...(decided.overridden === undefined ? {} : { overridden: true }) };
  };

  const routed = async (request: RoutedRequest, asked: string | undefined, overridden: boolean): Promise<RouteResolution> => {
    const { launch, provider } = request.session;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (launch === undefined || provider !== undefined || !isMessagesInferencePath(path)) {
      return await resolve(request);
    }
    const requestClass = requestClassOf(request.headers);
    const ticket = deps.record.begin(launch);
    const current = deps.record.routeOf(launch);
    if (requestClass !== undefined && requestClass !== MAIN_REQUEST_CLASS) {
      // A helper is placed by the context before anything resolves it. Only a Messages request carries a model, so only its head is read: any other request on a Messages sub-resource goes on with its body untouched.
      const scan = isMessagesRequest(request.method, path) ? await scanRequestHead(request) : undefined;
      const helper = scan?.replayed ?? request;
      if (scan?.model?.startsWith(ANTHROPIC_PREFIX) === true && !deps.definesProvider(ANTHROPIC_ROUTE_NAME)) {
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
    // The name the session asked for is what the context records, whatever it was renamed to: the selector or Claude name, never its expansion.
    const recordedAs = asked ?? requested;
    const served = servedProviderOf(resolution.request?.url ?? request.url);
    if (served === undefined) {
      // The resolver left the request on the Anthropic route, which a request that chose it by `anthropic/<model>` is entitled to; any other goes where the context says. Under a provider context that is the provider, whatever the request names (a name no provider claims and that is no Claude name, a name with a typo, no model at all, a body that is no JSON): it is served as asked, and never by the launch's account.
      const base = resolution.request ?? request;
      if (requested?.startsWith(ANTHROPIC_PREFIX) === true && !deps.definesProvider(ANTHROPIC_ROUTE_NAME)) {
        const placed = await toAnthropic(base, requested);
        if (placed.resolution.ok) {
          recordServing(launch, ticket, placed.resolution, (servedModel) => contextOf({ kind: "anthropic" }, deps.loginOf(request.session), recordedAs, servedModel, overridden), placed.served);
        }
        return placed.resolution;
      }
      // A context an override put the main loop in lasts only while an override still applies: a bare Claude name no override covers now goes where it would with no override, the launch's own route, and the context is recorded there. A context the person chose (`/model <provider>/<model>`) is no override's and stays.
      const overrideLapsed = current?.movedBy === "override" && !overridden && requested !== undefined && isBareClaudeName(requested);
      if (current?.kind === "provider" && !overrideLapsed) {
        const placed = await toProvider(base, current.provider, request.session);
        // Only a Claude name asked for on the main loop is a fact about it worth recording, and the route stays what it was: a request that chose no route moves nothing.
        if (placed.resolution.ok && requested !== undefined && (isBareClaudeName(requested) || requested === AUTO_MODEL)) {
          recordServing(launch, ticket, placed.resolution, (servedModel) => contextOf({ kind: "provider", provider: current.provider }, placed.credential, recordedAs, servedModel, current.movedBy === "override"), unlessAuto(placed.served));
        }
        return placed.resolution;
      }
    }
    // Only a Messages request is a turn of the main loop: any other request (a batch, its results, a listing) is served where the resolver put it and is a fact about no turn, so it leaves the context, and the model and credential recorded for the last turn, as they were.
    if (!isMessagesRequest(request.method, path)) {
      return resolution;
    }
    // Served where the resolver put it, and recorded with the model the resolution says it is sent: a qualified name's, a bare provider name's default, the member a virtual model or family selected, the one a `routes` entry rewrote it to, or, for the model `auto`, none until the route's report names the one it sent. A request that left the Anthropic route is recorded under the name it asked for.
    const route: RouteOf = served === undefined ? { kind: "anthropic" } : { kind: "provider", provider: served };
    const servedModel = resolution.servedModel ?? (served === undefined ? requested : undefined);
    // The credential is named from the provider's file as read for this request, which is read for every request anyway, so an edited credential block shows its new name at the next one.
    const credential = served === undefined ? deps.loginOf(request.session) : deps.providerMapping(served, request.session, "").credential;
    recordServing(launch, ticket, resolution, (model) => contextOf(route, credential, recordedAs, model, overridden), served === undefined ? servedModel : unlessAuto(servedModel));
    return resolution;
  };

  return async (request) => {
    if (deps.rename === undefined) {
      return await routed(request, undefined, false);
    }
    const named = await renamed(request, deps.rename.model, deps.rename.bodyLimitBytes);
    if ("refused" in named) {
      return named.refused;
    }
    const resolution = await routed(named.request, named.asked, named.overridden === true);
    // The usage log records the name the request asked for, as the context does.
    return resolution.ok && named.asked !== undefined ? { ...resolution, requestedModel: named.asked } : resolution;
  };
}

/** The name the model field at `span` of `head` spells: the literal's bytes read as the UTF-8 text they are and decoded, so a name spelt with escapes or non-ASCII characters is compared as the name it is. */
function decodedSpan(head: Buffer, span: Readonly<{ readonly start: number; readonly end: number }>): string | undefined {
  try {
    const decoded: unknown = JSON.parse(head.subarray(span.start, span.end).toString("utf8"));
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** `bytes` as the slices of it a rewrite of the model field would join: the bytes before the field, the new name, the bytes after (views of `bytes`, never copies of it), or `bytes` whole when the field does not spell `from`. */
function rewritingModelSegments(bytes: Buffer, from: string, to: string): readonly Buffer[] {
  const found = topLevelModel(bytes.toString("latin1"));
  return found !== undefined && decodedSpan(bytes, found) === from ? [bytes.subarray(0, found.start), Buffer.from(JSON.stringify(to), "utf8"), bytes.subarray(found.end)] : [bytes];
}

/** `bytes` with the span of its top-level model field replaced by `to`, when the field spells the name `from`; every other byte, whatever it is (text that is not UTF-8 included), as it came. `bytes` is viewed one character per byte for the walk, which looks only at ASCII structure, so the offsets it finds are byte offsets. */
function rewritingModelBytes(bytes: Buffer, from: string, to: string): Buffer {
  const segments = rewritingModelSegments(bytes, from, to);
  return segments.length === 1 ? bytes : Buffer.concat(segments);
}

/**
 * `request` with the model field in the first `headBytes` bytes of its body changed from `from` to `to`, and every other byte, the head's and the rest's, passed through exactly as it came: the rest streams on under the replay's backpressure and is never held. Unlike `withModel` it needs no copy of the body, which is what lets a helper that carries a whole conversation be rewritten without reading it. The framing header goes, because the new name is a different length.
 */
export function withModelInHead(request: RoutedRequest, headBytes: number, from: string, to: string): RoutedRequest {
  const rewriteHead = (head: Buffer): Buffer => rewritingModelBytes(head, from, to);
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
  const headers = withoutContentLength(request.headers);
  return { ...request, headers, body: Readable.from(rewritten()) };
}

/**
 * `request` with its body's model field changed from `from` to `to`, rewritten by span in the bytes a whole-body scan read (`bytes`), exactly one field changed and every other byte as it came. The framing header goes, because the new name is a different length and the forward re-frames the body itself.
 */
export function withModel(request: RoutedRequest, bytes: Buffer, from: string, to: string): RoutedRequest {
  const headers = withoutContentLength(request.headers);
  // The three slices are streamed as they are: joining them would copy the whole body once more for nothing.
  return { ...request, headers, body: Readable.from(rewritingModelSegments(bytes, from, to)) };
}
