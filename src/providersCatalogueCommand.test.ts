import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";

import { buildLayoutPaths } from "./paths";
import { catalogueCachePath } from "./providerCatalogue";
import { catalogueCredentialFingerprint } from "./codex/catalogueCredential";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "./frontdoor/state";
import { registerProviderCommand } from "./providers";
import { realFarmFs } from "./realPorts";
import { fakeCommandDeps } from "./test-helpers";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("./realCatalogueRefresh", () => ({ refreshCatalogueForReal: mocks.refresh }));
const TEST_GENERATION = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("shows a cached Codex catalogue belonging to the current account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "gpt-test" }], credentialFingerprint: catalogueCredentialFingerprint(true, "account-token", "workspace") }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", "--json"], { from: "user" });
  expect(log.mock.calls[0]?.[0]).toContain("gpt-test");
  const output: unknown = log.mock.calls[0]?.[0];
  if (typeof output !== "string") throw new Error("Expected JSON output");
  const parsed: unknown = JSON.parse(output);
  expect(parsed).toMatchObject({ listed: ["gpt-test"] });
});

it.each([["text", []], ["JSON", ["--json"]]])("redacts the userinfo and query of a Codex catalogue's URL in the %s of provider models", async (_format, flags) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-url-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://user:hunter2@example.test/models?key=abc123", models: [{ id: "gpt-test" }], credentialFingerprint: catalogueCredentialFingerprint(true, "account-token", "workspace") }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", ...flags], { from: "user" });
  const output = log.mock.calls.map((call) => String(call[0])).join("\n");
  expect(output).toContain("https://example.test/models");
  expect(output).not.toContain("hunter2");
  expect(output).not.toContain("abc123");
});

it("shows the serving front door's isolated Codex catalogue", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  const generation = "10000000-0000-4000-8000-000000000001";
  const cachePath = catalogueCachePath(paths, "c", process.pid, generation);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "door-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "account-token", "workspace"), supervisorPid: process.pid }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, codexHome, generation);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", "--json"], { from: "user" });
  expect(log.mock.calls[0]?.[0]).toContain("door-model");
});

it.each(["other-account", undefined])("refuses a cached Codex catalogue with fingerprint %s", async (fingerprint) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "stale-model" }], credentialFingerprint: fingerprint }));
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await expect(program.parseAsync(["provider", "models", "c", "--json"], { from: "user" })).rejects.toThrow("different Codex account");
});

it.each([process.ppid, undefined])("refuses a cached catalogue with non-current supervisor %s", async (owner) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account-token", account_id: "workspace" } }));
  const cachePath = catalogueCachePath(paths, "c", process.pid, TEST_GENERATION);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "old-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "account-token", "workspace"), supervisorPid: owner }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, codexHome, TEST_GENERATION);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await expect(program.parseAsync(["provider", "models", "c", "--json"], { from: "user" })).rejects.toThrow("different front door");
});

it("refreshes a Codex provider's model catalogue", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  mocks.refresh.mockResolvedValue({ fetchedAt: 1, url: "https://example.test", models: [{ id: "gpt-test" }] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", "--refresh", "--json"], { from: "user" });
  expect(mocks.refresh).toHaveBeenCalledWith(paths, "c", expect.anything());
});

it("refreshes with the serving front door's Codex home", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const doorHome = path.join(root, "door-codex");
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, doorHome, TEST_GENERATION);
  mocks.refresh.mockResolvedValue({ fetchedAt: 1, url: "https://example.test", models: [{ id: "gpt-test" }] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", "--refresh", "--json"], { from: "user" });
  expect(mocks.refresh).toHaveBeenLastCalledWith(paths, "c", expect.objectContaining({ CODEX_HOME: doorHome }), process.pid, TEST_GENERATION);
});

it("uses the caller's Codex home when the recorded supervisor is gone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const callerHome = path.join(root, "caller-home");
  vi.stubEnv("CODEX_HOME", callerHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: 2147483647, port: 1234 });
  mocks.refresh.mockResolvedValue({ fetchedAt: 1, url: "https://example.test", models: [{ id: "gpt-test" }] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await program.parseAsync(["provider", "models", "c", "--refresh", "--json"], { from: "user" });
  expect(mocks.refresh).toHaveBeenLastCalledWith(paths, "c", expect.objectContaining({ CODEX_HOME: callerHome }));
});

it("rejects a refreshed catalogue when the serving door changes during the fetch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-provider-models-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, path.join(root, "old-home"), TEST_GENERATION);
  mocks.refresh.mockImplementation(async () => {
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.ppid, port: 1234 });
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.ppid, path.join(root, "new-home"), TEST_GENERATION);
    return await Promise.resolve({ fetchedAt: 1, url: "https://example.test", models: [{ id: "old-model" }] });
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command().exitOverride();
  registerProviderCommand(program, fakeCommandDeps(paths));
  await expect(program.parseAsync(["provider", "models", "c", "--refresh", "--json"], { from: "user" })).rejects.toThrow("front door changed during catalogue refresh");
});
