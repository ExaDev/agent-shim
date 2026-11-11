import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { catalogueCredentialFingerprint } from "../codex/catalogueCredential";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "../frontdoor/state";
import { buildLayoutPaths } from "../paths";
import { catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, catalogueSettingsText, parseCatalogueCache } from "../providerCatalogue";
import { realFarmFs } from "../realPorts";
import { providerModels } from "./targets";

const TEST_GENERATION = "10000000-0000-4000-8000-000000000001";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-model-targets-")); });
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("does not expose a Codex target from a different account's catalogue", () => {
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "stale-model" }], credentialFingerprint: "old-account" }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "current-account", account_id: "workspace" } }));

  expect(providerModels(paths).map((row) => row.model)).not.toContain("stale-model");
});

it("exposes a Codex target from the selected account's catalogue", () => {
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "current-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "current-account", "workspace") }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "current-account", account_id: "workspace" } }));

  expect(providerModels(paths)).toContainEqual({ provider: "c", model: "current-model" });
});

it("uses the local Codex account when the recorded front door has exited", () => {
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  fs.writeFileSync(path.join(paths.catalogueDir, "c.json"), JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "local-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "local-account", "workspace") }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "local-account", account_id: "workspace" } }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: 2147483647, port: 1234 });
  expect(providerModels(paths)).toContainEqual({ provider: "c", model: "local-model" });
});

it.each([process.ppid, undefined])("does not expose a catalogue with non-current supervisor %s", (owner) => {
  const paths = buildLayoutPaths(root);
  const codexHome = path.join(root, "codex-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  const cachePath = catalogueCachePath(paths, "c", process.pid, TEST_GENERATION);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "old-door-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "account", "workspace"), supervisorPid: owner }));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "account", account_id: "workspace" } }));
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, codexHome, TEST_GENERATION);
  expect(parseCatalogueCache(fs.readFileSync(cachePath, "utf8"))).toBeDefined();
  expect(providerModels(paths)).not.toContainEqual({ provider: "c", model: "old-door-model" });
});

it("uses the serving door's Codex account when the launch environment names another home", () => {
  const paths = buildLayoutPaths(root);
  const generation = "10000000-0000-4000-8000-000000000001";
  const launchHome = path.join(root, "launch");
  const doorHome = path.join(root, "door");
  vi.stubEnv("CODEX_HOME", launchHome);
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.mkdirSync(launchHome, { recursive: true });
  fs.mkdirSync(doorHome, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "c.json"), JSON.stringify({ kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } }));
  const cachePath = catalogueCachePath(paths, "c", process.pid, generation);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "door-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "door-account", "workspace"), supervisorPid: process.pid }));
  fs.writeFileSync(path.join(launchHome, "auth.json"), JSON.stringify({ tokens: { access_token: "launch-account", account_id: "workspace" } }));
  fs.writeFileSync(path.join(doorHome, "auth.json"), JSON.stringify({ tokens: { access_token: "door-account", account_id: "workspace" } }));
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, doorHome, generation);
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 4100 });

  expect(providerModels(paths)).toContainEqual({ provider: "c", model: "door-model" });
});

it("offers the models of an http catalogue only while it was fetched under the provider's current settings", () => {
  const paths = buildLayoutPaths(root);
  const credential = { sources: [{ literal: "unused" }] };
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.mkdirSync(paths.catalogueDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "h.json"), JSON.stringify({ displayName: "H", baseUrl: "https://new.example", credential, catalogue: { tier: "sonnet" } }));
  /** Stores a catalogue that `baseUrl` served, with the digest of the settings the provider had then. */
  const store = (baseUrl: string): void => {
    fs.writeFileSync(catalogueCachePath(paths, "h"), JSON.stringify({ fetchedAt: 1, url: `${baseUrl}/v1/models`, models: [{ id: "served" }] }));
    fs.mkdirSync(path.dirname(catalogueSettingsPath(paths, "h")), { recursive: true });
    fs.writeFileSync(catalogueSettingsPath(paths, "h"), catalogueSettingsText(catalogueSettingsFingerprint({ baseUrl, catalogue: { tier: "sonnet" }, credential }), 1));
  };
  store("https://old.example");
  expect(providerModels(paths)).not.toContainEqual({ provider: "h", model: "served" });
  store("https://new.example");
  expect(providerModels(paths)).toContainEqual({ provider: "h", model: "served" });
});
