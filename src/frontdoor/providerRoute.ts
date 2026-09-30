import { ConfigValidationError } from "../config/load";
import { isCodexProvider, type CodexProvider, type Provider } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { resolveCodexConfig } from "../codex/translate";
import { LegacyProviderFileError, loadProvider } from "../providers";
import type { FsPort } from "../launcher/ports";
import { createCodexRouteMount } from "./codexMount";
import { CONNECT_INTERCEPT_HOST, HTTPS_PORT } from "./connect";
import { createPassthroughRoute } from "./passthrough";
import type { RouteResolution } from "./pipeline";
import { PROVIDER_PATH_PREFIX, directOrigin, parseProviderPath, type RoutedRequest } from "./route";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects: the in-process codex translator for a `codex` provider, the pass-through route for an `http` one. A bare `/v1/...` target (what the CONNECT surface hands the pipeline from a terminated OAuth session) rides a pass-through to Claude Code's own API. Anything else is unrouted.
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
}): (request: RoutedRequest) => Promise<RouteResolution> {
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
      route: passthroughFor(`http:${provider}`, {
        baseUrl: httpProvider.baseUrl,
        stripPrefix: `${PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`,
        headroomUpstream: directOrigin(deps.directPort()),
      }),
    };
  };
  return async (request) => await Promise.resolve(resolve(request));
}
