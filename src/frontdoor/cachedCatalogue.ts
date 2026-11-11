import type { HttpProvider } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realFsPort } from "../realPorts";
import type { createProviderRouteResolver } from "./providerRoute";
import { catalogueMatchesSettings, filterCatalogue, parseCatalogueCache, parseCatalogueSettings, type CatalogueDigest, type CatalogueModel } from "../providerCatalogue";
import { StoredCatalogue, TolerantReader, raiseUnreadableCatalogue } from "../storedCatalogue";

/**
 * The models `name`'s stored catalogue last listed, after the provider's own `include` and `exclude` patterns: none when the provider did not opt into a catalogue, none has been fetched, or the stored one has no digest of the settings it was fetched under that equals the provider's current ones. Reads the stored files only, never the network. A file that exists and cannot be read raises an `UnreadableCatalogueError` (the fault, never the path) for the caller that answers for this one provider.
 *
 * Parses a provider's stored files once for as long as their revisions (`revisionOf`, a stat of each) are the ones it parsed, instead of on every call: the door asks for a provider's default model on every request that selects the provider by its bare name, and an unchanged pair of files has the same answer. A revision is taken before and after the read and kept only when the two agree, so a write that lands while the files are read is not kept under the earlier revision; a file `revisionOf` cannot name is read on every call. The provider's own settings and filters are applied to the kept parse on every call, so two providers (or one edited) share nothing but the parse.
 */
export function cachingCatalogueModels(stored: StoredCatalogue, revisionOf: (filePath: string) => string | undefined): (name: string, provider: Readonly<Pick<HttpProvider, "baseUrl" | "catalogue" | "credential">>) => readonly CatalogueModel[] {
  const parsed = new Map<string, { readonly revision: string; readonly cache: ReturnType<typeof parseCatalogueCache>; readonly settings: CatalogueDigest | undefined }>();
  const listed = (cache: ReturnType<typeof parseCatalogueCache>, settings: CatalogueDigest | undefined, provider: Readonly<Pick<HttpProvider, "baseUrl" | "catalogue" | "credential">>): readonly CatalogueModel[] =>
    provider.catalogue === undefined || cache === undefined || !catalogueMatchesSettings(settings, cache, provider) ? [] : filterCatalogue(cache.models, provider.catalogue);
  return (name, provider) => {
    if (provider.catalogue === undefined) {
      return [];
    }
    const revision = stored.revision(name, revisionOf);
    const kept = parsed.get(name);
    if (revision !== undefined && kept?.revision === revision) {
      return listed(kept.cache, kept.settings, provider);
    }
    const cache = parseCatalogueCache(stored.cacheText(name));
    const settings = parseCatalogueSettings(stored.digestText(name));
    if (revision !== undefined && stored.revision(name, revisionOf) === revision) {
      parsed.set(name, { revision, cache, settings });
    }
    return listed(cache, settings, provider);
  };
}

/** The port the route resolver reads a provider's stored catalogue through, for the first model a bare provider name falls back to. */
export function storedCatalogueModelsPort(paths: LayoutPaths): Pick<Parameters<typeof createProviderRouteResolver>[0], "catalogueModelsOf"> {
  return { catalogueModelsOf: cachingCatalogueModels(new StoredCatalogue(paths, new TolerantReader((file) => realFarmFs.readFileUtf8(file), raiseUnreadableCatalogue)), (file) => realFsPort.fileRevision?.(file)) };
}
