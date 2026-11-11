import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { writeJsonAtomic } from "./config/store";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "./frontdoor/state";
import { buildLayoutPaths } from "./paths";
import { catalogueCachePath, catalogueMatchesSettings, catalogueSettingsFingerprint, catalogueSettingsPath, parseCatalogueCache, parseCatalogueSettings } from "./providerCatalogue";
import { realFarmFs } from "./realPorts";
import { refreshCatalogueForReal } from "./realCatalogueRefresh";

/** What runs between the writes of a refresh: a hook the test sets, called after each atomic JSON write (the catalogue's). */
const hooks = vi.hoisted(() => ({ afterCatalogueWrite: (): void => undefined }));
vi.mock("./config/store", async (importOriginal) => {
  const actual = await importOriginal<{ readonly writeJsonAtomic: typeof writeJsonAtomic }>();
  return {
    ...actual,
    writeJsonAtomic: (...args: Parameters<typeof actual.writeJsonAtomic>): void => {
      actual.writeJsonAtomic(...args);
      hooks.afterCatalogueWrite();
    },
  };
});

/** The permissions of a directory a test may use, and of one it has made read-only to refuse a write. */
const OWNER_ALL = 0o700;
const OWNER_READ_ONLY = 0o500;
const GENERATION = "10000000-0000-4000-8000-000000000001";
const credential = { sources: [{ literal: "placeholder" }] };

describe("a real refresh of an http provider's catalogue, over real files", () => {
  const roots: string[] = [];
  let paths: ReturnType<typeof buildLayoutPaths>;

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-real-refresh-"));
    roots.push(root);
    paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => await Promise.resolve(new Response(JSON.stringify({ data: [{ id: "served" }] }), { status: 200 }))));
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid, port: 1234 });
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, process.pid, path.join(root, "codex"), GENERATION);
  });

  afterEach(() => {
    hooks.afterCatalogueWrite = (): void => undefined;
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      fs.chmodSync(root, OWNER_ALL);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** Writes provider `h` with the base URL and returns it as the refresh reads it. */
  function provider(baseUrl: string) {
    const definition = { displayName: "H", baseUrl, credential, catalogue: { tier: "sonnet" as const } };
    fs.writeFileSync(path.join(paths.providersDir, "h.json"), JSON.stringify(definition));
    return definition;
  }
  const digestOnDisk = (): string | undefined => (fs.existsSync(catalogueSettingsPath(paths, "h")) ? parseCatalogueSettings(fs.readFileSync(catalogueSettingsPath(paths, "h"), "utf8"))?.settings : undefined);

  it("stores the catalogue and a digest file that parses to the provider's fingerprint", async () => {
    const definition = provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    expect(fs.existsSync(catalogueCachePath(paths, "h"))).toBe(true);
    expect(digestOnDisk()).toBe(catalogueSettingsFingerprint(definition));
  });

  it("changes nothing, the earlier digest included, when the serving door changed while the list was fetched", async () => {
    const definition = provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    vi.stubGlobal("fetch", vi.fn(async () => {
      writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid + 1, port: 1234 });
      return await Promise.resolve(new Response(JSON.stringify({ data: [{ id: "served" }] }), { status: 200 }));
    }));
    await expect(refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION)).rejects.toThrow("front door changed during catalogue refresh");
    expect(digestOnDisk()).toBe(catalogueSettingsFingerprint(definition));
  });

  it("refuses to store a digest once the serving door has changed, and leaves none", async () => {
    provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    expect(digestOnDisk()).toBeDefined();
    // The door changes between the catalogue's write and the digest's: the digest write refuses, and the earlier digest was removed before the catalogue was written.
    hooks.afterCatalogueWrite = () => {
      writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: process.pid + 1, port: 1234 });
    };
    await expect(refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION)).rejects.toThrow("front door changed during catalogue refresh");
    expect(digestOnDisk()).toBeUndefined();
  });

  it("leaves no digest when the digest cannot be written, so the earlier one never describes the new list", async () => {
    const first = provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    expect(digestOnDisk()).toBe(catalogueSettingsFingerprint(first));
    provider("https://two.example");
    const settingsDir = path.dirname(catalogueSettingsPath(paths, "h"));
    hooks.afterCatalogueWrite = () => {
      fs.chmodSync(settingsDir, OWNER_READ_ONLY);
    };
    await expect(refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION)).rejects.toThrow();
    fs.chmodSync(settingsDir, OWNER_ALL);
    provider("https://one.example");
    // Back at the first address: the digest that matched it is gone, so the list of the second server is not taken for the first's.
    expect(digestOnDisk()).toBeUndefined();
  });

  /** The models the door would list for provider `h` as it is now, from the files on disk. */
  function listed(): readonly string[] {
    const definition = JSON.parse(fs.readFileSync(path.join(paths.providersDir, "h.json"), "utf8")) as Parameters<typeof catalogueSettingsFingerprint>[0];
    const read = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
    const cache = parseCatalogueCache(read(catalogueCachePath(paths, "h")));
    return cache !== undefined && catalogueMatchesSettings(parseCatalogueSettings(read(catalogueSettingsPath(paths, "h"))), cache, definition) ? cache.models.map((model) => model.id) : [];
  }

  it("lists nothing from a catalogue a release before the digest rewrote, though the digest file left behind would match the settings again after an edit and a revert", async () => {
    provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    expect(listed()).toEqual(["served"]);
    // A release before the digest, running as the door after a downgrade, refreshes the provider edited to another server: it rewrites the catalogue and never touches the digest file.
    provider("https://two.example");
    const rewritten = JSON.parse(fs.readFileSync(catalogueCachePath(paths, "h"), "utf8")) as { fetchedAt: number };
    fs.writeFileSync(catalogueCachePath(paths, "h"), JSON.stringify({ ...rewritten, fetchedAt: rewritten.fetchedAt + 1, models: [{ id: "second-server" }] }));
    // The provider is edited back to the first server: the digest on disk is the first server's again, but it describes another catalogue.
    provider("https://one.example");
    expect(listed()).toEqual([]);
  });

  it("lists nothing when two refreshes of the provider interleave and the earlier one stores its digest last", async () => {
    provider("https://one.example");
    await refreshCatalogueForReal(paths, "h", {}, process.pid, GENERATION);
    const earlier = fs.readFileSync(catalogueSettingsPath(paths, "h"), "utf8");
    // A later refresh stores its catalogue and digest; the earlier one, slower, then stores its own digest over them.
    const later = JSON.parse(fs.readFileSync(catalogueCachePath(paths, "h"), "utf8")) as { fetchedAt: number };
    fs.writeFileSync(catalogueCachePath(paths, "h"), JSON.stringify({ ...later, fetchedAt: later.fetchedAt + 1, models: [{ id: "later" }] }));
    fs.writeFileSync(catalogueSettingsPath(paths, "h"), earlier);
    expect(listed()).toEqual([]);
  });
});
