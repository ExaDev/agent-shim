import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireIdentityNamesLock, IdentityNamesLockBusyError, nonWaitingIdentityNamesLockPorts, type IdentityNamesLockPorts } from "./identityNamesLock";
import { enterProcessRole } from "./processRole";
import { renameIdentity, type IdentityRenamePorts } from "./identityRename";
import { NOW_MS, OWN_PID, createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { IdentityAlreadyExistsError, IdentityNotFoundError, IdentityRemovalBusyError, addIdentity, identityIdOf, removeIdentity, useIdentity } from "./identityStore";
import { acquireIdentityLock, IdentityLockBusyError, identityLockPath } from "./launcher/lock";
import { registerLaunch } from "./launcher/launchRecords";
import { InterruptedNameRenameError, unfinishedNameRenames } from "./identityNameRenameRecord";
import { realFarmFs } from "./realPorts";

/** The names lock as another process would take it while this one holds it: a live holder, one attempt, no waiting. */
const ANOTHER_PROCESS: IdentityNamesLockPorts = { fs: realFarmFs, nowMs: () => NOW_MS, pid: OWN_PID + 1, isRunning: () => true, sleep: () => undefined, maxAttempts: 1 };

describe("the identity names lock", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("holds the names lock while changing the active selection", () => {
    const originalRename = fs.renameSync;
    let locked = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === world.paths.activeIdentityFile) {
        locked = fs.existsSync(path.join(world.root, ".identity-names.lock"));
      }
      originalRename(from, to);
    });
    try {
      useIdentity(world.paths, "personal");
      expect(locked).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("describes a held names lock without guessing the holder's operation", () => {
    const lock = acquireIdentityNamesLock(world.paths, ANOTHER_PROCESS);
    try {
      expect(() => acquireIdentityNamesLock(world.paths, ANOTHER_PROCESS)).toThrow(/another agent-shim identity operation/iu);
    } finally {
      lock.release();
    }
  });

  it("reports a live held names lock without a blocking process-table read on the front door", () => {
    const lock = acquireIdentityNamesLock(world.paths, { ...ANOTHER_PROCESS, pid: process.pid });
    const leave = enterProcessRole("frontdoor-supervisor");
    try {
      expect(() => acquireIdentityNamesLock(world.paths, nonWaitingIdentityNamesLockPorts)).toThrow(IdentityNamesLockBusyError);
    } finally {
      leave();
      lock.release();
    }
  });

  it("refuses to remove an identity while a registered launch is using it", () => {
    const remove = registerLaunch(realFarmFs, world.paths.launchesDir, { pid: process.pid, identity: "work", startedAtMs: NOW_MS }, () => true);
    try {
      expect(() => removeIdentity(world.paths, "work")).toThrow(/launch/i);
    } finally {
      remove();
    }
  });

  it("does not expire a names lock held by a live process during a long Keychain operation", () => {
    const lock = acquireIdentityNamesLock(world.paths, { ...ANOTHER_PROCESS, nowMs: () => 0 });
    try {
      expect(() => acquireIdentityNamesLock(world.paths, { ...ANOTHER_PROCESS, nowMs: () => Date.parse("1970-01-02T00:00:00Z") })).toThrow(IdentityNamesLockBusyError);
      expect(fs.existsSync(lock.path)).toBe(true);
    } finally {
      lock.release();
    }
  });

  /** The rename's ports with `during` run once, between its first and second steps, while it holds its locks. */
  function interleaved(during: () => Promise<void> | void): IdentityRenamePorts {
    const base = world.ports();
    let turns = 0;
    return world.ports({
      signals: {
        ...base.signals,
        turn: async () => {
          turns += 1;
          if (turns === 2) {
            await during();
          }
        },
      },
    });
  }

  it("renames, records and locks the identity the name reaches once the lock is taken, when a remove and an add replace it while the rename waits", async () => {
    // A request logged under work keeps that id from the identity added in its place, which is given work-2.
    fs.mkdirSync(world.paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(world.paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "work", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    const namesLock = path.join(world.root, ".identity-names.lock");
    let raced = false;
    const seen: { readonly records: readonly string[]; readonly locked: boolean }[] = [];
    const base = world.ports();
    const ports = world.ports({
      fs: {
        ...realFarmFs,
        // Just before the rename creates the names lock, after its lock-free checks resolved work, another process removes work and adds a new work.
        writeFileExclusive: (file, contents) => {
          if (file === namesLock && !raced) {
            raced = true;
            removeIdentity(world.paths, "work");
            addIdentity(world.paths, "work");
          }
          return realFarmFs.writeFileExclusive(file, contents);
        },
      },
      signals: {
        ...base.signals,
        turn: async () => {
          seen.push({ records: unfinishedNameRenames(world.paths).map((record) => record.id), locked: fs.existsSync(identityLockPath(world.paths.identitiesDir, "work-2")) });
          await Promise.resolve();
        },
      },
    });
    await renameIdentity(world.paths, "work", "client", ports);
    expect(raced).toBe(true);
    expect(identityIdOf(world.paths, "client")).toBe("work-2");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((step) => step.locked && step.records.length === 1 && step.records[0] === "work-2")).toBe(true);
  });

  it("keeps an identity add of the new name out while a rename applies, so two records never claim it", async () => {
    let refusal: unknown;
    await renameIdentity(world.paths, "work", "client", interleaved(() => {
      try {
        addIdentity(world.paths, "client", { namesLock: ANOTHER_PROCESS });
      } catch (error) {
        refusal = error;
      }
    }));
    expect(refusal).toBeInstanceOf(IdentityNamesLockBusyError);
    expect(refusal).toBeInstanceOf(IdentityLockBusyError);
    expect(refusal).toHaveProperty("message", expect.stringContaining("Another agent-shim identity operation"));
    expect(refusal).not.toHaveProperty("message", expect.stringContaining("resync"));
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(() => addIdentity(world.paths, "client", { namesLock: ANOTHER_PROCESS })).toThrow(IdentityAlreadyExistsError);
  });

  it("keeps a second rename to the same name out while the first applies", async () => {
    // No pool lists both identities, so the second rename's own checks pass while the first one applies and only the lock can keep it out.
    fs.writeFileSync(world.paths.globalConfigFile, "{}\n");
    let refusal: unknown;
    await renameIdentity(world.paths, "work", "client", interleaved(async () => {
      refusal = await renameIdentity(world.paths, "personal", "client", world.ports({ lock: { ...ANOTHER_PROCESS } })).catch((error: unknown) => error);
    }));
    // The record the first rename keeps refuses the second before it asks for the lock, which would refuse it too.
    expect(refusal).toBeInstanceOf(InterruptedNameRenameError);
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(identityIdOf(world.paths, "personal")).toBe("personal");
  });

  it("refuses to remove an identity a launch is resyncing, leaving its lock and its directory, and removes it once the lock is free", () => {
    const lock = identityLockPath(world.paths.identitiesDir, "work");
    fs.writeFileSync(lock, `${JSON.stringify({ identity: "work", pid: OWN_PID + 1, token: "launch", acquiredAtMs: NOW_MS })}\n`);
    const notWaiting: IdentityNamesLockPorts = { fs: realFarmFs, nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined, maxAttempts: 1 };
    let refusal: unknown;
    try {
      removeIdentity(world.paths, "work", notWaiting);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(IdentityRemovalBusyError);
    expect(refusal).toBeInstanceOf(IdentityLockBusyError);
    expect(refusal).toHaveProperty("message", expect.stringContaining(`Cannot remove identity "work": a launch of it (pid ${String(OWN_PID + 1)}) is resyncing its directory`));
    expect(fs.readFileSync(lock, "utf8")).toContain('"token":"launch"');
    expect(identityIdOf(world.paths, "work")).toBe("work");
    fs.rmSync(lock);
    expect(removeIdentity(world.paths, "work", notWaiting)).toBe("work");
    expect(identityIdOf(world.paths, "work")).toBeUndefined();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("holds the resync lock until everything it deletes is gone, so a waiting launch never takes it while the deletion runs", () => {
    const lock = identityLockPath(world.paths.identitiesDir, "work");
    const rmSync = fs.rmSync.bind(fs);
    const launchRefusals: unknown[] = [];
    // The names lock, released after the resync lock, and a settled rename record, removed before the resync lock is taken, are not the identity's state.
    const namesLock = identityLockPath(world.paths.root, "identity-names");
    // Before each deletion of the identity's state other than its resync lock, a launch of work tries for that lock once, as a waiting one would between its attempts.
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target !== lock && target !== namesLock && !String(target).startsWith(world.paths.identityNameRenamesDir)) {
        try {
          acquireIdentityLock({ fs: realFarmFs, identity: "work", dir: world.paths.identitiesDir, nowMs: () => NOW_MS, pid: OWN_PID + 1, isRunning: () => true, sleep: () => undefined, maxAttempts: 1 }).release();
          launchRefusals.push(`taken before ${String(target)} was deleted`);
        } catch (error) {
          launchRefusals.push(error);
        }
      }
      rmSync(target, options);
    });
    try {
      expect(removeIdentity(world.paths, "work")).toBe("work");
    } finally {
      spy.mockRestore();
    }
    expect(launchRefusals.length).toBeGreaterThan(0);
    for (const refusal of launchRefusals) {
      expect(refusal).toBeInstanceOf(IdentityLockBusyError);
    }
    expect(identityIdOf(world.paths, "work")).toBeUndefined();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("keeps an identity remove out while a rename of it applies", async () => {
    let refusal: unknown;
    await renameIdentity(world.paths, "work", "client", interleaved(() => {
      try {
        removeIdentity(world.paths, "work", ANOTHER_PROCESS);
      } catch (error) {
        refusal = error;
      }
    }));
    expect(refusal).toBeInstanceOf(IdentityLockBusyError);
    expect(identityIdOf(world.paths, "client")).toBe("work");
  });

  it("fails, rolling back the references it rewrote, when the identity's directory vanishes before its name is written", async () => {
    const before = treeOf(world.root);
    const vanish = interleaved(() => {
      fs.renameSync(world.directory("work"), `${world.root}/set-aside`);
    });
    await expect(renameIdentity(world.paths, "work", "client", vanish)).rejects.toThrow(IdentityNotFoundError);
    fs.renameSync(`${world.root}/set-aside`, world.directory("work"));
    expect(treeOf(world.root)).toEqual(before);
  });
});
