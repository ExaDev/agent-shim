import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CATALOGUE_MAX_AGE_MS,
  CATALOGUE_MODEL_ID_MAX_CHARS,
  CatalogueFetchError,
  catalogueCachePath,
  catalogueHeaders,
  catalogueMatchesSettings,
  catalogueSettingsPath,
  catalogueSettingsText,
  parseCatalogueSettings,
  catalogueSettingsFingerprint,
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

/** The statuses either side of the redirect range, which a read answers as a redirect only inside it. */
const FIRST_REDIRECT_STATUS = 300;
const PERMANENT_REDIRECT_STATUS = 308;
const LAST_REDIRECT_STATUS = 399;
const FIRST_CLIENT_ERROR_STATUS = 400;

describe("catalogueCachePath", () => {
  const paths = buildLayoutPaths("/home/test/.agent-shim");

  it("places a provider's cache directly inside the catalogues directory", () => {
    expect(catalogueCachePath(paths, "z.ai")).toBe("/home/test/.agent-shim/catalogues/z.ai.json");
  });

  it("isolates caches belonging to different supervisors", () => {
    const generation = "10000000-0000-4000-8000-000000000001";
    expect(catalogueCachePath(paths, "z.ai", 1, generation)).not.toBe(catalogueCachePath(paths, "z.ai", 2, generation));
    expect(catalogueCachePath(paths, "z.ai", 1, generation)).not.toBe(catalogueCachePath(paths, "z.ai"));
  });

  it("rejects a supervisor cache path without a generation", () => {
    expect(() => catalogueCachePath(paths, "z.ai", 1)).toThrow("generation");
  });

  it("isolates generations that reuse the same supervisor PID", () => {
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    expect(catalogueCachePath(paths, "z.ai", 1, first)).not.toBe(catalogueCachePath(paths, "z.ai", 1, second));
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

describe("catalogueUrls with a base URL carrying a query", () => {
  it("appends the catalogue path to the path, before the query, which is kept for the request", () => {
    expect(catalogueUrls({ baseUrl: "https://api.example.com/anthropic?key=abc123" }, {})).toEqual(["https://api.example.com/anthropic/v1/models?key=abc123", "https://api.example.com/v1/models?key=abc123"]);
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

  it("reads visible account models by slug while excluding hidden models", () => {
    expect(parseCatalogueBody({ models: [{ slug: "gpt-visible", display_name: "Visible", visibility: "list" }, { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" }] })).toEqual([{ id: "gpt-visible", name: "Visible" }]);
  });

  it("excludes hidden account models even when they carry an id", () => {
    expect(parseCatalogueBody({ models: [{ id: "gpt-hidden", slug: "gpt-hidden", visibility: "hide" }] })).toEqual([]);
  });

  it("keeps a generic provider model that includes an unrelated slug", () => {
    expect(parseCatalogueBody({ data: [{ id: "a", slug: "friendly-name" }] })).toEqual([{ id: "a" }]);
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

  it("is stale when it was fetched after now, since the clock has stepped back and its age cannot be told", () => {
    expect(isCatalogueStale(cache, FETCHED_AT - 1)).toBe(true);
    expect(isCatalogueStale(cache, FETCHED_AT)).toBe(false);
  });
});

/** Statuses either side of the 3xx range a redirect answer lies in. */
const REDIRECT_PERMANENT = 308;
const REDIRECT_MOVED = 301;
const REDIRECT_FOUND = 302;
const REDIRECT_SEE_OTHER = 303;
const REDIRECT_TEMPORARY = 307;
const NOT_MODIFIED = 304;
const LAST_REDIRECT = 399;
const FIRST_CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
const OK_EMPTY = 200;
/** The candidate URLs a provider with no catalogue URL of its own is asked. */
const READ_CANDIDATES = 2;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

describe("fetchCatalogue", () => {
  const params = (fetch: CatalogueFetch) => ({ provider: PROVIDER, catalogue: {}, credential: CREDENTIAL, fetch, now: () => NOW });

  it("returns the first URL that lists models, with the credential's headers", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: 200, body: { data: [{ id: "a" }] } });

    expect(await fetchCatalogue(params(fetch))).toEqual({ fetchedAt: NOW, url: "https://api.example.com/anthropic/v1/models", models: [{ id: "a" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toEqual({ authorization: "Bearer secret-token", "anthropic-version": "2023-06-01" });
  });

  it.each([[REDIRECT_PERMANENT, true], [REDIRECT_MOVED, true], [REDIRECT_FOUND, true], [REDIRECT_SEE_OTHER, true], [REDIRECT_TEMPORARY, true], [FIRST_REDIRECT_STATUS, false], [NOT_MODIFIED, false], [LAST_REDIRECT, false], [FIRST_CLIENT_ERROR, false], [SERVER_ERROR, false], [OK_EMPTY, false]])("marks the failure as a redirect only when a candidate answered with a 3xx (status %i: %s)", async (status, redirected) => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status, body: status === OK_EMPTY ? { data: [] } : undefined });
    const error: unknown = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CatalogueFetchError);
    expect(error instanceof CatalogueFetchError && error.redirected).toBe(redirected);
  });

  it.each([[UNAUTHORIZED_STATUS, true], [FORBIDDEN_STATUS, true], [FIRST_CLIENT_ERROR, false], [SERVER_ERROR, false]])("marks the failure as the credential's only when a candidate answered 401 or 403 (status %i: %s)", async (status, unauthorised) => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status, body: undefined });
    const error: unknown = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);
    expect(error instanceof CatalogueFetchError && error.unauthorised).toBe(unauthorised);
  });

  it.each([
    ["a 401 then a server error", [UNAUTHORIZED_STATUS, SERVER_ERROR], false],
    ["a server error then a 401", [SERVER_ERROR, UNAUTHORIZED_STATUS], false],
    ["a 403 then a timeout", [FORBIDDEN_STATUS, "timeout"], false],
    ["a timeout then a 403", ["timeout", FORBIDDEN_STATUS], false],
    ["a 401 then a 403", [UNAUTHORIZED_STATUS, FORBIDDEN_STATUS], true],
    ["two 403s", [FORBIDDEN_STATUS, FORBIDDEN_STATUS], true],
    ["a server error then a timeout", [SERVER_ERROR, "timeout"], false],
    ["a timeout then a server error", ["timeout", SERVER_ERROR], false],
    ["two timeouts", ["timeout", "timeout"], false],
  ] as const)("marks the failure as the credential's only when every candidate that failed refused it: %s", async (_label, answers, unauthorised) => {
    let asked = 0;
    const fetch = vi.fn<CatalogueFetch>(async () => {
      const answer = answers[asked];
      asked += 1;
      if (answer === "timeout" || answer === undefined) throw new Error("timed out");
      return await Promise.resolve({ status: answer, body: undefined });
    });
    const error: unknown = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);
    expect(fetch).toHaveBeenCalledTimes(READ_CANDIDATES);
    expect(error instanceof CatalogueFetchError && error.unauthorised).toBe(unauthorised);
  });

  it("keeps the redirect a first candidate answered with when a later one fails otherwise", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status: REDIRECT_PERMANENT, body: undefined }).mockResolvedValueOnce({ status: SERVER_ERROR, body: undefined });
    const error: unknown = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error instanceof CatalogueFetchError && error.redirected).toBe(true);
  });

  it.each([[true, false], [false, true], [undefined, false]])("says a redirect carried no Location (%j) only when none of the redirects it met did", async (located, unlocated) => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: REDIRECT_PERMANENT, body: undefined, ...(located === undefined ? {} : { located }) });
    const error: unknown = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);
    expect(error instanceof CatalogueFetchError && error.redirected).toBe(true);
    expect(error instanceof CatalogueFetchError && error.unlocated).toBe(unlocated);
  });

  it("keeps a Location a first candidate's redirect carried when a later redirect carried none, and says none for a failure that was no redirect", async () => {
    const mixed = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status: REDIRECT_PERMANENT, body: undefined, located: true }).mockResolvedValueOnce({ status: REDIRECT_PERMANENT, body: undefined, located: false });
    const error: unknown = await fetchCatalogue(params(mixed)).catch((caught: unknown) => caught);
    expect(error instanceof CatalogueFetchError && error.unlocated).toBe(false);
    const plain = vi.fn<CatalogueFetch>().mockResolvedValue({ status: SERVER_ERROR, body: undefined });
    const failure: unknown = await fetchCatalogue(params(plain)).catch((caught: unknown) => caught);
    expect(failure instanceof CatalogueFetchError && failure.unlocated).toBe(false);
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

describe("fetchCatalogue with a base URL carrying a credential", () => {
  const SECRET_PROVIDER = { baseUrl: "https://user:hunter2@api.example.com/anthropic?key=abc123" };
  const params = (fetch: CatalogueFetch) => ({ provider: SECRET_PROVIDER, catalogue: {}, credential: CREDENTIAL, fetch, now: () => NOW });

  it("requests the whole URL but stores and reports it without userinfo or query", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: 200, body: { data: [{ id: "a" }] } });

    const cache = await fetchCatalogue(params(fetch));

    expect(fetch.mock.calls[0]?.[0]).toContain("key=abc123");
    expect(cache.url).toBe("https://api.example.com/anthropic/v1/models");
  });

  it("names no userinfo or query in the failure message", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status: 404, body: undefined }).mockRejectedValueOnce(new Error("timed out"));

    const error = await fetchCatalogue(params(fetch)).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("no catalogue from https://api.example.com/anthropic/v1/models: status 404; https://api.example.com/v1/models: timed out");
  });

  it("names no userinfo or query when the configured catalogue URL carries them", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: 500, body: undefined });

    const error = await fetchCatalogue({ ...params(fetch), catalogue: { url: "https://user:hunter2@api.example.com/models?key=abc123" } }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("no catalogue from https://api.example.com/models: status 500");
  });

  it.each([
    [FIRST_REDIRECT_STATUS, "no redirect"],
    [PERMANENT_REDIRECT_STATUS, "a redirect"],
    [NOT_MODIFIED, "no redirect"],
    [LAST_REDIRECT_STATUS, "no redirect"],
    [FIRST_CLIENT_ERROR_STATUS, "no redirect"],
  ])("names status %i as %s", async (status, kind) => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status, body: undefined });

    const error = await fetchCatalogue({ ...params(fetch), catalogue: { url: "https://api.example.com/models" } }).catch((caught: unknown) => caught);

    const redirect = "a redirect, which is not followed: set the provider's base URL (or its catalogue.url) to the address it redirects to";
    expect((error as Error).message).toBe(`no catalogue from https://api.example.com/models: status ${String(status)}${kind === "a redirect" ? `, ${redirect}` : ""}`);
  });
});

describe("a model id a catalogue lists", () => {
  it.each([
    ["one made of control characters", "a\nfront door: forged"],
    ["one that holds a tab", "a\tb"],
    ["one that holds DEL", "a\u007fb"],
    ["one that holds a C1 control", "a\u009bb"],
    ["one that holds a line separator", "a\u2028b"],
    ["one that holds a paragraph separator", "a\u2029b"],
    ["one that holds a zero-width joiner", "a\u200db"],
    ["one that holds a bidirectional override", "a\u202eb"],
    ["one past the bound", "x".repeat(CATALOGUE_MODEL_ID_MAX_CHARS + 1)],
  ])("is not taken: %s, as a bare id or as an object's id", (_label, id) => {
    expect(parseCatalogueBody({ data: [id, { id }, { id: "kept" }] })).toEqual([{ id: "kept" }]);
  });

  it("is taken at exactly the bound, and trimmed before it is measured", () => {
    const longest = "x".repeat(CATALOGUE_MODEL_ID_MAX_CHARS);
    expect(parseCatalogueBody({ data: [{ id: ` ${longest} ` }] })).toEqual([{ id: longest }]);
  });
});

describe("a display name a catalogue gives a model", () => {
  const UNSAFE_NAMES: readonly (readonly [string, string])[] = [
    ["one made of control characters", "Alpha\nfront door: forged"],
    ["one that holds a tab", "Al\tpha"],
    ["one that holds DEL", "Al\u007fpha"],
    ["one that holds a C1 control", "Al\u009bpha"],
    ["one that holds a line separator", "Al\u2028pha"],
    ["one that holds a zero-width joiner", "Al\u200dpha"],
    ["one that holds a bidirectional override", "Al\u202epha"],
    ["one past the bound", "x".repeat(CATALOGUE_MODEL_ID_MAX_CHARS + 1)],
  ];

  it.each(UNSAFE_NAMES)("is dropped, and the model listed under its id alone: %s, as display_name or as name", (_label, name) => {
    expect(parseCatalogueBody({ data: [{ id: "a", display_name: name }, { id: "b", name }, { id: "c", display_name: name, name: "Fine" }] })).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("is dropped when it is empty or only blanks", () => {
    expect(parseCatalogueBody({ data: [{ id: "a", display_name: "" }, { id: "b", name: "   " }] })).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("is kept at exactly the bound, trimmed before it is measured, and kept when it is plain", () => {
    const longest = "x".repeat(CATALOGUE_MODEL_ID_MAX_CHARS);
    expect(parseCatalogueBody({ data: [{ id: "a", display_name: ` ${longest} ` }, { id: "b", name: "Beta Two" }] })).toEqual([{ id: "a", name: longest }, { id: "b", name: "Beta Two" }]);
  });

  it.each(UNSAFE_NAMES)("makes a stored catalogue that holds it no catalogue, so it is fetched again: %s", (_label, name) => {
    const cache = { fetchedAt: 1, url: "https://example.test", models: [{ id: "a", name }] };
    expect(parseCatalogueCache(JSON.stringify(cache))).toBeUndefined();
    expect(parseCatalogueCache(JSON.stringify({ ...cache, models: [{ id: "a", name: "Alpha" }] }))).toEqual({ ...cache, models: [{ id: "a", name: "Alpha" }] });
  });
});

describe("catalogueSettingsPath", () => {
  it("is settings/<name>.json in the catalogue directory, which releases that read the digest file are documented to find", () => {
    const paths = buildLayoutPaths("/home/user/.agent-shim");
    expect(catalogueSettingsPath(paths, "spark")).toBe(path.join(paths.catalogueDir, "settings", "spark.json"));
    expect(catalogueSettingsPath(paths, "spark")).not.toBe(catalogueCachePath(paths, "spark"));
  });
});

describe("parseCatalogueSettings", () => {
  const FETCHED_AT = 5;
  const own = { settings: "digest", fetchedAt: FETCHED_AT };

  it("reads the digest file catalogueSettingsText writes", () => {
    expect(parseCatalogueSettings(catalogueSettingsText("digest", FETCHED_AT))).toEqual(own);
  });

  it.each([
    ["an extra key", JSON.stringify({ ...own, extra: true })],
    ["an empty settings string", JSON.stringify({ settings: "", fetchedAt: FETCHED_AT })],
    ["a fetchedAt that is no number", JSON.stringify({ settings: "digest", fetchedAt: "5" })],
    ["no fetchedAt", JSON.stringify({ settings: "digest" })],
    ["text that is no JSON", "{ not json"],
    ["a JSON value that is no object", "5"],
  ])("refuses %s, as no digest", (_label, text) => {
    expect(parseCatalogueSettings(text)).toBeUndefined();
  });

  it("is none for a file that does not exist", () => {
    expect(parseCatalogueSettings(undefined)).toBeUndefined();
  });
});

describe("catalogueSettingsFingerprint", () => {
  const provider = { baseUrl: "https://user:hunter2@a.example/v1?key=queryvalue", catalogue: { tier: "sonnet" as const }, credential: { sources: [{ command: ["op", "read", "op://v/i/f"] as [string, ...string[]] }], target: "bearer" as const } };

  it("is a digest that holds nothing of what it was made from", () => {
    const fingerprint = catalogueSettingsFingerprint(provider);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    for (const material of ["hunter2", "queryvalue", "op://", "read"]) {
      expect(fingerprint).not.toContain(material);
    }
  });

  it("is the same for the same settings written in another key order, and does not depend on the filters, which are applied over the stored list", () => {
    const reordered = { credential: { target: "bearer" as const, sources: [{ command: ["op", "read", "op://v/i/f"] as [string, ...string[]] }] }, catalogue: { exclude: ["x"], tier: "haiku" as const }, baseUrl: provider.baseUrl };
    expect(catalogueSettingsFingerprint(reordered)).toBe(catalogueSettingsFingerprint(provider));
  });

  it.each([
    ["the base URL", { ...provider, baseUrl: "https://a.example/v2" }],
    ["the catalogue URL", { ...provider, catalogue: { tier: "sonnet" as const, url: "https://a.example/models" } }],
    ["an argument of a command source", { ...provider, credential: { ...provider.credential, sources: [{ command: ["op", "read", "op://v/i/g"] as [string, ...string[]] }] } }],
  ])("differs when %s differs", (_label, other) => {
    expect(catalogueSettingsFingerprint(other)).not.toBe(catalogueSettingsFingerprint(provider));
  });

  it("differs between a provider with a catalogue and one without, whatever else it holds", () => {
    const without = { baseUrl: provider.baseUrl, credential: provider.credential };
    expect(catalogueSettingsFingerprint(without)).not.toBe(catalogueSettingsFingerprint(provider));
    expect(catalogueSettingsFingerprint({ ...without, catalogue: { tier: "sonnet" } })).toBe(catalogueSettingsFingerprint(provider));
  });

  it("matches a stored list only when the list records the same settings", () => {
    const own = catalogueSettingsFingerprint(provider);
    const cache = { fetchedAt: 5 };
    expect(catalogueMatchesSettings({ settings: own, fetchedAt: 5 }, cache, provider)).toBe(true);
    expect(catalogueMatchesSettings({ settings: "other", fetchedAt: 5 }, cache, provider)).toBe(false);
    expect(catalogueMatchesSettings({ settings: own, fetchedAt: 4 }, cache, provider)).toBe(false);
    expect(catalogueMatchesSettings(undefined, cache, provider)).toBe(false);
  });
});

describe("the advice a redirect's answer carries", () => {
  const provider = { baseUrl: "https://api.example.com/anthropic" };
  const ADVICE = "to the address it redirects to";

  it("is given only for a redirect that carried a Location, and a fetch that cannot tell is read as one that did", async () => {
    const message = async (located: boolean | undefined): Promise<string> => {
      const fetch: CatalogueFetch = async () => await Promise.resolve({ status: PERMANENT_REDIRECT_STATUS, body: undefined, ...(located === undefined ? {} : { located }) });
      const error: unknown = await fetchCatalogue({ provider, catalogue: { url: "https://api.example.com/models" }, credential: CREDENTIAL, fetch, now: () => NOW }).then(() => undefined, (cause: unknown) => cause);
      return error instanceof Error ? error.message : "";
    };
    expect(await message(true)).toContain(ADVICE);
    expect(await message(undefined)).toContain(ADVICE);
    expect(await message(false)).not.toContain(ADVICE);
    expect(await message(false)).toContain("with no Location");
  });
});
