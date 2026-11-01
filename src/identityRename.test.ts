import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError, readActiveIdentity, readIdentity } from "./identityStore";
import { describeIdentityRename, IdentityInUseError, renameIdentity, type IdentityRenamePorts } from "./identityRename";
import { identityTokenPath, TOKEN_FILE_MODE } from "./identityToken";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { IDENTITY_NAME_LOCATIONS } from "./identityNameLocations";
import { createFakeKeychain, type FakeKeychain } from "./keychainTestWorld";
import type { SessionProcess } from "./identitySessions";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";

/** The shape of the suffix a resync gives its superseded and scratch farms: the launcher's process id, then a UUID. */
const SUFFIX = "4242.0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_SUFFIX = "17.7c9e6679-7425-40de-944b-e07fc1f90ae7";
const NOW_MS = 1_000;
const OWN_PID = 4242;
const PERMISSION_BITS = 0o777;
const OCTAL = 8;

/** A made-up login blob; the tests assert it crosses the fake Keychain boundary only on standard input. */
const LOGIN_SECRET = '{"claudeAiOauth":{"accessToken":"made-up-value-for-the-rename-test"}}';

interface World {
  readonly root: string;
  readonly paths: LayoutPaths;
  readonly keychain: FakeKeychain;
  readonly cache: Map<string, CachedCredential>;
  readonly sessions: Map<string, readonly SessionProcess[]>;
  readonly ports: (overrides?: Partial<IdentityRenamePorts>) => IdentityRenamePorts;
  readonly read: (relative: string) => string;
  readonly json: (relative: string) => unknown;
  readonly directory: (name: string) => string;
}

function writeFile(file: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

function writeJson(file: string, value: unknown, mode?: number): void {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** The owner-only mode the usage store gives the files it writes. */
const PRIVATE_FILE_MODE = 0o600;

/** A temporary state root holding an identity `work` that is referenced from every place a name is kept, and a second identity `personal` that must be left alone. */
function createWorld(platform: NodeJS.Platform = "linux"): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-rename-test-"));
  const paths = buildLayoutPaths(root);
  const keychain = createFakeKeychain();
  const cache = new Map<string, CachedCredential>();
  const sessions = new Map<string, readonly SessionProcess[]>();
  const tokenFile = path.join(root, "credentials", "work.token");

  writeJson(path.join(root, "identities", "work", "identity.json"), {
    name: "work",
    allowAmbientCredential: false,
    label: "Example Org",
    credential: { sources: [{ file: tokenFile }, { env: "EXAMPLE_TOKEN" }, { file: "/example/elsewhere/work.token" }], target: "oauthToken", cache: { store: "file" } },
  });
  writeJson(path.join(root, "identities", "work", ".agent-shim-farm.json"), { version: 1, builtAtMs: 1, identity: "work", cwd: "/example/project", claudeHome: "/example/claude", materialised: [], links: [] });
  writeFile(path.join(root, "identities", "work", ".credentials.json"), "{}\n");
  writeFile(path.join(root, "identities", `.work.previous.${SUFFIX}`, "left-over.txt"), "kept\n");
  writeJson(path.join(root, "identities", "personal", "identity.json"), { name: "personal", allowAmbientCredential: false });
  writeFile(tokenFile, "a-made-up-token-file-body\n", TOKEN_FILE_MODE);
  writeJson(paths.globalConfigFile, {
    pools: {
      subs: { identities: ["work", "personal", "pool:fleet"] },
      fleet: { identities: [{ identity: "work", when: { branch: "main" } }, "personal"] },
      other: { identities: ["personal"] },
    },
    jobs: {
      burn: { target: { identity: "work" }, trigger: { beforeReset: "fiveHour", lead: "1h" }, prompt: "go", cwd: "/work", timeout: "10m" },
      pooled: { target: { pool: "subs" }, trigger: { beforeReset: "sevenDay", lead: "2h" }, prompt: "go", cwd: "/work", timeout: "10m" },
    },
    models: { virtual: { fast: { mode: "ordered", members: ["acct:work/opus", "z/glm-5.3"] } }, tiers: { opus: "acct:work/opus", sonnet: "acct:personal/sonnet" } },
  });
  writeJson(path.join(paths.configProfilesDir, "client.json"), { models: { hide: ["acct:work/haiku"], show: ["acct:personal/haiku"] } });
  writeJson(path.join(paths.configProfilesDir, "plain.json"), { description: "no model refs" });
  writeJson(paths.directoryRulesFile, {
    rules: [
      { path: "/example/project", identity: "work" },
      { path: "/example/other", identity: "personal" },
      { path: "/example/pooled", identity: "pool:subs", models: { tiers: { opus: "acct:work/opus" } } },
    ],
  });
  writeFile(paths.activeIdentityFile, "work\n");
  writeJson(path.join(paths.usageSnapshotsDir, "work.json"), { schemaVersion: 1, identity: "work", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} }, PRIVATE_FILE_MODE);
  writeJson(path.join(paths.usageSnapshotsDir, "personal.json"), { schemaVersion: 1, identity: "personal", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} }, PRIVATE_FILE_MODE);
  writeJson(
    paths.usagePicksFile,
    { schemaVersion: 1, picks: { "/example/project": { identity: "work", at: "2026-10-30T10:00:00.000Z" }, "/example/other": { identity: "personal", at: "2026-10-30T10:00:00.000Z" } } },
    PRIVATE_FILE_MODE,
  );
  writeJson(paths.usageAnchorsFile, { schemaVersion: 1, handled: { work: "2026-10-30T10:00:00.000Z", personal: "2026-10-30T11:00:00.000Z" } }, PRIVATE_FILE_MODE);
  cache.set("file:identity work", { token: "a-made-up-cached-token", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } });
  if (platform === "darwin") {
    keychain.seed(claudeCodeKeychainService(path.join(root, "identities", "work")), "alex", LOGIN_SECRET);
  }

  const cachePort: CredentialCachePort = {
    read: (store, owner) => cache.get(`${store}:${owner}`),
    write: (store, owner, entry) => {
      cache.set(`${store}:${owner}`, entry);
    },
    remove: (store, owner) => {
      cache.delete(`${store}:${owner}`);
    },
  };
  const world: World = {
    root,
    paths,
    keychain,
    cache,
    sessions,
    ports: (overrides = {}) => ({
      fs: realFarmFs,
      credentialCache: { port: cachePort, platform: "linux" },
      run: keychain.run,
      platform,
      sessions: { sessionsOn: (configDir) => sessions.get(configDir) ?? [] },
      lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined },
      ...overrides,
    }),
    read: (relative) => fs.readFileSync(path.join(root, relative), "utf8"),
    json: (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as unknown,
    directory: (name) => path.join(root, "identities", name),
  };
  return world;
}

/** Every file and directory under `root`, with the file contents and mode, so two trees compare byte for byte. */
function treeOf(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        tree[`${relative}/`] = "dir";
        walk(full);
      } else {
        tree[relative] = `${(fs.statSync(full).mode & PERMISSION_BITS).toString(OCTAL)} ${fs.readFileSync(full, "utf8")}`;
      }
    }
  };
  walk(root);
  return tree;
}

describe("renameIdentity", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("moves the identity's directory, and any superseded farm beside it, to the new name", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(world.directory("work"))).toBe(false);
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(fs.readFileSync(path.join(world.directory("client"), ".credentials.json"), "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(world.root, "identities", `.work.previous.${SUFFIX}`))).toBe(false);
    expect(fs.readFileSync(path.join(world.root, "identities", `.client.previous.${SUFFIX}`, "left-over.txt"), "utf8")).toBe("kept\n");
  });

  it("leaves no lock behind and keeps no former name", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.readdirSync(path.join(world.root, "identities")).sort()).toEqual([`.client.previous.${SUFFIX}`, "client", "personal"]);
    expect(fs.existsSync(path.join(world.root, "provider-aliases.json"))).toBe(false);
    expect(readIdentity(world.paths, "work")).toBeUndefined();
  });

  it("leaves the farms of another identity whose name starts the same way where they are", () => {
    writeJson(path.join(world.root, "identities", "work.previous.old", "identity.json"), { name: "work.previous.old", allowAmbientCredential: false });
    writeFile(path.join(world.root, "identities", `.work.previous.old.scratch.${OTHER_SUFFIX}`, "kept.txt"), "kept\n");
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.readFileSync(path.join(world.root, "identities", `.work.previous.old.scratch.${OTHER_SUFFIX}`, "kept.txt"), "utf8")).toBe("kept\n");
    expect(fs.existsSync(path.join(world.root, "identities", "work.previous.old", "identity.json"))).toBe(true);
    expect(fs.existsSync(path.join(world.root, "identities", `.client.scratch.${OTHER_SUFFIX}`))).toBe(false);
  });

  it("rewrites the name in identity.json and points its credential file source at the moved token file", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    const identity = readIdentity(world.paths, "client");
    expect(identity?.name).toBe("client");
    expect(identity?.label).toBe("Example Org");
    expect(identity?.credential?.sources).toEqual([{ file: path.join(world.root, "credentials", "client.token") }, { env: "EXAMPLE_TOKEN" }, { file: "/example/elsewhere/work.token" }]);
    expect(identity?.credential?.cache).toEqual({ store: "file" });
  });

  it("re-roots a credential file source that sits inside the identity's own directory", () => {
    const file = path.join(world.directory("work"), "identity.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { credential: { sources: unknown[] } };
    stored.credential.sources.push({ file: path.join(world.directory("work"), "secrets", "token") });
    fs.writeFileSync(file, JSON.stringify(stored));
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "client")?.credential?.sources.at(-1)).toEqual({ file: path.join(world.directory("client"), "secrets", "token") });
  });

  it("moves the stored token file, keeping its owner-only mode", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(path.join(world.root, "credentials", "work.token"))).toBe(false);
    const moved = path.join(world.root, "credentials", "client.token");
    expect(fs.readFileSync(moved, "utf8")).toBe("a-made-up-token-file-body\n");
    expect(fs.statSync(moved).mode & PERMISSION_BITS).toBe(TOKEN_FILE_MODE);
    expect(identityTokenPath(world.paths, "client")).toBe(moved);
  });

  it("moves the cached credential to the new owner", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.cache.has("file:identity work")).toBe(false);
    expect(world.cache.get("file:identity client")?.token).toBe("a-made-up-cached-token");
  });

  it("rewrites the farm's own record of whose farm it is", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("identities/client/.agent-shim-farm.json")).toEqual({ version: 1, builtAtMs: 1, identity: "client", cwd: "/example/project", claudeHome: "/example/claude", materialised: [], links: [] });
  });

  it("renames the member in every pool, nested and conditional ones included, and leaves pool selectors and other members alone", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toMatchObject({
      pools: {
        subs: { identities: ["client", "personal", "pool:fleet"] },
        fleet: { identities: [{ identity: "client", when: { branch: "main" } }, "personal"] },
        other: { identities: ["personal"] },
      },
    });
  });

  it("retargets the jobs that run as the identity, and not the ones that run as a pool", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toMatchObject({ jobs: { burn: { target: { identity: "client" } }, pooled: { target: { pool: "subs" } } } });
  });

  it("requalifies account model refs in the global block, a profile and a directory rule, and no other identity's", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toMatchObject({ models: { virtual: { fast: { mode: "ordered", members: ["acct:client/opus", "z/glm-5.3"] } }, tiers: { opus: "acct:client/opus", sonnet: "acct:personal/sonnet" } } });
    expect(world.json("config-profiles/client.json")).toEqual({ models: { hide: ["acct:client/haiku"], show: ["acct:personal/haiku"] } });
    expect(world.json("config-profiles/plain.json")).toEqual({ description: "no model refs" });
    expect(world.json("directory-rules.json")).toEqual({
      rules: [
        { path: "/example/project", identity: "client" },
        { path: "/example/other", identity: "personal" },
        { path: "/example/pooled", identity: "pool:subs", models: { tiers: { opus: "acct:client/opus" } } },
      ],
    });
  });

  it("selects the new name when the renamed identity was the active one, and leaves another active identity alone", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("client");
    fs.writeFileSync(world.paths.activeIdentityFile, "personal\n");
    renameIdentity(world.paths, "personal", "home", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("home");
    fs.writeFileSync(world.paths.activeIdentityFile, "pool:subs\n");
    renameIdentity(world.paths, "client", "work", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("pool:subs");
  });

  it("moves the usage snapshot and rewrites the name inside it, replacing a stale one under the new name", () => {
    writeJson(path.join(world.paths.usageSnapshotsDir, "client.json"), { schemaVersion: 1, identity: "client", updatedAt: "2025-01-01T00:00:00.000Z", providers: {} });
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(path.join(world.paths.usageSnapshotsDir, "work.json"))).toBe(false);
    expect(world.json("usage/snapshots/client.json")).toEqual({ schemaVersion: 1, identity: "client", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} });
    expect(world.json("usage/snapshots/personal.json")).toMatchObject({ identity: "personal" });
  });

  it("rewrites the recorded pool picks and the anchor stamps", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("usage/picks.json")).toEqual({
      schemaVersion: 1,
      picks: { "/example/project": { identity: "client", at: "2026-10-30T10:00:00.000Z" }, "/example/other": { identity: "personal", at: "2026-10-30T10:00:00.000Z" } },
    });
    expect(world.json("usage/anchors.json")).toEqual({ schemaVersion: 1, handled: { client: "2026-10-30T10:00:00.000Z", personal: "2026-10-30T11:00:00.000Z" } });
  });

  it("reports each thing it moved or rewrote, in order", () => {
    const report = renameIdentity(world.paths, "work", "client", world.ports());
    expect(report).toEqual({
      from: "work",
      to: "client",
      dryRun: false,
      steps: [
        "rewrite identities/work/identity.json: name, credential file source",
        "rewrite identities/work/.agent-shim-farm.json: identity",
        `move identities/.work.previous.${SUFFIX} to identities/.client.previous.${SUFFIX}`,
        "move identities/work to identities/client",
        "move credentials/work.token to credentials/client.token",
        "move the cached credential of identity work to identity client, if one is stored",
        "rewrite config.json: pool subs, pool fleet, job burn, models",
        "rewrite config-profiles/client.json: models",
        "rewrite directory-rules.json: rule /example/project, rule /example/pooled",
        "rewrite active-identity",
        "move usage/snapshots/work.json to usage/snapshots/client.json",
        "rewrite usage/picks.json: 1 pick",
        "rewrite usage/anchors.json: 1 stamp",
      ],
      warnings: [],
    });
  });

  describe("refusals", () => {
    it("refuses while a session is running on the identity, naming it, and changes nothing", () => {
      world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
      const before = treeOf(world.root);
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(IdentityInUseError);
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/pid 4711 \(claude\)/);
      expect(treeOf(world.root)).toEqual(before);
    });

    it("refuses an unknown identity, a name it already has, an unusable name and an unchanged one, naming which", () => {
      expect(() => renameIdentity(world.paths, "ghost", "client", world.ports())).toThrow(IdentityNotFoundError);
      expect(() => renameIdentity(world.paths, "work", "personal", world.ports())).toThrow(IdentityAlreadyExistsError);
      expect(() => renameIdentity(world.paths, "work", "-bad", world.ports())).toThrow(InvalidIdentityNameError);
      expect(() => renameIdentity(world.paths, "work", "work", world.ports())).toThrow(CliError);
    });

    it("refuses a name whose directory or superseded farm is already there, even without an identity.json", () => {
      fs.mkdirSync(world.directory("client"));
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/already/);
      fs.rmdirSync(world.directory("client"));
      fs.mkdirSync(path.join(world.root, "identities", `.client.previous.${OTHER_SUFFIX}`));
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/already/);
    });

    it("refuses when the new name already has a token file", () => {
      writeFile(path.join(world.root, "credentials", "client.token"), "someone else's\n", TOKEN_FILE_MODE);
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/token/);
      expect(world.read("credentials/client.token")).toBe("someone else's\n");
    });

    it("refuses while another resync holds the identity lock", () => {
      writeFile(path.join(world.root, "identities", ".work.lock"), `${JSON.stringify({ identity: "work", pid: 99, token: "t", acquiredAtMs: NOW_MS })}\n`);
      expect(() => renameIdentity(world.paths, "work", "client", world.ports({ lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } }))).toThrow(/resync is already running/);
      expect(fs.existsSync(world.directory("work"))).toBe(true);
    });
  });

  describe("rollback", () => {
    it("restores everything when a late step fails", () => {
      const before = treeOf(world.root);
      const failing = {
        ...realFarmFs,
        writeFilePrivate: (file: string, contents: string): void => {
          if (file === world.paths.usageAnchorsFile) {
            throw new Error("disk full");
          }
          realFarmFs.writeFilePrivate(file, contents);
        },
      };
      expect(() => renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).toThrow(/disk full/);
      expect(treeOf(world.root)).toEqual(before);
      expect(world.cache.get("file:identity work")?.token).toBe("a-made-up-cached-token");
      expect(world.cache.has("file:identity client")).toBe(false);
    });

    it("restores everything when a middle step fails", () => {
      const before = treeOf(world.root);
      const cachePort: CredentialCachePort = {
        read: (store, owner) => world.cache.get(`${store}:${owner}`),
        write: () => {
          throw new Error("cache store unavailable");
        },
        remove: (store, owner) => {
          world.cache.delete(`${store}:${owner}`);
        },
      };
      expect(() => renameIdentity(world.paths, "work", "client", world.ports({ credentialCache: { port: cachePort, platform: "linux" } }))).toThrow(/cache store unavailable/);
      expect(treeOf(world.root)).toEqual(before);
    });

    it("stops before changing anything when a configuration file cannot be read", () => {
      writeFile(path.join(world.root, "config.json"), "{ not json");
      const before = treeOf(world.root);
      expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow();
      expect(treeOf(world.root)).toEqual(before);
    });
  });
});

describe("describeIdentityRename (--dry-run)", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("lists exactly the steps a real rename takes, and changes nothing", () => {
    const before = treeOf(world.root);
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(treeOf(world.root)).toEqual(before);
    expect(planned.dryRun).toBe(true);
    const done = renameIdentity(world.paths, "work", "client", world.ports());
    expect(done.dryRun).toBe(false);
    expect(done.steps).toEqual(planned.steps);
    expect(done.warnings).toEqual(planned.warnings);
  });

  it("asks the Keychain nothing that returns a secret, and writes nothing to it", () => {
    describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(world.keychain.calls.length).toBeGreaterThan(0);
    expect(world.keychain.calls.every((call) => call.args[0] === "find-generic-password" && !call.args.includes("-w") && !call.args.includes("-g") && call.input === undefined)).toBe(true);
    expect(world.keychain.items.size).toBe(1);
  });

  it("takes no lock, so it leaves no file behind", () => {
    describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(fs.readdirSync(path.join(world.root, "identities")).some((entry) => entry.endsWith(".lock"))).toBe(false);
  });

  it("refuses for the same reasons a rename does", () => {
    world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow(IdentityInUseError);
    expect(() => describeIdentityRename(world.paths, "work", "personal", world.ports())).toThrow(IdentityAlreadyExistsError);
  });
});

describe("renameIdentity with a macOS Keychain login", () => {
  let world: World;
  const oldService = (): string => claudeCodeKeychainService(world.directory("work"));
  const newService = (): string => claudeCodeKeychainService(world.directory("client"));

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("carries the login to the service derived from the new directory and removes the old item last", () => {
    const oldKey = oldService();
    const newKey = newService();
    const report = renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.keychain.items.get(newKey)?.account).toBe("alex");
    expect(world.keychain.secretOf(newKey)?.toString("utf8")).toBe(LOGIN_SECRET);
    expect(world.keychain.items.has(oldKey)).toBe(false);
    expect(report.steps[0]).toBe(`copy the Keychain login "${oldKey}" to "${newKey}"`);
    expect(report.steps.at(-1)).toBe(`delete the former Keychain login "${oldKey}"`);
  });

  it("never exposes the login in an argument list, a step, a warning or a thrown error", () => {
    const report = renameIdentity(world.paths, "work", "client", world.ports());
    const exposed = world.keychain.calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
    expect(exposed).not.toContain("made-up-value-for-the-rename-test");
    expect(exposed).not.toContain(Buffer.from(LOGIN_SECRET).toString("hex"));
    expect(JSON.stringify(report)).not.toContain("made-up-value-for-the-rename-test");
  });

  it("deletes the old item only after the new one has been looked up and found", () => {
    renameIdentity(world.paths, "work", "client", world.ports());
    const calls = world.keychain.calls.map((call) => `${call.args[0] ?? ""} ${call.args.includes(newService()) ? "new" : call.args.includes(oldService()) ? "old" : ""}`.trim());
    const deleteOld = calls.lastIndexOf("delete-generic-password old");
    const lookupNew = calls.lastIndexOf("find-generic-password new");
    expect(deleteOld).toBeGreaterThan(-1);
    expect(lookupNew).toBeGreaterThan(-1);
    expect(lookupNew).toBeLessThan(deleteOld);
    expect(calls.slice(deleteOld + 1)).toEqual([]);
  });

  it("keeps the old login and the old name when the new item cannot be created", () => {
    world.keychain.failNextAdd(1);
    const before = treeOf(world.root);
    expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/Could not create the login/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(oldService())).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(false);
  });

  it("removes the new item and keeps the old one when a later step fails", () => {
    const before = treeOf(world.root);
    const failing = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        if (file === world.paths.usageAnchorsFile) {
          throw new Error("disk full");
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    expect(() => renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).toThrow(/disk full/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(oldService())).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(false);
  });

  it("refuses when a login is already filed under the new directory, without touching either", () => {
    world.keychain.seed(newService(), "alex", "left over");
    const before = treeOf(world.root);
    expect(() => renameIdentity(world.paths, "work", "client", world.ports())).toThrow(/already holds a login/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.secretOf(newService())?.toString("utf8")).toBe("left over");
  });

  it("copies nothing for an identity with no login in the Keychain", () => {
    world.keychain.items.delete(oldService());
    const report = renameIdentity(world.paths, "work", "client", world.ports());
    expect(report.steps.some((step) => step.includes("Keychain"))).toBe(false);
    expect(world.keychain.calls.some((call) => call.args[0] === "-i" || call.args[0] === "delete-generic-password")).toBe(false);
  });

  it("warns, rather than undoing a finished rename, when the old item cannot be deleted", () => {
    const original = world.keychain.run;
    const stubborn = {
      run: (command: string, args: readonly string[], input?: string) => (args[0] === "delete-generic-password" && args.includes(oldService()) ? { status: 1, stdout: "", stderr: "denied" } : original.run(command, args, input)),
    };
    const report = renameIdentity(world.paths, "work", "client", world.ports({ run: stubborn }));
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(`security delete-generic-password -s "${oldService()}"`);
  });
});

describe("renameIdentity off macOS", () => {
  it("never calls security: the credentials file moves with the directory", () => {
    const world = createWorld("linux");
    try {
      renameIdentity(world.paths, "work", "client", world.ports());
      expect(world.keychain.calls).toEqual([]);
      expect(fs.readFileSync(path.join(world.directory("client"), ".credentials.json"), "utf8")).toBe("{}\n");
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
});

describe("IDENTITY_NAME_LOCATIONS", () => {
  it("decides every place the state root keeps files, so a new one cannot be forgotten by a rename", () => {
    expect(Object.keys(IDENTITY_NAME_LOCATIONS).sort()).toEqual(Object.keys(buildLayoutPaths("/example/root")).sort());
  });
});
