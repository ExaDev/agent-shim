import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { buildLayoutPaths } from "./paths";
import { refreshCatalogueForReal } from "./realCatalogueRefresh";

const mocks = vi.hoisted(() => ({
  readProvider: vi.fn(),
  write: vi.fn(),
  createCodexRoutePorts: vi.fn(),
  spawnSyncBlocking: vi.fn(),
  writeBinding: vi.fn(),
  fileRevision: vi.fn(),
  readFrontDoorState: vi.fn(),
  readFrontDoorCodexRecord: vi.fn(),
}));
vi.mock("./blockingSpawn", () => ({ spawnSyncBlocking: mocks.spawnSyncBlocking }));
vi.mock("./providersStore", () => ({ readProvider: mocks.readProvider }));
vi.mock("./config/store", () => ({ writeJsonAtomic: mocks.write }));
vi.mock("./codex/commands", () => ({ createCodexRoutePorts: mocks.createCodexRoutePorts }));
vi.mock("./realPorts", () => ({ realCredentialPort: {}, realFarmFs: { mkdirp: vi.fn(), writeFilePrivate: mocks.writeBinding }, realFsPort: { fileRevision: mocks.fileRevision } }));
vi.mock("./frontdoor/state", () => ({ readFrontDoorState: mocks.readFrontDoorState, readFrontDoorCodexRecord: mocks.readFrontDoorCodexRecord }));

beforeEach(() => { mocks.fileRevision.mockReturnValue("revision-1"); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("uses the selected Sign in with ChatGPT grant for a real catalogue refresh", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] }, codex: { login: "chatgpt-sign-in" } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "chatgpt-sign-in": { auth: { current: async () => await Promise.resolve({ accessToken: "selected-grant", accountId: undefined }) } } } });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-new", visibility: "list" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const paths = buildLayoutPaths("/test/agent-shim");

  await expect(refreshCatalogueForReal(paths, "c", {})).resolves.toMatchObject({ models: [{ id: "gpt-new" }] });
  expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ headers: { authorization: "Bearer selected-grant" } }));
});

it("uses the Codex CLI login and its installed version for a real catalogue refresh", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const paths = buildLayoutPaths("/test/agent-shim");

  await expect(refreshCatalogueForReal(paths, "c", {})).resolves.toMatchObject({ models: [{ id: "gpt-cli" }] });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.166.0");
  const request: unknown = fetch.mock.calls[0]?.[1];
  expect(request).toMatchObject({ headers: { authorization: "Bearer cli-grant", "chatgpt-account-id": "workspace" } });
});

it("selects the CLI credential using the refresh environment", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  const paths = buildLayoutPaths("/test/agent-shim");
  const env = { CODEX_HOME: "/selected/codex" };

  await refreshCatalogueForReal(paths, "c", env);

  expect(mocks.createCodexRoutePorts).toHaveBeenCalledWith(expect.any(Function), paths.chatgptSignInFile, { env });
});

it("stores the Codex binding with the source file revision", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  mocks.fileRevision.mockReturnValue("revision-1");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  const paths = buildLayoutPaths("/test/agent-shim");
  const cache = await refreshCatalogueForReal(paths, "c", { CODEX_HOME: "/selected/codex" });
  expect(mocks.writeBinding).toHaveBeenCalledWith(`${paths.catalogueDir}/c.binding.json`, JSON.stringify({ fingerprint: cache.credentialFingerprint, source: "/selected/codex/auth.json", revision: "revision-1" }));
});

it("does not publish when the login file changes during the fetch", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  let revision = "old-revision";
  mocks.fileRevision.mockImplementation(() => revision);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { revision = "new-revision"; return await Promise.resolve(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })); }));
  await expect(refreshCatalogueForReal(buildLayoutPaths("/test/agent-shim"), "c", { CODEX_HOME: "/selected/codex" })).rejects.toThrow("Codex login changed during catalogue refresh");
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.writeBinding).not.toHaveBeenCalled();
});

it("does not publish when its front door was replaced during the fetch", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  mocks.readFrontDoorState.mockReturnValue({ supervisorPid: 2, port: 1234 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  await expect(refreshCatalogueForReal(buildLayoutPaths("/test/agent-shim"), "c", { CODEX_HOME: "/selected/codex" }, 1, "10000000-0000-4000-8000-000000000001")).rejects.toThrow("front door changed during catalogue refresh");
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.writeBinding).not.toHaveBeenCalled();
});

it("writes a door-owned catalogue under its unique generation", async () => {
  const generation = "10000000-0000-4000-8000-000000000001";
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  mocks.readFrontDoorState.mockReturnValue({ supervisorPid: 1, port: 1234 });
  mocks.readFrontDoorCodexRecord.mockReturnValue({ codexHome: "/selected/codex", generation });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  await refreshCatalogueForReal(buildLayoutPaths("/test/agent-shim"), "c", { CODEX_HOME: "/selected/codex" }, 1, generation);
  expect(mocks.write).toHaveBeenCalledWith(`/test/agent-shim/catalogues/supervisors/1/${generation}/c.json`, expect.objectContaining({ supervisorPid: 1 }));
  expect(mocks.writeBinding).toHaveBeenCalledWith(`/test/agent-shim/catalogues/supervisors/1/${generation}/c.binding.json`, expect.any(String));
});

it("rejects an obsolete generation even when the supervisor PID is reused", async () => {
  const oldGeneration = "10000000-0000-4000-8000-000000000001";
  const newGeneration = "10000000-0000-4000-8000-000000000002";
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: { current: async () => await Promise.resolve({ accessToken: "cli-grant", accountId: "workspace" }) } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  mocks.readFrontDoorState.mockReturnValue({ supervisorPid: 1, port: 1234 });
  mocks.readFrontDoorCodexRecord.mockReturnValue({ codexHome: "/selected/codex", generation: newGeneration });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "old-model", visibility: "list" }] }), { status: 200 })));
  await expect(refreshCatalogueForReal(buildLayoutPaths("/test/agent-shim"), "c", { CODEX_HOME: "/selected/codex" }, 1, oldGeneration)).rejects.toThrow("front door changed during catalogue refresh");
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.writeBinding).not.toHaveBeenCalled();
});

it("publishes after an authorised token refresh changes the login file", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  let revision = "old-revision";
  let token = "old-token";
  mocks.fileRevision.mockImplementation(() => revision);
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: {
    current: async () => await Promise.resolve({ accessToken: token, accountId: "workspace" }),
    refresh: async () => { token = "new-token"; revision = "new-revision"; return await Promise.resolve({ accessToken: token, accountId: "workspace" }); },
  } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  const paths = buildLayoutPaths("/test/agent-shim");
  const cache = await refreshCatalogueForReal(paths, "c", { CODEX_HOME: "/selected/codex" });
  expect(mocks.writeBinding).toHaveBeenCalledWith(`${paths.catalogueDir}/c.binding.json`, JSON.stringify({ fingerprint: cache.credentialFingerprint, source: "/selected/codex/auth.json", revision: "new-revision" }));
});

it("publishes when reading the login refreshes an expired credential", async () => {
  mocks.readProvider.mockReturnValue({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } });
  let revision = "old-revision";
  mocks.fileRevision.mockImplementation(() => revision);
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "codex-cli": { auth: {
    current: async () => { revision = "new-revision"; return await Promise.resolve({ accessToken: "new-token", accountId: "workspace" }); },
  } } } });
  mocks.spawnSyncBlocking.mockReturnValue({ status: 0, stdout: "codex-cli 0.166.0\n" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-cli", visibility: "list" }] }), { status: 200 })));
  const paths = buildLayoutPaths("/test/agent-shim");
  const cache = await refreshCatalogueForReal(paths, "c", { CODEX_HOME: "/selected/codex" });
  expect(mocks.writeBinding).toHaveBeenCalledWith(`${paths.catalogueDir}/c.binding.json`, JSON.stringify({ fingerprint: cache.credentialFingerprint, source: "/selected/codex/auth.json", revision: "new-revision" }));
});

it("uses one provider definition for both credential and endpoint selection", async () => {
  const credential = { sources: [{ literal: "unused" }] };
  mocks.readProvider.mockReturnValueOnce({ kind: "codex", displayName: "C", credential, codex: { login: "chatgpt-sign-in" } }).mockReturnValueOnce({ kind: "codex", displayName: "C", credential });
  mocks.createCodexRoutePorts.mockReturnValue({ upstreams: { "chatgpt-sign-in": { auth: { current: async () => await Promise.resolve({ accessToken: "selected-grant", accountId: undefined }) } } } });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-new", visibility: "list" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  await expect(refreshCatalogueForReal(buildLayoutPaths("/test/agent-shim"), "c", {})).resolves.toMatchObject({ models: [{ id: "gpt-new" }] });
  expect(mocks.readProvider).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.anything());
});
