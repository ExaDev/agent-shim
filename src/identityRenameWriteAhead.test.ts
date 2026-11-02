import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { collectDoctorReport } from "./doctorReport";
import { describeIdentityRename, discardRenameJournal, renameIdentity } from "./identityRename";
import { readRenameJournal, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { LOGIN_SECRET, OWN_PID, createWorld, failingOnce, treeOf, type World } from "./identityRenameTestWorld";
import { removeIdentity } from "./identityStore";
import type { FarmFs } from "./launcher/ports";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";

/** What a journal records of one step, in the order the steps are listed. */
interface Marks {
  readonly description: string;
  readonly started: boolean;
  readonly done: boolean;
}

/** Reads the marks out of the text of a journal as it was written. */
function marksOf(contents: string): readonly Marks[] {
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || !("steps" in parsed) || !Array.isArray(parsed.steps)) {
    throw new Error("not a journal");
  }
  return parsed.steps.map((step: unknown) => {
    if (typeof step !== "object" || step === null || !("description" in step) || typeof step.description !== "string") {
      throw new Error("not a step");
    }
    return { description: step.description, started: "started" in step && step.started === true, done: "done" in step && step.done === true };
  });
}

describe("the journal is written ahead of each step", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("records every step as begun, and not done, before the step runs, and as done after it, so a process killed in between leaves a record that shows the step may have been applied", async () => {
    const written: (readonly Marks[])[] = [];
    const watching = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        if (file.startsWith(world.paths.identityRenamesDir)) {
          written.push(marksOf(contents));
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    const report = await renameIdentity(world.paths, "work", "client", world.ports({ fs: watching }));
    const stepCount = written[0]?.length ?? 0;
    expect(stepCount).toBeGreaterThan(1);
    for (let index = 0; index < stepCount; index += 1) {
      const begunAt = written.findIndex((marks) => marks[index]?.started === true && marks[index]?.done === false);
      const doneAt = written.findIndex((marks) => marks[index]?.done === true);
      expect(begunAt, `step ${String(index)} was never recorded as begun before it was done`).toBeGreaterThanOrEqual(0);
      expect(doneAt).toBeGreaterThan(begunAt);
    }
    expect(report.steps.length).toBeGreaterThanOrEqual(stepCount);
  });

  it("writes every save of the journal durably, and no other file of the rename", async () => {
    const writes: { readonly file: string; readonly durable: boolean }[] = [];
    const watching = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string, options?: { readonly durable?: boolean }): void => {
        writes.push({ file, durable: options?.durable === true });
        realFarmFs.writeFilePrivate(file, contents, options);
      },
    };
    await renameIdentity(world.paths, "work", "client", world.ports({ fs: watching }));
    const journalWrites = writes.filter((write) => write.file.startsWith(world.paths.identityRenamesDir));
    expect(journalWrites.length).toBeGreaterThan(2);
    expect(journalWrites.every((write) => write.durable)).toBe(true);
    expect(writes.filter((write) => !write.file.startsWith(world.paths.identityRenamesDir)).some((write) => write.durable)).toBe(false);
  });

  it("clears the marks of every step the rollback undoes, and keeps those of a step it could not undo, a failed one included, since that step may be applied", async () => {
    const failing = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        if (file === world.paths.usageAnchorsFile) {
          throw new Error("disk full");
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
      rename: (from: string, to: string): void => {
        if (to === world.directory("work")) {
          throw new Error("the directory is busy");
        }
        realFarmFs.rename(from, to);
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).rejects.toThrow(/Rolling back also failed/);
    const journal = readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"));
    expect(journal?.steps.filter((step) => step.done).map((step) => step.description)).toEqual(["move identities/work to identities/client"]);
    // The step that failed was begun and could not be undone either, so it may be partly applied; every other step was undone and is no longer marked.
    expect(journal?.steps.filter((step) => step.started && !step.done).map((step) => step.description)).toEqual(["rewrite usage/anchors.json: 1 stamp"]);
    expect(journal?.steps.filter((step) => !step.started && !step.done).length).toBe((journal?.steps.length ?? 0) - 2);
  });
});

describe("a journal that shows a step begun but not done", () => {
  let world: World;
  let before: readonly string[];

  beforeEach(() => {
    world = createWorld("darwin");
    before = describeIdentityRename(world.paths, "work", "client", world.ports()).steps;
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** The steps a rename takes before it moves the directory, which keep the identity under its old name. */
  function stepsBeforeTheMove(): readonly string[] {
    const move = before.findIndex((step) => step.startsWith("move identities/work to identities/client"));
    return before.slice(0, move);
  }

  /** A journal of the plan with only step `index` begun, as a process killed after applying it and before marking it done leaves. */
  function journalWithStepBegun(index: number): RenameJournal {
    return {
      version: 1,
      from: "work",
      to: "client",
      startedAt: "2026-10-30T10:00:00.000Z",
      pid: OWN_PID,
      steps: before.map((description, position) => ({ description, done: false, started: position === index })),
    };
  }

  it("has steps before the move to check, among them the Keychain copy and the rewrite of the identity's own file", () => {
    const steps = stepsBeforeTheMove();
    expect(steps.some((step) => step.startsWith("copy the Keychain login"))).toBe(true);
    expect(steps.some((step) => step.startsWith("rewrite identities/work/identity.json"))).toBe(true);
  });

  it("is refused by --discard-journal for each step that runs before the move, and leaves the record and the identity as they were", () => {
    const steps = stepsBeforeTheMove();
    for (const [index, description] of steps.entries()) {
      writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), journalWithStepBegun(index));
      const tree = treeOf(world.root);
      expect(() => discardRenameJournal(world.paths, "work", "client", world.ports()), description).toThrow(/can be finished/);
      expect(treeOf(world.root), description).toEqual(tree);
    }
  });

  it("is described by doctor, for each step that runs before the move, as one to finish, counting the step and never offering to discard it as losing nothing", () => {
    for (const [index, description] of stepsBeforeTheMove().entries()) {
      writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), journalWithStepBegun(index));
      const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
      const message = report.findings.find((entry) => entry.section === "identity" && entry.subject === "work" && entry.severity === "fail")?.message ?? "";
      expect(message, description).toContain("Finish it with `agent-shim identity rename work client`");
      expect(message, description).toContain("(1 of");
      expect(message, description).not.toContain("--discard-journal");
      expect(message, description).not.toContain("loses nothing");
    }
  });

  it("is refused for a remove of the old name with text that names the command that finishes it and does not offer to discard the record", () => {
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), journalWithStepBegun(0));
    const refusal = ((): string => {
      try {
        removeIdentity(world.paths, "work");
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    })();
    expect(refusal).toContain("Cannot remove identity \"work\"");
    expect(refusal).toContain("Finish it with `agent-shim identity rename work client`");
    expect(refusal).not.toContain("--discard-journal");
  });

  it("is carried into a run that finishes the rename, as applied, and is finished by it", async () => {
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), journalWithStepBegun(0));
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"))).toBeUndefined();
    expect(path.basename(world.directory("client"))).toBe("client");
  });
});

/** The writes of the journal in the order a rename makes them, counted from 1: the whole journal before the first step, then for each step a write ahead of it and a write after it. */
const INITIAL_WRITE = 1;
const DONE_WRITE_OF_FIRST_STEP = 3;
const BEGUN_WRITE_OF_SECOND_STEP = 4;

describe("a journal write that fails", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /**
   * A filesystem on which the `failing`th write of the journal (counting from 1) throws, as it does when the disk is full, and every other write goes through. `removing` makes the removal of the journal fail too.
   */
  function failingJournalWrite(failing: number, removing = false): FarmFs {
    let writes = 0;
    return {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        if (file.startsWith(world.paths.identityRenamesDir)) {
          writes += 1;
          if (writes === failing) {
            throw new Error("no space left on device");
          }
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
      removeRecursive: (target: string): void => {
        if (removing && target.startsWith(world.paths.identityRenamesDir)) {
          throw new Error("EACCES: permission denied");
        }
        realFarmFs.removeRecursive(target);
      },
    };
  }

  async function failureOf(attempt: () => Promise<unknown>): Promise<string> {
    const failure: unknown = await attempt().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    return failure instanceof Error ? failure.message : "";
  }

  it("before the first step stops the rename with an error that says so and that nothing was changed, not with the bare error of the disk", async () => {
    const before = treeOf(world.root);
    const message = await failureOf(async () => renameIdentity(world.paths, "work", "client", world.ports({ fs: failingJournalWrite(INITIAL_WRITE) })));
    expect(message).toContain("could not be written");
    expect(message).toContain("no space left on device");
    expect(message).toContain("the rename was rolled back and nothing was changed");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("ahead of a step stops before the step runs, rolls back the steps before it, and says so", async () => {
    const before = treeOf(world.root);
    const message = await failureOf(async () => renameIdentity(world.paths, "work", "client", world.ports({ fs: failingJournalWrite(BEGUN_WRITE_OF_SECOND_STEP) })));
    expect(message).toContain("could not be written");
    expect(message).toContain("no space left on device");
    expect(message).toContain("the rename was rolled back and nothing was changed");
    expect(treeOf(world.root)).toEqual(before);
    expect(readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"))).toBeUndefined();
  });

  it("after a step rolls that step back too, and says so", async () => {
    const before = treeOf(world.root);
    const message = await failureOf(async () => renameIdentity(world.paths, "work", "client", world.ports({ fs: failingJournalWrite(DONE_WRITE_OF_FIRST_STEP) })));
    expect(message).toContain("could not be written");
    expect(message).toContain("the rename was rolled back and nothing was changed");
    expect(treeOf(world.root)).toEqual(before);
  });

  it("ahead of a step leaves a step that never ran unmarked in the journal a later write saves, so a rename that was rolled back can still be discarded", async () => {
    // The begun write of the second step fails, the first step is rolled back, and the record then cannot be removed: what is left on disk must show nothing begun.
    const message = await failureOf(async () => renameIdentity(world.paths, "work", "client", world.ports({ fs: failingJournalWrite(BEGUN_WRITE_OF_SECOND_STEP, true) })));
    expect(message).toContain("could not be removed");
    expect(message).toContain("agent-shim identity rename work client --discard-journal");
    const journal = readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"));
    expect(journal?.steps.filter((step) => step.started || step.done)).toEqual([]);
    expect(discardRenameJournal(world.paths, "work", "client", world.ports())).toEqual({ from: "work", to: "client" });
  });

  it("ahead of a step in a run that finishes an earlier one leaves that step unmarked in the journal it keeps", async () => {
    const half = {
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
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: half }))).rejects.toThrow(/Rolling back also failed/);
    const message = await failureOf(async () => renameIdentity(world.paths, "work", "client", world.ports({ fs: failingJournalWrite(BEGUN_WRITE_OF_SECOND_STEP) })));
    expect(message).toContain("could not be written");
    expect(message).toContain("the steps this run applied were rolled back; the rename it was finishing is still unfinished");
    const journal = readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"));
    expect(journal?.steps.filter((step) => step.started || step.done).map((step) => step.description)).toEqual(["move identities/work to identities/client"]);
  });
});

describe("a resumed run that fails and rolls back, after an earlier run's Keychain copy landed and was marked begun but not done", () => {
  let world: World;
  let oldService: string;
  let newService: string;

  beforeEach(() => {
    world = createWorld("darwin");
    oldService = claudeCodeKeychainService(world.directory("work"));
    newService = claudeCodeKeychainService(world.directory("client"));
    // What a process killed after the copy took effect and before it was marked done leaves: the login under the new service, and a journal that shows the copy as begun only.
    world.keychain.seed(newService, "alex", LOGIN_SECRET);
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), {
      version: 1,
      from: "work",
      to: "client",
      startedAt: "2026-10-30T10:00:00.000Z",
      pid: OWN_PID,
      steps: [{ description: `copy the Keychain login "${oldService}" to "${newService}"`, started: true, done: false }],
    });
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("keeps the copy marked begun in the journal it keeps, so --discard-journal still refuses a rename whose login is already under the new service", async () => {
    // The step that fails does so once, so its undo works and the rollback is complete.
    const message = await renameIdentity(world.paths, "work", "client", world.ports({ fs: failingOnce(world) })).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toContain("disk full");
    expect(message).not.toContain("Rolling back also failed");
    const journal = readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"));
    expect(journal?.steps.filter((step) => step.started || step.done).map((step) => step.description)).toEqual([`copy the Keychain login "${oldService}" to "${newService}"`]);
    // The login is still under the new service, and the identity under the old name: the state a discard would walk away from.
    expect(world.keychain.items.has(newService)).toBe(true);
    expect(fs.existsSync(world.directory("work"))).toBe(true);
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(/can be finished/);
    expect(readRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"))).toBeDefined();
  });
});
