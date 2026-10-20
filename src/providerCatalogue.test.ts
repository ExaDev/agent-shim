import { describe, expect, it, vi } from "vitest";

import {
  CATALOGUE_MAX_AGE_MS,
  CatalogueFetchError,
  catalogueCachePath,
  catalogueHeaders,
  catalogueUrls,
  fetchCatalogue,
  filterCatalogue,
  isCatalogueStale,
  parseCatalogueBody,
  parseCatalogueCache,
  type CatalogueFetch,
} from "./providerCatalogue";
import { InvalidProviderNameError } from "./config/names";
import { buildLayoutPaths } from "./paths";

const NOW = Date.parse("2026-01-02T00:00:00Z");
const CREDENTIAL = { target: "bearer", token: "secret-token" } as const;
const PROVIDER = { baseUrl: "https://api.example.com/anthropic/" };

describe("catalogueCachePath", () => {
  const paths = buildLayoutPaths("/home/test/.agent-shim");

  it("places a provider's cache directly inside the catalogues directory", () => {
    expect(catalogueCachePath(paths, "z.ai")).toBe("/home/test/.agent-shim/catalogues/z.ai.json");
  });

  it.each(["../x", "../../etc/passwd", "a/b", "", ".."])("refuses %j, which would reach a file outside the directory", (name) => {
    expect(() => catalogueCachePath(paths, name)).toThrow(InvalidProviderNameError);
  });
});

describe("catalogueUrls", () => {
  it("asks under the base URL and then under the host", () => {
    expect(catalogueUrls(PROVIDER, {})).toEqual(["https://api.example.com/anthropic/v1/models", "https://api.example.com/v1/models"]);
  });

  it("asks once when the base URL is the host", () => {
    expect(catalogueUrls({ baseUrl: "https://api.example.com" }, {})).toEqual(["https://api.example.com/v1/models"]);
  });

  it("asks only the configured URL when there is one", () => {
    expect(catalogueUrls(PROVIDER, { url: "https://api.example.com/paas/v4/models" })).toEqual(["https://api.example.com/paas/v4/models"]);
  });
});

describe("parseCatalogueBody", () => {
  it("reads Anthropic's and OpenAI's data list with display names", () => {
    expect(parseCatalogueBody({ data: [{ id: "a", display_name: "Model A" }, { id: "b", name: "Model B" }, { id: "c" }] })).toEqual([{ id: "a", name: "Model A" }, { id: "b", name: "Model B" }, { id: "c" }]);
  });

  it("reads a models list and a bare list of ids or objects", () => {
    expect(parseCatalogueBody({ models: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(parseCatalogueBody(["a", { id: "b" }])).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("keeps each id once, in the order given, and skips entries that name no model", () => {
    expect(parseCatalogueBody({ data: [{ id: "a" }, { id: "a" }, { id: "" }, { id: 3 }, null, "  ", { name: "x" }, { id: " b " }] })).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("yields nothing for a body that holds no list", () => {
    expect(parseCatalogueBody(undefined)).toEqual([]);
    expect(parseCatalogueBody("<html>")).toEqual([]);
    expect(parseCatalogueBody({ error: "no" })).toEqual([]);
  });
});

describe("filterCatalogue", () => {
  const models = [{ id: "glm-5" }, { id: "glm-5-air" }, { id: "gpt-oss" }, { id: "x/y:free" }];

  it("lists everything when no pattern is given", () => {
    expect(filterCatalogue(models, {})).toEqual(models);
  });

  it("keeps what an include pattern admits and drops what an exclude pattern names, exclude winning", () => {
    expect(filterCatalogue(models, { include: ["glm-*"] }).map((model) => model.id)).toEqual(["glm-5", "glm-5-air"]);
    expect(filterCatalogue(models, { exclude: ["*air", "gpt-*"] }).map((model) => model.id)).toEqual(["glm-5", "x/y:free"]);
    expect(filterCatalogue(models, { include: ["glm-*"], exclude: ["*air"] }).map((model) => model.id)).toEqual(["glm-5"]);
  });

  it("matches ids that contain slashes and colons", () => {
    expect(filterCatalogue(models, { include: ["x/**"] }).map((model) => model.id)).toEqual(["x/y:free"]);
  });
});

describe("catalogueHeaders", () => {
  it("sends a bearer token as authorization and an api key as x-api-key, with the API version", () => {
    expect(catalogueHeaders(CREDENTIAL)).toEqual({ authorization: "Bearer secret-token", "anthropic-version": "2023-06-01" });
    expect(catalogueHeaders({ target: "apiKey", token: "k" })).toEqual({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
  });
});

describe("parseCatalogueCache and isCatalogueStale", () => {
  const FETCHED_AT = Date.parse("2026-01-01T00:00:00Z");
  const cache = { fetchedAt: FETCHED_AT, url: "https://x/v1/models", models: [{ id: "a" }] };

  it("reads a stored cache and refuses text that is not one", () => {
    expect(parseCatalogueCache(JSON.stringify(cache))).toEqual(cache);
    expect(parseCatalogueCache(undefined)).toBeUndefined();
    expect(parseCatalogueCache("not json")).toBeUndefined();
    expect(parseCatalogueCache(JSON.stringify({ ...cache, extra: 1 }))).toBeUndefined();
    expect(parseCatalogueCache(JSON.stringify({ fetchedAt: "now" }))).toBeUndefined();
  });

  it("is stale from exactly the maximum age onwards", () => {
    expect(isCatalogueStale(cache, FETCHED_AT + CATALOGUE_MAX_AGE_MS - 1)).toBe(false);
    expect(isCatalogueStale(cache, FETCHED_AT + CATALOGUE_MAX_AGE_MS)).toBe(true);
  });
});

describe("fetchCatalogue", () => {
  const params = (fetch: CatalogueFetch) => ({ provider: PROVIDER, catalogue: {}, credential: CREDENTIAL, fetch, now: () => NOW });

  it("returns the first URL that lists models, with the credential's headers", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: 200, body: { data: [{ id: "a" }] } });

    expect(await fetchCatalogue(params(fetch))).toEqual({ fetchedAt: NOW, url: "https://api.example.com/anthropic/v1/models", models: [{ id: "a" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toEqual({ authorization: "Bearer secret-token", "anthropic-version": "2023-06-01" });
  });

  it("falls through a refusal, an empty list and a thrown error to the next URL", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status: 404, body: undefined }).mockResolvedValueOnce({ status: 200, body: { data: [{ id: "host-model" }] } });

    expect(await fetchCatalogue(params(fetch))).toMatchObject({ url: "https://api.example.com/v1/models", models: [{ id: "host-model" }] });
  });

  it("names every URL's outcome and never the credential when none lists a model", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status: 200, body: { data: [] } }).mockRejectedValueOnce(new Error("timed out"));

    const error = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CatalogueFetchError);
    expect((error as Error).message).toBe("no catalogue from https://api.example.com/anthropic/v1/models: no models listed; https://api.example.com/v1/models: timed out");
    expect((error as Error).message).not.toContain("secret-token");
  });
});
