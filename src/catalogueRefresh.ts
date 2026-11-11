import { CATALOGUE_REFRESH_TIMEOUT_MS, CatalogueFetchError, catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, fetchCatalogue, parseCatalogueBody, type CatalogueCache, type CatalogueFetch } from "./providerCatalogue";
import { catalogueCredentialFingerprint } from "./codex/catalogueCredential";
import type { CodexAuthStore, CodexCredentials } from "./codex/auth";
import { HTTP_STATUS } from "./codex/http";
import type { CredentialResolution } from "./credential";
import type { HttpProvider, Provider } from "./config/schema";
import type { LayoutPaths } from "./paths";

/** The first HTTP status that is not a successful response. */
const HTTP_REDIRECTION_START = 300;

/** The effects `refreshProviderCatalogue` needs: reading the provider, resolving its credential, asking the network, and storing the result. */
export interface RefreshCatalogueDeps {
  readonly paths: LayoutPaths;
  readonly readProvider: (name: string) => Provider | undefined;
  readonly resolveCredential: (name: string, provider: HttpProvider) => CredentialResolution;
  readonly fetch: CatalogueFetch;
  readonly codexAuth?: CodexAuthStore;
  readonly codexVersion?: string;
  readonly now: () => number;
  readonly write: (filePath: string, cache: CatalogueCache) => void;
  /** Stores the digest of the settings an `http` catalogue fetched at `fetchedAt` was fetched under, in the file `catalogueSettingsPath` names. */
  readonly writeSettings: (filePath: string, settings: string, fetchedAt: number) => void;
  /** Removes the digest file `catalogueSettingsPath` names, when there is one. */
  readonly removeSettings: (filePath: string) => void;
  readonly writeBinding: (name: string, fingerprint: string) => void;
}

/**
 * Fetches `name`'s catalogue with its own credential and stores it, returning what was stored. Throws when the provider does not exist, is not an `http` provider that opted into a catalogue, has no usable credential, or answers no catalogue at any candidate URL (`CatalogueFetchError`), leaving the previous cache in place.
 */
export async function refreshProviderCatalogue(name: string, deps: Readonly<RefreshCatalogueDeps>): Promise<CatalogueCache> {
  const provider = deps.readProvider(name);
  if (provider === undefined) {
    throw new CatalogueFetchError(`no provider named "${name}"`);
  }
  if (provider.kind === "codex" && deps.codexAuth !== undefined) {
    let credential = await deps.codexAuth.current();
    const cli = provider.codex?.login !== "chatgpt-sign-in";
    let url = "https://api.openai.com/v1/models";
    if (cli) {
      const version = deps.codexVersion;
      if (version === undefined) throw new CatalogueFetchError("Codex CLI version is unavailable");
      url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`;
    }
    const headers = (value: CodexCredentials): Record<string, string> => ({ authorization: `Bearer ${value.accessToken}`, ...(cli && value.accountId !== undefined ? { "chatgpt-account-id": value.accountId } : {}), ...(cli ? { originator: "codex_cli_rs" } : {}) });
    let response = await deps.fetch(url, headers(credential), CATALOGUE_REFRESH_TIMEOUT_MS);
    if (response.status === HTTP_STATUS.unauthorized) {
      credential = await deps.codexAuth.refresh(credential.accessToken);
      response = await deps.fetch(url, headers(credential), CATALOGUE_REFRESH_TIMEOUT_MS);
    }
    if (response.status < HTTP_STATUS.ok || response.status >= HTTP_REDIRECTION_START) throw new CatalogueFetchError(`Codex model catalogue returned HTTP ${String(response.status)}`);
    if (typeof response.body !== "object" || response.body === null || !("models" in response.body) || !Array.isArray(response.body.models)) {
      throw new CatalogueFetchError("invalid Codex model catalogue: models must be an array");
    }
    const credentialFingerprint = catalogueCredentialFingerprint(cli, credential.accessToken, credential.accountId);
    const current = await deps.codexAuth.current();
    if (catalogueCredentialFingerprint(cli, current.accessToken, current.accountId) !== credentialFingerprint) throw new CatalogueFetchError("Codex account changed during catalogue refresh");
    const cache = { fetchedAt: deps.now(), url, models: [...parseCatalogueBody(response.body)], credentialFingerprint };
    deps.writeBinding(name, credentialFingerprint);
    deps.write(catalogueCachePath(deps.paths, name), cache);
    return cache;
  }
  if ((provider.kind !== undefined && provider.kind !== "http") || provider.catalogue === undefined) {
    throw new CatalogueFetchError(`provider "${name}" has no catalogue configured: set one with \`agent-shim provider set ${name} --catalogue-tier <tier>\``);
  }
  const resolution = deps.resolveCredential(name, provider);
  if (!resolution.ok) {
    throw new CatalogueFetchError(resolution.message);
  }
  const cache = await fetchCatalogue({ provider, catalogue: provider.catalogue, credential: resolution.credential, fetch: deps.fetch, now: deps.now });
  // The digest goes first and comes back last: whatever stops the refresh in between (a crash, a failed write) leaves a catalogue with no digest, which no reader uses, and never an earlier digest over a catalogue fetched under other settings.
  const settingsFile = catalogueSettingsPath(deps.paths, name);
  deps.removeSettings(settingsFile);
  deps.write(catalogueCachePath(deps.paths, name), cache);
  deps.writeSettings(settingsFile, catalogueSettingsFingerprint(provider), cache.fetchedAt);
  return cache;
}
