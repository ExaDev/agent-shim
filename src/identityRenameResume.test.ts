import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeIdentityRename, renameIdentity } from "./identityRename";
import { describeUnfinishedRename, readRenameJournal, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { LOGIN_SECRET, NOW_MS, OWN_PID, createWorld, treeOf, type World, failingOnce } from "./identityRenameTestWorld";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";

/** The tree of the world with its random root replaced, so two worlds that ended in the same state compare equal. */
function normalisedTree(world: World): Record<string, string> {
  return Object.fromEntries(Object.entries(treeOf(world.root)).map(([file, contents]) => [file, contents.split(world.root).join("<root>")]));
}

/** The journal of the rename of `work` to `client` as the world holds it, or undefined. */
function journalOf(world: World): RenameJournal | undefined {
  return readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"));
}

/** A filesystem that fails the last step and then refuses to move the directory back, so the rename ends partly done and leaves its journal. */
function leavingItHalfDone(world: World) {
  return {
    ...realFarmFs,
    rename: (from: string, to: string): void => {
      if (to === world.directory("work")) {
        throw new Error("the directory is busy");
      }
      realFarmFs.rename(from, to);
    },
    writeFilePrivate: (file: string, contents: string): void => {
      if (file === world.paths.usageAnchorsFile) {
        throw new Error("disk full");
      }
      realFarmFs.writeFilePrivate(file, contents);
    },
  };
}

describe("the journal a rename keeps", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("exists before the first step with every step undone, marks each step done as it is applied, and is gone once the rename is over", async () => {
    const seen: { readonly first: RenameJournal | undefined; readonly last: RenameJournal | undefined }[] = [];
    let first: RenameJournal | undefined;
    const watching = {
      ...realFarmFs,
      rename: (from: string, to: string): void => {
        first ??= journalOf(world);
        realFarmFs.rename(from, to);
      },
      writeFilePrivate: (file: string, contents: string): void => {
        if (file === world.paths.usageAnchorsFile) {
          seen.push({ first, last: journalOf(world) });
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    const report = await renameIdentity(world.paths, "work", "client", world.ports({ fs: watching }));
    const [observed] = seen;
    expect(first).toMatchObject({ version: 1, from: "work", to: "client", pid: OWN_PID });
    expect(first?.steps.map((step) => step.description)).toEqual(report.steps.slice(0, first?.steps.length));
    expect(first?.steps.every((step) => !step.done)).toBe(false);
    expect(observed?.last?.steps.filter((step) => step.done).length).toBe((observed?.last?.steps.length ?? 0) - 1);
    expect(journalOf(world)).toBeUndefined();
  });

  it("is removed when a step fails and every earlier step was undone, since nothing is left half done", async () => {
    const failing = failingOnce(world);
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).rejects.toThrow(/disk full/);
    expect(journalOf(world)).toBeUndefined();
  });

  it("is left in place when the rollback could not undo everything, and no stray directory is made under the old name", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow(/Rolling back also failed/);
    expect(journalOf(world)).toMatchObject({ from: "work", to: "client" });
    expect(fs.existsSync(world.directory("work"))).toBe(false);
    expect(fs.existsSync(world.directory("client"))).toBe(true);
  });

  it("marks as done only the steps the rollback could not undo, so the count doctor reports is what is left", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow(/Rolling back also failed/);
    const journal = journalOf(world);
    expect(journal?.steps.length).toBeGreaterThan(1);
    expect(journal?.steps.filter((step) => step.done).map((step) => step.description)).toEqual(["move identities/work to identities/client"]);
  });

  it("is not written by a dry run, which only says what a rename would do", () => {
    describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(world.paths.identityRenamesDir)).toBe(false);
  });
});

describe("running a rename again after one was left unfinished", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("finishes it, plans only what is left, and ends in the state a rename that was never interrupted ends in", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow();
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(report.steps.some((step) => step.startsWith("move identities/work to"))).toBe(false);
    expect(report.steps.some((step) => step.startsWith("rewrite config.json"))).toBe(true);
    expect(journalOf(world)).toBeUndefined();

    const clean = createWorld();
    try {
      await renameIdentity(clean.paths, "work", "client", clean.ports());
      expect(normalisedTree(world)).toEqual(normalisedTree(clean));
    } finally {
      fs.rmSync(clean.root, { recursive: true, force: true });
    }
  });

  it("is kept with every step marked undone when the run that finishes it fails and rolls back completely, since the state is the earlier run's again", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow();
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failingOnce(world) }))).rejects.toThrow(/disk full/);
    const journal = journalOf(world);
    expect(journal?.steps.length).toBeGreaterThan(0);
    expect(journal?.steps.filter((step) => step.done)).toEqual([]);
    expect(journal === undefined ? "" : describeUnfinishedRename(journal, { finishable: true })).toContain(`(0 of ${String(journal?.steps.length)} steps recorded as done)`);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).resolves.toBeDefined();
    expect(journalOf(world)).toBeUndefined();
  });

  it("finishes a rename that was killed after moving the directory, which no rollback ran for", async () => {
    // What a SIGKILL leaves: the directory and its identity.json already under the new name, and the journal.
    const original = fs.readFileSync(path.join(world.directory("work"), "identity.json"), "utf8");
    fs.writeFileSync(path.join(world.directory("work"), "identity.json"), original.replace('"name": "work"', '"name": "client"'));
    fs.renameSync(world.directory("work"), world.directory("client"));
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), {
      version: 1,
      from: "work",
      to: "client",
      startedAt: new Date(NOW_MS).toISOString(),
      pid: OWN_PID,
      steps: [{ description: "move identities/work to identities/client", done: false }],
    });
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(journalOf(world)).toBeUndefined();
    expect(world.json("config.json")).toMatchObject({ pools: { subs: { identities: ["client", "personal", "pool:fleet"] } } });
    expect(fs.existsSync(world.directory("work"))).toBe(false);
  });

  it("lists in a dry run only what is left, and writes nothing", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow();
    const before = treeOf(world.root);
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(planned.steps.some((step) => step.startsWith("move identities/work to"))).toBe(false);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("refuses a rename of the pair the other way round, or of either identity with another name, naming the unfinished one and the command that finishes it", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow();
    const journal = journalOf(world);
    if (journal === undefined) {
      throw new Error("expected a journal");
    }
    const before = treeOf(world.root);
    for (const [from, to] of [["client", "work"], ["work", "other"], ["client", "other"], ["other", "client"]] as const) {
      await expect(renameIdentity(world.paths, from, to, world.ports())).rejects.toThrow(describeUnfinishedRename(journal, { finishable: true }));
      expect(() => describeIdentityRename(world.paths, from, to, world.ports())).toThrow(describeUnfinishedRename(journal, { finishable: true }));
    }
    expect(treeOf(world.root)).toEqual(before);
  });

  it("leaves a rename of two other identities alone", async () => {
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: leavingItHalfDone(world) }))).rejects.toThrow();
    await expect(renameIdentity(world.paths, "personal", "home", world.ports())).resolves.toBeDefined();
    expect(fs.existsSync(world.directory("home"))).toBe(true);
  });

  it("refuses a journal it cannot read, naming the file, since it cannot say what was left half done", async () => {
    const damaged = path.join(world.paths.identityRenamesDir, "damaged.json");
    fs.mkdirSync(world.paths.identityRenamesDir, { recursive: true });
    fs.writeFileSync(damaged, "{ not json");
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(damaged);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toBeInstanceOf(CliError);
    expect(treeOf(world.root)).toEqual(before);
  });

  it("still refuses a name that is taken when there is no journal, so an ordinary clash is not mistaken for an unfinished rename", async () => {
    await expect(renameIdentity(world.paths, "work", "personal", world.ports())).rejects.toThrow(/already exists/);
  });
});

describe("running a rename again with a macOS login already copied", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("does not copy it again or read it, keeps it, and deletes the old one once the rename is over", async () => {
    const oldService = claudeCodeKeychainService(world.directory("work"));
    const newService = claudeCodeKeychainService(world.directory("client"));
    world.keychain.seed(newService, "alex", LOGIN_SECRET);
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), {
      version: 1,
      from: "work",
      to: "client",
      startedAt: new Date(NOW_MS).toISOString(),
      pid: OWN_PID,
      steps: [{ description: `copy the Keychain login "${oldService}" to "${newService}"`, done: true }],
    });
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.keychain.secretOf(newService)?.toString("utf8")).toBe(LOGIN_SECRET);
    expect(world.keychain.items.has(oldService)).toBe(false);
    expect(world.keychain.calls.some((call) => call.args[0] === "-i" || call.args.includes("-g"))).toBe(false);
    expect(report.steps.some((step) => step.startsWith("copy the Keychain login"))).toBe(false);
    expect(report.steps.at(-1)).toBe(`delete the former Keychain login "${oldService}"`);
  });
});
