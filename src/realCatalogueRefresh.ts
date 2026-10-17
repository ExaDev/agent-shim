import { refreshProviderCatalogue } from "./catalogueRefresh";
import { writeJsonAtomic } from "./config/store";
import { resolveCredential } from "./credential";
import type { CatalogueCache, CatalogueFetch } from "./providerCatalogue";
import type { LayoutPaths } from "./paths";
import { readProvider } from "./providersStore";
import { realCredentialPort } from "./realPorts";

/** One real GET: the status and the parsed JSON body, which is `undefined` when the body is not JSON. */
const realCatalogueFetch: CatalogueFetch = async (url, headers, timeoutMs) => {
  const response = await fetch(url, { headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: undefined };
  }
};

/** Fetches and stores `name`'s catalogue for real: its provider file, its own credential (through the real credential port and its cache), the network and an atomic write. Shared by the door's refresh child and `agent-shim provider models --refresh`. */
export async function refreshCatalogueForReal(paths: LayoutPaths, name: string, env: Readonly<Record<string, string | undefined>>): Promise<CatalogueCache> {
  return await refreshProviderCatalogue(name, {
    paths,
    readProvider: (providerName) => readProvider(paths, providerName),
    resolveCredential: (providerName, provider) => resolveCredential({ credential: provider.credential, env, port: realCredentialPort, subject: `provider ${providerName}` }),
    fetch: realCatalogueFetch,
    now: () => Date.now(),
    write: (filePath, cache) => {
      writeJsonAtomic(filePath, cache);
    },
  });
}
