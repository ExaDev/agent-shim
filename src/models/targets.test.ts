import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { catalogueCredentialFingerprint } from "../codex/catalogueCredential";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "../frontdoor/state";
import { buildLayoutPaths } from "../paths";
import { catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, catalogueSettingsText, parseCatalogueCache } from "../providerCatalogue";
import { realFarmFs } from "../realPorts";
import { errorWithCode } from "../test-helpers";
import { providerModels } from "./targets";

const TEST_GENERATION = "10000000-0000-4000-8000-000000000001";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-model-targets-")); });
afterEach(() => {
  vi.restoreAllMocks();
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

// The title names each owner and never holds its pid, which differs between runs: the deleted-test check compares the suite's listings by title.
it.each([["another process", process.ppid], ["no recorded supervisor", undefined]])("does not expose a catalogue whose supervisor is %s", (_owner, owner) => {
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

/** Makes `fs.readFileSync` throw `code` for `file`; every other read goes to the real file system. The readers under test read text (`readFileSync(path, "utf8")`), the one form this answers. */
function failReadsOf(file: string, code: string): void {
  const real = fs.readFileSync.bind(fs);
  const failingRead = (target: fs.PathOrFileDescriptor, encoding: BufferEncoding): string => {
    if (target === file) throw errorWithCode(`${code}: failed, open '${file}'`, code);
    return real(target, encoding);
  };
  // `readFileSync` is overloaded and a mock must take its whole type, which no one-signature function has; the readers under test call the text form only.
  vi.spyOn(fs, "readFileSync").mockImplementation(failingRead as typeof fs.readFileSync);
}

/** A layout with an http provider `z` that opted into a catalogue whose stored list names `cat-model`, fetched under z's settings as they are. */
function catalogued(): ReturnType<typeof buildLayoutPaths> {
  const paths = buildLayoutPaths(root);
  const z = { displayName: "Z", baseUrl: "https://z.example", credential: { sources: [{ literal: "unused" }] }, catalogue: { tier: "opus" as const } };
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, "z.json"), JSON.stringify(z));
  const cache = { fetchedAt: 1, url: "https://z.example/v1/models", models: [{ id: "cat-model" }] };
  fs.mkdirSync(path.dirname(catalogueCachePath(paths, "z")), { recursive: true });
  fs.writeFileSync(catalogueCachePath(paths, "z"), JSON.stringify(cache));
  const parsed = parseCatalogueCache(JSON.stringify(cache));
  if (parsed === undefined) throw new Error("the fixture catalogue does not parse");
  fs.mkdirSync(path.dirname(catalogueSettingsPath(paths, "z")), { recursive: true });
  fs.writeFileSync(catalogueSettingsPath(paths, "z"), catalogueSettingsText(catalogueSettingsFingerprint(z), parsed.fetchedAt));
  return paths;
}

it("lists a provider's catalogue models in its targets, and passes a read of that catalogue that fails for the moment on rather than leaving them out", () => {
  const paths = catalogued();
  expect(providerModels(paths)).toContainEqual({ provider: "z", model: "cat-model" });
  failReadsOf(catalogueCachePath(paths, "z"), "EMFILE");
  expect(() => providerModels(paths)).toThrow(expect.objectContaining({ code: "EMFILE" }));
  vi.restoreAllMocks();
  failReadsOf(catalogueCachePath(paths, "z"), "EACCES");
  expect(providerModels(paths).map((row) => row.model)).not.toContain("cat-model");
});

it("passes a read of the door's state file that fails for the moment on rather than reading it as no door", () => {
  const paths = catalogued();
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  failReadsOf(paths.frontdoorStateFile, "EMFILE");
  expect(() => providerModels(paths)).toThrow(/EMFILE/u);
});

it("passes a read of the serving door's Codex record that fails for the moment on rather than reading it as no record", () => {
  const paths = catalogued();
  writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
  writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, path.join(root, "codex-home"), TEST_GENERATION);
  failReadsOf(path.join(paths.frontdoorDir, "codex-homes", `${String(process.pid)}.json`), "EMFILE");
  expect(() => providerModels(paths)).toThrow(/EMFILE/u);
});

