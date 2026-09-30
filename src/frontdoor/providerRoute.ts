import { ConfigValidationError } from "../config/load";
import { isCodexProvider, type CodexProvider } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { resolveCodexConfig } from "../codex/translate";
import { LegacyProviderFileError, loadProvider } from "../providers";
import type { FsPort } from "../launcher/ports";
import { createCodexRouteMount } from "./codexMount";
import type { RouteResolution } from "./pipeline";
import { parseProviderPath, providerBaseUrl, type RoutedRequest } from "./route";

/**
 * Resolves the route a request's target names: `/providers/<name>/...` reads the provider file fresh on every request (so an edited provider applies to the next request with no restart) and answers with the route its kind selects. Any other target is unrouted.
 *
 * In this stage only a `codex` provider resolves to a served route, mounted as the in-process translator; an `http` provider is refused with a named error until the pass-through route lands, so a misdirected session fails loudly rather than silently tunnelling.
 */
export function createProviderRouteResolver(deps: {
  /** Reads provider files, the same filesystem port the launcher uses. */
  readonly fs: FsPort;
  readonly providersDir: string;
  /** The ports the codex translation route needs, already wired to the real auth store and upstream fetch. */
  readonly codexPorts: Omit<CodexRoutePorts, "loadProvider">;
  /** The front door's own loopback port, so a headroom hop in front of a codex route can be told to forward back to this very listener. */
  readonly ownPort: () => number;
}): (request: RoutedRequest) => Promise<RouteResolution> {
  /** The resolution itself is synchronous: reading one provider file needs no await, and keeping it sync is what lets the async wrapper stay honest about its one await. */
  const resolve = (request: RoutedRequest): RouteResolution => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const scoped = parseProviderPath(path);
    if (scoped === undefined) {
      return { ok: false, status: HTTP_STATUS.notFound, message: `no such endpoint: ${path}` };
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
    if (!isCodexProvider(definition)) {
      return { ok: false, status: HTTP_STATUS.notFound, message: `provider ${provider} is an http provider, which the front door does not route directly yet` };
    }
    const codexProvider: CodexProvider = definition;
    return {
      ok: true,
      route: createCodexRouteMount(
        { ...deps.codexPorts, loadProvider: () => ({ ok: true, config: resolveCodexConfig(codexProvider.codex) }) },
        providerBaseUrl(deps.ownPort(), provider),
        provider,
      ),
    };
  };
  return async (request) => await Promise.resolve(resolve(request));
}
