import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCatalogueKeeper } from "./catalogueKeeper";
import type { HttpProvider } from "./config/schema";
import { servedModelPorts } from "./frontdoor/cachedCatalogue";
import { keeperCatalogueReaders } from "./frontdoor/keeperCatalogueReaders";
import * as probe from "./frontdoor/probe";
import { realFrontDoorPort } from "./frontdoor/realFrontDoorPort";
import { FRONT_DOOR_PROTOCOL, writeFrontDoorState } from "./frontdoor/state";
import { catalogueStatusPublisher, readCatalogueFailure, readCatalogueStatus, writeCatalogueFailureReason, writeCatalogueStatus } from "./frontdoor/catalogueState";
import { providerModelRows } from "./launcher/modelPicker";
import { providerModels } from "./models/targets";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { catalogueCachePath, catalogueGenerationDir, catalogueSettingsFingerprint, catalogueSettingsPath, catalogueSettingsText } from "./providerCatalogue";
import { UnreadableCatalogueError } from "./storedCatalogue";
import { catalogueCredentialFingerprint } from "./codex/catalogueCredential";
import { writeFrontDoorCodexHome } from "./frontdoor/state";
import { registerProviderCommand } from "./providers";
import * as realPorts from "./realPorts";
import { realFarmFs } from "./realPorts";
import { fakeCommandDeps } from "./test-helpers";

/** Every kind of stored file a reader may meet that exists and cannot be read: no permission, a directory in its place, a symlink loop. */
const FAULTS = [
  { kind: "no permission", code: "EACCES", needsUser: true },
  { kind: "a directory in its place", code: "EISDIR", needsUser: false },
  { kind: "a symlink loop", code: "ELOOP", needsUser: false },
] as const;
type Fault = (typeof FAULTS)[number];

const RUNNING_AS_ROOT = process.getuid?.() === 0;
const GENERATION = "10000000-0000-4000-8000-000000000001";
const SUPERVISOR_PID = 4242;
const NOW_MS = 10_000;
const FETCHED_AT_MS = 9_000;
const READABLE = 0o600;
const UNREADABLE = 0o000;
const SERVING_PORT = 4100;
const SERVING_CONNECT_PORT = 4300;

const credential = { sources: [{ literal: "placeholder" }] };
const definition = (displayName: string): HttpProvider => ({ displayName, baseUrl: "http://127.0.0.1:9", credential, catalogue: { tier: "sonnet" }, pickerModels: [{ model: `${displayName}-own`, tier: "sonnet" }] });
const GOOD = definition("good");
const BAD = definition("bad");

/** One stored file of the provider `bad` and how it is broken. */
type Target = "catalogue" | "digest" | "status" | "failure";

/** A layout over a throwaway root holding providers `good` and `bad`, each with a catalogue and the digest of its settings, a refresh status and a failure record, one file of `bad` made unreadable the way `fault` says. */
class World {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-stored-readers-"));
  readonly paths: LayoutPaths = buildLayoutPaths(this.root);
  readonly restore: (() => void)[] = [];

  constructor() {
    fs.mkdirSync(this.paths.providersDir, { recursive: true });
    for (const [name, provider] of [["good", GOOD], ["bad", BAD]] as const) {
      fs.writeFileSync(path.join(this.paths.providersDir, `${name}.json`), JSON.stringify(provider));
      this.storeCatalogue(name, provider);
      writeCatalogueStatus(realFarmFs, this.paths, SUPERVISOR_PID, GENERATION, name, "failed", undefined, FETCHED_AT_MS);
      writeCatalogueFailureReason(realFarmFs, this.paths, SUPERVISOR_PID, GENERATION, name, "reason", { redirected: true });
    }
  }

  /** Stores a catalogue of `name` fetched at `fetchedAt` listing the model `<name>-served`, and the digest of `provider`'s settings. */
  storeCatalogue(name: string, provider: HttpProvider, fetchedAt: number = FETCHED_AT_MS): void {
    const cacheFile = catalogueCachePath(this.paths, name);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt, url: "http://127.0.0.1:9/v1/models", models: [{ id: `${name}-served` }] }));
    fs.mkdirSync(path.dirname(catalogueSettingsPath(this.paths, name)), { recursive: true });
    fs.writeFileSync(catalogueSettingsPath(this.paths, name), catalogueSettingsText(catalogueSettingsFingerprint(provider), fetchedAt));
  }

  fileOf(name: string, target: Target): string {
    const generation = catalogueGenerationDir(this.paths, SUPERVISOR_PID, GENERATION);
    const files: Readonly<Record<Target, string>> = {
      catalogue: catalogueCachePath(this.paths, name),
      digest: catalogueSettingsPath(this.paths, name),
      status: path.join(generation, `${name}.status.json`),
      failure: path.join(generation, "failures", `${name}.json`),
    };
    return files[target];
  }

  /** Makes `bad`'s `target` file unreadable the way `fault` says. */
  break(target: Target, fault: Fault): void {
    this.breakFile(this.fileOf("bad", target), fault);
  }

  /** Makes `file` unreadable the way `fault` says; the mode of one without permission is restored when the world is closed. */
  breakFile(file: string, fault: Fault): void {
    if (fault.code === "EACCES") {
      fs.chmodSync(file, UNREADABLE);
      this.restore.push(() => {
        fs.chmodSync(file, READABLE);
      });
      return;
    }
    fs.rmSync(file);
    if (fault.code === "EISDIR") fs.mkdirSync(file);
    else fs.symlinkSync(file, file);
  }

  /** What every message a reader produced must not contain: the root every path of the layout is under. */
  hasPath(text: string): boolean {
    return text.includes(this.root);
  }

  close(): void {
    for (const undo of this.restore.splice(0)) undo();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

const worlds: World[] = [];
const newWorld = (): World => {
  const world = new World();
  worlds.push(world);
  return world;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const world of worlds.splice(0)) world.close();
});

const faults = FAULTS.filter((fault) => !(fault.needsUser && RUNNING_AS_ROOT));

/**
 * Every reader of a stored catalogue file, one describe each, over every way the file can be unreadable: the one provider's file is skipped, recorded or answered for as that reader's contract says, with the fault's code and never a path, and the other provider is unaffected. A reader that a source adds reads through `StoredCatalogue`, the only module outside the writers that names a stored file's path (`storedCatalogueGuard.test.ts`), and gets its describe here.
 */
describe.each(faults)("a stored catalogue file that is unreadable: $kind", (fault) => {
  describe.each(["catalogue", "digest"] as const)("its %s", (target) => {
    it("is raised by the door's model reader as the fault alone, for that provider only", () => {
      const world = newWorld();
      world.break(target, fault);
      const { catalogueModelsOf } = servedModelPorts(world.paths, () => undefined);
      expect(catalogueModelsOf?.("good", GOOD)).toEqual([{ id: "good-served" }]);
      let raised: Error | undefined;
      try {
        catalogueModelsOf?.("bad", BAD);
      } catch (error) {
        raised = error instanceof Error ? error : undefined;
      }
      expect(raised).toBeInstanceOf(UnreadableCatalogueError);
      expect(raised instanceof UnreadableCatalogueError && raised.fault).toBe(fault.code);
      expect(world.hasPath(raised instanceof Error ? raised.message : "")).toBe(false);
    });

    it("is recorded by the keeper against that provider, which does not stop the others", () => {
      const world = newWorld();
      world.break(target, fault);
      const refreshed: string[] = [];
      const published: string[] = [];
      const lines: string[] = [];
      // `good` has no catalogue to be current, so it is due: the tick must reach it after `bad`.
      fs.rmSync(world.fileOf("good", "catalogue"));
      const keeper = createCatalogueKeeper({
        supervisorPid: SUPERVISOR_PID,
        providers: () => [["bad", BAD], ["good", GOOD]],
        ...keeperCatalogueReaders(world.paths, SUPERVISOR_PID, GENERATION),
        refresh: async (name) => {
          refreshed.push(name);
          await Promise.resolve();
        },
        nowMs: () => NOW_MS,
        log: (line) => {
          lines.push(line);
        },
        publishStatus: (name, status, _fingerprint, reason) => {
          published.push(`${name} ${status} ${reason ?? ""}`.trim());
        },
      });
      expect(() => {
        keeper.tick();
      }).not.toThrow();
      expect(refreshed).toEqual(["good"]);
      expect(published).toContain(`bad failed stored catalogue cannot be read (${fault.code})`);
      expect(keeper.status("bad")).toBe("failed");
      expect(lines.join("\n")).toContain(fault.code);
      expect(world.hasPath([...lines, ...published].join("\n"))).toBe(false);
    });

    it("is skipped by the model listing, which lists the other provider's catalogue and this one's own models", () => {
      const world = newWorld();
      world.break(target, fault);
      const listed = providerModels(world.paths);
      const modelsOf = (name: string): readonly string[] => listed.filter((entry) => entry.provider === name).map((entry) => entry.model);
      expect(modelsOf("good")).toEqual(providerModelRows(GOOD, [{ id: "good-served" }]).map((row) => row.model));
      expect(modelsOf("bad")).toEqual(providerModelRows(BAD).map((row) => row.model));
    });

    it("stops `provider models` for that provider with its fault and no path", async () => {
      const world = newWorld();
      world.break(target, fault);
      const program = new Command().exitOverride();
      registerProviderCommand(program, fakeCommandDeps(world.paths));
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program.parseAsync(["provider", "models", "good"], { from: "user" });
      expect(output.mock.calls.flat().join("\n")).toContain("good-served");
      let failure = "";
      try {
        await program.parseAsync(["provider", "models", "bad"], { from: "user" });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain('"bad"');
      expect(failure).toContain(`(${fault.code})`);
      expect(world.hasPath(failure)).toBe(false);
    });

    it("reads as absent to a launch waiting for catalogues, which waits for a refresh like a missing one", () => {
      const world = newWorld();
      writeFrontDoorState(realFarmFs, world.paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: process.pid + 1, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
      fs.writeFileSync(world.paths.frontdoorControlTokenFile, "test-token");
      fs.mkdirSync(path.dirname(world.paths.frontdoorCaCertFile), { recursive: true });
      fs.writeFileSync(world.paths.frontdoorCaCertFile, "test-ca");
      vi.spyOn(probe, "requestCatalogueRefreshSync").mockReturnValue({ ok: true });
      fs.rmSync(path.join(world.paths.providersDir, "good.json"));
      world.break(target, fault);
      const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
        // The refresh the launch asked for lands: the unreadable file is replaced by a current catalogue and its digest.
        fs.rmSync(world.fileOf("bad", target), { recursive: true, force: true });
        world.storeCatalogue("bad", BAD, Date.now());
      });
      expect(() => realFrontDoorPort(world.paths, () => {
        throw new Error("unexpected daemon");
      }).waitForCatalogues?.(process.pid + 1)).not.toThrow();
      expect(sleep).toHaveBeenCalledOnce();
    });
  });

  describe.each(["status", "failure"] as const)("its refresh %s record", (target) => {
    it("reads as no record to the launcher and `doctor`, and the other provider's record is read", () => {
      const world = newWorld();
      world.break(target, fault);
      const read = (name: string): unknown => (target === "status" ? readCatalogueStatus(realFarmFs, world.paths, SUPERVISOR_PID, GENERATION, name) : readCatalogueFailure(realFarmFs, world.paths, SUPERVISOR_PID, GENERATION, name));
      expect(read("bad")).toBeUndefined();
      expect(read("good")).toBeDefined();
    });
  });
});

describe("the readers' contract on a file that is merely absent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is that nothing is recorded, raised or listed for it", () => {
    const world = newWorld();
    fs.rmSync(world.fileOf("bad", "catalogue"));
    const { catalogueModelsOf } = servedModelPorts(world.paths, () => undefined);
    expect(catalogueModelsOf?.("bad", BAD)).toEqual([]);
    expect(readCatalogueStatus(realFarmFs, world.paths, SUPERVISOR_PID, "00000000-0000-4000-8000-000000000000", "bad")).toBeUndefined();
  });
});

/** The catalogue of a Codex provider is bound to the login file of the account that fetched it, which is read beside the catalogue: a login file that cannot be read is that one provider's fault too. */
describe.each(faults)("the login file of a Codex provider that is unreadable: $kind", (fault) => {
  const CODEX_FETCHED_MS = 5_000;

  /** A world with the providers `good` and `bad` and a Codex provider `codex` whose catalogue is stored and whose login file `auth.json` is made unreadable. */
  function codexWorld(broken: "login" | "catalogue" = "login"): { readonly world: World; readonly loginFile: string; readonly home: string } {
    const world = newWorld();
    const home = path.join(world.root, "codex-home");
    fs.mkdirSync(home, { recursive: true });
    const loginFile = path.join(home, "auth.json");
    fs.writeFileSync(loginFile, JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }));
    fs.writeFileSync(path.join(world.paths.providersDir, "codex.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential }));
    const codexCache = catalogueCachePath(world.paths, "codex");
    fs.writeFileSync(codexCache, JSON.stringify({ fetchedAt: CODEX_FETCHED_MS, url: "https://example.test", models: [{ id: "gpt" }], credentialFingerprint: catalogueCredentialFingerprint(true, "token", "workspace") }));
    vi.stubEnv("CODEX_HOME", home);
    world.breakFile(broken === "login" ? loginFile : codexCache, fault);
    return { world, loginFile, home };
  }

  it("is skipped by the model listing, which still lists every other provider's models", () => {
    const { world } = codexWorld();
    const listed = providerModels(world.paths);
    expect(listed.filter((entry) => entry.provider === "good").map((entry) => entry.model)).toEqual(providerModelRows(GOOD, [{ id: "good-served" }]).map((row) => row.model));
    expect(listed.some((entry) => entry.provider === "codex")).toBe(false);
  });

  it("stops `provider models` for that provider with its fault and no path", async () => {
    const { world } = codexWorld();
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(world.paths));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let failure = "";
    try {
      await program.parseAsync(["provider", "models", "codex"], { from: "user" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('"codex"');
    expect(failure).toContain(`(${fault.code})`);
    expect(world.hasPath(failure)).toBe(false);
  });

  it("is no reason for `provider models` of that provider to name anything but its catalogue when it is the catalogue that cannot be read", async () => {
    const { world } = codexWorld("catalogue");
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(world.paths));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let failure = "";
    try {
      await program.parseAsync(["provider", "models", "codex"], { from: "user" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('The stored catalogue of "codex" cannot be read');
    expect(failure).toContain(`(${fault.code})`);
    expect(world.hasPath(failure)).toBe(false);
  });

  it("is recorded by the keeper against that provider as its fault's code and no path, and the other providers are refreshed", () => {
    const { world, home } = codexWorld();
    const refreshed: string[] = [];
    const lines: string[] = [];
    const published: string[] = [];
    fs.rmSync(world.fileOf("good", "catalogue"));
    const keeper = createCatalogueKeeper({
      supervisorPid: SUPERVISOR_PID,
      providers: () => [["codex", { kind: "codex", displayName: "Codex", credential }], ["good", GOOD]],
      ...keeperCatalogueReaders(world.paths, SUPERVISOR_PID, GENERATION, { CODEX_HOME: home }, world.root),
      refresh: async (name) => {
        refreshed.push(name);
        await Promise.resolve();
      },
      nowMs: () => NOW_MS,
      log: (line) => {
        lines.push(line);
      },
      publishStatus: (name, status) => {
        published.push(`${name} ${status}`);
      },
    });
    expect(() => {
      keeper.tick();
    }).not.toThrow();
    expect(refreshed).toEqual(["good"]);
    expect(published).toContain("codex failed");
    expect(keeper.status("codex")).toBe("failed");
    expect(lines.join("\n")).toContain(`its login cannot be read (${fault.code})`);
    expect(world.hasPath(lines.join("\n"))).toBe(false);
  });

  it("is reported to a launch waiting for catalogues as its fault's code and no path, and the launch does not wait for it", () => {
    const { world, home } = codexWorld();
    const pid = process.pid + 1;
    writeFrontDoorState(realFarmFs, world.paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: pid, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    writeFrontDoorCodexHome(realFarmFs, world.paths.frontdoorDir, pid, home, GENERATION);
    fs.rmSync(path.join(world.paths.providersDir, "good.json"));
    fs.rmSync(path.join(world.paths.providersDir, "bad.json"));
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      throw new Error("unexpected wait");
    });
    const warning = realFrontDoorPort(world.paths, () => {
      throw new Error("unexpected daemon");
    }).waitForCatalogues?.(pid);
    expect(warning).toContain(`Cannot read the catalogue credentials for codex (${fault.code})`);
    expect(world.hasPath(warning ?? "")).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("a provider whose files are readable again after the keeper recorded them as unreadable", () => {
  it.skipIf(RUNNING_AS_ROOT)("is ready again with a current catalogue, in the status a launch's wait reads, though nothing refreshes it", () => {
    const world = newWorld();
    // The door the launch waits on is the supervisor the keeper publishes under.
    const supervisor = process.pid + 1;
    const keeperPublish = catalogueStatusPublisher(realFarmFs, world.paths, supervisor, GENERATION, () => Date.now());
    const published: string[] = [];
    const refreshed: string[] = [];
    const now = Date.now();
    world.storeCatalogue("bad", BAD, now);
    const keeper = createCatalogueKeeper({
      supervisorPid: supervisor,
      providers: () => [["bad", BAD]],
      ...keeperCatalogueReaders(world.paths, supervisor, GENERATION),
      refresh: async (name) => {
        refreshed.push(name);
        await Promise.resolve();
      },
      nowMs: () => now,
      log: () => undefined,
      publishStatus: (name, status, ...rest) => {
        published.push(`${name} ${status}`);
        keeperPublish(name, status, ...rest);
      },
    });
    world.break("catalogue", FAULTS[0]);
    keeper.tick();
    expect(readCatalogueStatus(realFarmFs, world.paths, supervisor, GENERATION, "bad")?.status).toBe("failed");
    for (const undo of world.restore.splice(0)) undo();
    keeper.tick();
    expect(published).toEqual(["bad failed", "bad ready"]);
    expect(refreshed).toEqual([]);
    expect(readCatalogueStatus(realFarmFs, world.paths, supervisor, GENERATION, "bad")?.status).toBe("ready");
    expect(keeper.status("bad")).toBeUndefined();

    writeFrontDoorState(realFarmFs, world.paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: supervisor, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    writeFrontDoorCodexHome(realFarmFs, world.paths.frontdoorDir, supervisor, world.root, GENERATION);
    fs.rmSync(path.join(world.paths.providersDir, "good.json"));
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      throw new Error("unexpected wait");
    });
    expect(realFrontDoorPort(world.paths, () => {
      throw new Error("unexpected daemon");
    }).waitForCatalogues?.(supervisor)).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("a provider with no catalogue whose refresh failed, whose files cannot be read and are then readable again inside the backoff", () => {
  it.skipIf(RUNNING_AS_ROOT)("stays failed in the status a launch's wait reads: the launch is told the refresh failed, not that the catalogue is ready", async () => {
    const world = newWorld();
    const supervisor = process.pid + 1;
    const keeperPublish = catalogueStatusPublisher(realFarmFs, world.paths, supervisor, GENERATION, () => Date.now());
    const published: string[] = [];
    // `bad` has no catalogue at all, and its server is down.
    fs.rmSync(world.fileOf("bad", "catalogue"));
    fs.rmSync(world.fileOf("bad", "digest"));
    fs.rmSync(path.join(world.paths.providersDir, "good.json"));
    const keeper = createCatalogueKeeper({
      supervisorPid: supervisor,
      providers: () => [["bad", BAD]],
      ...keeperCatalogueReaders(world.paths, supervisor, GENERATION),
      refresh: async () => {
        await Promise.resolve();
        throw new Error("server down");
      },
      nowMs: () => Date.now(),
      log: () => undefined,
      publishStatus: (name, status, ...rest) => {
        published.push(`${name} ${status}${rest[1] === undefined ? "" : `:${rest[1]}`}`);
        keeperPublish(name, status, ...rest);
      },
    });
    keeper.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const catalogueFile = world.fileOf("bad", "catalogue");
    fs.mkdirSync(catalogueFile);
    keeper.tick();
    fs.rmdirSync(catalogueFile);
    keeper.tick();
    expect(published).toEqual(["bad running", "bad failed:server down", "bad failed:stored catalogue cannot be read (EISDIR)", "bad failed:server down"]);
    expect(keeper.status("bad")).toBe("failed");

    writeFrontDoorState(realFarmFs, world.paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: supervisor, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    writeFrontDoorCodexHome(realFarmFs, world.paths.frontdoorDir, supervisor, world.root, GENERATION);
    const sleep = vi.spyOn(realPorts, "realSleepSync").mockImplementation(() => {
      throw new Error("unexpected wait");
    });
    const warning = realFrontDoorPort(world.paths, () => {
      throw new Error("unexpected daemon");
    }).waitForCatalogues?.(supervisor);
    expect(warning).toContain("Catalogue refresh failed for bad");
    expect(sleep).not.toHaveBeenCalled();
  });
});
