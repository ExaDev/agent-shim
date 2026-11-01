import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport, runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";
import { describeUnfinishedRename, renameJournalFile, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { buildLayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";

const JOURNAL: RenameJournal = {
  version: 1,
  from: "work",
  to: "client",
  startedAt: "2026-10-30T12:00:00.000Z",
  pid: 4242,
  steps: [
    { description: "move identities/work to identities/client", done: true },
    { description: "rewrite config.json: pool subs", done: false },
  ],
};

describe("doctor and an unfinished rename", () => {
  it("says nothing about renames when none was left unfinished", () => {
    const withNone = runDoctor(baseParams({ identities: [identity("work")], renameJournals: { journals: [], unreadable: [] } }));
    const without = runDoctor(baseParams({ identities: [identity("work")] }));
    expect(findingsFor(withNone, "identity")).toEqual(findingsFor(without, "identity"));
  });

  it("fails for each one, naming the identity it moved from and the command that finishes it", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    expect(findingsFor(report, "identity")).toContainEqual({ section: "identity", subject: "work", severity: "fail", message: `There is ${describeUnfinishedRename(JOURNAL)}` });
  });

  it("fails for a file in the journals directory that is not a journal, naming it and saying it blocks every rename", () => {
    const report = runDoctor(baseParams({ renameJournals: { journals: [], unreadable: [{ file: "/home/u/.agent-shim/identity-renames/damaged.json", detail: "not valid JSON" }] } }));
    const [finding] = findingsFor(report, "identity");
    expect(finding).toMatchObject({ section: "identity", severity: "fail", subject: "damaged.json" });
    expect(finding?.message).toContain("/home/u/.agent-shim/identity-renames/damaged.json");
    expect(finding?.message).toContain("not valid JSON");
    expect(finding?.message).toContain("no identity can be renamed");
  });
});

describe("collectDoctorReport and an unfinished rename", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-rename-journal-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the journals the state root holds", () => {
    const paths = buildLayoutPaths(root);
    writeRenameJournal(realFarmFs, renameJournalFile(paths.identityRenamesDir, "work", "client"), JOURNAL);
    const report = collectDoctorReport({ paths, env: { PATH: "" } });
    expect(findingsFor(report, "identity")).toContainEqual({ section: "identity", subject: "work", severity: "fail", message: `There is ${describeUnfinishedRename(JOURNAL)}` });
  });

  it("reports a damaged journal instead of failing to produce a report", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.identityRenamesDir, { recursive: true });
    fs.writeFileSync(path.join(paths.identityRenamesDir, "damaged.json"), "{ not json");
    const report = collectDoctorReport({ paths, env: { PATH: "" } });
    expect(findingsFor(report, "identity").some((finding) => finding.severity === "fail" && finding.subject === "damaged.json")).toBe(true);
  });
});
