import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realPorts from "../realPorts";
import * as probe from "./probe";

import { buildLayoutPaths } from "../paths";
import { enterProcessRole } from "../processRole";
import { realFrontDoorPort } from "./realFrontDoorPort";
import { declareThisProcessTheFrontDoor, resetFrontDoorDeclarationForTests } from "./selfIdentity";
import { FRONT_DOOR_PROTOCOL, writeFrontDoorState } from "./state";
import { realFarmFs } from "../realPorts";
import { catalogueCredentialFingerprint } from "../codex/catalogueCredential";
import { CATALOGUE_REFRESH_DEADLINE_MS, CATALOGUE_REFRESH_TIMEOUT_MS, CATALOGUE_RETRY_MS, catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsText } from "../providerCatalogue";
import { writeFrontDoorCodexHome } from "./state";
import { writeCatalogueFailureReason, writeCatalogueStatus } from "./catalogueState";

/** The settings every `http` provider these tests write has, which a stored catalogue records so the door takes it for the provider as it is. */
const HTTP_SETTINGS = catalogueSettingsFingerprint({ baseUrl: "https://example.test", catalogue: { tier: "sonnet" }, credential: { sources: [{ env: "TOKEN" }] } });
const POLLS_BEFORE_CACHE = 3;
const SERVING_PORT = 4100;
const SERVING_CONNECT_PORT = 4300;

/** Stores a catalogue file of provider `file` (such as `http.json`) fetched at `fetchedAt`, and the digest file beside it holding `digest` (the settings of these tests' providers by default, another server's settings, or none). */
function storeCatalogue(paths: ReturnType<typeof buildLayoutPaths>, file: string, fetchedAt: number, digest: "own" | "other" | "none" = "own"): void {
  fs.writeFileSync(path.join(paths.catalogueDir, file), JSON.stringify({ fetchedAt, url: "https://example.test/v1/models", models: [{ id: "model" }] }));
  if (digest !== "none") {
    fs.mkdirSync(path.join(paths.catalogueDir, "settings"), { recursive: true });
    fs.writeFileSync(path.join(paths.catalogueDir, "settings", file), catalogueSettingsText(digest === "own" ? HTTP_SETTINGS : "settings-of-another-server", fetchedAt));
  }
}

describe("a launch the front door plans for itself", () => {
  let root: string;
  let leave: (() => void) | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-door-self-"));
    const paths = buildLayoutPaths(root);
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: process.pid + 1, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    fs.writeFileSync(paths.frontdoorControlTokenFile, "test-token");
    fs.mkdirSync(path.dirname(paths.frontdoorCaCertFile), { recursive: true });
    fs.writeFileSync(paths.frontdoorCaCertFile, "test-ca");
    vi.spyOn(probe, "requestCatalogueRefreshSync").mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    leave?.();
    leave = undefined;
    resetFrontDoorDeclarationForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not wait for its own catalogue work", () => {
    declareThisProcessTheFrontDoor();
    const port = realFrontDoorPort(buildLayoutPaths(root), () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues).toBeTypeOf("function");
    port.waitForCatalogues?.(process.pid);
  });

  it("does not wait when no providers have catalogues", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] } }));
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(process.pid); }).not.toThrow();
  });

  it("does not wait for a fresh HTTP catalogue", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    storeCatalogue(paths, "http.json", Date.now());
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(process.pid); }).not.toThrow();
  });

  it("waits for a fresh HTTP catalogue that was fetched under settings other than the provider's current ones, until one fetched under its own is published", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    storeCatalogue(paths, "http.json", Date.now(), "other");
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(process.pid + 1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("waits for a fresh HTTP catalogue with no digest, as an older door stores it, until one with a digest is published", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    storeCatalogue(paths, "http.json", Date.now(), "none");
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(process.pid + 1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("waits for a missing HTTP catalogue to be published", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(process.pid + 1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("waits for the door's catalogue refresh for as long as the door lets one run, which is longer than the fetch itself", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    let now = Date.now();
    let monotonic = performance.now();
    let sleeps = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      now += CATALOGUE_REFRESH_TIMEOUT_MS / 2;
      monotonic += CATALOGUE_REFRESH_TIMEOUT_MS / 2;
      sleeps++;
      if (sleeps === POLLS_BEFORE_CACHE) storeCatalogue(paths, "http.json", now);
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toBeUndefined();
    expect(sleeps).toBe(POLLS_BEFORE_CACHE);
  });

  it("reports a catalogue timeout without refusing the launch", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { now += CATALOGUE_RETRY_MS; });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toContain("Timed out waiting for provider catalogues");
  });

  it("gives up waiting for a catalogue once the door's refresh deadline has passed on the monotonic clock, naming the wait", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "haiku" } }));
    let monotonic = performance.now();
    let sleeps = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      // Each poll lets the clock pass a third of the deadline, so the wait ends on the poll after the deadline has passed.
      monotonic += CATALOGUE_REFRESH_DEADLINE_MS / POLLS_BEFORE_CACHE;
      sleeps += 1;
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toContain("Timed out waiting for provider catalogues");
    expect(sleeps).toBe(POLLS_BEFORE_CACHE);
  });

  it("keeps waiting for a catalogue when only the wall clock jumps past the wait's bound, since the bound is on the monotonic clock", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "haiku" } }));
    let now = Date.now();
    let sleeps = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      // The wall clock steps two refresh bounds forward, and the monotonic clock stands still.
      now += CATALOGUE_REFRESH_TIMEOUT_MS * 2;
      sleeps += 1;
      if (sleeps === POLLS_BEFORE_CACHE) {
        storeCatalogue(paths, "http.json", now);
      }
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toBeUndefined();
    expect(sleeps).toBe(POLLS_BEFORE_CACHE);
  });

  it("reports later provider failures when an earlier provider times out", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    for (const name of ["first", "second"]) fs.writeFileSync(path.join(paths.providersDir, `${name}.json`), JSON.stringify({ displayName: name, baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    let now = Date.now();
    let monotonic = performance.now();
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "second", "failed", undefined, now);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { now += CATALOGUE_RETRY_MS / 2; monotonic += CATALOGUE_RETRY_MS / 2; });
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(warning).toContain("second");
    expect(warning).toContain("Timed out");
  });

  it("reports a refused catalogue control request without refusing the launch", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    vi.mocked(probe.requestCatalogueRefreshSync).mockReturnValue({ ok: false, reason: "control refused" });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toContain("control refused");
  });

  it("reports missing catalogue control material without refusing the launch", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    fs.rmSync(paths.frontdoorControlTokenFile);
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toContain("control material is unavailable");
  });

  it("reports a missing front-door certificate without refusing the launch", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    fs.rmSync(paths.frontdoorCaCertFile);
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(process.pid + 1)).toContain("certificate");
  });

  it("warns when the serving door changes while a catalogue is pending", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: pid + 1, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(pid)).toContain("front door changed");
  });

  it("does not wait for a failed catalogue refresh", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now());
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { throw new Error("unexpected wait"); });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(pid); }).not.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports a failed catalogue refresh to the launcher", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now());
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(warning).toContain("http");
    expect(warning).toContain("failed");
  });

  it("reports every failed catalogue refresh to the launcher", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    for (const name of ["first", "second"]) {
      fs.writeFileSync(path.join(paths.providersDir, `${name}.json`), JSON.stringify({ displayName: name, baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
      writeCatalogueStatus(realFarmFs, paths, pid, generation, name, "failed", undefined, Date.now());
    }
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(warning).toContain("first");
    expect(warning).toContain("second");
  });

  it("clears a provider warning when it recovers while another refresh is pending", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    for (const name of ["first", "second"]) fs.writeFileSync(path.join(paths.providersDir, `${name}.json`), JSON.stringify({ displayName: name, baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "first", "failed", undefined, Date.now());
    vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      for (const name of ["first", "second"]) storeCatalogue(paths, `${name}.json`, Date.now());
      writeCatalogueStatus(realFarmFs, paths, pid, generation, "first", "ready", undefined, Date.now());
    });
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(warning).toBeUndefined();
  });

  /** A launch's wait with `http` failed a moment ago under `recordedSettings` (none for a failure file that records none, `null` for no failure file), the provider as the file holds it now, and a refresh that publishes a catalogue under the current settings when the wait sleeps: whether the launch slept, and what it warned. */
  function waitAfterFailureRecordedUnder(recordedSettings: string | null | undefined): { readonly slept: number; readonly warning: string | undefined } {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now());
    if (recordedSettings !== null) {
      writeCatalogueFailureReason(realFarmFs, paths, pid, generation, "http", "no catalogue: status 500", recordedSettings === undefined ? {} : { settings: recordedSettings });
    }
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    const warning = port.waitForCatalogues?.(pid);
    return { slept: sleep.mock.calls.length, warning };
  }

  it("treats a failure recorded under the provider's current settings, or one that records none, as final for the launch", () => {
    expect(waitAfterFailureRecordedUnder(HTTP_SETTINGS)).toEqual({ slept: 0, warning: "Catalogue refresh failed for http" });
    expect(waitAfterFailureRecordedUnder(undefined)).toEqual({ slept: 0, warning: "Catalogue refresh failed for http" });
    expect(waitAfterFailureRecordedUnder(null)).toEqual({ slept: 0, warning: "Catalogue refresh failed for http" });
  });

  it("carries no warning of a failure recorded for a provider that has no catalogue now, and does not wait for it", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now());
    writeCatalogueFailureReason(realFarmFs, paths, pid, generation, "http", "no catalogue: status 308", { redirected: true, settings: catalogueSettingsFingerprint({ baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] } }) });
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { throw new Error("unexpected wait"); });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(pid)).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits for the refresh of a provider edited since its refresh failed, and carries no warning of the failure", () => {
    expect(waitAfterFailureRecordedUnder("settings-of-the-provider-before-it-was-edited")).toEqual({ slept: 1, warning: undefined });
  });

  it("waits for a refresh after a failure's retry window expires", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now() - CATALOGUE_RETRY_MS);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", Date.now());
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not trust an HTTP failure with no timestamp", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed");
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { storeCatalogue(paths, "http.json", Date.now()); });
    realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not trust a future HTTP failure", () => {
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, Date.now() + CATALOGUE_RETRY_MS);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { storeCatalogue(paths, "http.json", Date.now()); });
    realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  /** How old a recorded failure is, in ms, and whether a launch takes it as final (and so reports it) rather than waiting for the refresh the door starts: only an age from nothing up to, not including, the retry window counts, so an age of exactly the window and a failure stamped by a clock that has since stepped back do not. */
  const FAILURE_AGES: readonly (readonly [string, number, boolean])[] = [
    ["a moment ago", 0, true],
    ["one millisecond short of the retry window", CATALOGUE_RETRY_MS - 1, true],
    ["exactly the retry window", CATALOGUE_RETRY_MS, false],
    ["after the clock has stepped back behind it", -1, false],
  ];
  const FROZEN_NOW_MS = 4_000_000_000_000;

  it.each(FAILURE_AGES)("takes an http provider's refresh failure recorded %s as final: %s", (_label, age, final) => {
    vi.spyOn(Date, "now").mockReturnValue(FROZEN_NOW_MS);
    const paths = buildLayoutPaths(root);
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, root, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "http", "failed", undefined, FROZEN_NOW_MS - age);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      storeCatalogue(paths, "http.json", FROZEN_NOW_MS);
    });
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledTimes(final ? 0 : 1);
    expect(warning === undefined).toBe(!final);
  });

  it.each(FAILURE_AGES)("takes a Codex provider's refresh failure recorded %s as final: %s", (_label, age, final) => {
    vi.spyOn(Date, "now").mockReturnValue(FROZEN_NOW_MS);
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", fingerprint, FROZEN_NOW_MS - age);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      fs.writeFileSync(catalogueCachePath(paths, "codex", pid, generation), JSON.stringify({ fetchedAt: FROZEN_NOW_MS, url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: fingerprint, supervisorPid: pid }));
    });
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledTimes(final ? 0 : 1);
    expect(warning === undefined).toBe(!final);
  });

  it("does not apply an unbound Codex failure to a new account", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "new-token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed");
    const cache = catalogueCachePath(paths, "codex", pid, generation);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: catalogueCredentialFingerprint(true, "new-token", "workspace"), supervisorPid: pid }));
    });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not wait for a failed Codex refresh for the current account", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", catalogueCredentialFingerprint(true, "token", "workspace"), Date.now());
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { throw new Error("unexpected wait"); });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(pid); }).not.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports a failed Codex refresh for the current account", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", catalogueCredentialFingerprint(true, "token", "workspace"), Date.now());
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(warning).toContain("codex");
    expect(warning).toContain("failed");
  });

  it("does not wait for a failed Codex refresh when no login is present", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", undefined, Date.now());
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { throw new Error("unexpected wait"); });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(pid); }).not.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports an unreadable Codex login without refusing a launch", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), "not json");
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(port.waitForCatalogues?.(pid)).toContain("invalid Codex login file");
  });

  it("continues waiting for another provider after an unreadable Codex login", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "a-codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(paths.providersDir, "z-http.json"), JSON.stringify({ displayName: "HTTP", baseUrl: "https://example.test", credential: { sources: [{ env: "TOKEN" }] }, catalogue: { tier: "sonnet" } }));
    fs.writeFileSync(path.join(home, "auth.json"), "not json");
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { storeCatalogue(paths, "z-http.json", Date.now()); });
    const warning = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
    expect(warning).toContain("invalid Codex login file");
  });

  it("waits after the current Codex account's failure expires", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", fingerprint, Date.now() - CATALOGUE_RETRY_MS);
    const cache = catalogueCachePath(paths, "codex", pid, generation);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: fingerprint, supervisorPid: pid })); });
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    port.waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not trust a Codex failure with no timestamp", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", fingerprint);
    const cache = catalogueCachePath(paths, "codex", pid, generation);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: fingerprint, supervisorPid: pid })); });
    realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not trust a future Codex failure", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const pid = process.pid + 1;
    const generation = "10000000-0000-4000-8000-000000000001";
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, pid, home, generation);
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    writeCatalogueStatus(realFarmFs, paths, pid, generation, "codex", "failed", fingerprint, Date.now() + CATALOGUE_RETRY_MS);
    const cache = catalogueCachePath(paths, "codex", pid, generation);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => { fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: fingerprint, supervisorPid: pid })); });
    realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); }).waitForCatalogues?.(pid);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not wait for a fresh Codex catalogue for the serving account", () => {
    const paths = buildLayoutPaths(root);
    const home = path.join(root, "codex");
    const generation = "10000000-0000-4000-8000-000000000001";
    const supervisorPid = process.pid + 1;
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ env: "TOKEN" }] } }));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    const record = path.join(paths.frontdoorDir, "codex-homes", `${String(supervisorPid)}.json`);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ codexHome: home, generation }));
    const cache = catalogueCachePath(paths, "codex", supervisorPid, generation);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: catalogueCredentialFingerprint(true, "token", "workspace"), supervisorPid }));
    const port = realFrontDoorPort(paths, () => { throw new Error("unexpected daemon"); });
    expect(() => { port.waitForCatalogues?.(supervisorPid); }).not.toThrow();
  });

  it("registers against its own serving state without reading the process table, which would block the loop that answers every session", () => {
    const paths = buildLayoutPaths(root);
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: process.pid, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    declareThisProcessTheFrontDoor();
    leave = enterProcessRole("frontdoor-supervisor");
    const up = realFrontDoorPort(paths, () => {
      throw new Error("a door that is serving starts no daemon");
    }).ensure(undefined);
    expect(up).toMatchObject({ port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT, supervisorPid: process.pid });
  });
});
