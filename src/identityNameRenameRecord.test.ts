import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import { createRouterClient } from "@orpc/server";
import { createConfigApiRouter } from "./frontdoor/configApi";
import { MAX_NAME_BYTES } from "./config/names";
import { describeInterruptedNameRename, InterruptedNameRenameError, readNameRenameRecords, removeNameRenameRecord, unfinishedNameRenames, writeNameRenameRecord } from "./identityNameRenameRecord";
import { killedRename } from "./identityNameRenameKilledTestWorld";
import { describeIdentityMove, describeIdentityRename, renameIdentity } from "./identityRename";
import { createWorld, type World } from "./identityRenameTestWorld";
import { addIdentity, identityIdOf, removeIdentity, requireIdentityAddable } from "./identityStore";
import type { FarmFs } from "./launcher/ports";
import { realFarmFs } from "./realPorts";

const TOKEN = "a-made-up-control-token";

describe("a rename of the name alone that was killed part way", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Leaves exactly what a rename of work to client killed before its last step leaves: every reference rewritten to client, the identity still named work in its identity.json, and the record of the rename. */
  async function killedAfterReferences(): Promise<void> {
    await renameIdentity(world.paths, "work", "client", world.ports());
    const file = path.join(world.paths.identitiesDir, "work", "identity.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"name": "client"', '"name": "work"'));
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" });
  }

  it("leaves a record that makes identity add of the new name refuse, naming what it rewrote and the command that finishes it", () => {
    // A real rename in a child process, killed with SIGKILL once the last reference is rewritten and before the name is.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "killed-name-rename-home-"));
    try {
      expect(killedRename(home, world.paths.root, "before-name")).toBe("SIGKILL");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(readNameRenameRecords(world.paths)).toMatchObject([{ id: "work", from: "work", to: "client" }]);
    let refusal: unknown;
    try {
      addIdentity(world.paths, "client");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(InterruptedNameRenameError);
    const message = refusal instanceof Error ? refusal.message : "";
    expect(message).toContain('a rename of identity "work" to "client" was interrupted');
    expect(message).toContain("pool subs");
    expect(message).toContain("rule /example/project");
    expect(message).toContain("the active selection");
    expect(message).toContain("Finish it with `agent-shim identity rename work client`");
    expect(identityIdOf(world.paths, "client")).toBeUndefined();
  });

  it("names the rewritten account model refs of the configuration, a profile and a directory rule, beside the references it already names", async () => {
    await killedAfterReferences();
    const message = describeInterruptedNameRename(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" });
    expect(message).toContain("pool subs");
    expect(message).toContain("models");
    expect(message).toContain("profile client");
    expect(message).toContain("rule /example/pooled");
    expect(message).not.toContain("profile plain");
  });

  it("describes the rename and lets doctor report the rest when config.json, directory-rules.json or a profile is malformed", async () => {
    await killedAfterReferences();
    fs.writeFileSync(world.paths.globalConfigFile, "{");
    fs.writeFileSync(world.paths.directoryRulesFile, "{");
    fs.writeFileSync(path.join(world.paths.configProfilesDir, "client.json"), "{");
    const record = { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" } as const;
    expect(describeInterruptedNameRename(world.paths, record)).toContain('A rename of identity "work" to "client" was interrupted and has already rewritten references to "client" (the active selection, 1 recorded pool pick). Finish it');
    expect(() => unfinishedNameRenames(world.paths)).not.toThrow();
    const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
    expect(findingsFor(report, "identity").some((entry) => entry.message.includes("was interrupted"))).toBe(true);
  });

  it("refuses removing the identity and another rename of either name, and is finished by running the same rename again", async () => {
    await killedAfterReferences();
    expect(() => {
      removeIdentity(world.paths, "work");
    }).toThrow(InterruptedNameRenameError);
    await expect(renameIdentity(world.paths, "personal", "client", world.ports())).rejects.toThrow(InterruptedNameRenameError);
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });

  it("is refused through the door's config.identity.add as a conflict with the same message", async () => {
    await killedAfterReferences();
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths: world.paths, keychain: { runAsync: async () => await Promise.reject(new Error("no Keychain here")), platform: "linux" } }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    const refusal: unknown = await api.identity.add({ name: "client" }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "CONFLICT" });
    expect(refusal instanceof Error ? refusal.message : "").toContain("agent-shim identity rename work client");
  });

  it("leaves no record behind a rename that ended or was rolled back", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readNameRenameRecords(world.paths)).toEqual([]);
    // Fails once, so the rollback that follows rewrites the file and completes.
    let failed = false;
    const failing: FarmFs = {
      ...realFarmFs,
      writeFilePrivate: (file, contents, options) => {
        if (file === world.paths.usagePicksFile && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        realFarmFs.writeFilePrivate(file, contents, options);
      },
    };
    await expect(renameIdentity(world.paths, "client", "other", world.ports({ fs: failing }))).rejects.toThrow("disk full");
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });

  it("keeps the record when the rollback cannot undo a step, so identity add of the new name still refuses", async () => {
    // The recorded picks are the last reference rewritten before the name: the rename is interrupted once they are written, and putting them back fails.
    let picksWritten = false;
    const failingUndo: FarmFs = {
      ...realFarmFs,
      writeFilePrivate: (file, contents, options) => {
        if (file === world.paths.usagePicksFile) {
          if (picksWritten) {
            throw new Error("disk gone");
          }
          picksWritten = true;
          realFarmFs.writeFilePrivate(file, contents, options);
          world.interrupt("SIGINT");
          return;
        }
        realFarmFs.writeFilePrivate(file, contents, options);
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failingUndo }))).rejects.toThrow("disk gone");
    expect(readNameRenameRecords(world.paths).map((record) => [record.id, record.from, record.to])).toEqual([["work", "work", "client"]]);
    expect(() => addIdentity(world.paths, "client")).toThrow(InterruptedNameRenameError);
  });

  it("keeps the record and reports the earlier rename as still unfinished when a run finishing it is interrupted or rolls back a failed step", async () => {
    const startedAt = "2026-10-30T10:00:00.000Z";
    const picksBefore = fs.readFileSync(world.paths.usagePicksFile, "utf8");
    await killedAfterReferences();
    fs.writeFileSync(world.paths.usagePicksFile, picksBefore);
    const interruptedAfterPicks: FarmFs = {
      ...realFarmFs,
      writeFilePrivate: (file, contents, options) => {
        realFarmFs.writeFilePrivate(file, contents, options);
        if (file === world.paths.usagePicksFile) {
          world.interrupt("SIGINT");
        }
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: interruptedAfterPicks }))).rejects.toThrow(
      "Interrupted by SIGINT: the steps this run applied were rolled back; the rename it was finishing is still unfinished, and running the same command again finishes it.",
    );
    expect(readNameRenameRecords(world.paths)).toEqual([{ version: 1, id: "work", from: "work", to: "client", startedAt }]);
    expect(() => addIdentity(world.paths, "client")).toThrow(InterruptedNameRenameError);

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
    expect(readNameRenameRecords(world.paths)).toEqual([{ version: 1, id: "work", from: "work", to: "client", startedAt }]);
    expect(() => addIdentity(world.paths, "client")).toThrow(InterruptedNameRenameError);

    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });

  it("refreshes locks between reference steps, does not refresh locks or roll back after the final step writes the new name into identity.json, and treats a record whose references still name the old name as unfinished", async () => {
    let stolenBeforeName = false;
    const lockStolenBeforeName: FarmFs = {
      ...realFarmFs,
      writeFilePrivate: (file, contents, options) => {
        realFarmFs.writeFilePrivate(file, contents, options);
        if (file === world.paths.usagePicksFile && !stolenBeforeName) {
          stolenBeforeName = true;
          fs.writeFileSync(path.join(world.paths.identitiesDir, ".work.lock"), `${JSON.stringify({ identity: "work", pid: 1, token: "taken", acquiredAtMs: 1 })}\n`);
        }
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: lockStolenBeforeName }))).rejects.toThrow("taken over");
    fs.rmSync(path.join(world.paths.identitiesDir, ".work.lock"), { force: true });
    expect(identityIdOf(world.paths, "work")).toBe("work");
    expect(readNameRenameRecords(world.paths)).toEqual([]);

    const lockStolenAfterName: FarmFs = {
      ...realFarmFs,
      readFileUtf8: (file) => {
        if (file.endsWith(".work.lock") && world.read("identities/work/identity.json").includes('"client"')) {
          return JSON.stringify({ identity: "work", pid: 1, token: "taken", acquiredAtMs: 1 });
        }
        return realFarmFs.readFileUtf8(file);
      },
    };
    await renameIdentity(world.paths, "work", "client", world.ports({ fs: lockStolenAfterName }));
    expect(identityIdOf(world.paths, "client")).toBe("work");
    expect(readNameRenameRecords(world.paths)).toEqual([]);

    // If identity.json carries the new name while unshared references still name the old name, the record is not settled.
    fs.writeFileSync(world.paths.activeIdentityFile, "work\n");
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" });
    expect(unfinishedNameRenames(world.paths)).toMatchObject([{ id: "work", from: "work", to: "client" }]);
  });
});

describe("the command an interrupted rename of the name alone says finishes it", () => {
  let world: World;
  const startedAt = "2026-10-30T10:00:00.000Z";

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Stores a second identity named work under work-2, so two identities claim the name. */
  function secondWork(): void {
    fs.mkdirSync(world.directory("work-2"), { recursive: true });
    fs.writeFileSync(path.join(world.directory("work-2"), "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
  }

  it("names the identity by its id when another identity also claims the old name, and that command finishes it", async () => {
    secondWork();
    writeNameRenameRecord(world.paths, { version: 1, id: "work-2", from: "work", to: "client", startedAt });
    const [record] = readNameRenameRecords(world.paths);
    if (record === undefined) {
      throw new Error("no record");
    }
    expect(describeInterruptedNameRename(world.paths, record)).toContain("Finish it with `agent-shim identity rename work-2 client --id`");
    // Its id is its old name too, but that name reaches two identities.
    expect(describeInterruptedNameRename(world.paths, { version: 1, id: "work", from: "work", to: "office", startedAt })).toContain("Finish it with `agent-shim identity rename work office --id`");
    await renameIdentity(world.paths, "work-2", "client", world.ports(), { byId: true });
    expect(identityIdOf(world.paths, "client")).toBe("work-2");
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });

  it("refuses renaming another identity that shares the old name to the new name while the first identity's rename is unfinished", async () => {
    secondWork();
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt });
    expect(() => describeIdentityRename(world.paths, "work-2", "client", world.ports(), { byId: true })).toThrow(InterruptedNameRenameError);
    await expect(renameIdentity(world.paths, "work-2", "client", world.ports(), { byId: true })).rejects.toThrow(InterruptedNameRenameError);
    expect(readNameRenameRecords(world.paths)).toEqual([{ version: 1, id: "work", from: "work", to: "client", startedAt }]);
  });

  it("holds nothing once no identity is stored under its id, so the names it held are free and the add removes it", () => {
    writeNameRenameRecord(world.paths, { version: 1, id: "removed", from: "office", to: "client", startedAt });
    expect(readNameRenameRecords(world.paths)).toHaveLength(1);
    expect(unfinishedNameRenames(world.paths)).toEqual([]);
    addIdentity(world.paths, "client");
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });

  it("names it by its id when the id is not the name, even with the old name claimed once, and by its name otherwise", () => {
    fs.renameSync(world.directory("work"), world.directory("work-3"));
    writeNameRenameRecord(world.paths, { version: 1, id: "work-3", from: "work", to: "client", startedAt });
    writeNameRenameRecord(world.paths, { version: 1, id: "personal", from: "personal", to: "home", startedAt });
    const described = readNameRenameRecords(world.paths).map((record) => describeInterruptedNameRename(world.paths, record));
    expect(described.some((text) => text.includes("Finish it with `agent-shim identity rename work-3 client --id`"))).toBe(true);
    expect(described.some((text) => text.includes("Finish it with `agent-shim identity rename personal home`"))).toBe(true);
  });
});

describe("a record of a rename of the name alone filed under a name no rename gives it", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("blocks no name, is left where it is, and is reported by doctor", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    // The record a finished rename of work to client would have kept, stored under another file name.
    const stray = path.join(world.paths.identityNameRenamesDir, "work--client.json");
    fs.mkdirSync(world.paths.identityNameRenamesDir, { recursive: true });
    fs.writeFileSync(stray, `${JSON.stringify({ version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" })}\n`);
    expect(readNameRenameRecords(world.paths)).toEqual([]);
    expect(() => removeIdentity(world.paths, "client")).not.toThrow();
    expect(fs.existsSync(stray)).toBe(true);
    expect(findingsFor(collectDoctorReport({ paths: world.paths, env: { PATH: "" } }), "identity")).toContainEqual(expect.objectContaining({ severity: "warn", subject: "work--client.json" }));
  });

  it("is left in place, once settled, by a dry run of either rename and by the check made before an add, and removed by the add", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" });
    const [settled] = fs.readdirSync(world.paths.identityNameRenamesDir);
    const kept = (): boolean => settled !== undefined && fs.existsSync(path.join(world.paths.identityNameRenamesDir, settled));
    describeIdentityRename(world.paths, "personal", "other", world.ports());
    expect(kept()).toBe(true);
    describeIdentityMove(world.paths, "personal", "elsewhere", world.ports());
    expect(kept()).toBe(true);
    requireIdentityAddable(world.paths, "office", { run: { run: () => ({ status: 0, stdout: "", stderr: "" }) }, platform: "linux" }, false);
    expect(kept()).toBe(true);
    addIdentity(world.paths, "office");
    expect(kept()).toBe(false);
  });

  it("holds nothing once settled, even when removing it does not take it away", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    // A settled record filed where its rename keeps it, which a removal left behind.
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z" });
    const removal = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    expect(() => addIdentity(world.paths, "work")).not.toThrow();
    removal.mockRestore();
  });
});

describe("the file a rename of the name alone keeps its record in", () => {
  let world: World;
  const startedAt = "2026-10-30T10:00:00.000Z";

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is a different one for two pairs whose names, joined by a double dash, read the same", () => {
    writeNameRenameRecord(world.paths, { version: 1, id: "one", from: "a--b", to: "c", startedAt });
    writeNameRenameRecord(world.paths, { version: 1, id: "two", from: "a", to: "b--c", startedAt });
    expect(readNameRenameRecords(world.paths).map((record) => record.id).sort()).toEqual(["one", "two"]);
  });

  it("is one the filesystem accepts for two of the longest names a new identity may have, and is removed by them", () => {
    const from = "a".repeat(MAX_NAME_BYTES);
    const to = "b".repeat(MAX_NAME_BYTES);
    writeNameRenameRecord(world.paths, { version: 1, id: "work", from, to, startedAt });
    expect(readNameRenameRecords(world.paths).map((record) => record.to)).toEqual([to]);
    removeNameRenameRecord(world.paths, from, to);
    expect(readNameRenameRecords(world.paths)).toEqual([]);
  });
});
