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
import { PROVIDER_PATH_PREFIX, directOrigin, parseProviderPath, type FrontDoorRoute, type RoutedRequest } from "./route";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects: the in-process codex translator for a `codex` provider, the pass-through route for an `http` one with the provider's own credential attached in place of whatever the child presented. A bare `/v1/...` target (what the CONNECT surface hands the pipeline from a terminated OAuth session) rides a pass-through to Claude Code's own API, except the Remote Control session family when the door serves that surface itself (`rcSelfHostRoute`, the self-hosted mode's route). Anything else is unrouted.
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
  return async (request) => await Promise.resolve(resolve(request));
}

/** The credential headers one resolved provider credential becomes on the wire, in the form Claude Code itself gives that target: a bearer or OAuth token as `Authorization`, an API key as `x-api-key`. */
function providerCredentialHeaders(credential: ResolvedCredential): Record<string, string> {
  return credential.target === "apiKey" ? { "x-api-key": credential.token } : { authorization: `Bearer ${credential.token}` };
}

/**
 * Wraps an `http` provider's route so the provider's own resolved credential, never whatever the child presented, authenticates upstream. The route names exactly one upstream whose credential is the provider's, so the door owns it there the way the codex translator already owns a codex provider's auth: the launcher does hand the child the same credential to present, but a session that presents something else must neither spend a wrong credential at the provider nor leak it to one (Remote Control's OAuth mode is exactly this: forced on beside a provider, Claude Code sends the stored OAuth bearer for inference whatever the environment says, which reached providers as live 401s). The swap sits in the route so it applies on both pipelines, after the headroom hop's redeem restores the client's headers at the direct listener: the provider's credential crosses neither headroom nor the plain-HTTP leg. Resolution runs per request over the block this resolution just read, so an edited credential applies to the next request exactly as an edited base URL does; a block none of whose sources yields a token is answered as an Anthropic-shaped error naming the provider, never forwarded with the client's credential instead.
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
