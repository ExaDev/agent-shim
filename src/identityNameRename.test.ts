import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, UsageError } from "./cliError";
import { IDENTITY_NAME_LOCATIONS } from "./identityNameLocations";
import { describeIdentityMove, describeIdentityRename, moveIdentity, renameIdentity } from "./identityRename";
import { renameJournalFile, writeRenameJournal } from "./identityRenameJournal";
import { DuplicateIdentityNameError } from "./identityRecords";
import { NOW_MS, OWN_PID, PRIVATE_FILE_MODE, createWorld, treeOf, writeJson, type World } from "./identityRenameTestWorld";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError, addIdentity, identityExists, identityIdOf, readActiveIdentity, readIdentity, removeIdentity, requireIdentityAddable } from "./identityStore";
import { identityLockPath, IdentityLockBusyError } from "./launcher/lock";
import type { FarmFs } from "./launcher/ports";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";

describe("renameIdentity, which changes the name alone", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("changes the name in identity.json and leaves the identity in the directory it was created in", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(world.directory("work"))).toBe(true);
    expect(fs.existsSync(world.directory("client"))).toBe(false);
    expect(world.json("identities/work/identity.json")).toMatchObject({ name: "client" });
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(identityExists(world.paths, "work")).toBe(false);
    expect(readIdentity(world.paths, "client")?.name).toBe("client");
  });

  it("rewrites every reference to the name: pools, nested and conditional members, jobs, model refs, profiles, rules, the active selection and picks, leaving the anchor stamps filed by id", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.json("config.json")).toEqual({
      pools: {
        subs: { identities: ["client", "personal", "pool:fleet"] },
        fleet: { identities: [{ identity: "client", when: { branch: "main" } }, "personal"] },
        other: { identities: ["personal"] },
      },
      jobs: {
        burn: { target: { identity: "client" }, trigger: { beforeReset: "fiveHour", lead: "1h" }, prompt: "go", cwd: "/work", timeout: "10m" },
        pooled: { target: { pool: "subs" }, trigger: { beforeReset: "sevenDay", lead: "2h" }, prompt: "go", cwd: "/work", timeout: "10m" },
      },
      models: { virtual: { fast: { mode: "ordered", members: ["acct:client/opus", "z/glm-5.3"] } }, tiers: { opus: "acct:client/opus", sonnet: "acct:personal/sonnet" } },
    });
    expect(world.json("config-profiles/client.json")).toEqual({ models: { hide: ["acct:client/haiku"], show: ["acct:personal/haiku"] } });
    expect(world.json("directory-rules.json")).toMatchObject({ rules: [{ path: "/example/project", identity: "client" }, { path: "/example/other", identity: "personal" }, { path: "/example/pooled", identity: "pool:subs", models: { tiers: { opus: "acct:client/opus" } } }] });
    expect(readActiveIdentity(world.paths)).toBe("client");
    expect(world.json("usage/picks.json")).toMatchObject({ picks: { "/example/project": { identity: "client" }, "/example/other": { identity: "personal" } } });
    // The anchor stamps are filed under the id, which the rename keeps.
    expect(world.json("usage/anchors.json")).toMatchObject({ handled: { work: "2026-10-30T10:00:00.000Z", personal: "2026-10-30T11:00:00.000Z" } });
  });

  it("leaves everything filed under the id as it was: the directory's files, the usage snapshot, the token file and the cached credential", async () => {
    const before = treeOf(world.root);
    const cacheBefore = new Map(world.cache);
    await renameIdentity(world.paths, "work", "client", world.ports());
    const after = treeOf(world.root);
    const idFiled = (file: string): boolean => file.startsWith("identities/work/") || file.startsWith("usage/snapshots/") || file.startsWith("credentials/");
    const changed = Object.keys({ ...before, ...after }).filter((file) => idFiled(file) && before[file] !== after[file]);
    expect(changed).toEqual(["identities/work/identity.json"]);
    expect(world.cache).toEqual(cacheBefore);
  });

  it("asks nothing of the Keychain, so the login stays filed under the directory every session holds", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.keychain.calls).toEqual([]);
    expect(world.keychain.items.has(claudeCodeKeychainService(world.directory("work")))).toBe(true);
  });

  it("goes ahead while a session runs on the identity and while a launch of it is starting", async () => {
    world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
    world.launches.set("work", [{ pid: 4712, program: "agent-shim" }]);
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(identityIdOf(world.paths, "client")).toBe("work");
  });

  it("lists the same steps in its dry run, ending with the name itself, and changes nothing", async () => {
    const before = treeOf(world.root);
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(treeOf(world.root)).toEqual(before);
    expect(planned.dryRun).toBe(true);
    expect(planned.steps.at(-1)).toBe("rewrite identities/work/identity.json: name");
    const done = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(done.steps).toEqual(planned.steps);
    expect(done.warnings).toEqual([]);
  });

  it("changes only the case of a name, which the physical rename cannot do in one step", async () => {
    await renameIdentity(world.paths, "work", "Work", world.ports());
    expect(identityIdOf(world.paths, "Work")).toBe("work");
    expect(readActiveIdentity(world.paths)).toBe("Work");
  });

  it("refuses a new name another identity has, an invalid one, the same one, and an old one no identity has, changing nothing", async () => {
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "personal", world.ports())).rejects.toThrow(IdentityAlreadyExistsError);
    await expect(renameIdentity(world.paths, "work", "@client", world.ports())).rejects.toThrow(InvalidIdentityNameError);
    await expect(renameIdentity(world.paths, "work", "work", world.ports())).rejects.toThrow(UsageError);
    await expect(renameIdentity(world.paths, "nobody", "client", world.ports())).rejects.toThrow(IdentityNotFoundError);
    expect(() => describeIdentityRename(world.paths, "work", "personal", world.ports())).toThrow(IdentityAlreadyExistsError);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses while an unfinished rename with --move names either name, naming the command that finishes it", async () => {
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), { version: 1, from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z", pid: OWN_PID, steps: [{ description: "move identities/work to identities/client", started: true, done: false }] });
    await expect(renameIdentity(world.paths, "work", "elsewhere", world.ports())).rejects.toThrow("agent-shim identity rename work client --move");
    await expect(renameIdentity(world.paths, "personal", "client", world.ports())).rejects.toThrow(CliError);
    expect(identityIdOf(world.paths, "work")).toBe("work");
  });

  it("refuses, rewriting nothing, while an interrupted resync has left the identity only in a superseded farm", async () => {
    // What a resync killed between the two renames of its swap leaves: no identities/work, and its farm, record included, beside it.
    fs.renameSync(world.directory("work"), path.join(world.paths.identitiesDir, ".work.previous.5151.1c9e0f6a-2b3d-4e5f-8a7b-9c0d1e2f3a4b"));
    expect(identityIdOf(world.paths, "work")).toBe("work");
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("superseded farm beside identities/work, which is missing. Launch it once (`agent-shim run @work`): the launch puts the directory back, then try again.");
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow("cannot be renamed yet");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses, rewriting nothing, while the identity's directory holds no identity.json yet beside a superseded farm that does", async () => {
    // What a resync killed after its swap and before it carried identity.json over leaves.
    const superseded = path.join(world.paths.identitiesDir, ".work.previous.5151.1c9e0f6a-2b3d-4e5f-8a7b-9c0d1e2f3a4b");
    fs.mkdirSync(superseded, { recursive: true });
    fs.renameSync(path.join(world.directory("work"), "identity.json"), path.join(superseded, "identity.json"));
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("superseded farm beside identities/work, which holds no identity.json yet. Launch it once (`agent-shim run @work`): the launch carries the file back into the directory, then try again.");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses while the identity's resync lock is held by a running process, changing nothing", async () => {
    writeJson(identityLockPath(world.paths.identitiesDir, "work"), { identity: "work", pid: OWN_PID + 1, token: "held", acquiredAtMs: NOW_MS }, PRIVATE_FILE_MODE);
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } }))).rejects.toThrow(IdentityLockBusyError);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.handlers()).toBe(0);
  });

  it("leaves no signal handler behind when the identity is removed while it waits for the names lock", async () => {
    const namesLock = path.join(world.root, ".identity-names.lock");
    let removed = false;
    const ports = world.ports({
      fs: {
        ...realFarmFs,
        writeFileExclusive: (file, contents) => {
          if (file === namesLock && !removed) {
            removed = true;
            removeIdentity(world.paths, "work");
          }
          return realFarmFs.writeFileExclusive(file, contents);
        },
      },
    });
    await expect(renameIdentity(world.paths, "work", "client", ports)).rejects.toThrow(IdentityNotFoundError);
    expect(removed).toBe(true);
    expect(world.handlers()).toBe(0);
  });

  it("rolls back every reference it rewrote when a later step fails, byte for byte", async () => {
    const before = treeOf(world.root);
    // The recorded picks are the last reference rewritten before the name, so every reference before them has to be undone.
    // It fails once, so the rollback's own rewrite of the file succeeds and the rollback completes.
    let failed = false;
    const failingPicks: FarmFs = {
      ...realFarmFs,
      writeFilePrivate: (file, contents, options) => {
        if (file === world.paths.usagePicksFile && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        realFarmFs.writeFilePrivate(file, contents, options);
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failingPicks }))).rejects.toThrow("disk full");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("rolls back when it is interrupted between steps", async () => {
    const before = treeOf(world.root);
    let turns = 0;
    const ports = world.ports({
      signals: {
        ...world.ports().signals,
        onInterrupt: world.ports().signals.onInterrupt,
        turn: async () => {
          turns += 1;
          if (turns === 2) {
            world.interrupt("SIGINT");
          }
          await Promise.resolve();
        },
      },
    });
    await expect(renameIdentity(world.paths, "work", "client", ports)).rejects.toThrow("Interrupted by SIGINT");
    expect(treeOf(world.root)).toEqual(before);
    expect(world.handlers()).toBe(0);
  });

  it("finishes a rename that was killed after some references were rewritten, when run again", async () => {
    // What a kill after the pools step leaves: the pools name the new name, and the identity is still under the old.
    const config = world.json("config.json");
    fs.writeFileSync(world.paths.globalConfigFile, `${JSON.stringify(config).replaceAll('"work"', '"client"').replaceAll("acct:work/", "acct:client/")}\n`);
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(world.read("config.json")).not.toContain('"work"');
    expect(readActiveIdentity(world.paths)).toBe("client");
  });

  it("leaves the old name's directory occupied, so an identity added under the old name is given the next free directory and the Keychain check looks there", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    // The Keychain still holds the renamed identity's login under identities/work, which is not in the way of a new identity stored elsewhere.
    expect(() => {
      requireIdentityAddable(world.paths, "work", { run: world.keychain.run, platform: "darwin" }, false);
    }).not.toThrow();
    addIdentity(world.paths, "work");
    expect(identityIdOf(world.paths, "work")).toBe("work-2");
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(world.json("identities/work/identity.json")).toMatchObject({ name: "client" });
    expect(world.json("identities/work-2/identity.json")).toMatchObject({ name: "work" });
  });

  it("changes only files in places IDENTITY_NAME_LOCATIONS marks as holding a name", async () => {
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
    expect(changed.filter((file) => ownerOf(file) !== "name")).toEqual([]);
  });
});

describe("renameIdentity by id", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    // A second identity stored under its own directory that also claims the name work.
    writeJson(path.join(world.paths.identitiesDir, "other", "identity.json"), { name: "work", allowAmbientCredential: false });
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("renames one of two identities that claim one name, leaving the references to the name for the one that keeps it", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(DuplicateIdentityNameError);
    const configBefore = world.read("config.json");
    const report = await renameIdentity(world.paths, "other", "client", world.ports(), { byId: true });
    expect(report.steps).toEqual(["rewrite identities/other/identity.json: name"]);
    expect(identityIdOf(world.paths, "client")).toBe("other");
    expect(identityIdOf(world.paths, "work")).toBe("work");
    expect(world.read("config.json")).toBe(configBefore);
    expect(readActiveIdentity(world.paths)).toBe("work");
  });

  it("rewrites the references when the identity addressed by id is the only one with its name", async () => {
    fs.rmSync(path.join(world.paths.identitiesDir, "other"), { recursive: true });
    await renameIdentity(world.paths, "work", "client", world.ports(), { byId: true });
    expect(readActiveIdentity(world.paths)).toBe("client");
  });

  it("refuses an id no identity is stored under", async () => {
    await expect(renameIdentity(world.paths, "nobody", "client", world.ports(), { byId: true })).rejects.toThrow("No identity is stored under identities/nobody. `agent-shim identity list` shows each identity's id.");
  });
});

describe("moveIdentity of an identity renamed without --move", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is refused in the dry run and the real run, since no directory has the identity's name, changing nothing", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    const before = treeOf(world.root);
    expect(() => describeIdentityMove(world.paths, "client", "office", world.ports())).toThrow("has no directory of its name to move");
    await expect(moveIdentity(world.paths, "client", "office", world.ports())).rejects.toThrow("has no directory of its name to move");
    expect(treeOf(world.root)).toEqual(before);
  });
});
