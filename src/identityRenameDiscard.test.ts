import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeIdentityRename, discardRenameJournal, renameIdentity } from "./identityRename";
import { describeUnfinishedRename, readRenameJournal, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { NOW_MS, OWN_PID, createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { addIdentity, identityExists, removeIdentity } from "./identityStore";
import { IdentityLockBusyError } from "./launcher/lock";
import { realFarmFs } from "./realPorts";

/** Writes the journal of a rename of `from` to `to` that nothing has applied yet, as one left by a run that was killed would be. */
function leaveJournal(world: World, from: string, to: string): RenameJournal {
  const journal: RenameJournal = {
    version: 1,
    from,
    to,
    startedAt: "2026-10-30T10:00:00.000Z",
    pid: OWN_PID,
    steps: [{ description: `move identities/${from} to identities/${to}`, done: false }],
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
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/no identity under either name/);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("agent-shim identity rename work client --discard-journal");
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toBeInstanceOf(CliError);
    expect(() => describeIdentityRename(world.paths, "work", "client", world.ports())).toThrow("agent-shim identity rename work client --discard-journal");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("is refused the same way when both names are identities, which no rename can reconcile", async () => {
    createByHand(world, "client");
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/both names are identities/);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow("agent-shim identity rename work client --discard-journal");
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

  it("is not discarded while the identity is under exactly one of the two names, where running the rename again finishes it", () => {
    leaveJournal(world, "work", "client");
    const before = treeOf(world.root);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow("agent-shim identity rename work client");
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(/can be finished/);
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
    removeByHand(world, "work");
    const before = treeOf(world.root);
    expect(() => addIdentity(world.paths, "client")).toThrow(describeUnfinishedRename(journal));
    expect(() => addIdentity(world.paths, "work")).toThrow(describeUnfinishedRename(journal));
    expect(() => addIdentity(world.paths, "client")).toThrow(/Cannot add identity "client"/);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("remove refuses either name of the pair, naming the command that finishes the rename, and removes nothing", () => {
    const journal = leaveJournal(world, "work", "client");
    createByHand(world, "client");
    const before = treeOf(world.root);
    expect(() => {
      removeIdentity(world.paths, "work");
    }).toThrow(describeUnfinishedRename(journal));
    expect(() => {
      removeIdentity(world.paths, "client");
    }).toThrow(describeUnfinishedRename(journal));
    expect(() => {
      removeIdentity(world.paths, "work");
    }).toThrow(/Cannot remove identity "work"/);
    expect(identityExists(world.paths, "work")).toBe(true);
    expect(treeOf(world.root)).toEqual(before);
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
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(() => {
      removeIdentity(world.paths, "client");
    }).not.toThrow();
    expect(addIdentity(world.paths, "work").name).toBe("work");
  });
});
