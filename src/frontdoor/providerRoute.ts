import { ConfigValidationError } from "../config/load";
import { isCodexProvider, type CodexProvider, type Credential, type Provider } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { resolveCodexConfig } from "../codex/translate";
import { resolveCredential, type CredentialPort, type ResolvedCredential } from "../credential";
import { LegacyProviderFileError, loadProvider } from "../providersStore";
import type { FsPort } from "../launcher/ports";
import { createCodexRouteMount } from "./codexMount";
import { CONNECT_INTERCEPT_HOST, HTTPS_PORT } from "./connect";
import { restoreCredentials } from "./custody";
import { createPassthroughRoute } from "./passthrough";
import type { RouteResolution } from "./pipeline";
import { evaluateWhen, referencesFact, type ConditionContext, type PoolWindowFacts } from "../resolve/conditions";
import type { UsageSnapshot } from "../usage/schema";

/** One hour in milliseconds, the unit the quota windows' hours-until-reset facts are stated in. */
const MS_PER_HOUR = 3_600_000;
import type { QuotaWindow } from "../usage/schema";
import { PROVIDER_PATH_PREFIX, directOrigin, parseProviderPath, type FrontDoorRoute, type RoutedRequest } from "./route";
import { Readable } from "node:stream";
import { scanRequestHead } from "./requestScan";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects: the in-process codex translator for a `codex` provider, the pass-through route for an `http` one with the provider's own credential attached in place of whatever the child presented. A bare `/v1/...` target (what the CONNECT surface hands the pipeline from a terminated OAuth session) rides a pass-through to Claude Code's own API, except in two cases: the Remote Control session family when the door serves that surface itself (`rcSelfHostRoute`, the self-hosted mode's route), and a session whose launch named a provider, whose inference is rewritten under that provider's scoped path and resolved as if the child had dialled the provider directly. Anything else is unrouted.
 */
export function createProviderRouteResolver(deps: {
  /** Reads provider files, the same filesystem port the launcher uses. */
  readonly fs: FsPort;
  readonly providersDir: string;
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
   * The self-hosted Remote Control route, when the door runs that mode: it takes over the `/v1/code/sessions` family and the `/v1/sessions` compatibility list, which would otherwise ride the pass-through to the real API. Absent, every `/v1/` target rides the pass-through exactly as before.
   */
  readonly rcSelfHostRoute?: FrontDoorRoute;
}): (request: RoutedRequest) => Promise<RouteResolution> {
  /** Whether one path belongs to the Remote Control family the self-hosted route serves. */
  const isRcSelfHostPath = (path: string): boolean => path === "/v1/code/sessions" || path.startsWith("/v1/code/sessions/") || path === "/v1/sessions" || path.startsWith("/v1/sessions/");
  /** The pass-through every bare /v1/ request from the CONNECT surface rides: straight to Claude Code's own API, with no per-request upstream for a headroom hop (the daemon's default upstream is exactly that API, which is what an OAuth session wants). */
  const oauthRoute = createPassthroughRoute("anthropic", { baseUrl: `https://${CONNECT_INTERCEPT_HOST}:${String(HTTPS_PORT)}`, stripPrefix: undefined, headroomUpstream: undefined });

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
      if (request.session.provider !== undefined && path.startsWith("/v1/") && !isRcSelfHostPath(path)) {
        // A provider session arrives believing it is talking to Claude Code's own API (that belief is load-bearing: the CLI's Remote Control activation gate admits only that host, with no override), so its inference rides a bare /v1/ path. The door, which terminates that host's TLS, is the one that decides where the traffic actually goes: the session's named provider, resolved exactly as a provider-scoped request would be. The Remote Control family never takes this branch, whichever surface serves it, because a provider serves inference, not the CCR session protocol.
        return resolve({ ...request, url: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(request.session.provider)}${request.url}` });
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
    const httpProvider: Provider = definition;
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
    let current = request;
    let replay: RoutedRequest | undefined;
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
        const definition = providerName === undefined ? undefined : loadProvider(deps.providersDir, providerName, deps.fs);
        routes = definition === undefined || isCodexProvider(definition) ? undefined : definition.routes;
      } catch {
        // An invalid provider file is the sync resolver's own refusal to report, not this layer's.
        routes = undefined;
      }
      if (routes === undefined || routes.length === 0) {
        const resolution = resolve(current);
        return resolution.ok && replay !== undefined ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }) } : resolution;
      }
      // How far this request must be read: the head suffices for the model field, but a condition that names the image fact needs the whole conversation (an image anywhere is the fact, and the newest turn sits at the body's end), and so does a route that rewrites the model name. The route author's own predicate chooses the cost.
      const whole = routes.some((entry) => entry.model !== undefined || referencesFact(entry.when, "request.hasImage"));
      // The targets' quota facts, from this identity's snapshot: a route's condition names them to skip an exhausted target. A provider the snapshot has never recorded carries no facts, so a condition naming its windows is undecided and falls through, never routing onto it by accident.
      const snapshot = deps.usageSnapshotOf?.(current.session.identity);
      const windowFacts = (raw: QuotaWindow | undefined): PoolWindowFacts | undefined => {
        if (raw?.utilization === undefined || raw.resetsAt === undefined) {
          return undefined;
        }
        return { remaining: Math.max(0, 1 - raw.utilization), utilization: raw.utilization, hoursUntilReset: Math.max(0, (Date.parse(raw.resetsAt) - Date.now()) / MS_PER_HOUR) };
      };
      const providerQuota = Object.fromEntries(
        routes.flatMap((entry) => {
          const unified = snapshot?.providers[entry.provider]?.rateLimit?.unified;
          return [[entry.provider, { fiveHour: windowFacts(unified?.fiveHour), sevenDay: windowFacts(unified?.sevenDay) }]];
        }),
      );
      const scan = await scanRequestHead(current, whole);
      if (scan.replayed === undefined) {
        // Nothing was read (the body was empty): the original request is the honest handover.
        const resolution = resolve(current);
        return resolution.ok && replay !== undefined ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }) } : resolution;
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
        return resolution.ok ? { ok: true, route: servingRewritten(resolution.route, { ...replay, url: current.url }) } : resolution;
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
