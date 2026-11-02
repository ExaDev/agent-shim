import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./cliError";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError, readActiveIdentity, readIdentity } from "./identityStore";
import { describeIdentityRename, IdentityInUseError, renameIdentity } from "./identityRename";
import { identityTokenPath, TOKEN_FILE_MODE } from "./identityToken";
import type { CredentialCachePort } from "./credentialCache";
import { IDENTITY_NAME_LOCATIONS } from "./identityNameLocations";
import { buildLayoutPaths } from "./paths";
import { claudeCodeKeychainService } from "./usage/signIn";
import { NOW_MS, OTHER_SUFFIX, OWN_PID, PERMISSION_BITS, PRIVATE_FILE_MODE, SUFFIX, type World, createWorld, treeOf, writeFile, writeJson, failingOnce } from "./identityRenameTestWorld";

describe("renameIdentity", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("moves the identity's directory, and any superseded farm beside it, to the new name", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(world.directory("work"))).toBe(false);
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(fs.readFileSync(path.join(world.directory("client"), ".credentials.json"), "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(world.root, "identities", `.work.previous.${SUFFIX}`))).toBe(false);
    expect(fs.readFileSync(path.join(world.root, "identities", `.client.previous.${SUFFIX}`, "left-over.txt"), "utf8")).toBe("kept\n");
  });

  it("leaves no lock behind and keeps no former name", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.readdirSync(path.join(world.root, "identities")).sort()).toEqual([`.client.previous.${SUFFIX}`, "client", "personal"]);
    expect(fs.existsSync(path.join(world.root, "provider-aliases.json"))).toBe(false);
    expect(readIdentity(world.paths, "work")).toBeUndefined();
  });

  it("leaves the farms of another identity whose name starts the same way where they are", async () => {
    writeJson(path.join(world.root, "identities", "work.previous.old", "identity.json"), { name: "work.previous.old", allowAmbientCredential: false });
    writeFile(path.join(world.root, "identities", `.work.previous.old.scratch.${OTHER_SUFFIX}`, "kept.txt"), "kept\n");
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.readFileSync(path.join(world.root, "identities", `.work.previous.old.scratch.${OTHER_SUFFIX}`, "kept.txt"), "utf8")).toBe("kept\n");
    expect(fs.existsSync(path.join(world.root, "identities", "work.previous.old", "identity.json"))).toBe(true);
    expect(fs.existsSync(path.join(world.root, "identities", `.client.scratch.${OTHER_SUFFIX}`))).toBe(false);
  });

  it("rewrites the name in identity.json and points its credential file source at the moved token file", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    const identity = readIdentity(world.paths, "client");
    expect(identity?.name).toBe("client");
    expect(identity?.label).toBe("Example Org");
    expect(identity?.credential?.sources).toEqual([{ file: path.join(world.root, "credentials", "client.token") }, { env: "EXAMPLE_TOKEN" }, { file: "/example/elsewhere/work.token" }]);
    expect(identity?.credential?.cache).toEqual({ store: "file" });
  });

  it("re-roots a credential file source that sits inside the identity's own directory", async () => {
    const file = path.join(world.directory("work"), "identity.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { credential: { sources: unknown[] } };
    stored.credential.sources.push({ file: path.join(world.directory("work"), "secrets", "token") });
    fs.writeFileSync(file, JSON.stringify(stored));
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "client")?.credential?.sources.at(-1)).toEqual({ file: path.join(world.directory("client"), "secrets", "token") });
  });

  it("moves the stored token file, keeping its owner-only mode", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(path.join(world.root, "credentials", "work.token"))).toBe(false);
    const moved = path.join(world.root, "credentials", "client.token");
    expect(fs.readFileSync(moved, "utf8")).toBe("a-made-up-token-file-body\n");
    expect(fs.statSync(moved).mode & PERMISSION_BITS).toBe(TOKEN_FILE_MODE);
    expect(identityTokenPath(world.paths, "client")).toBe(moved);
  });

  it("moves the cached credential to the new owner", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.cache.has("file:identity work")).toBe(false);
    expect(world.cache.get("file:identity client")?.token).toBe("a-made-up-cached-token");
  });

  it("rewrites the farm's own record of whose farm it is", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("identities/client/.agent-shim-farm.json")).toEqual({ version: 1, builtAtMs: 1, identity: "client", cwd: "/example/project", claudeHome: "/example/claude", materialised: [], links: [] });
  });

  it("renames the member in every pool, nested and conditional ones included, and leaves pool selectors and other members alone", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toMatchObject({
      pools: {
        subs: { identities: ["client", "personal", "pool:fleet"] },
        fleet: { identities: [{ identity: "client", when: { branch: "main" } }, "personal"] },
        other: { identities: ["personal"] },
      },
    });
  });

  it("retargets the jobs that run as the identity, and not the ones that run as a pool", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toMatchObject({ jobs: { burn: { target: { identity: "client" } }, pooled: { target: { pool: "subs" } } } });
  });

  it("requalifies account model refs in the global block, a profile and a directory rule, and no other identity's", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
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

  it("selects the new name when the renamed identity was the active one, and leaves another active identity alone", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("client");
    fs.writeFileSync(world.paths.activeIdentityFile, "personal\n");
    await renameIdentity(world.paths, "personal", "home", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("home");
    fs.writeFileSync(world.paths.activeIdentityFile, "pool:subs\n");
    await renameIdentity(world.paths, "client", "work", world.ports());
    expect(readActiveIdentity(world.paths)).toBe("pool:subs");
  });

  it("moves the usage snapshot and rewrites the name inside it, replacing a stale one under the new name", async () => {
    writeJson(path.join(world.paths.usageSnapshotsDir, "client.json"), { schemaVersion: 1, identity: "client", updatedAt: "2025-01-01T00:00:00.000Z", providers: {} });
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(path.join(world.paths.usageSnapshotsDir, "work.json"))).toBe(false);
    expect(world.json("usage/snapshots/client.json")).toEqual({ schemaVersion: 1, identity: "client", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} });
    expect(world.json("usage/snapshots/personal.json")).toMatchObject({ identity: "personal" });
  });

  it("rewrites the recorded pool picks and the anchor stamps", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("usage/picks.json")).toEqual({
      schemaVersion: 1,
      picks: { "/example/project": { identity: "client", at: "2026-10-30T10:00:00.000Z" }, "/example/other": { identity: "personal", at: "2026-10-30T10:00:00.000Z" } },
    });
    expect(world.json("usage/anchors.json")).toEqual({ schemaVersion: 1, handled: { client: "2026-10-30T10:00:00.000Z", personal: "2026-10-30T11:00:00.000Z" } });
  });

  it("reports each thing it moved or rewrote, in order", async () => {
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(report).toEqual({
      from: "work",
      to: "client",
      dryRun: false,
      steps: [
        "rewrite identities/work/identity.json: name, credential source",
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
    it("refuses while a session is running on the identity, naming it, and changes nothing", async () => {
      world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
      const before = treeOf(world.root);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(IdentityInUseError);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/pid 4711 \(claude\)/);
      expect(treeOf(world.root)).toEqual(before);
    });

    it("refuses while a launch is between its farm resync and its spawn, when no process carries the directory yet, naming the launcher", async () => {
      world.launches.set("work", [{ pid: 4712, program: "agent-shim launch" }]);
      const before = treeOf(world.root);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(IdentityInUseError);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/pid 4712 \(agent-shim launch\)/);
      expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow(IdentityInUseError);
      expect(treeOf(world.root)).toEqual(before);
    });

    it("does not mind a launch of another identity", async () => {
      world.launches.set("personal", [{ pid: 4712, program: "agent-shim launch" }]);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).resolves.toBeDefined();
    });

    it("refuses an unknown identity, a name it already has, an unusable name and an unchanged one, naming which", async () => {
      await expect(renameIdentity(world.paths, "ghost", "client", world.ports())).rejects.toThrow(IdentityNotFoundError);
      await expect(renameIdentity(world.paths, "work", "personal", world.ports())).rejects.toThrow(IdentityAlreadyExistsError);
      await expect(renameIdentity(world.paths, "work", "-bad", world.ports())).rejects.toThrow(InvalidIdentityNameError);
      await expect(renameIdentity(world.paths, "work", "work", world.ports())).rejects.toThrow(CliError);
    });

    it("refuses a name whose directory or superseded farm is already there, even without an identity.json", async () => {
      fs.mkdirSync(world.directory("client"));
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/already/);
      fs.rmdirSync(world.directory("client"));
      fs.mkdirSync(path.join(world.root, "identities", `.client.previous.${OTHER_SUFFIX}`));
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/already/);
    });

    it("refuses when the new name already has a token file", async () => {
      writeFile(path.join(world.root, "credentials", "client.token"), "someone else's\n", TOKEN_FILE_MODE);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/token/);
      expect(world.read("credentials/client.token")).toBe("someone else's\n");
    });

    it("refuses while another resync holds the identity lock", async () => {
      writeFile(path.join(world.root, "identities", ".work.lock"), `${JSON.stringify({ identity: "work", pid: 99, token: "t", acquiredAtMs: NOW_MS })}\n`);
      await expect(renameIdentity(world.paths, "work", "client", world.ports({ lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } }))).rejects.toThrow(/resync is already running/);
      expect(fs.existsSync(world.directory("work"))).toBe(true);
    });
  });

  describe("rollback", () => {
    it("restores everything when a late step fails", async () => {
      const before = treeOf(world.root);
      const failing = failingOnce(world);
      await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).rejects.toThrow(/disk full/);
      expect(treeOf(world.root)).toEqual(before);
      expect(world.cache.get("file:identity work")?.token).toBe("a-made-up-cached-token");
      expect(world.cache.has("file:identity client")).toBe(false);
    });

    it("restores everything when a middle step fails", async () => {
      const before = treeOf(world.root);
      let cacheFailed = false;
      const cachePort: CredentialCachePort = {
        read: (store, owner) => world.cache.get(`${store}:${owner}`),
        write: (store, owner, entry) => {
          if (!cacheFailed) {
            cacheFailed = true;
            throw new Error("cache store unavailable");
          }
          world.cache.set(`${store}:${owner}`, entry);
        },
        remove: (store, owner) => {
          world.cache.delete(`${store}:${owner}`);
        },
      };
      await expect(renameIdentity(world.paths, "work", "client", world.ports({ credentialCache: { port: cachePort, platform: "linux" } }))).rejects.toThrow(/cache store unavailable/);
      expect(treeOf(world.root)).toEqual(before);
    });

    it("stops before changing anything when a configuration file cannot be read", async () => {
      writeFile(path.join(world.root, "config.json"), "{ not json");
      const before = treeOf(world.root);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow();
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

  it("lists exactly the steps a real rename takes, and changes nothing", async () => {
    const before = treeOf(world.root);
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(treeOf(world.root)).toEqual(before);
    expect(planned.dryRun).toBe(true);
    const done = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(done.dryRun).toBe(false);
    expect(done.steps).toEqual(planned.steps);
    expect(done.warnings).toEqual(planned.warnings);
  });

  it("refuses a usage snapshot it cannot read in the plan, so a dry run that passes is not followed by a real run that fails after the Keychain copy", async () => {
    fs.writeFileSync(path.join(world.paths.usageSnapshotsDir, "work.json"), "{ not json");
    const before = treeOf(world.root);
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow(/usage\/snapshots\/work\.json/);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/usage\/snapshots\/work\.json/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.calls.every((call) => call.args[0] === "find-generic-password" && !call.args.includes("-g"))).toBe(true);
  });

  it("refuses a usage snapshot of another schema version in the plan too", () => {
    writeJson(path.join(world.paths.usageSnapshotsDir, "work.json"), { schemaVersion: 99, identity: "work", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} }, PRIVATE_FILE_MODE);
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow(CliError);
  });

  describe("what only the real run can refuse on, because it needs a lock or a secret", () => {
    /** A password of printable text longer than a whole `security -i` line, so neither the hex form nor the quoted form of the copy command can carry it. */
    const TOO_LARGE_FOR_ANY_FORM = 5000;

    it("passes while another resync holds the identity lock, which the real run refuses on", async () => {
      writeFile(path.join(world.root, "identities", ".work.lock"), `${JSON.stringify({ identity: "work", pid: 99, token: "t", acquiredAtMs: NOW_MS })}\n`);
      const ports = world.ports({ lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } });
      expect(describeIdentityRename(world.paths, "work", "client", ports).dryRun).toBe(true);
      await expect(renameIdentity(world.paths, "work", "client", ports)).rejects.toThrow(/resync is already running/);
    });

    it("passes when the login cannot be read, which the real run refuses on", async () => {
      const unreadable = { run: (command: string, args: readonly string[], input?: string) => (args.includes("-g") ? { status: 1, stdout: "", stderr: "" } : world.keychain.run.run(command, args, input)) };
      const ports = world.ports({ run: unreadable });
      expect(describeIdentityRename(world.paths, "work", "client", ports).dryRun).toBe(true);
      await expect(renameIdentity(world.paths, "work", "client", ports)).rejects.toThrow(/Could not read the login/);
    });

    it("passes when the login is too long for one `security -i` line, which the real run refuses on", async () => {
      world.keychain.seed(claudeCodeKeychainService(world.directory("work")), "alex", "a".repeat(TOO_LARGE_FOR_ANY_FORM));
      expect(describeIdentityRename(world.paths, "work", "client", world.ports()).dryRun).toBe(true);
      await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/too large to copy/);
    });

    it("passes when the cached credential cannot be read, which the real run refuses on", async () => {
      const unreadable: CredentialCachePort = {
        read: () => {
          throw new Error("cache unreadable");
        },
        write: () => undefined,
        remove: () => undefined,
      };
      const ports = world.ports({ credentialCache: { port: unreadable, platform: "linux" } });
      expect(describeIdentityRename(world.paths, "work", "client", ports).dryRun).toBe(true);
      await expect(renameIdentity(world.paths, "work", "client", ports)).rejects.toThrow(/cache unreadable/);
    });
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

  it("refuses a running session and a name already taken, which need neither a lock nor a secret", () => {
    world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow(IdentityInUseError);
    expect(() => describeIdentityRename(world.paths, "work", "personal", world.ports())).toThrow(IdentityAlreadyExistsError);
  });
});

describe("IDENTITY_NAME_LOCATIONS", () => {
  it("decides every place the state root keeps files, so a new one cannot be forgotten by a rename", () => {
    expect(Object.keys(IDENTITY_NAME_LOCATIONS).sort()).toEqual(Object.keys(buildLayoutPaths("/example/root")).sort());
  });

  it("marks as rewritten the place of every file a rename actually changes, so the table says what the rename does", async () => {
    const world = createWorld("darwin");
    try {
      // A provider whose credential names the identity's token file is rewritten by the rename, which is what the table has to say of the providers directory.
      writeJson(path.join(world.paths.providersDir, "z.json"), {
        displayName: "z.ai",
        baseUrl: "https://api.z.ai/api/anthropic",
        credential: { sources: [{ file: identityTokenPath(world.paths, "work") }] },
      });
      const before = treeOf(world.root);
      await renameIdentity(world.paths, "work", "client", world.ports());
      const after = treeOf(world.root);
      const isField = (key: string): key is keyof typeof world.paths => key in world.paths;
      const places = Object.entries(IDENTITY_NAME_LOCATIONS).flatMap(([field, decision]) => (isField(field) ? [{ place: path.relative(world.root, world.paths[field]), decision }] : []));
      const ownerOf = (file: string): string | undefined =>
        places
          .filter(({ place }) => place === "" || file === place || file.startsWith(`${place}/`))
          .sort((left, right) => right.place.length - left.place.length)[0]?.decision;
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !key.endsWith("/") && before[key] !== after[key]);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.filter((file) => ownerOf(file) !== "rewritten")).toEqual([]);
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
});
