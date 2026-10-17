import { describe, expect, it, vi } from "vitest";

import { refreshProviderCatalogue, type RefreshCatalogueDeps } from "./catalogueRefresh";
import type { Provider } from "./config/schema";
import { buildLayoutPaths } from "./paths";
import { CatalogueFetchError, catalogueCachePath, type CatalogueCache } from "./providerCatalogue";

const paths = buildLayoutPaths("/home/test/.agent-shim");
const NOW = Date.parse("2026-01-01T00:00:00Z");
const CREDENTIAL = { sources: [{ env: "TOKEN" }] };
const catalogued: Provider = { displayName: "A", baseUrl: "https://a.example/api", credential: CREDENTIAL, catalogue: { tier: "sonnet" } };

function deps(overrides: Partial<RefreshCatalogueDeps> = {}) {
  const write = vi.fn<(filePath: string, cache: CatalogueCache) => void>();
  const fetch = vi.fn<RefreshCatalogueDeps["fetch"]>().mockResolvedValue({ status: 200, body: { data: [{ id: "m1" }] } });
  const all: RefreshCatalogueDeps = {
    paths,
    readProvider: () => catalogued,
    resolveCredential: () => ({ ok: true, credential: { target: "bearer", token: "tok", source: { env: "TOKEN" }, warnings: [] } }),
    fetch,
    now: () => NOW,
    write,
    ...overrides,
  };
  return { all, write, fetch };
}

describe("refreshProviderCatalogue", () => {
  it("fetches with the provider's credential and stores the result in the provider's cache file", async () => {
    const { all, write, fetch } = deps();

    const cache = await refreshProviderCatalogue("a", all);

    expect(cache).toEqual({ fetchedAt: NOW, url: "https://a.example/api/v1/models", models: [{ id: "m1" }] });
    expect(write).toHaveBeenCalledWith(catalogueCachePath(paths, "a"), cache);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ authorization: "Bearer tok" });
  });

  it("refuses a provider that does not exist, has no catalogue setting, or is not an http provider, without a request", async () => {
    const missing = deps({ readProvider: () => undefined });
    await expect(refreshProviderCatalogue("a", missing.all)).rejects.toThrow('no provider named "a"');
    const plain = deps({ readProvider: () => ({ displayName: "A", baseUrl: "https://a.example", credential: CREDENTIAL }) });
    await expect(refreshProviderCatalogue("a", plain.all)).rejects.toThrow("has no catalogue configured");
    const codex = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL }) });
    await expect(refreshProviderCatalogue("a", codex.all)).rejects.toThrow("has no catalogue configured");
    expect(missing.fetch).not.toHaveBeenCalled();
    expect(plain.fetch).not.toHaveBeenCalled();
    expect(codex.fetch).not.toHaveBeenCalled();
  });

  it("refuses with the credential resolution's message and makes no request when there is no usable credential", async () => {
    const { all, fetch, write } = deps({ resolveCredential: () => ({ ok: false, message: "no source yielded a token" }) });

    await expect(refreshProviderCatalogue("a", all)).rejects.toThrow("no source yielded a token");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves the previous cache in place when no URL lists a model", async () => {
    const { all, write } = deps({ fetch: vi.fn<RefreshCatalogueDeps["fetch"]>().mockResolvedValue({ status: 500, body: undefined }) });

    await expect(refreshProviderCatalogue("a", all)).rejects.toBeInstanceOf(CatalogueFetchError);
    expect(write).not.toHaveBeenCalled();
  });
});
