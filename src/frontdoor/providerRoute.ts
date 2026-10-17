import { ConfigValidationError } from "../config/load";
import { isAntigravityProvider, isCodexProvider, isHttpProvider, type AntigravityProvider, type CodexProvider, type HttpProvider, type Credential, isRouterProvider, type ModelsConfig } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { resolveCodexConfig } from "../codex/translate";
import { resolveAntigravityConfig, type ResolvedAntigravityConfig } from "../antigravity/translate";
import { createCachedAntigravityQuotaSource, fetchAntigravityQuotaSummary, type AntigravityQuotaMap } from "../antigravity/quota";
import { resolveCredential, type CredentialPort, type ResolvedCredential } from "../credential";
import { LegacyProviderFileError, loadProvider } from "../providersStore";
import type { FsPort } from "../launcher/ports";
import { createCodexRouteMount } from "./codexMount";
import { createAntigravityRouteMount } from "./antigravityMount";
import { CONNECT_INTERCEPT_HOST, HTTPS_PORT } from "./connect";
import { restoreCredentials } from "./custody";
import { createPassthroughRoute } from "./passthrough";
import type { RouteResolution } from "./pipeline";
import { evaluateWhen, referencesFact, type ConditionContext } from "../resolve/conditions";
import { quotaFactsOf } from "../usage/quotaFacts";
import { expandMembers } from "../modelsStore";
import { candidateOf } from "../selection/candidates";
import { selectMember, type RequestNeeds } from "../selection/engine";
import { FAMILY_PREFIX, buildFamilies, expandFamilyMembers, familyCapabilities, familyMode, familyNamed, familyOfRef } from "../models/families";
import { withoutContextMarker } from "../models/identity";
import type { TargetObservation } from "../selection/signals";
import type { UsageSnapshot } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, directOrigin, parseProviderPath, type FrontDoorRoute, type RoutedRequest } from "./route";
import { Readable } from "node:stream";
import { scanRequestHead } from "./requestScan";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects: the in-process codex translator for a `codex` provider, the pass-through route for an `http` one with the provider's own credential attached in place of whatever the child presented. A bare `/v1/...` target (what the CONNECT surface hands the pipeline from a terminated OAuth session) rides a pass-through to Claude Code's own API, except in two cases: the Remote Control session family when the door serves that surface itself (`rcSelfHostRoute`, the self-hosted mode's route), and a session whose launch named a provider, whose inference is rewritten under that provider's scoped path (`scopeSessionProviderPath`, before anything else, so the route that serves sees the scoped target too, not only the resolution) and resolved as if the child had dialled the provider directly. Anything else is unrouted.
 */
/** Whether one path belongs to the Remote Control family the self-hosted route serves. */
const isRcSelfHostPath = (path: string): boolean => path === "/v1/code/sessions" || path.startsWith("/v1/code/sessions/") || path === "/v1/sessions" || path.startsWith("/v1/sessions/");

/**
 * Rewrites a provider session's bare `/v1/` target under its provider's scoped path: the request a child dialling the provider directly would have sent. Any other request (a provider-scoped path, a session that named no provider, a non-`/v1/` path, or the Remote Control family a provider never serves) is returned unchanged.
 */
function scopeSessionProviderPath(request: RoutedRequest): RoutedRequest {
  if (request.session.provider === undefined) {
    return request;
  }
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (!path.startsWith("/v1/") || isRcSelfHostPath(path)) {
    return request;
  }
  return { ...request, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(request.session.provider)}${request.url}` };
}

/** What a request's model name resolves to when it routes by name: the provider that serves it, the model name that provider serves it under (a qualified name loses its qualifier, a virtual model resolves to the member its mode chose), and the member ref the choice landed on, for the stickiness the next request of the same session reads. */
interface RoutedModel {
  readonly provider: string;
  readonly model: string;
  readonly ref: string;
}

/** What `resolveRoutedModel` reads from the door: the session's models block, the quota snapshot of its identity, what each target's recent requests observed, and the targets the providers offer (which families are formed from). */
interface RoutedModelDeps {
  readonly models?: (session: Readonly<{ readonly sessionId?: string }>) => ModelsConfig | undefined;
  readonly usageSnapshotOf?: (identity: string | undefined) => UsageSnapshot | undefined;
  readonly observations?: (target: string) => TargetObservation | undefined;
  readonly targets?: () => readonly string[];
}

/** How many characters of a request body are taken to be one token when the size of the context a switch would re-send is estimated: the common rule of thumb for English text and code, an estimate and never a measurement. */
const CHARS_PER_TOKEN = 4;

/** What a request asks of the model that serves it, from the facts a whole-body scan found, for the modes that filter before they rank. */
function needsOf(scan: Readonly<{ readonly hasImage?: boolean; readonly toolsPresent?: boolean; readonly thinking?: boolean; readonly text?: string }>): RequestNeeds {
  return { hasImage: scan.hasImage === true, hasTools: scan.toolsPresent === true, thinking: scan.thinking === true, contextTokens: Math.ceil((scan.text?.length ?? 0) / CHARS_PER_TOKEN) };
}

/** Resolves a routing session's model name to its target: a qualified name names its provider directly, a virtual model or a family (`family:<key>`) chooses among its members through its selection mode (quota windows from the session's snapshot, latency and success from the observed targets, prices from the models block, what the request needs against what each member's family carries), and a bare unknown name has no target. */
function resolveRoutedModel(
  model: string,
  providerName: string | undefined,
  session: Readonly<{ readonly identity?: string; readonly sessionId?: string }>,
  includeUnqualified: boolean,
  deps: Readonly<RoutedModelDeps>,
  memory: Readonly<Map<string, string>>,
  rotations: Readonly<Map<string, number>>,
  needs: RequestNeeds | undefined,
): RoutedModel | undefined {
  const models = deps.models?.(session);
  // The wire name a provider expects carries no context marker: Claude Code strips it from the names it sends, and a member ref may name its model with it (`z/glm-5.3[1m]`), so the target the resolver writes has it stripped too or the provider sees a model it does not know.
  const qualified = model.includes("/") && !model.startsWith("acct:") ? model : undefined;
  if (qualified !== undefined) {
    const [provider, ...rest] = qualified.split("/");
    const named = rest.join("/");
    return provider === undefined || named === "" ? undefined : { provider, model: withoutContextMarker(named), ref: qualified };
  }
  const isFamily = model.startsWith(FAMILY_PREFIX);
  const virtual = isFamily ? undefined : models?.virtual?.[model];
  if ((virtual === undefined && !isFamily) || !includeUnqualified) {
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
    const facts = quotaFactsOf(snapshot?.providers[provider ?? ""]?.rateLimit?.unified, Date.now());
    const candidate = candidateOf(ref, order, {
      quota: facts,
      ...(deps.observations?.(ref) === undefined ? {} : { observation: deps.observations(ref) }),
      ...(models?.prices?.[ref] === undefined ? {} : { price: models.prices[ref] }),
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
  return provider === undefined || chosen === "" ? undefined : { provider, model: withoutContextMarker(chosen), ref: selection.ref };
}

/** The identity and model an `acct:` member names, when the model a session asked for is one (`acct:work/opus` directly, or a virtual model whose first member is). One login per process, so no route can serve it: only a relaunch under the identity can. */
function resolveAccountTarget(model: string, models: ModelsConfig | undefined): { readonly identity: string; readonly model: string } | undefined {
  if (model.startsWith("acct:")) {
    const ref = model.slice("acct:".length);
    const [identity, ...rest] = ref.split("/");
    const named = rest.join("/");
    return identity === undefined || named === "" ? undefined : { identity, model: named };
  }
  const virtual = models?.virtual?.[model];
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
  /** Resolves an `http` provider's credential block: the same port the launcher resolves a launch's provider with, cache included. */
  readonly credentials: CredentialPort;
  /** Reads the session identity's usage snapshot, kept fresh by the caller (the door's own store writes it): the per-provider quota facts a route condition skips an exhausted target with. */
  readonly usageSnapshotOf?: (identity: string | undefined) => UsageSnapshot | undefined;
  /**
   * Serves an `acct:` model member by leaving a move request for the session's supervisor, returning whether the session is supervised (so the request was written and a relaunch is coming); unsupervised sessions get the message that names the command to run instead. Wired to the supervise registry by the door's own process; absent in every other caller, where no session is supervised.
   */
  readonly accountMoves?: (sessionId: string, to: string, model: string) => boolean;
  /** The observed latency, success and token mix of one target (`provider/model`), from the door's observation store seeded by the usage log: what the ranked modes of a virtual model's selection read. */
  readonly observations?: (target: string) => TargetObservation | undefined;
  /**
   * The self-hosted Remote Control route, when the door runs that mode: it takes over the `/v1/code/sessions` family and the `/v1/sessions` compatibility list, which would otherwise ride the pass-through to the real API. Absent, every `/v1/` target rides the pass-through exactly as before.
   */
  readonly rcSelfHostRoute?: FrontDoorRoute;
}): (request: RoutedRequest) => Promise<RouteResolution> {
  /** The pass-through every bare /v1/ request from the CONNECT surface rides: straight to Claude Code's own API, with no per-request upstream for a headroom hop (the daemon's default upstream is exactly that API, which is what an OAuth session wants). */
  const oauthRoute = createPassthroughRoute("anthropic", { baseUrl: `https://${CONNECT_INTERCEPT_HOST}:${String(HTTPS_PORT)}`, stripPrefix: undefined, headroomUpstream: undefined });

  /**
   * One cached quota source per antigravity provider, for this resolver's lifetime: each refresh resolves the provider's own credential block and polls the backend's quota summary exactly as its CLI does, so the unified headers a session's responses carry describe the account's real windows.
   */
  const antigravityQuotaSources = new Map<string, () => AntigravityQuotaMap | undefined>();
  // The routing memory an antigravity provider's sessions keep their last model in: one per provider, held by the resolver, because the route is mounted afresh for every request and a memory inside the mount would forget between requests.
  const antigravityRoutingMemory = new Map<string, Map<string, string>>();
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
        const res = resolveCredential({ credential: definition.credential, env: deps.env, port: deps.credentials, subject: `provider ${provider}` });
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
  const passthroughFor = (name: string, target: { readonly baseUrl: string; readonly stripPrefix: string | undefined; readonly headroomUpstream: string | undefined }): ReturnType<typeof createPassthroughRoute> => {
    const key = `${name}\u0000${target.baseUrl}\u0000${target.stripPrefix ?? ""}\u0000${target.headroomUpstream ?? ""}`;
    const existing = passthroughByTarget.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const route = createPassthroughRoute(name, target);
    passthroughByTarget.set(key, route);
    return route;
  };

  /** The resolution itself is synchronous: reading one provider file needs no await, and keeping it sync is what lets the async wrapper stay honest about its one await. */
  const resolve = (request: RoutedRequest): RouteResolution => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const scoped = parseProviderPath(path);
    if (scoped === undefined) {
      if (deps.rcSelfHostRoute !== undefined && isRcSelfHostPath(path)) {
        return { ok: true, route: deps.rcSelfHostRoute };
      }
      return path.startsWith("/v1/") ? { ok: true, route: oauthRoute } : { ok: false, status: HTTP_STATUS.notFound, message: `no such endpoint: ${path}` };
    }
    const { provider } = scoped;
    let definition;
    try {
      definition = loadProvider(deps.providersDir, provider, deps.fs);
    } catch (error) {
      if (error instanceof ConfigValidationError || error instanceof LegacyProviderFileError) {
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
            loadProvider: () => {
              const res = resolveCredential({
                credential: antigravityProvider.credential,
                env: deps.env,
                port: deps.credentials,
                subject: `provider ${provider}`,
              });
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
          },
          directOrigin(deps.directPort()),
          provider,
        ),
      };
    }
    if (isRouterProvider(definition)) {
      // The router mounts in the routing layer below: it has no route of its own until a request's model name resolves to a target, so the resolver serves the OAuth passthrough for any path a routing layer did not claim.
      return { ok: true, route: passthroughFor(`router:${provider}`, { baseUrl: `http://127.0.0.1:${String(deps.directPort())}`, stripPrefix: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`, headroomUpstream: directOrigin(deps.directPort()) }) };
    }
    const httpProvider: HttpProvider = definition;
    return {
      ok: true,
      route: attachingProviderCredential(
        passthroughFor(`http:${provider}`, {
          baseUrl: httpProvider.baseUrl,
          stripPrefix: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`,
          headroomUpstream: directOrigin(deps.directPort()),
        }),
        { provider, credential: httpProvider.credential, env: deps.env, port: deps.credentials },
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

  return async (request) => {
    // A provider session arrives believing it is talking to Claude Code's own API (that belief is load-bearing: the CLI's Remote Control activation gate admits only that host, with no override), so its inference rides a bare /v1/ path. The rewrite to the session's provider scoped path happens here, before anything else, because the whole pipeline must see it: the body scan, the resolution and above all the route that serves, since a translating route re-derives its provider from the scoped path and a bare path would leave it unrouted. The Remote Control family never takes this branch, whichever surface serves it, because a provider serves inference, not the CCR session protocol.
    const scopedRequest = scopeSessionProviderPath(request);
    const serveScoped = (resolution: { ok: true; route: FrontDoorRoute }): { ok: true; route: FrontDoorRoute } =>
      scopedRequest === request ? resolution : { ok: true, route: servingRewritten(resolution.route, scopedRequest) };
    let current = scopedRequest;
    let replay: RoutedRequest | undefined;
    // Set once a model name has been resolved to its target: the name the target now carries is its own (a provider may serve a model named like `hf:zai-org/GLM-5.1`, which would read as a qualified ref), so the target's turn of the loop serves it as it is and never resolves it by name again.
    let nameResolved = false;
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
      let isRouter;
      try {
        const definition = providerName === undefined ? undefined : loadProvider(deps.providersDir, providerName, deps.fs);
        routes = definition === undefined || !isHttpProvider(definition) ? undefined : definition.routes;
        isRouter = definition !== undefined && isRouterProvider(definition);
      } catch {
        // An invalid provider file is the sync resolver's own refusal to report, not this layer's.
        routes = undefined;
        isRouter = false;
      }
      // A router resolves each request's model name through the models block to a target provider, whose own kind handling and credential then serve it: the same one-scan, one-rewrite shape the `routes` list below uses. A session that asked to route by name gets the same resolution on the provider it launched on: a qualified model name leaves that provider for the one that serves it. A provider-less (OAuth) session gets it too, but qualified names only: its bare names are Claude Code's own and still go to Anthropic, and the Remote Control family of paths is never a provider's to serve.
      const routesByName = !nameResolved && (isRouter || current.session.routeByName) && !isRcSelfHostPath(path);
      if (routesByName) {
        // Whole-body, because a resolved name is served under its target's own model name: the qualified or virtual name the session sent is rewritten in the one copy of the body this scan holds, exactly as a `routes` entry that names a model is.
        const scan = await scanRequestHead(current, true);
        if (scan.replayed === undefined) {
          // Nothing was read (the body was empty): the original request is the honest handover.
          const resolution = resolve(current);
          return resolution.ok && replay !== undefined
            ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } }
            : resolution.ok
              ? serveScoped(resolution)
              : resolution;
        }
        replay = scan.replayed;
        // An `acct:` member is served by relaunch, never by a route: one login per process. The door asks the session's supervisor to move it (when one is watching) and answers the request with what is happening, so the turn ends cleanly rather than hanging or 502-ing.
        const account = scan.model === undefined ? undefined : resolveAccountTarget(scan.model, deps.models?.(current.session));
        if (account !== undefined) {
          const sessionId = current.session.sessionId ?? "";
          const moved = sessionId !== "" && (deps.accountMoves?.(sessionId, account.identity, account.model) ?? false);
          return {
            ok: false,
            status: HTTP_STATUS.badRequest,
            message: moved
              ? `model "${account.model}" runs under identity "${account.identity}"; this session is being moved there and will resume with it`
              : `model "${account.model}" runs under identity "${account.identity}", which needs a relaunch this session cannot make; start it there with: claude @${account.identity} --resume`,
          };
        }
        const routed = scan.model === undefined ? undefined : resolveRoutedModel(scan.model, providerName, current.session, isRouter || providerName !== undefined, deps, routingMemory, rotations, needsOf(scan));
        const requested = scan.model;
        if (routed !== undefined) {
          routingMemory.set(current.session.sessionId ?? "", routed.ref);
          if (requested !== undefined && routed.provider === providerName && routed.model === requested) {
            // The name points back at the provider the session is already on under the name it serves: nothing to rewrite, serve it here.
            const resolution = resolve(current);
            return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } } : resolution;
          }
          if (requested !== undefined && routed.model !== requested) {
            // The rewrite replaces the model field's value in the one copy of the body the whole-body scan already holds, so the target receives exactly the request that matched with exactly one field changed; the framing header is dropped because the new name is a different length.
            const rewritten = (scan.text ?? "").replace(new RegExp('"model":\\s*"' + requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), '"model":"' + routed.model + '"');
            const headers = Object.fromEntries(Object.entries(replay.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
            replay = { ...replay, headers, body: Readable.from([Buffer.from(rewritten, "utf8")]) };
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
          const resolution = resolve(current);
          return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } } : resolution;
        }
      }
      if (routes === undefined || routes.length === 0) {
        const resolution = resolve(current);
        return resolution.ok && replay !== undefined
          ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } }
          : resolution.ok
            ? serveScoped(resolution)
            : resolution;
      }
      // How far this request must be read: the head suffices for the model field, but a condition that names the image fact needs the whole conversation (an image anywhere is the fact, and the newest turn sits at the body's end), and so does a route that rewrites the model name. The route author's own predicate chooses the cost.
      const whole = routes.some((entry) => entry.model !== undefined || referencesFact(entry.when, "request.hasImage"));
      // The targets' quota facts, from this identity's snapshot: a route's condition names them to skip an exhausted target. A provider the snapshot has never recorded carries no facts, so a condition naming its windows is undecided and falls through, never routing onto it by accident.
      const snapshot = deps.usageSnapshotOf?.(current.session.identity);
      const providerQuota = Object.fromEntries(
        routes.flatMap((entry) => {
          return [[entry.provider, quotaFactsOf(snapshot?.providers[entry.provider]?.rateLimit?.unified, Date.now())]];
        }),
      );
      const scan = await scanRequestHead(current, whole);
      if (scan.replayed === undefined) {
        // Nothing was read (the body was empty): the original request is the honest handover.
        const resolution = resolve(current);
        return resolution.ok && replay !== undefined
          ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } }
          : resolution.ok
            ? serveScoped(resolution)
            : resolution;
      }
      replay = scan.replayed;
      const requestFacts = {
        ...(scan.model === undefined ? {} : { model: scan.model }),
        ...(scan.hasImage === undefined ? {} : { hasImage: scan.hasImage }),
        ...(scan.toolsPresent === undefined ? {} : { toolsPresent: scan.toolsPresent }),
        ...(scan.thinking === undefined ? {} : { thinking: scan.thinking }),
        ...(scan.maxTokens === undefined ? {} : { maxTokens: scan.maxTokens }),
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
        const resolution = resolve(current);
        return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }), request: { ...replay, url: current.url } } : resolution;
      }
      if (matched.model !== undefined && scan.text !== undefined && scan.model !== undefined) {
        // The rewrite replaces the model field's value in the one copy of the body the whole-body scan already holds, so the target receives exactly the request that matched with exactly one field changed.
        const rewritten = scan.text.replace(new RegExp('"model":\\s*"' + scan.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), '"model":"' + matched.model + '"');
        // The rewritten body's byte count no longer matches the client's content-length (the new model name is a different length), so the framing header is dropped and the forward re-frames the body itself.
        const headers = Object.fromEntries(Object.entries(replay.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
        replay = { ...replay, headers, body: Readable.from([Buffer.from(rewritten, "utf8")]) };
      }
      // The match rides the target's own scoped path, so the loop's next turn resolves it exactly as a direct dial would: its kind, its credential, and its own routes list all apply. The path after this provider's own prefix (or the whole bare /v1/ path of a session-named provider) is the target's to serve, query included.
      const rest = scoped === undefined ? path : path.slice(`${PROVIDER_PATH_PREFIX}${encodeURIComponent(scoped.provider)}`.length);
      const query = current.url.includes("?") ? current.url.slice(current.url.indexOf("?")) : "";
      // The body carried forward is the replay's: the original stream's head was consumed by this turn's scan, and the target's own resolution (including another scan, when the target itself routes) must read a body that still begins at the head.
      current = { ...current, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(matched.provider)}${rest}${query}`, body: replay.body, headers: replay.headers };
    }
  };
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
  deps: { readonly provider: string; readonly credential: Credential; readonly env: Readonly<Record<string, string | undefined>>; readonly port: CredentialPort },
): FrontDoorRoute {
  return {
    name: route.name,
    headroomEligible: route.headroomEligible,
    headroomUpstream: route.headroomUpstream,
    serve: async (request, response) => {
      const resolution = resolveCredential({ credential: deps.credential, env: deps.env, port: deps.port, subject: `provider ${deps.provider}` });
      if (!resolution.ok) {
        // 502 with the api_error type, the shape the pass-through itself answers an unreachable upstream with: the door cannot authenticate this request at its upstream, which is a gateway failure, never the client's credential to fix.
        response.start(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
        await response.write(
          JSON.stringify({ type: "error", error: { type: "api_error", message: `provider ${deps.provider} has no usable credential for the front door to attach: ${resolution.message}` } }),
        );
        response.end();
        return;
      }
      await route.serve({ ...request, headers: restoreCredentials(request.headers, providerCredentialHeaders(resolution.credential)) }, response);
    },
  };
}
