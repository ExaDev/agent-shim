import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { describeIdentityRename, discardRenameJournal, renameIdentity } from "./identityRename";
import { readRenameJournal, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { OWN_PID, createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { removeIdentity } from "./identityStore";
import { realFarmFs } from "./realPorts";

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
    expect(journal?.steps.filter((step) => step.started === true && !step.done).map((step) => step.description)).toEqual(["rewrite usage/anchors.json: 1 stamp"]);
    expect(journal?.steps.filter((step) => step.started !== true && !step.done).length).toBe((journal?.steps.length ?? 0) - 2);
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
