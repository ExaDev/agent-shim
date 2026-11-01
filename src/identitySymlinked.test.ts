import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { discardRenameJournal, renameIdentity } from "./identityRename";
import { renameJournalFile, writeRenameJournal } from "./identityRenameJournal";
import { createWorld, writeJson, type World } from "./identityRenameTestWorld";
import { listIdentities, readIdentity } from "./identityStore";
import { realFarmFs } from "./realPorts";

describe("an identity whose directory is a symlink to a directory", () => {
  let world: World;
  let elsewhere: string;

  beforeEach(() => {
    world = createWorld();
    elsewhere = path.join(world.root, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Moves the identity `name` to a directory outside the identities directory and leaves a symlink to it under its name. */
  function linkIdentity(name: string): string {
    const target = path.join(elsewhere, name);
    fs.renameSync(world.directory(name), target);
    fs.symlinkSync(target, world.directory(name));
    return target;
  }

  function leaveJournal(): void {
    writeRenameJournal(realFarmFs, renameJournalFile(world.paths.identityRenamesDir, "work", "client"), {
      version: 1,
      from: "work",
      to: "client",
      startedAt: "2026-10-30T10:00:00.000Z",
      pid: 4242,
      steps: [{ description: "move identities/work to identities/client", done: false }],
    });
  }

  it("is listed, with the identity it holds", () => {
    linkIdentity("personal");
    const entry = listIdentities(world.paths).find((candidate) => candidate.name === "personal");
    expect(entry?.identity?.name).toBe("personal");
  });

  it("leaves out a symlink that does not resolve to a directory", () => {
    fs.symlinkSync(path.join(elsewhere, "missing"), world.directory("dangling"));
    fs.writeFileSync(path.join(elsewhere, "a-file"), "");
    fs.symlinkSync(path.join(elsewhere, "a-file"), world.directory("not-a-directory"));
    expect(listIdentities(world.paths).map((entry) => entry.name)).toEqual(["personal", "work"]);
  });

  it("is counted by doctor as the rename counts it, so a rename of it that was left unfinished is not called unfinishable", () => {
    linkIdentity("work");
    leaveJournal();
    const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
    const findings = report.findings.filter((finding) => finding.section === "identity" && finding.subject === "work" && finding.severity === "fail");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).not.toContain("--discard-journal");
    expect(findings[0]?.message).not.toContain("cannot be finished");
    expect(() => discardRenameJournal(world.paths, "work", "client", world.ports())).toThrow(/can be finished/);
  });

  it("has its credential sources re-pointed by a rename of another identity, and its command sources warned about", async () => {
    const target = linkIdentity("personal");
    writeJson(path.join(target, "identity.json"), {
      name: "personal",
      allowAmbientCredential: false,
      credential: { sources: [{ file: path.join(world.root, "credentials", "work.token") }, { command: ["cat", path.join(world.directory("work"), "secrets", "token")] }], target: "oauthToken" },
    });
    const done = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "personal")?.credential?.sources[0]).toEqual({ file: path.join(world.root, "credentials", "client.token") });
    expect(done.warnings).toContainEqual(expect.stringContaining('Identity "personal" has a command credential source'));
  });
});
