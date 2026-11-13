import { holdFrom } from "../elapsedWindow";
import { createAgyCredentialResolver } from "../antigravity/agyCredential";
import { ConfigFileNotJsonError, ConfigValidationError } from "../config/load";
import { InvalidProviderNameError, isFileName } from "../config/names";
import { isAntigravityProvider, isCodexProvider, isHttpProvider, type AntigravityProvider, type CodexProvider, type HttpProvider, type Credential, isRouterProvider, type ModelsConfig } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { resolveCodexConfig } from "../codex/translate";
import { resolveAntigravityConfig, type ResolvedAntigravityConfig } from "../antigravity/translate";
import { createCachedAntigravityQuotaSource, fetchAntigravityQuotaSummary, type AntigravityQuotaMap } from "../antigravity/quota";
import { resolveCredentialAsync, shareInFlightResolutions, type AsyncCredentialPort, type ResolvedCredential, type ResolveCredentialAsyncParams, type CredentialResolution } from "../credential";
import { LegacyProviderFileError } from "../providersStore";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS, providerConnectTimeoutMs } from "../providerReachability";
import type { FsPort } from "../launcher/ports";
import { createCodexRouteMount } from "./codexMount";
import { createAntigravityRouteMount } from "./antigravityMount";
import { CONNECT_INTERCEPT_HOST, HTTPS_PORT } from "./connect";
import { restoreCredentials } from "./custody";
import { createPassthroughRoute } from "./passthrough";
import type { RouteResolution, ServedModelReport } from "./pipeline";
import { evaluateWhen, referencesFact, type ConditionContext } from "../resolve/conditions";
import { quotaFactsOf } from "../usage/quotaFacts";
import { expandMembers } from "../modelsStore";
import { candidateOf } from "../selection/candidates";
import { selectMember, type RequestNeeds } from "../selection/engine";
import { FAMILY_PREFIX, buildFamilies, expandFamilyMembers, familyCapabilities, familyMode, familyNamed, familyOfRef } from "../models/families";
import { withoutContextMarker } from "../models/identity";
import type { TargetObservation } from "../selection/signals";
import type { UsageSnapshot } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, directOrigin, parseProviderPath, type FrontDoorRoute, type ModelChoice, type RoutedRequest } from "./route";
import { AMBIGUOUS_MODEL_MESSAGE } from "./topLevelModel";
import { reservedProviderNameReason } from "../models/reservedModelNames";
import { ANTHROPIC_PREFIX, ANTHROPIC_ROUTE_NAME, followingMainLoop, withModel, type MainLoopRouteRecord, type RenameContext, type RenameModel } from "./mainLoopRoute";
import { overrideFor, type RouteOverridesRead } from "../routeOverridesStore";
import { isBareClaudeName } from "../models/tiers";
import { expandSelectorName, type SelectorPorts } from "../models/selectors";
import type { SelectorStatePorts } from "../models/selectorPorts";
import { createProviderReads, servesName, type ProviderDefault, type RoutedRefusal } from "./providerReads";
import { scanRequestHead, type RequestScan } from "./requestScan";
import type { CatalogueFetch, CatalogueModel } from "../providerCatalogue";
import { CONNECT_LIMITS } from "./connect";
import { editingHttpRequest } from "./httpRequestEdits";
import { abandonBody } from "./cappedBody";
import { MESSAGES_BODY_LIMIT_BYTES, bodyTooLargeMessage, isMessagesRequest } from "./messagesBodyLimit";
import { encodedRequestMessage } from "./requestEncoding";
import { createServedModels } from "./servedModel";
import { ownEntry } from "../ownEntry";

/** How often the door logs that one upstream could not be connected to, while it stays down. */
export const COULD_NOT_CONNECT_LOG_INTERVAL_MS = 60_000;
import { isRcSessionFamilyPath } from "./rcSelfHostOffline";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects: the in-process codex translator for a `codex` provider, the pass-through route for an `http` one with the provider's own credential attached in place of whatever the child presented. A bare `/v1/...` target (what the CONNECT surface hands the pipeline from a terminated OAuth session) rides a pass-through to Claude Code's own API, except in two cases: the Remote Control session family when the door serves that surface itself (`rcSelfHostRoute`, the self-hosted mode's route), and a session whose launch named a provider, whose inference is rewritten under that provider's scoped path (`scopeSessionProviderPath`, before anything else, so the route that serves sees the scoped target too, not only the resolution) and resolved as if the child had dialled the provider directly. Anything else is unrouted.
 */

/**
 * Rewrites a provider session's bare `/v1/` target under its provider's scoped path: the request a child dialling the provider directly would have sent. Any other request (a provider-scoped path, a session that named no provider, a non-`/v1/` path, or the Remote Control family a provider never serves) is returned unchanged.
 */
function scopeSessionProviderPath(request: RoutedRequest): RoutedRequest {
  if (request.session.provider === undefined) {
    return request;
  }
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (!path.startsWith("/v1/") || isRcSessionFamilyPath(path)) {
    return request;
  }
  return { ...request, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(request.session.provider)}${request.url}` };
}

/** The models of `providerName` among the `<provider>/<model>` targets the providers offer. */
function targetModelsOf(deps: Readonly<Pick<RoutedModelDeps, "targets">>, providerName: string): readonly string[] {
  const prefix = `${providerName}/`;
  return (deps.targets?.() ?? []).flatMap((ref) => (ref.startsWith(prefix) ? [ref.slice(prefix.length)] : []));
}

/** What a request's model name resolves to when it routes by name: the provider that serves it, the model name that provider serves it under (a qualified name loses its qualifier, a virtual model resolves to the member its mode chose), and the member ref the choice landed on, for the stickiness the next request of the same session reads. A virtual model or family selection also carries the name the session asked for and the distinct providers its members span, so the response can tell the middleware a choice among alternatives happened. */
interface RoutedModel {
  readonly provider: string;
  readonly model: string;
  readonly ref: string;
  readonly requested?: string;
  readonly providers?: readonly string[];
}

/** What `resolveRoutedModel` reads from the door: the session's models block, the quota snapshot of its identity, what each target's recent requests observed, and the targets the providers offer (which families are formed from). */
interface RoutedModelDeps {
  readonly models?: (session: Readonly<{ readonly sessionId?: string }>) => ModelsConfig | undefined;
  /** Whether a provider file defines this name: the qualification test for a slash in a model name, so a provider's own slashed model ids (an aggregator's `vendor/model`) are only ever treated as a cross-provider ref when the first segment really names a provider. */
  readonly definesProvider?: (name: string) => boolean;
  /** Why the provider file of this name cannot be used (it exists and is invalid), or `undefined` when it is absent or valid: a qualified name whose first segment names such a file is refused with this reason, where an absent file leaves the name to follow the session's route. */
  readonly providerFaultOf?: (name: string) => string | undefined;
  /** The model a bare provider name selects, or `undefined` when no provider file defines the name; a file that is invalid selects a refusal saying so. */
  readonly defaultModelOf?: (name: string) => ProviderDefault | undefined;
  /** The model names the session's own provider gives in its `env` (its tier models and `ANTHROPIC_MODEL`): names that provider serves though no catalogue lists them, so no other provider's bare name takes them. */
  readonly envModelsOf?: (providerName: string) => readonly string[];
  readonly usageSnapshotOf?: (identity: string | undefined) => UsageSnapshot | undefined;
  readonly observations?: (target: string) => TargetObservation | undefined;
  readonly targets?: () => readonly string[];
}

/** The request facts that are read off the text of the body, so only a whole body can say they are absent: a route that names one makes the scan of a Messages request whole, and on a request whose body is not read whole each is undecided unless the head matched. `isCountTokens` is read off the path and `model` is found by the structural walk, so neither is among them. */
const WHOLE_BODY_FACTS = ["hasImage", "toolsPresent", "thinking", "maxTokens"] as const;

/** The whole-body facts a scan decided: all it found of a whole-body scan, and of a head only the ones that matched (`true`, or a `max_tokens` number), never an absence. */
function wholeBodyFactsOf(scan: Readonly<Pick<RequestScan, "whole" | "hasImage" | "toolsPresent" | "thinking" | "maxTokens">>): Readonly<Pick<RequestScan, "hasImage" | "toolsPresent" | "thinking" | "maxTokens">> {
  const decided = (value: boolean | undefined): boolean | undefined => (scan.whole === true || value === true ? value : undefined);
  const hasImage = decided(scan.hasImage);
  const toolsPresent = decided(scan.toolsPresent);
  const thinking = decided(scan.thinking);
  return {
    ...(hasImage === undefined ? {} : { hasImage }),
    ...(toolsPresent === undefined ? {} : { toolsPresent }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(scan.maxTokens === undefined ? {} : { maxTokens: scan.maxTokens }),
  };
}

/** How many characters of a request body are taken to be one token when the size of the context a switch would re-send is estimated: the common rule of thumb for English text and code, an estimate and never a measurement. */
const CHARS_PER_TOKEN = 4;

/** What a request asks of the model that serves it, from the facts a whole-body scan found, for the modes that filter before they rank. */
function needsOf(scan: Readonly<{ readonly hasImage?: boolean; readonly toolsPresent?: boolean; readonly thinking?: boolean; readonly text?: string }>): RequestNeeds {
  return { hasImage: scan.hasImage === true, hasTools: scan.toolsPresent === true, thinking: scan.thinking === true, contextTokens: Math.ceil((scan.text?.length ?? 0) / CHARS_PER_TOKEN) };
}

/** Resolves a routing session's model name to its target: a qualified name names its provider directly, a virtual model or a family (`family:<key>`) chooses among its members through its selection mode (quota windows from the session's snapshot, latency and success from the observed targets, prices from the models block, what the request needs against what each member's family carries), and a bare name the block does not define has no target. */
function resolveRoutedModel(
  model: string,
  providerName: string | undefined,
  session: Readonly<{ readonly identity?: string; readonly sessionId?: string }>,
  deps: Readonly<RoutedModelDeps>,
  memory: Readonly<Map<string, string>>,
  rotations: Readonly<Map<string, number>>,
  needs: RequestNeeds | undefined,
): RoutedModel | RoutedRefusal | undefined {
  const models = deps.models?.(session);
  // The wire name a provider expects carries no context marker: Claude Code strips it from the names it sends, and a member ref may name its model with it (`z/glm-5.3[1m]`), so the target the resolver writes has it stripped too or the provider sees a model it does not know.
  const qualified = model.includes("/") && !model.startsWith("acct:") ? model : undefined;
  if (qualified !== undefined) {
    const [provider, ...rest] = qualified.split("/");
    const named = rest.join("/");
    const fault = provider === undefined || named === "" ? undefined : deps.providerFaultOf?.(provider);
    if (fault !== undefined) {
      return { refusal: fault };
    }
    return provider === undefined || named === "" || (deps.definesProvider !== undefined && !deps.definesProvider(provider)) ? undefined : { provider, model: withoutContextMarker(named), ref: qualified };
  }
  const isFamily = model.startsWith(FAMILY_PREFIX);
  const virtual = isFamily ? undefined : ownEntry(models?.virtual, model);
  // The session's own provider serves a name when its targets list it or its `env` maps a model to it: the launch chose that provider, so such a name stays its own and neither the models block nor a provider's bare name takes it.
  // Asked only on the branches that need it: a bare name that is no provider's costs nothing here, and the targets of every provider are listed only when the session provider's `env` does not name the model.
  const servedBySessionProvider = (): boolean => providerName !== undefined && servesName(model, () => deps.envModelsOf?.(providerName) ?? [], () => targetModelsOf(deps, providerName));
  // A bare name is the models block's to resolve only when the session's own provider does not serve that very name: the block serves the names nothing else can. After the block has had its say, a name equal to a defined provider selects that provider's default model, so `/model spark` works in any session without naming one of its models. A virtual model or family named like a provider therefore keeps winning, and a name nothing defines stays Claude Code's own.
  if (virtual === undefined && !isFamily) {
    const bare = withoutContextMarker(model);
    const selected = reservedProviderNameReason(bare) === undefined ? deps.defaultModelOf?.(bare) : undefined;
    if (selected === undefined || servedBySessionProvider()) {
      return undefined;
    }
    return "refusal" in selected ? selected : { provider: bare, model: withoutContextMarker(selected.model), ref: `${bare}/${selected.model}` };
  }
  if (servedBySessionProvider()) {
    return undefined;
  }
  const declared = isFamily ? [model] : expandMembers(model, models);
  // Families are formed from the targets the providers offer, which is read only when a member names a family or the block holds family settings the candidates' capabilities are read from.
  const families = isFamily || declared.some((member) => member.startsWith(FAMILY_PREFIX)) || models?.families !== undefined ? buildFamilies(deps.targets?.() ?? [], models) : [];
  const mode = virtual?.mode ?? familyMode(familyNamed(families, model)?.settings ?? {});
  const members = expandFamilyMembers(declared, families).filter((member) => !member.startsWith("acct:"));
  if (members.length === 0) {
    return undefined;
  }
  const snapshot = deps.usageSnapshotOf?.(session.identity);
  const current = memory.get(session.sessionId ?? "");
  const evaluated = members.map((ref, order) => {
    const [provider] = ref.split("/");
    const facts = quotaFactsOf(ownEntry(snapshot?.providers, provider ?? "")?.rateLimit?.unified, Date.now());
    const candidate = candidateOf(ref, order, {
      quota: facts,
      ...(deps.observations?.(ref) === undefined ? {} : { observation: deps.observations(ref) }),
      ...(ownEntry(models?.prices, ref) === undefined ? {} : { price: ownEntry(models?.prices, ref) }),
    }, ref === current);
    return { candidate, capabilities: familyCapabilities(familyOfRef(families, ref)?.settings ?? {}) };
  });
  const rotation = rotations.get(model) ?? 0;
  rotations.set(model, rotation + 1);
  const selection = selectMember(mode, evaluated, { rotation, ...(needs === undefined ? {} : { needs }) });
  if (selection.ref === undefined) {
    return undefined;
  }
  const [provider, ...rest] = selection.ref.split("/");
  const chosen = rest.join("/");
  // The choice itself is part of the answer: the virtual or family name the session asked for, and the distinct providers its members span (one entry when they never leave a single provider), for the response middleware to record.
  const providers = [...new Set(members.map((ref) => ref.split("/")[0] ?? ""))].filter((name) => name !== "");
  return provider === undefined || chosen === "" ? undefined : { provider, model: withoutContextMarker(chosen), ref: selection.ref, requested: model, providers };
}

/** The identity and model an `acct:` member names, when the model a session asked for is one (`acct:work/opus` directly, or a virtual model whose first member is). One login per process, so no route can serve it: only a relaunch under the identity can. */
function resolveAccountTarget(model: string, models: ModelsConfig | undefined): { readonly identity: string; readonly model: string } | undefined {
  if (model.startsWith("acct:")) {
    const ref = model.slice("acct:".length);
    const [identity, ...rest] = ref.split("/");
    const named = rest.join("/");
    return identity === undefined || !isFileName(identity) || named === "" ? undefined : { identity, model: named };
  }
  const virtual = ownEntry(models?.virtual, model);
  const first = virtual?.members.find((member) => member.startsWith("acct:"));
  return first === undefined ? undefined : resolveAccountTarget(first, undefined);
}

export function createProviderRouteResolver(deps: {
  /** Reads provider files, the same filesystem port the launcher uses. */
  readonly fs: FsPort;
  readonly providersDir: string;
  /** The models block the router resolves a session's names against: the block the session launched with when it carried definitions of its own, else the global block read live so edits take effect without a relaunch. */
  readonly models?: (session: Readonly<{ readonly sessionId?: string }>) => ModelsConfig | undefined;
  /** Every target the providers offer, as `<provider>/<model>` refs: what families are formed from. Absent when nothing offers the door a catalogue. */
  readonly targets?: () => readonly string[];
  /** The ports the codex translation route needs, already wired to the real auth store and upstream fetch. */
  readonly codexPorts: Omit<CodexRoutePorts, "loadProvider">;
  /**
   * The direct listener's loopback port. A headroom hop in front of any route is told to forward back to the DIRECT listener's bare origin (headroom appends the client's own path, provider prefix and all, and the direct listener re-resolves it), never this door's main one, or the request would hop through headroom twice.
   */
  readonly directPort: () => number;
  /**
   * The environment `env` credential sources are read from, and whose `OP_SERVICE_ACCOUNT_TOKEN` decides an `op` source's interactivity: the door process's own, the same environment the launcher resolved the launch's provider against.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves an `http` provider's credential block: the same sources and cache the launcher resolves a launch's provider with, asked without blocking because a request waits on it inside the process that answers every session. */
  readonly credentials: AsyncCredentialPort;
  /** Reads the session identity's usage snapshot, kept fresh by the caller (the door's own store writes it): the per-provider quota facts a route condition skips an exhausted target with. */
  readonly usageSnapshotOf?: (identity: string | undefined) => UsageSnapshot | undefined;
  /**
   * Serves an `acct:` model member by leaving a move request for the session's supervisor, resolving to whether the session is supervised (so the request was written and a relaunch is coming); unsupervised sessions get the message that names the command to run instead. Wired to the supervise registry by the door's own process; absent in every other caller, where no session is supervised.
   */
  readonly accountMoves?: (sessionId: string, to: string, model: string) => Promise<boolean>;
  /** The observed latency, success and token mix of one target (`provider/model`), from the door's observation store seeded by the usage log: what the ranked modes of a virtual model's selection read. */
  readonly observations?: (target: string) => TargetObservation | undefined;
  /**
   * The self-hosted Remote Control route, when the door runs that mode: it takes over the `/v1/code/sessions` family and the `/v1/sessions` compatibility list, which would otherwise ride the pass-through to the real API. Every other `/v1/` request of a self-hosted session is answered by the connect surface's local answers before it reaches this resolver. Absent, every `/v1/` target rides the pass-through exactly as before.
   */
  readonly rcSelfHostRoute?: FrontDoorRoute;
  /** The door's log: where an upstream that could not be connected to is reported, at most once per upstream per `COULD_NOT_CONNECT_LOG_INTERVAL_MS`. */
  readonly log: (line: string) => void;
  /** The clock that interval is measured on. */
  readonly now: () => number;
  /** Where each provider-less session's latest main-loop request was served, which its helper requests follow (see `followingMainLoop`): the door's one record, bounded by its session registry. */
  readonly mainLoopRoutes: MainLoopRouteRecord;
  /** Reads one URL of a provider's model list: what the model name `auto` is resolved from. Absent when the embedding cannot make the request, in which case `auto` is refused with that reason. */
  readonly catalogueFetch?: CatalogueFetch;
  /** The most bytes of a Messages request body an `http` provider's route reads whole to edit it; absent means the documented maximum request size (`MESSAGES_BODY_LIMIT_BYTES`). Injected so a test can cross the cap with a small body. */
  readonly messagesBodyLimitBytes?: number;
  /** The models of a provider's cached catalogue, after its own filters, or none: where a bare name takes the model it selects when the provider's env names no tier model. */
  readonly catalogueModelsOf?: (name: string, provider: HttpProvider) => readonly CatalogueModel[];
  /** Told of every request the routed pass-through to Claude Code's own API is dispatched, before it is dialled, whether the route serves it or the headroom hop in front of it forwards it (the daemon's default upstream is that API): the door's capture records each one, so a record of everything that left for the real API covers the routed pipeline as well as the connect surface's piped exchanges. A throw refuses the request before anything is dialled. */
  readonly observeAnthropicPassthrough?: (request: RoutedRequest) => void;
  /** The name of the identity stored under a directory id (what a session's identity header carries), read as it is now so a rename applies at once; undefined for an id no identity is stored under. The route overrides' identity scopes are keyed by name. */
  readonly identityNameOf?: (id: string) => string | undefined;
  /** The runtime route overrides as they stand now (see `createRouteOverridesReader`): a main-loop request whose model is a bare Claude name is routed by the target of the override that applies to it. Absent, nothing is overridden. */
  readonly routeOverrides?: () => RouteOverridesRead;
  /** The person's configuration a selector (`auto/<selector>[/<class>]`) names besides providers and families: profiles, identities, pools and logins, read fresh per request. Absent, no profile, identity or pool is a selector's to name, and providers and families still are. */
  readonly selectorState?: SelectorStatePorts;
}): (request: RoutedRequest) => Promise<RouteResolution> {
  /** When each upstream (by the subject its routes name it with) last had a failure to connect logged. */
  const couldNotConnectLoggedAt = new Map<string, number>();
  /** Logs a pass-through's failure to connect, unless the same upstream had one logged within the interval: a session retrying a down provider fails every few seconds, and one line a minute says it is still down. */
  const couldNotConnectFor = (subject: string) => (line: string): void => {
    const now = deps.now();
    const last = couldNotConnectLoggedAt.get(subject);
    if (last !== undefined) {
      // The interval restarts when the clock has stepped back behind the last line, so a down provider is not logged on every failure for as long as the step lasts.
      const interval = holdFrom(last, now, COULD_NOT_CONNECT_LOG_INTERVAL_MS);
      couldNotConnectLoggedAt.set(subject, interval.sinceMs);
      if (interval.held) {
        return;
      }
    }
    couldNotConnectLoggedAt.set(subject, now);
    deps.log(`front door: ${line}`);
  };

  /** The pass-through every bare /v1/ request from the CONNECT surface rides: straight to Claude Code's own API, with no per-request upstream for a headroom hop (the daemon's default upstream is exactly that API, which is what an OAuth session wants). */
  const anthropicRoute = createPassthroughRoute("anthropic", {
    baseUrl: `https://${CONNECT_INTERCEPT_HOST}:${String(HTTPS_PORT)}`,
    stripPrefix: undefined,
    headroomUpstream: undefined,
    subject: "the Anthropic API",
    connectTimeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
    couldNotConnect: couldNotConnectFor("the Anthropic API"),
  });
  const oauthRoute: FrontDoorRoute = deps.observeAnthropicPassthrough === undefined ? anthropicRoute : { ...anthropicRoute, observeDispatch: deps.observeAnthropicPassthrough };

  /** Resolves a credential block on the request path; requests in flight together for the same block share one run of its sources. */
  const resolveCredential = shareInFlightResolutions(resolveCredentialAsync);
  const resolveAgyCredential = createAgyCredentialResolver(deps.credentials);
  /**
   * One cached quota source per antigravity provider, for this resolver's lifetime: each refresh resolves the provider's own credential block and polls the backend's quota summary exactly as its CLI does, so the unified headers a session's responses carry describe the account's real windows.
   */
  const antigravityQuotaSources = new Map<string, () => AntigravityQuotaMap | undefined>();
  // The routing memory an antigravity provider's sessions keep their last model in: one per provider, held by the resolver, because the route is mounted afresh for every request and a memory inside the mount would forget between requests.
  const antigravityRoutingMemory = new Map<string, Map<string, string>>();
  // The models an antigravity provider's backend has refused as spent, each until the instant it lifts: one per provider (its account's allowance is shared by every session routed through it), held here for the same reason as the routing memory.
  const antigravityExhaustedModels = new Map<string, Map<string, number>>();
  const reads = createProviderReads({ fs: deps.fs, providersDir: deps.providersDir, ...(deps.models === undefined ? {} : { models: deps.models }), ...(deps.catalogueModelsOf === undefined ? {} : { catalogueModelsOf: deps.catalogueModelsOf }) });
  const { providerOf, providerFaultOf, definesProvider, envModelsOf, defaultModelOf, providerMapping } = reads;
  const noState: SelectorStatePorts = {
    profile: () => ({ kind: "absent" }),
    identity: () => ({ kind: "absent" }),
    pool: () => ({ kind: "absent" }),
    poolPick: (name) => ({ refusal: `no pool named "${name}"` }),
    sameLogin: (identity, sessionIdentity) => identity === sessionIdentity,
  };
  /** The live state one request's selector is expanded against: the configuration ports, the Claude ids the session has sent and the route it is on, the providers as this resolver reads them, and the families the providers' offered targets form under the session's models block. */
  const selectorPortsFor = (context: Readonly<RenameContext>): SelectorPorts => ({
    claudeNameOf: context.claudeNameOf,
    routeProvider: context.routeProvider,
    ...(deps.selectorState ?? noState),
    provider: (name) => {
      const found = reads.lookupProvider(name);
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    providerTarget: (provider, target) => reads.selectorTarget(provider, target, context.session),
    family: (key) => familyNamed(buildFamilies(deps.targets?.() ?? [], deps.models?.(context.session)), `${FAMILY_PREFIX}${key}`) !== undefined,
  });
  /** The target of the route override that applies to a main-loop request for `model`, a refusal when the overrides cannot be read, or undefined. Only a bare Claude name is looked up, so no other request reads the table. */
  const overriddenName = (model: string, context: Readonly<RenameContext>): { readonly name: string; readonly overridden: true } | RoutedRefusal | undefined => {
    if (deps.routeOverrides === undefined || !context.main || !context.unscoped || !isBareClaudeName(model)) {
      return undefined;
    }
    const read = deps.routeOverrides();
    if ("fault" in read) {
      return { refusal: `${read.fault}, so the door cannot tell where to route ${JSON.stringify(model)}; fix or remove the file (agent-shim doctor names what is wrong)` };
    }
    const { sessionId } = context.session;
    // The header carries the identity's directory id, and the identity scopes are keyed by its name as it is now.
    const identity = context.session.identity === undefined ? undefined : deps.identityNameOf?.(context.session.identity);
    // The provider scope is read off the route context only when the table has one, since that costs a stat of the context file.
    const provider = read.table.providers === undefined ? undefined : context.routeProvider();
    const match = overrideFor(read.table, { ...(sessionId === undefined ? {} : { sessionId }), ...(identity === undefined ? {} : { identity }), ...(provider === undefined ? {} : { provider }) }, model);
    return match === undefined ? undefined : { name: match.target, overridden: true };
  };
  /**
   * A session launched on a provider sends every request to that provider, whatever its model name, and its requests carry the provider's placeholder credential rather than an Anthropic login, so a name the door renamed to the Anthropic route (`anthropic/<model>`) cannot be served there and would reach the provider under that name: it is refused, naming the relaunch that puts the session on its own login. A provider file called `anthropic` claims the name, which then routes as any qualified name does.
   */
  const onLaunchProvider = (renamed: { readonly name: string; readonly overridden?: true }, context: Readonly<RenameContext>): { readonly name: string; readonly overridden?: true } | RoutedRefusal => {
    const launchProvider = context.session.provider;
    if (launchProvider === undefined || !renamed.name.startsWith(ANTHROPIC_PREFIX) || definesProvider(ANTHROPIC_ROUTE_NAME)) {
      return renamed;
    }
    return { refusal: `this session was launched on provider "${launchProvider}", whose requests carry no Anthropic login, so ${JSON.stringify(renamed.name)} cannot be served on the Anthropic route: relaunch the session without --provider (claude @<identity> --resume) to use it` };
  };
  const renameOnce: RenameModel = (model, context) => {
    const overridden = overriddenName(model, context);
    if (overridden !== undefined && "refusal" in overridden) {
      return overridden;
    }
    const name = overridden?.name ?? model;
    const expanded = expandSelectorName(name, selectorPortsFor(context), context.session.identity === undefined ? {} : { identityId: context.session.identity });
    if (expanded === undefined) {
      return overridden;
    }
    if ("refusal" in expanded) {
      return overridden === undefined ? expanded : { refusal: `the route override of ${JSON.stringify(model)} routes it by ${JSON.stringify(name)}, which cannot be routed: ${expanded.refusal}` };
    }
    return overridden === undefined ? { name: expanded.name } : { name: expanded.name, overridden: true };
  };
  /** Replaces a main-loop Claude name with its override's target, and a selector (the request's own name or the target) with the name it expands to, before anything routes the request. An override is applied once: its target is never looked up again. A renaming to the Anthropic route in a session launched on a provider is refused (see `onLaunchProvider`). */
  const rename: RenameModel = (model, context) => {
    const renamed = renameOnce(model, context);
    return renamed === undefined || "refusal" in renamed ? renamed : onLaunchProvider(renamed, context);
  };
  // The most a Messages body is read whole under: the same bound the editing wrapper reads under, so neither of the resolver's whole-body scans holds more of a body than that.
  const messagesBodyLimitBytes = deps.messagesBodyLimitBytes ?? MESSAGES_BODY_LIMIT_BYTES;
  /** A scan of `request`'s head, or of the whole body under `messagesBodyLimitBytes` when `whole`: both whole-body scans of the resolver go through it, so neither can hold more of a body than the limit. */
  const scanUnderLimit = async (request: RoutedRequest, whole: boolean): ReturnType<typeof scanRequestHead> => await scanRequestHead(request, whole, undefined, whole ? messagesBodyLimitBytes : undefined);
  /** The bytes a whole-body scan kept: a scan made with `whole` always holds them, so their absence is a defect of the scan, never a state to carry on from. */
  const wholeBytesOf = (scan: Readonly<RequestScan>): Buffer => {
    if (scan.bytes === undefined) {
      throw new Error("a whole-body scan keeps the bytes it read");
    }
    return scan.bytes();
  };
  /** The 413 for a whole-body scan that stopped at the limit; the rest of the upload drains instead of stalling the client. */
  const refusedAsTooLarge = (scan: Readonly<{ readonly replayed: RoutedRequest }>, limitBytes: number, provider: string | undefined): RouteResolution => {
    abandonBody(scan.replayed.body);
    return { ok: false, status: HTTP_STATUS.payloadTooLarge, message: bodyTooLargeMessage(limitBytes, provider) };
  };
  const servedModels = deps.catalogueFetch === undefined ? undefined : createServedModels({ fetch: deps.catalogueFetch, now: deps.now });
  const droppedToolsLogged = new Set<string>();
  // The routing memory a by-name session keeps its last chosen member in, and the rotation counter that keeps `spread` turning, both held by the resolver for the same reason: the route is mounted afresh for every request.
  const routingMemory = new Map<string, string>();
  const rotations = new Map<string, number>();
  const memoryFor = (provider: string): Map<string, string> => {
    const existing = antigravityRoutingMemory.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, string>();
    antigravityRoutingMemory.set(provider, created);
    return created;
  };
  const exhaustedModelsFor = (provider: string): Map<string, number> => {
    const existing = antigravityExhaustedModels.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, number>();
    antigravityExhaustedModels.set(provider, created);
    return created;
  };
  const antigravityQuotaOf = (
    provider: string,
    definition: AntigravityProvider,
    config: ResolvedAntigravityConfig,
  ): (() => AntigravityQuotaMap | undefined) => {
    const existing = antigravityQuotaSources.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    const source = createCachedAntigravityQuotaSource({
      now: () => Date.now(),
      fetchSummary: async (nowMs) => {
        const res = await resolveAgyCredential(await resolveCredential({ credential: definition.credential, env: deps.env, port: deps.credentials, subject: `provider ${provider}` }));
        if (!res.ok) {
          return undefined;
        }
        return fetchAntigravityQuotaSummary({
          token: res.credential.token,
          endpoint: config.cloud.endpoint ?? undefined,
          projectId: config.cloud.projectId ?? undefined,
          nowMs,
        });
      },
    });
    antigravityQuotaSources.set(provider, source);
    return source;
  };

  /**
   * Pass-through routes by target, cached: a route owns a keep-alive connection pool, so building one per request would both churn connections (no reuse across a session's requests) and accumulate pools that only an idle timeout retires. A provider file edit that changes the base URL simply lands on a new cache entry.
   */
  const passthroughByTarget = new Map<string, ReturnType<typeof createPassthroughRoute>>();
  const passthroughFor = (
    name: string,
    target: { readonly baseUrl: string; readonly stripPrefix: string | undefined; readonly headroomUpstream: string | undefined; readonly subject: string; readonly connectTimeoutMs: number },
  ): ReturnType<typeof createPassthroughRoute> => {
    const key = `${name}\u0000${target.baseUrl}\u0000${target.stripPrefix ?? ""}\u0000${target.headroomUpstream ?? ""}\u0000${String(target.connectTimeoutMs)}`;
    const existing = passthroughByTarget.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const route = createPassthroughRoute(name, { ...target, couldNotConnect: couldNotConnectFor(target.subject) });
    passthroughByTarget.set(key, route);
    return route;
  };

  /** The resolution itself is synchronous: reading one provider file needs no await, and keeping it sync is what lets the async wrapper stay honest about its one await. */
  const resolve = (request: RoutedRequest, report?: Readonly<ServedModelReport>): RouteResolution => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const scoped = parseProviderPath(path);
    if (scoped === undefined) {
      if (deps.rcSelfHostRoute !== undefined && isRcSessionFamilyPath(path)) {
        return { ok: true, route: deps.rcSelfHostRoute };
      }
      if (request.session.selfHosted === true) {
        // The pass-through below is the real API: a self-hosted session's request that is neither the Remote Control family nor a provider's inference has no route, however it came to be routed.
        return { ok: false, status: HTTP_STATUS.notFound, message: `a self-hosted Remote Control session's request is never passed to the real API: ${path}` };
      }
      return path.startsWith("/v1/") ? { ok: true, route: oauthRoute } : { ok: false, status: HTTP_STATUS.notFound, message: `no such endpoint: ${path}` };
    }
    const { provider } = scoped;
    let definition;
    try {
      definition = providerOf(provider);
    } catch (error) {
      if (error instanceof InvalidProviderNameError) {
        return { ok: false, status: HTTP_STATUS.notFound, message: `no provider named ${JSON.stringify(provider)}` };
      }
      if (error instanceof ConfigValidationError || error instanceof LegacyProviderFileError || error instanceof ConfigFileNotJsonError) {
        return { ok: false, status: HTTP_STATUS.internalServerError, message: `provider ${provider} is invalid: ${error instanceof Error ? error.message : String(error)}` };
      }
      throw error;
    }
    if (definition === undefined) {
      return { ok: false, status: HTTP_STATUS.notFound, message: `no provider named "${provider}"` };
    }
    if (isCodexProvider(definition)) {
      const codexProvider: CodexProvider = definition;
      return {
        ok: true,
        route: createCodexRouteMount(
          { ...deps.codexPorts, loadProvider: () => ({ ok: true, config: resolveCodexConfig(codexProvider.codex) }) },
          directOrigin(deps.directPort()),
          provider,
        ),
      };
    }
    if (isAntigravityProvider(definition)) {
      const antigravityProvider: AntigravityProvider = definition;
      const config = resolveAntigravityConfig(antigravityProvider.antigravity);
      return {
        ok: true,
        route: createAntigravityRouteMount(
          {
            loadProvider: async () => {
              const res = await resolveAgyCredential(await resolveCredential({
                credential: antigravityProvider.credential,
                env: deps.env,
                port: deps.credentials,
                subject: `provider ${provider}`,
              }));
              if (!res.ok) {
                return { ok: false, status: HTTP_STATUS.unauthorized, message: res.message };
              }
              return {
                ok: true,
                config,
                token: res.credential.token,
                credentialTarget: antigravityProvider.credential.target,
              };
            },
            quotaSource: antigravityQuotaOf(provider, antigravityProvider, config),
            lastRouted: memoryFor(provider),
            exhaustedModels: exhaustedModelsFor(provider),
          },
          directOrigin(deps.directPort()),
          provider,
        ),
      };
    }
    if (isRouterProvider(definition)) {
      // The router mounts in the routing layer below: it has no route of its own until a request's model name resolves to a target, so the resolver serves the OAuth passthrough for any path a routing layer did not claim.
      return {
        ok: true,
        route: passthroughFor(`router:${provider}`, {
          baseUrl: `http://127.0.0.1:${String(deps.directPort())}`,
          stripPrefix: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`,
          headroomUpstream: directOrigin(deps.directPort()),
          subject: `router ${provider}'s own door listener`,
          connectTimeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
        }),
      };
    }
    const httpProvider: HttpProvider = definition;
    return {
      ok: true,
      route: editingHttpRequest(
        attachingProviderCredential(
          passthroughFor(`http:${provider}`, {
            baseUrl: httpProvider.baseUrl,
            stripPrefix: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`,
            headroomUpstream: directOrigin(deps.directPort()),
            subject: `provider ${provider}`,
            connectTimeoutMs: providerConnectTimeoutMs(httpProvider),
          }),
          { provider, credential: httpProvider.credential, env: deps.env, port: deps.credentials, resolve: resolveCredential },
        ),
        {
          provider,
          definition: httpProvider,
          served: servedModels,
          credential: async () => await resolveCredential({ credential: httpProvider.credential, env: deps.env, port: deps.credentials, subject: `provider ${provider}` }),
          droppedLogged: droppedToolsLogged,
          log: deps.log,
          bodyLimitBytes: messagesBodyLimitBytes,
          droppedLoggedLimit: CONNECT_LIMITS.maxTunnels,
          servedModelSent: (model) => {
            report?.listener?.(model);
          },
        },
      ),
    };
  };
  /**
   * The per-request routing layer over the path-only resolution: a provider whose file carries `routes` has each request matched against the list in order, over the facts a bounded scan of the body's head found, and the first definite match is resolved exactly as a request dialled to that provider directly would be. An undecided condition falls through (never to a cheaper provider by accident) and an unmatched request stays on the provider itself; whichever route finally serves, it is handed the replayed body the scan produced, because the scan is the only reader and its replay is the one unbroken remainder.
   */
  const servingRewritten = (route: FrontDoorRoute, rewritten: RoutedRequest): FrontDoorRoute => ({
    name: route.name,
    headroomEligible: route.headroomEligible,
    headroomUpstream: route.headroomUpstream,
    // The pipeline serves the route with the request it received; the routing layer's decisions (the rewritten target path, the replayed body and, when the model name was rewritten, the re-framed headers) are substituted here, so the route sees exactly the request the resolution acted on.
    serve: async (request, response) => {
      await route.serve({ ...request, url: rewritten.url, headers: rewritten.headers, body: rewritten.body }, response);
    },
  });

  /** The routing loop, which hands `noteRequestedModel` the model name the request's body carried each time a scan reads it, the first name first. */
  const resolveByName = async (request: RoutedRequest, noteRequestedModel: (model: string | undefined) => void, noteServedModel: (provider: string, model: string) => void, noteRouted: (provider: string, model: string) => void, report: Readonly<ServedModelReport>): Promise<RouteResolution> => {
    // A provider session arrives believing it is talking to Claude Code's own API (that belief is load-bearing: the CLI's Remote Control activation gate admits only that host, with no override), so its inference rides a bare /v1/ path. The rewrite to the session's provider scoped path happens here, before anything else, because the whole pipeline must see it: the body scan, the resolution and above all the route that serves, since a translating route re-derives its provider from the scoped path and a bare path would leave it unrouted. The Remote Control family never takes this branch, whichever surface serves it, because a provider serves inference, not the CCR session protocol.
    const scopedRequest = scopeSessionProviderPath(request);
    const serveScoped = (resolution: { ok: true; route: FrontDoorRoute }): { ok: true; route: FrontDoorRoute } =>
      scopedRequest === request ? resolution : { ok: true, route: servingRewritten(resolution.route, scopedRequest) };
    let current = scopedRequest;
    let replay: RoutedRequest | undefined;
    // Set once a model name has been resolved to its target: the name the target now carries is its own (a provider may serve a model named like `hf:zai-org/GLM-5.1`, which would read as a qualified ref), so the target's turn of the loop serves it as it is and never resolves it by name again.
    let nameResolved = false;
    // The model choice a virtual model or family made, carried to the resolution so the response middleware can record it; the loop's later turns (the target's own resolution) serve the chosen name as it is and leave this untouched.
    let modelChoice: ModelChoice | undefined;
    const visited = new Set<string>();
    for (;;) {
      const path = new URL(current.url, "http://127.0.0.1").pathname;
      const scoped = parseProviderPath(path);
      const providerName = scoped?.provider ?? current.session.provider;
      if (providerName !== undefined && visited.has(providerName)) {
        return { ok: false, status: HTTP_STATUS.internalServerError, message: `provider routing cycle: ${[...visited, providerName].join(" -> ")}` };
      }
      if (providerName !== undefined) {
        visited.add(providerName);
      }
      let routes;
      try {
        const definition = providerName === undefined ? undefined : providerOf(providerName);
        routes = definition === undefined || !isHttpProvider(definition) ? undefined : definition.routes;
      } catch {
        // An invalid provider file is the sync resolver's own refusal to report, not this layer's.
        routes = undefined;
      }
      // A router resolves each request's model name through the models block to a target provider, whose own kind handling and credential then serve it: the same one-scan, one-rewrite shape the `routes` list below uses. A qualified model name (a slash whose first segment names a defined provider) is resolved on every session, whatever it launched on: the picker offers every provider's models qualified, and a session that selects one is routed to the provider that serves it. Bare names are resolved everywhere, except a name the session's own provider serves itself, which stays that provider's. The Remote Control family of paths is never a provider's to serve.
      // Only a Messages request carries a model to resolve, and only its body is read whole (under the Messages limit): any other request (a file upload, a batch) is forwarded as it arrives.
      const isMessages = isMessagesRequest(current.method, path);
      if (isMessages) {
        // Every scan below reads the body as JSON text, which an encoded body is not: refused here once, before any of them, as the editing wrapper refuses it for a request it reads itself.
        const encoded = encodedRequestMessage(current.headers, providerName);
        if (encoded !== undefined) {
          abandonBody(current.body);
          return { ok: false, status: HTTP_STATUS.unsupportedMediaType, message: encoded };
        }
      }
      const resolvesNames = !nameResolved && !isRcSessionFamilyPath(path) && isMessages;
      if (resolvesNames) {
        // Whole-body, because a resolved name is served under its target's own model name: the qualified or virtual name the session sent is rewritten in the one copy of the body this scan holds, exactly as a `routes` entry that names a model is.
        const scan = await scanUnderLimit(current, true);
        if (scan.tooLarge === true) {
          return refusedAsTooLarge(scan, messagesBodyLimitBytes, providerName);
        }
        noteRequestedModel(scan.model);
        replay = scan.replayed;
        // An `acct:` member is served by relaunch, never by a route: one login per process. The door asks the session's supervisor to move it (when one is watching) and answers the request with what is happening, so the turn ends cleanly rather than hanging or 502-ing.
        const account = scan.model === undefined ? undefined : resolveAccountTarget(scan.model, deps.models?.(current.session));
        if (account !== undefined) {
          const sessionId = current.session.sessionId ?? "";
          const moved = sessionId !== "" && ((await deps.accountMoves?.(sessionId, account.identity, account.model)) ?? false);
          return {
            ok: false,
            status: HTTP_STATUS.badRequest,
            message: moved
              ? `model "${account.model}" runs under identity "${account.identity}"; this session is being moved there and will resume with it`
              : `model "${account.model}" runs under identity "${account.identity}", which needs a relaunch this session cannot make; start it there with: claude @${account.identity} --resume`,
          };
        }
        const routed = scan.model === undefined ? undefined : resolveRoutedModel(scan.model, providerName, current.session, { ...deps, definesProvider, providerFaultOf, defaultModelOf, envModelsOf }, routingMemory, rotations, needsOf(scan));
        const requested = scan.model;
        if (routed !== undefined && "refusal" in routed) {
          return { ok: false, status: HTTP_STATUS.badRequest, message: routed.refusal };
        }
        if (routed === undefined) {
          // Nothing to resolve by name, and this scan consumed the original body: the request the `routes` matching below (or the serving at the end) reads is the replay, which carries the whole body. Reading the original again would see only its remainder, and leaving both scans attached to one stream is a hang.
          current = scan.replayed;
        }
        if (routed !== undefined) {
          routingMemory.set(current.session.sessionId ?? "", routed.ref);
          // The provider and the model the name chose: a qualified name's, a bare provider name's default, or the member a virtual model or family selected. That is the model the provider is sent unless a `routes` entry rewrites it (`noteRouted`) or the model is `auto`, which the route's report replaces with the one it sends.
          noteServedModel(routed.provider, routed.model);
          // A virtual model's or family's selection is a choice among alternatives, unlike a qualified name the session picked itself: only that choice is recorded for the response middleware.
          if (routed.requested !== undefined) {
            modelChoice = { requested: routed.requested, providers: routed.providers ?? [routed.provider] };
          }
          if (requested !== undefined && routed.provider === providerName && routed.model === requested) {
            // The name points back at the provider the session is already on under the name it serves: nothing to rewrite, serve it here.
            const resolution = resolve(current, report);
            return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url }, ...(modelChoice === undefined ? {} : { modelChoice }) } : resolution;
          }
          if (requested !== undefined && routed.model !== requested) {
            if (scan.hasSeveralModelFields()) {
              return { ok: false, status: HTTP_STATUS.badRequest, message: AMBIGUOUS_MODEL_MESSAGE };
            }
            // The target receives exactly the request that matched, with exactly its model field changed.
            replay = withModel(replay, wholeBytesOf(scan), requested, routed.model);
          }
          if (routed.provider !== providerName) {
            const scopedPrefix = providerName === undefined ? undefined : `${PROVIDER_PATH_PREFIX}${encodeURIComponent(providerName)}`;
            const rest = scopedPrefix !== undefined && path.startsWith(scopedPrefix) ? path.slice(scopedPrefix.length) : path;
            const query = current.url.includes("?") ? current.url.slice(current.url.indexOf("?")) : "";
            const carried = replay;
            current = { ...current, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(routed.provider)}${rest}${query}`, body: carried.body, headers: carried.headers };
            nameResolved = true;
            continue;
          }
          // Same provider, renamed model: serve the rewritten body here, on the provider the session is already on.
          const resolution = resolve(current, report);
          return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url }, ...(modelChoice === undefined ? {} : { modelChoice }) } : resolution;
        }
      }
      if (routes === undefined || routes.length === 0) {
        const resolution = resolve(current, report);
        return resolution.ok && replay !== undefined
          ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url }, ...(modelChoice === undefined ? {} : { modelChoice }) }
          : resolution.ok
            ? // Nothing read this request's body (it carries no model, or no scan was needed), so the request it is served as is the scoped one with its body as it arrived: the resolution says so, which the caller that places the request on a provider requires.
              { ...serveScoped(resolution), request: current }
            : resolution;
      }
      // How far this request must be read: the head suffices for the model field, but a condition that names the image fact needs the whole conversation (an image anywhere is the fact, and the newest turn sits at the body's end), and so does a route that rewrites the model name. The route author's own predicate chooses the cost.
      const whole = routes.some((entry) => entry.model !== undefined || WHOLE_BODY_FACTS.some((fact) => referencesFact(entry.when, `request.${fact}`)));
      // The targets' quota facts, from this identity's snapshot: a route's condition names them to skip an exhausted target. A provider the snapshot has never recorded carries no facts, so a condition naming its windows is undecided and falls through, never routing onto it by accident.
      const snapshot = deps.usageSnapshotOf?.(current.session.identity);
      const providerQuota = Object.fromEntries(
        routes.flatMap((entry) => {
          return [[entry.provider, quotaFactsOf(ownEntry(snapshot?.providers, entry.provider)?.rateLimit?.unified, Date.now())]];
        }),
      );
      const scan = await scanUnderLimit(current, whole && isMessages);
      if (scan.tooLarge === true) {
        return refusedAsTooLarge(scan, messagesBodyLimitBytes, providerName);
      }
      noteRequestedModel(scan.model);
      replay = scan.replayed;
      const requestFacts = {
        ...(scan.model === undefined ? {} : { model: scan.model }),
        // One rule for every fact read off the text of the body: decided from a whole body, and from a head only when the head matched (a head that shows no image, tools, thinking or `max_tokens` says nothing about the rest of the body).
        ...wholeBodyFactsOf(scan),
        ...(scan.isCountTokens === undefined ? {} : { isCountTokens: scan.isCountTokens }),
      };
      const context: ConditionContext = { nowMs: Date.now(), env: deps.env, providerQuota, ...(Object.keys(requestFacts).length === 0 ? {} : { request: requestFacts }) };
      let matched: { provider: string; model: string | undefined } | undefined;
      for (const entry of routes) {
        const verdict = evaluateWhen(entry.when, context);
        if (verdict.status === "definite" && verdict.passed) {
          matched = { provider: entry.provider, model: entry.model };
          break;
        }
      }
      if (matched === undefined) {
        const resolution = resolve(current, report);
        return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url }, ...(modelChoice === undefined ? {} : { modelChoice }) } : resolution;
      }
      if (matched.model !== undefined && scan.bytes !== undefined && scan.model !== undefined) {
        if (scan.hasSeveralModelFields()) {
          return { ok: false, status: HTTP_STATUS.badRequest, message: AMBIGUOUS_MODEL_MESSAGE };
        }
        // The target receives exactly the request that matched, with exactly its model field changed.
        replay = withModel(replay, scan.bytes(), scan.model, matched.model);
      }
      // The model the target is sent is the one it serves the request under, whatever name first chose the provider: the match's own model when it rewrites, else the name the body already carries. A later match in a chain replaces an earlier one, since the last target is where the request is served.
      const sentModel = matched.model ?? scan.model;
      if (sentModel !== undefined) {
        noteRouted(matched.provider, sentModel);
      }
      // The match rides the target's own scoped path, so the loop's next turn resolves it exactly as a direct dial would: its kind, its credential, and its own routes list all apply. The path after this provider's own prefix (or the whole bare /v1/ path of a session-named provider) is the target's to serve, query included.
      const rest = scoped === undefined ? path : path.slice(`${PROVIDER_PATH_PREFIX}${encodeURIComponent(scoped.provider)}`.length);
      const query = current.url.includes("?") ? current.url.slice(current.url.indexOf("?")) : "";
      // The body carried forward is the replay's: the original stream's head was consumed by this turn's scan, and the target's own resolution (including another scan, when the target itself routes) must read a body that still begins at the head.
      current = { ...current, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(matched.provider)}${rest}${query}`, body: replay.body, headers: replay.headers };
    }
  };

  /** The login the Anthropic route uses for a session, as the context records it: the identity whose login it is, by the directory id its header carries (a rename leaves it true), or the launch's own. */
  const loginOf = (session: RoutedRequest["session"]): string => (session.identity === undefined ? "the launch's login" : `identity ${session.identity} login`);

  return followingMainLoop(
    async (request) => {
      // The first scan reads the body as the client sent it; a later one reads a target's rewrite, which is not what the session asked for.
      let requestedModel: string | undefined;
      let served: { readonly provider: string; readonly model: string } | undefined;
      const report: ServedModelReport = {};
      const resolution = await resolveByName(
        request,
        (model) => {
          requestedModel ??= model;
        },
        (provider, model) => {
          served ??= { provider, model };
        },
        (provider, model) => {
          served = { provider, model };
        },
        report,
      );
      if (!resolution.ok) {
        return resolution;
      }
      return { ...resolution, servedModelReport: report, ...(requestedModel === undefined ? {} : { requestedModel }), ...(served === undefined ? {} : { servedModel: served.model }) };
    },
    { record: deps.mainLoopRoutes, providerMapping, loginOf, definesProvider, rename: { model: rename, bodyLimitBytes: messagesBodyLimitBytes } },
  );
}

/** The credential headers one resolved provider credential becomes on the wire, in the form Claude Code itself gives that target: a bearer or OAuth token as `Authorization`, an API key as `x-api-key`. */
function providerCredentialHeaders(credential: ResolvedCredential): Record<string, string> {
  return credential.target === "apiKey" ? { "x-api-key": credential.token } : { authorization: `Bearer ${credential.token}` };
}

/**
 * Wraps an `http` provider's route so the provider's own resolved credential, never whatever the child presented, authenticates upstream. The route names exactly one upstream whose credential is the provider's, so the door owns it there the way the codex translator already owns a codex provider's auth: the launcher hands the child no provider credential at all, and a session that presents something anyway (Remote Control's OAuth mode is exactly this: it sends the stored OAuth bearer for inference whatever the environment says) must neither spend a wrong credential at the provider nor leak it to one. The swap sits in the route so it applies on both pipelines, after the headroom hop's redeem restores the client's headers at the direct listener: the provider's credential crosses neither headroom nor the plain-HTTP leg. Resolution runs per request over the block this resolution just read, so an edited credential applies to the next request exactly as an edited base URL does; a block none of whose sources yields a token is answered as an Anthropic-shaped error naming the provider, never forwarded with the client's credential instead.
 */
function attachingProviderCredential(
  route: FrontDoorRoute,
  deps: {
    readonly provider: string;
    readonly credential: Credential;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly port: AsyncCredentialPort;
    readonly resolve: (params: ResolveCredentialAsyncParams) => Promise<CredentialResolution>;
  },
): FrontDoorRoute {
  return {
    name: route.name,
    headroomEligible: route.headroomEligible,
    headroomUpstream: route.headroomUpstream,
    serve: async (request, response) => {
      const resolution = await deps.resolve({ credential: deps.credential, env: deps.env, port: deps.port, subject: `provider ${deps.provider}` });
      if (!resolution.ok) {
        // 502 with the api_error type, the shape the pass-through itself answers an unreachable upstream with: the door cannot authenticate this request at its upstream, which is a gateway failure, never the client's credential to fix.
        response.start(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
        await response.write(
          JSON.stringify({ type: "error", error: { type: "api_error", message: `the front door has no credential to attach: ${resolution.message}` } }),
        );
        response.end();
        return;
      }
      await route.serve({ ...request, headers: restoreCredentials(request.headers, providerCredentialHeaders(resolution.credential)) }, response);
    },
  };
}
