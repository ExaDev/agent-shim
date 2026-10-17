import { CatalogueFetchError, catalogueCachePath, fetchCatalogue, type CatalogueCache, type CatalogueFetch } from "./providerCatalogue";
import type { CredentialResolution } from "./credential";
import type { Provider } from "./config/schema";
import type { LayoutPaths } from "./paths";

/** The effects `refreshProviderCatalogue` needs: reading the provider, resolving its credential, asking the network, and storing the result. */
export interface RefreshCatalogueDeps {
  readonly paths: LayoutPaths;
  readonly readProvider: (name: string) => Provider | undefined;
  readonly resolveCredential: (name: string, provider: Provider) => CredentialResolution;
  readonly fetch: CatalogueFetch;
  readonly now: () => number;
  readonly write: (filePath: string, cache: CatalogueCache) => void;
}

/**
 * Fetches `name`'s catalogue with its own credential and stores it, returning what was stored. Throws when the provider does not exist, is not an `http` provider that opted into a catalogue, has no usable credential, or answers no catalogue at any candidate URL (`CatalogueFetchError`), leaving the previous cache in place.
 */
export async function refreshProviderCatalogue(name: string, deps: Readonly<RefreshCatalogueDeps>): Promise<CatalogueCache> {
  const provider = deps.readProvider(name);
  if (provider === undefined) {
    throw new CatalogueFetchError(`no provider named "${name}"`);
  }
  if ((provider.kind !== undefined && provider.kind !== "http") || provider.catalogue === undefined) {
    throw new CatalogueFetchError(`provider "${name}" has no catalogue configured: set one with \`agent-shim provider set ${name} --catalogue-tier <tier>\``);
  }
  const resolution = deps.resolveCredential(name, provider);
  if (!resolution.ok) {
    throw new CatalogueFetchError(resolution.message);
  }
  const cache = await fetchCatalogue({ provider, catalogue: provider.catalogue, credential: resolution.credential, fetch: deps.fetch, now: deps.now });
  deps.write(catalogueCachePath(deps.paths, name), cache);
  return cache;
}
