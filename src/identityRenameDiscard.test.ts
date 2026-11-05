import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError, UsageError } from "./cliError";
import { UnsafeNameError } from "./config/names";
import { describeIdentityMove, describeIdentityRename, discardRenameJournal, moveIdentity, renameIdentity } from "./identityRename";
import { describeUnfinishedRename, readRenameJournal, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { NOW_MS, OWN_PID, createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { InvalidIdentityNameError, addIdentity, identityExists, removeIdentity } from "./identityStore";
import { IdentityLockBusyError } from "./launcher/lock";
import { realFarmFs } from "./realPorts";
import { ignoresCase } from "./sameDirectory";

/** Writes the journal of a rename of `from` to `to`, with its one step marked `done` or not: not done is what a run that was killed before its first step, or one that rolled back completely, leaves. */
function leaveJournal(world: World, from: string, to: string, done = false): RenameJournal {
  const journal: RenameJournal = {
    version: 1,
    from,
    to,
    startedAt: "2026-10-30T10:00:00.000Z",
    pid: OWN_PID,
    steps: [{ description: `move identities/${from} to identities/${to}`, started: done, done }],
  };
  writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, from, to), journal);
  return journal;
}

function journalOf(world: World, from: string, to: string): RenameJournal | undefined {
  return readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, from, to));
}

/** Makes `name` an identity by hand, as something other than `identity add` (which now refuses it) would. */
function createByHand(world: World, name: string): void {
  fs.mkdirSync(world.directory(name), { recursive: true });
  fs.writeFileSync(path.join(world.directory(name), "identity.json"), `${JSON.stringify({ name, allowAmbientCredential: false })}\n`);
}

function removeByHand(world: World, name: string): void {
  fs.rmSync(world.directory(name), { recursive: true, force: true });
}

describe("a rename left unfinished whose identity is under neither name, or under both", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is refused with an outcome that says nothing can finish it and names the flag that discards it, leaving everything as it was", async () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/no identity under either name/);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("agent-shim identity rename work client --move --discard-journal");
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toBeInstanceOf(CliError);
    expect(() => describeIdentityMove(world.paths, "work", "client", world.ports())).toThrow("agent-shim identity rename work client --move --discard-journal");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is refused the same way when both names are identities, which no rename can reconcile", async () => {
    createByHand(world, "client");
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/both names are identities/);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("agent-shim identity rename work client --move --discard-journal");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is discarded by the flag, which removes the one journal and its locks and changes no identity", () => {
    removeByHand(world, "work");
    const baseline = treeOf(world.root);
    leaveJournal(world, "work", "client");
    leaveJournal(world, "personal", "home");
    const other = journalOf(world, "personal", "home");
    expect(discardRenameJournal(world.paths, "work", "client", world.ports())).toEqual({ from: "work", to: "client" });
    expect(journalOf(world, "work", "client")).toBeUndefined();
    expect(journalOf(world, "personal", "home")).toEqual(other);
    fs.rmSync(renameJournalFile(world.paths.identityRenamesDir, "personal", "home"));
    expect(treeOf(world.root)).toEqual(baseline);
  });

  it("is discarded by the flag when both names are identities, and both are left as they were", () => {
    createByHand(world, "client");
    const baseline = treeOf(world.root);
    leaveJournal(world, "work", "client");
    discardRenameJournal(world.paths, "work", "client", world.ports());
    expect(treeOf(world.root)).toEqual(baseline);
  });

  it("frees the names for identity add once it is discarded", () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    expect(() => addIdentity(world.paths, "work")).toThrow();
    discardRenameJournal(world.paths, "work", "client", world.ports());
    expect(addIdentity(world.paths, "work").name).toBe("work");
  });

  it("is not discarded while a step is marked done and the identity is under exactly one of the two names, where running the rename again finishes it", () => {
    leaveJournal(world, "work", "client", true);
    const before = treeOf(world.root);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow("agent-shim identity rename work client");
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(/can be finished/);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow("a step is recorded as begun or done");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is discarded when no step is marked done and the identity is still under the old name, since nothing was applied and discarding loses nothing", () => {
    const baseline = treeOf(world.root);
    leaveJournal(world, "work", "client");
    expect(discardRenameJournal(world.paths, "work", "client", world.ports())).toEqual({ from: "work", to: "client" });
    expect(journalOf(world, "work", "client")).toBeUndefined();
    expect(treeOf(world.root)).toEqual(baseline);
  });

  it("is not discarded when no step is marked done but the directory is already under the new name, which the marks may have lagged behind", () => {
    fs.renameSync(world.directory("work"), world.directory("client"));
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(/can be finished/);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow('the identity is already under "client"');
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is not discarded for a pair that has no journal", () => {
    leaveJournal(world, "personal", "home");
    const before = treeOf(world.root);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow('There is no unfinished rename of "work" to "client" to discard.');
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is not discarded while another process holds one of the locks, since that process may be running the rename", () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    fs.writeFileSync(path.join(world.root, "identities", ".client.lock"), `${JSON.stringify({ identity: "client", pid: 1, token: "someone-else", acquiredAtMs: NOW_MS })}\n`);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(IdentityLockBusyError);
    expect(journalOf(world, "work", "client")).toBeDefined();
    expect(fs.existsSync(path.join(world.root, "identities", ".work.lock"))).toBe(false);
  });

  it("refuses the same name twice without taking a lock, as a rename does", () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    expect(() => discardRenameJournal(world.paths, "work", "work", world.ports())).toThrow(UsageError);
    expect(() => discardRenameJournal(world.paths, "work", "work", world.ports())).toThrow(/already the identity's name/);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses a name that is not a valid new identity name, and takes no lock outside the state root", () => {
    removeByHand(world, "work");
    const before = treeOf(world.root);
    const outside = path.join(world.root, "..", "evil-lock-probe");
    expect(() => discardRenameJournal(world.paths, "work", "../../evil", world.ports())).toThrow(InvalidIdentityNameError);
    expect(() => discardRenameJournal(world.paths, "../../evil", "client", world.ports())).toThrow(UnsafeNameError);
    expect(treeOf(world.root)).toEqual(before);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("reads a journal it cannot read as an error that names the file, rather than discarding what it cannot describe", () => {
    removeByHand(world, "work");
    const file = renameJournalFile(world.paths.identityRenamesDir, "work", "client");
    fs.mkdirSync(world.paths.identityRenamesDir, { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("identity add and identity remove while a rename is unfinished", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("add refuses either name of the pair, naming the command that finishes the rename, and writes nothing", () => {
    const journal = leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    expect(() => addIdentity(world.paths, "client")).toThrow(describeUnfinishedRename(journal, { finishable: true, discardable: true }));
    expect(() => addIdentity(world.paths, "work")).toThrow(describeUnfinishedRename(journal, { finishable: true, discardable: true }));
    expect(() => addIdentity(world.paths, "client")).toThrow(/Cannot add identity "client"/);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("remove refuses either name of the pair, naming the command that finishes the rename, and removes nothing", () => {
    const journal = leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    expect(() => {
      removeIdentity(world.paths, "work");
    }).toThrow(describeUnfinishedRename(journal, { finishable: true, discardable: true }));
    expect(() => {
      removeIdentity(world.paths, "client");
    }).toThrow(describeUnfinishedRename(journal, { finishable: true, discardable: true }));
    expect(() => {
      removeIdentity(world.paths, "work");
    }).toThrow(/Cannot remove identity "work"/);
    expect(identityExists(world.paths, "work")).toBe(true);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses a name that reaches the directory of either one through a symlink, which the filesystem treats as the same identity", () => {
    leaveJournal(world, "work", "client");
    fs.symlinkSync(world.directory("work"), world.directory("work-alias"));
    const before = treeOf(world.root);
    expect(() => addIdentity(world.paths, "work-alias")).toThrow(/Cannot add identity "work-alias"/);
    expect(() => {
      removeIdentity(world.paths, "work-alias");
    }).toThrow(/Cannot remove identity "work-alias"/);
    expect(treeOf(world.root)).toEqual(before);
  });

  it.runIf(ignoresCase(os.tmpdir()))("refuses another spelling of a held name on a filesystem that ignores case, whether or not its directory exists yet", () => {
    leaveJournal(world, "work", "client");
    expect(() => {
      removeIdentity(world.paths, "Work");
    }).toThrow(/Cannot remove identity "Work"/);
    expect(() => addIdentity(world.paths, "CLIENT")).toThrow(/Cannot add identity "CLIENT"/);
    expect(fs.existsSync(world.directory("client"))).toBe(false);
  });

  it("refuses a rename, of either kind, to a name that reaches the directory a journal holds through a symlink", async () => {
    leaveJournal(world, "work", "client");
    fs.symlinkSync(world.directory("work"), world.directory("work-alias"));
    const before = treeOf(world.root);
    expect(() => describeIdentityRename(world.paths, "personal", "work-alias", world.ports())).toThrow(/work-alias/);
    await expect(renameIdentity(world.paths, "personal", "work-alias", world.ports())).rejects.toThrow("agent-shim identity rename work client --move");
    await expect(moveIdentity(world.paths, "personal", "work-alias", world.ports())).rejects.toThrow("agent-shim identity rename work client --move");
    expect(treeOf(world.root)).toEqual(before);
  });

  it.runIf(ignoresCase(os.tmpdir()))("refuses a rename, of either kind, to another spelling of a held name on a filesystem that ignores case", async () => {
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "personal", "CLIENT", world.ports())).rejects.toThrow("agent-shim identity rename work client --move");
    await expect(moveIdentity(world.paths, "personal", "CLIENT", world.ports())).rejects.toThrow("agent-shim identity rename work client --move");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("names the discard command in the refusal of a rename of another name when nothing can finish the unfinished one", async () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    await expect(moveIdentity(world.paths, "work", "other", world.ports())).rejects.toThrow("agent-shim identity rename work client --move --discard-journal");
    await expect(moveIdentity(world.paths, "work", "other", world.ports())).rejects.not.toThrow("Finish it with");
  });

  it("names the command that discards the record, not one that finishes the rename, when nothing can finish it", () => {
    removeByHand(world, "work");
    leaveJournal(world, "work", "client");
    const attempts = [
      () => {
        addIdentity(world.paths, "client");
      },
      () => {
        removeIdentity(world.paths, "work");
      },
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow("agent-shim identity rename work client --move --discard-journal");
      expect(attempt).not.toThrow("Finish it with");
    }
  });

  it("leaves every other name alone, and a file that is not a journal does not stop it", () => {
    leaveJournal(world, "work", "client");
    fs.writeFileSync(path.join(world.paths.identityRenamesDir, "damaged.json"), "{ not json");
    expect(addIdentity(world.paths, "other").name).toBe("other");
    expect(() => {
      removeIdentity(world.paths, "personal");
    }).not.toThrow();
    expect(identityExists(world.paths, "personal")).toBe(false);
  });

  it("allows both again once the rename has been finished", async () => {
    leaveJournal(world, "work", "client");
    await moveIdentity(world.paths, "work", "client", world.ports());
    expect(() => {
      removeIdentity(world.paths, "client");
    }).not.toThrow();
    expect(addIdentity(world.paths, "work").name).toBe("work");
  });
});
