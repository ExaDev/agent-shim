import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { discardRenameJournal, renameIdentity } from "./identityRename";
import { renameJournalFile, writeRenameJournal } from "./identityRenameJournal";
import { createWorld, writeJson, type World } from "./identityRenameTestWorld";
import { listIdentities, readIdentity } from "./identityStore";
import { realFarmFs } from "./realPorts";

/** The mode of a directory nobody can enter, and the mode that gives it back to its owner so it can be removed. */
const NO_ACCESS = 0;
const OWNER_ALL = 0o700;

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

  describe("that cannot be reached", () => {
    /** An entry the filesystem refuses to reach (a link it will not resolve, or a directory nobody can enter), made under the identities directory, and the error code it gives. */
    const unreachable: readonly { readonly case: string; readonly code: string; readonly make: (made: World, outside: string) => readonly string[] }[] = [
      {
        case: "a cycle of links",
        code: "ELOOP",
        make: (made) => {
          fs.symlinkSync(made.directory("loop-b"), made.directory("loop-a"));
          fs.symlinkSync(made.directory("loop-a"), made.directory("loop-b"));
          return ["loop-a", "loop-b"];
        },
      },
      {
        case: "a target below a directory that cannot be searched",
        code: "EACCES",
        make: (made, outside) => {
          const locked = path.join(outside, "locked");
          fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
          fs.symlinkSync(path.join(locked, "inner"), made.directory("locked-link"));
          fs.chmodSync(locked, NO_ACCESS);
          return ["locked-link"];
        },
      },
      {
        case: "a symlink to a directory nobody can enter",
        code: "EACCES",
        make: (made, outside) => {
          const closed = path.join(outside, "closed");
          fs.mkdirSync(closed);
          fs.writeFileSync(path.join(closed, "identity.json"), `${JSON.stringify({ name: "closed-link", allowAmbientCredential: false })}\n`);
          fs.symlinkSync(closed, made.directory("closed-link"));
          fs.chmodSync(closed, NO_ACCESS);
          return ["closed-link"];
        },
      },
      {
        case: "a directory nobody can enter",
        code: "EACCES",
        make: (made) => {
          fs.mkdirSync(made.directory("closed-dir"));
          fs.writeFileSync(path.join(made.directory("closed-dir"), "identity.json"), `${JSON.stringify({ name: "closed-dir", allowAmbientCredential: false })}\n`);
          fs.chmodSync(made.directory("closed-dir"), NO_ACCESS);
          return ["closed-dir"];
        },
      },
      {
        case: "a target below a file",
        code: "ENOTDIR",
        make: (made, outside) => {
          fs.writeFileSync(path.join(outside, "a-file"), "");
          fs.symlinkSync(path.join(outside, "a-file", "child"), made.directory("below-a-file"));
          return ["below-a-file"];
        },
      },
    ];

    afterEach(() => {
      // A directory made unsearchable by a case could not be removed with the world.
      for (const closed of [path.join(elsewhere, "locked"), path.join(elsewhere, "closed"), world.directory("closed-dir")]) {
        if (fs.existsSync(closed)) {
          fs.chmodSync(closed, OWNER_ALL);
        }
      }
    });

    const root = process.getuid?.() === 0;

    it.skipIf(root).each(unreachable)("is left out of the listing, not thrown from it, for $case, and the other identities are listed", ({ make }) => {
      make(world, elsewhere);
      expect(listIdentities(world.paths).map((entry) => entry.name)).toEqual(["personal", "work"]);
    });

    it.skipIf(root).each(unreachable)("is reported by doctor as an entry it did not count, with the reason, for $case, and the rest of the report is produced", ({ code, make }) => {
      const names = make(world, elsewhere);
      const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
      for (const name of names) {
        const finding = report.findings.find((entry) => entry.section === "identity" && entry.subject === name);
        expect(finding?.severity).toBe("warn");
        expect(finding?.message).toContain(code);
        expect(finding?.message).toContain("not counted as an identity");
        expect(finding?.message).toContain("cannot be reached");
      }
      expect(report.findings.some((entry) => entry.section === "identity" && entry.subject === "work" && entry.severity === "pass")).toBe(true);
    });
  });
});
