import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelsConfig, ModelsLayer } from "./config/schema";
import { writeJsonAtomic } from "./config/store";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { readProviderAliases } from "./providerAliases";
import { renameModelRefs, renameProvider, type ProviderRenamePorts } from "./providerRename";
import { InvalidProviderNameError } from "./config/names";
import { addProvider, ProviderAlreadyExistsError, ProviderNotFoundError, providerExists, readProvider } from "./providersStore";
import { realFarmFs } from "./realPorts";
import { USAGE_SCHEMA_VERSION } from "./usage/schema";

describe("renameModelRefs", () => {
  const models: ModelsConfig = {
    virtual: { auto: { mode: "ordered", members: ["z/glm-5.3", "s/glm-5.3", "family:glm-5-1", "acct:work/opus"] } },
    tiers: { opus: "z/glm-5.3", sonnet: "auto" },
    prices: { "z/glm-5.3": { input: 1, output: 2 }, "s/glm-5.3": { input: 3, output: 4 } },
    hide: ["z/old"],
    show: ["z/glm-5.3"],
    same: [["z/glm-5.3", "s/glm-5.3"]],
    distinct: [["z/a", "s/a"]],
    families: { "glm-5-1": { names: ["z/glm-5.1", "glm-5.1"] } },
  };

  it("requalifies every ref the provider qualifies, wherever the block holds one", () => {
    expect(renameModelRefs(models, "z", "zai")).toEqual({
      virtual: { auto: { mode: "ordered", members: ["zai/glm-5.3", "s/glm-5.3", "family:glm-5-1", "acct:work/opus"] } },
      tiers: { opus: "zai/glm-5.3", sonnet: "auto" },
      prices: { "zai/glm-5.3": { input: 1, output: 2 }, "s/glm-5.3": { input: 3, output: 4 } },
      hide: ["zai/old"],
      show: ["zai/glm-5.3"],
      same: [["zai/glm-5.3", "s/glm-5.3"]],
      distinct: [["zai/a", "s/a"]],
      families: { "glm-5-1": { names: ["zai/glm-5.1", "glm-5.1"] } },
    });
  });

  it("matches the provider segment whole, so a provider named like the start of another is not touched", () => {
    expect(renameModelRefs({ hide: ["zebra/x", "z/x"] }, "z", "zai")).toEqual({ hide: ["zebra/x", "zai/x"] });
  });

  it("keeps a cascade layer's removals as they are", () => {
    const layer: ModelsLayer = { virtual: { auto: null }, tiers: { opus: null, sonnet: "z/m" }, prices: { "z/m": null }, families: { fam: null } };
    expect(renameModelRefs(layer, "z", "zai")).toEqual({ virtual: { auto: null }, tiers: { opus: null, sonnet: "zai/m" }, prices: { "zai/m": null }, families: { fam: null } });
  });
});

describe("renameProvider", () => {
  let root: string;
  let paths: LayoutPaths;
  let cache: Map<string, CachedCredential>;
  let ports: ProviderRenamePorts;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-rename-test-"));
    paths = buildLayoutPaths(root);
    cache = new Map();
    const credentialCache: CredentialCachePort = {
      read: (store, owner) => cache.get(`${store}:${owner}`),
      write: (store, owner, entry) => {
        cache.set(`${store}:${owner}`, entry);
      },
      remove: (store, owner) => {
        cache.delete(`${store}:${owner}`);
      },
    };
    ports = { fs: realFarmFs, credentialCache: { port: credentialCache, platform: "linux" } };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", sources: [{ env: "Z_API_TOKEN" }] };

  it("moves the file and records the old name as an alias", () => {
    addProvider(paths, "z", base);
    const report = renameProvider(paths, "z", "zai", ports);
    expect(providerExists(paths, "z")).toBe(false);
    expect(readProvider(paths, "zai")?.displayName).toBe("z.ai");
    expect(readProviderAliases(paths)).toEqual({ z: "zai" });
    expect(report).toEqual({ from: "z", to: "zai", updated: [] });
  });

  it("repoints an earlier alias, so a second rename leaves no chain", () => {
    addProvider(paths, "z", base);
    renameProvider(paths, "z", "zai", ports);
    renameProvider(paths, "zai", "glm", ports);
    expect(readProviderAliases(paths)).toEqual({ z: "glm", zai: "glm" });
  });

  it("refuses a missing provider, an existing target, an invalid name and the same name, changing nothing", () => {
    addProvider(paths, "z", base);
    addProvider(paths, "o", { ...base, displayName: "OpenRouter" });
    expect(() => renameProvider(paths, "gone", "x", ports)).toThrow(ProviderNotFoundError);
    expect(() => renameProvider(paths, "z", "o", ports)).toThrow(ProviderAlreadyExistsError);
    expect(() => renameProvider(paths, "z", "-bad", ports)).toThrow(InvalidProviderNameError);
    expect(() => renameProvider(paths, "z", "z", ports)).toThrow("already");
    expect(providerExists(paths, "z")).toBe(true);
    expect(readProviderAliases(paths)).toEqual({});
  });

  it("rewrites the configuration that names the provider and leaves the rest alone", () => {
    addProvider(paths, "z", base);
    writeJsonAtomic(path.join(paths.providersDir, "s.json"), {
      displayName: "Synthetic",
      baseUrl: "https://api.synthetic.new/anthropic",
      credential: { sources: [{ env: "S_API_TOKEN" }] },
      routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*glm.*" } }, provider: "z" }],
    });
    writeJsonAtomic(paths.globalConfigFile, { launch: { provider: "z" }, models: { tiers: { opus: "z/glm-5.3" } } });
    fs.mkdirSync(paths.configProfilesDir, { recursive: true });
    writeJsonAtomic(path.join(paths.configProfilesDir, "work.json"), { launch: { provider: "z" }, models: { virtual: { auto: null, fast: { mode: "ordered", members: ["z/glm-5.3"] } } } });
    writeJsonAtomic(path.join(paths.configProfilesDir, "other.json"), { launch: { provider: "s" } });
    writeJsonAtomic(paths.directoryRulesFile, { rules: [{ path: "/work", launch: { provider: "z" } }, { path: "/play", launch: { provider: "s" } }] });
    const report = renameProvider(paths, "z", "zai", ports);
    expect(report.updated).toEqual(["config.json", "profile work", "rule /work", "provider s routes"]);
    expect(JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8"))).toEqual({ launch: { provider: "zai" }, models: { tiers: { opus: "zai/glm-5.3" } } });
    expect(JSON.parse(fs.readFileSync(path.join(paths.configProfilesDir, "work.json"), "utf8"))).toEqual({ launch: { provider: "zai" }, models: { virtual: { auto: null, fast: { mode: "ordered", members: ["zai/glm-5.3"] } } } });
    expect(JSON.parse(fs.readFileSync(path.join(paths.configProfilesDir, "other.json"), "utf8"))).toEqual({ launch: { provider: "s" } });
    expect(JSON.parse(fs.readFileSync(paths.directoryRulesFile, "utf8"))).toEqual({ rules: [{ path: "/work", launch: { provider: "zai" } }, { path: "/play", launch: { provider: "s" } }] });
    expect(readProvider(paths, "s")).toMatchObject({ routes: [{ provider: "zai" }] });
  });

  it("moves the provider's usage slice to the new name, and drops a stale one the new name already has", () => {
    addProvider(paths, "z", base);
    fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
    const snapshot = (providers: Record<string, unknown>): unknown => ({ schemaVersion: USAGE_SCHEMA_VERSION, identity: "work", updatedAt: "2026-10-19T00:00:00.000Z", providers });
    writeJsonAtomic(path.join(paths.usageSnapshotsDir, "work.json"), snapshot({ z: { lastStatus: 200 }, s: { lastStatus: 201 } }));
    writeJsonAtomic(path.join(paths.usageSnapshotsDir, "play.json"), { ...(snapshot({ z: { lastStatus: 429 }, zai: { lastStatus: 200 } }) as object), identity: "play" });
    writeJsonAtomic(path.join(paths.usageSnapshotsDir, "idle.json"), { ...(snapshot({ s: {} }) as object), identity: "idle" });
    const report = renameProvider(paths, "z", "zai", ports);
    const providersOf = (identity: string): unknown => (JSON.parse(fs.readFileSync(path.join(paths.usageSnapshotsDir, `${identity}.json`), "utf8")) as { providers: unknown }).providers;
    expect(providersOf("work")).toEqual({ s: { lastStatus: 201 }, zai: { lastStatus: 200 } });
    expect(providersOf("play")).toEqual({ zai: { lastStatus: 200 } });
    expect(providersOf("idle")).toEqual({ s: {} });
    expect(report.updated).toEqual(["usage play", "usage work"]);
  });

  it("moves the fetched catalogue and the cached credential with the provider", () => {
    writeJsonAtomic(path.join(paths.providersDir, "z.json"), { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }], cache: { store: "file" } } });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.catalogueDir, "z.json"), "{}");
    const entry: CachedCredential = { token: "synthetic-token", fetchedAt: 1, source: { env: "Z_API_TOKEN" } };
    cache.set("file:provider z", entry);
    const report = renameProvider(paths, "z", "zai", ports);
    expect(fs.existsSync(path.join(paths.catalogueDir, "z.json"))).toBe(false);
    expect(fs.existsSync(path.join(paths.catalogueDir, "zai.json"))).toBe(true);
    expect(cache.get("file:provider zai")).toEqual(entry);
    expect(cache.has("file:provider z")).toBe(false);
    expect(report.updated).toEqual(["catalogue", "credential cache"]);
  });
});
