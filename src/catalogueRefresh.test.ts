import { describe, expect, it, vi } from "vitest";

import { refreshProviderCatalogue, type RefreshCatalogueDeps } from "./catalogueRefresh";
import { catalogueCredentialFingerprint } from "./codex/catalogueCredential";
import { reportFatalError } from "./cliReport";
import { resolveCredential } from "./credential";
import type { Provider } from "./config/schema";
import { buildLayoutPaths } from "./paths";
import { CatalogueFetchError, catalogueCachePath, type CatalogueCache } from "./providerCatalogue";
import { fakeCredentials } from "./test-helpers";

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
    writeBinding: vi.fn<RefreshCatalogueDeps["writeBinding"]>(),
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

  it("fetches the signed-in account's visible models using its own grant", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "gpt-new", display_name: "New", visibility: "list" }, { slug: "hidden", visibility: "hide" }] } });
    const withAuth = { ...all, codexAuth: { current: async () => await Promise.resolve({ accessToken: "test-token", accountId: undefined }), refresh: vi.fn() } };
    await expect(refreshProviderCatalogue("c", withAuth)).resolves.toMatchObject({ models: [{ id: "gpt-new", name: "New" }] });
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", { authorization: "Bearer test-token" }, expect.any(Number));
  });

  it("publishes a non-secret account binding when a Codex catalogue is stored", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "gpt-new", visibility: "list" }] } });
    const writeBinding = vi.fn<RefreshCatalogueDeps["writeBinding"]>();
    const withAuth = { ...all, writeBinding, codexAuth: { current: async () => await Promise.resolve({ accessToken: "test-token", accountId: undefined }), refresh: vi.fn() } };
    await refreshProviderCatalogue("c", withAuth);
    expect(writeBinding).toHaveBeenCalledWith("c", catalogueCredentialFingerprint(false, "test-token", undefined));
  });

  it("preserves the catalogue when its account binding cannot be written", async () => {
    const { all, fetch, write } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "gpt-new", visibility: "list" }] } });
    const writeBinding = () => { throw new Error("binding write failed"); };
    const codexAuth = { current: async () => await Promise.resolve({ accessToken: "test-token", accountId: undefined }), refresh: vi.fn() };
    await expect(refreshProviderCatalogue("c", { ...all, writeBinding, codexAuth })).rejects.toThrow("binding write failed");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not publish a catalogue if the account changes during the request", async () => {
    const { all, fetch, write } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "old-account-model", visibility: "list" }] } });
    const current = vi.fn().mockResolvedValueOnce({ accessToken: "old-token", accountId: undefined }).mockResolvedValueOnce({ accessToken: "new-token", accountId: undefined });
    const writeBinding = vi.fn<RefreshCatalogueDeps["writeBinding"]>();
    await expect(refreshProviderCatalogue("c", { ...all, writeBinding, codexAuth: { current, refresh: vi.fn() } })).rejects.toThrow("Codex account changed during catalogue refresh");
    expect(write).not.toHaveBeenCalled();
    expect(writeBinding).not.toHaveBeenCalled();
  });

  it("fetches the Codex CLI account's catalogue with its workspace identifier", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "gpt-cli", visibility: "list" }] } });
    const withAuth = { ...all, codexAuth: { current: async () => await Promise.resolve({ accessToken: "cli-token", accountId: "workspace" }), refresh: vi.fn() }, codexVersion: "0.166.0" };
    await expect(refreshProviderCatalogue("c", withAuth)).resolves.toMatchObject({ models: [{ id: "gpt-cli" }] });
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/models?client_version=0.166.0", expect.objectContaining({ authorization: "Bearer cli-token", "chatgpt-account-id": "workspace" }), expect.any(Number));
  });

  it("refreshes a rejected account token and retries the model list once", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValueOnce({ status: 401, body: undefined }).mockResolvedValueOnce({ status: 200, body: { models: [{ slug: "gpt-new", visibility: "list" }] } });
    const refresh = vi.fn().mockResolvedValue({ accessToken: "new-token", accountId: undefined });
    const current = vi.fn().mockResolvedValueOnce({ accessToken: "old-token", accountId: undefined }).mockResolvedValue({ accessToken: "new-token", accountId: undefined });
    const withAuth = { ...all, codexAuth: { current, refresh } };
    await expect(refreshProviderCatalogue("c", withAuth)).resolves.toMatchObject({ models: [{ id: "gpt-new" }] });
    expect(refresh).toHaveBeenCalledWith("old-token");
    expect(fetch.mock.calls[1]?.[1]).toEqual({ authorization: "Bearer new-token" });
  });

  it("refuses a malformed account catalogue without replacing the saved one", async () => {
    const { all, fetch, write } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { error: "not a model list" } });
    const withAuth = { ...all, codexAuth: { current: async () => await Promise.resolve({ accessToken: "token", accountId: undefined }), refresh: vi.fn() } };
    await expect(refreshProviderCatalogue("c", withAuth)).rejects.toThrow("invalid Codex model catalogue");
    expect(write).not.toHaveBeenCalled();
  });

  it("binds the stored model list to the credential that fetched it", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL, codex: { login: "chatgpt-sign-in" } }) });
    fetch.mockResolvedValue({ status: 200, body: { models: [{ slug: "gpt-new", visibility: "list" }] } });
    const current = vi.fn().mockResolvedValueOnce({ accessToken: "first-account", accountId: undefined }).mockResolvedValueOnce({ accessToken: "first-account", accountId: undefined }).mockResolvedValue({ accessToken: "second-account", accountId: undefined });
    const withAuth = { ...all, codexAuth: { current, refresh: vi.fn() } };
    const first = await refreshProviderCatalogue("c", withAuth);
    const second = await refreshProviderCatalogue("c", withAuth);
    expect(first).toHaveProperty("credentialFingerprint", expect.any(String));
    expect(first).not.toHaveProperty("credentialFingerprint", second.credentialFingerprint);
  });

  it("reports when the Codex CLI version is unavailable before asking the backend", async () => {
    const { all, fetch } = deps({ readProvider: () => ({ kind: "codex", displayName: "C", credential: CREDENTIAL }) });
    const withAuth = { ...all, codexAuth: { current: async () => await Promise.resolve({ accessToken: "cli-token", accountId: "workspace" }), refresh: vi.fn() } };
    await expect(refreshProviderCatalogue("c", withAuth)).rejects.toThrow("Codex CLI version is unavailable");
    expect(fetch).not.toHaveBeenCalled();
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

  it("reports a credential no source yields with the agent-shim prefix once, as the command line prints the refusal", async () => {
    const { all } = deps({ resolveCredential: (name, provider) => resolveCredential({ credential: provider.credential, env: {}, port: fakeCredentials(), subject: `provider ${name}` }) });
    const printed: string[] = [];
    const refusal: unknown = await refreshProviderCatalogue("a", all).catch((error: unknown) => error);
    reportFatalError(refusal, {
      writeErr: (line) => {
        printed.push(line);
      },
      env: {},
    });
    expect(printed).toEqual(["agent-shim: provider a has no usable credential: env TOKEN is unset or empty"]);
  });

  it("leaves the previous cache in place when no URL lists a model", async () => {
    const { all, write } = deps({ fetch: vi.fn<RefreshCatalogueDeps["fetch"]>().mockResolvedValue({ status: 500, body: undefined }) });

    await expect(refreshProviderCatalogue("a", all)).rejects.toBeInstanceOf(CatalogueFetchError);
    expect(write).not.toHaveBeenCalled();
  });
});
