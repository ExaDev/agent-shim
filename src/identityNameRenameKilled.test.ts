import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import { describeInterruptedNameRename, readNameRenameRecords, unfinishedNameRenames } from "./identityNameRenameRecord";
import { describeIdentityMove, renameIdentity } from "./identityRename";
import { InterruptedNameRenameError } from "./identityNameRenameRecord";
import { addIdentity, identityIdOf, removeIdentity } from "./identityStore";
import { killedRename } from "./identityNameRenameKilledTestWorld";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realIdentityRenamePorts } from "./realIdentityRename";

describe("a rename of the name alone killed part way, by a real SIGKILL", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "killed-name-rename-test-"));
    paths = buildLayoutPaths(path.join(root, "state"));
    addIdentity(paths, "work");
    fs.mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    fs.writeFileSync(paths.globalConfigFile, `${JSON.stringify({ pools: { subs: { identities: ["work"] } } })}\n`);
    fs.mkdirSync(path.dirname(paths.usagePicksFile), { recursive: true });
    fs.writeFileSync(paths.usagePicksFile, `${JSON.stringify({ schemaVersion: 1, picks: { "/example/project": { identity: "work", at: "2026-10-30T10:00:00.000Z" } } })}\n`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The identity findings the real `doctor` makes over the state root that are not passes, as severity and message. */
  function problemsFound(): readonly (readonly string[])[] {
    return findingsFor(collectDoctorReport({ paths, env: { PATH: "" } }), "identity")
      .filter((finding) => finding.severity !== "pass")
      .map((finding) => [finding.severity, finding.message]);
  }

  it("after the name was written, counts as finished: nothing refuses, and the next rename that acts clears the record", async () => {
    expect(killedRename(root, paths.root, "after-name")).toBe("SIGKILL");
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(readNameRenameRecords(paths)).toHaveLength(1);
    expect(unfinishedNameRenames(paths)).toEqual([]);
    expect(problemsFound()).toEqual([]);
    // Running it again is refused before any lock is taken, leaving the record, which holds nothing, to the next rename that acts.
    await expect(renameIdentity(paths, "work", "client", realIdentityRenamePorts(paths))).rejects.toThrow('No identity named "work"');
    expect(unfinishedNameRenames(paths)).toEqual([]);
    await renameIdentity(paths, "client", "other", realIdentityRenamePorts(paths));
    expect(readNameRenameRecords(paths)).toEqual([]);
    addIdentity(paths, "work");
    expect(identityIdOf(paths, "work")).toBe("work-2");
    removeIdentity(paths, "other");
  });

  it("before the name was written, blocks the names it holds, refuses --move of either, is reported by doctor, and is finished by running it again", async () => {
    expect(killedRename(root, paths.root, "before-name")).toBe("SIGKILL");
    expect(identityIdOf(paths, "work")).toBe("work");
    const [record] = unfinishedNameRenames(paths);
    expect(record).toMatchObject({ id: "work", from: "work", to: "client" });
    expect(() => addIdentity(paths, "client")).toThrow(InterruptedNameRenameError);
    expect(() => describeIdentityMove(paths, "work", "elsewhere", realIdentityRenamePorts(paths))).toThrow(InterruptedNameRenameError);
    if (record === undefined) {
      throw new Error("no record");
    }
    const description = describeInterruptedNameRename(paths, record);
    expect(description).toContain("pool subs");
    expect(problemsFound()).toEqual([["fail", description]]);
    await renameIdentity(paths, "work", "client", realIdentityRenamePorts(paths));
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(readNameRenameRecords(paths)).toEqual([]);
  });

  it("whose identity has since gone, holds nothing", async () => {
    expect(killedRename(root, paths.root, "before-name")).toBe("SIGKILL");
    fs.rmSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    expect(unfinishedNameRenames(paths)).toEqual([]);
    addIdentity(paths, "client");
    expect(readNameRenameRecords(paths)).toEqual([]);
    await Promise.resolve();
  });
});
