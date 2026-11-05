import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport, runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";
import { addIdentity } from "./identityStore";
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
    { description: "move identities/work to identities/client", started: true, done: true },
    { description: "rewrite config.json: pool subs", started: false, done: false },
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
    expect(findingsFor(report, "identity")).toContainEqual({ section: "identity", subject: "work", severity: "fail", message: `There is ${describeUnfinishedRename(JOURNAL, { finishable: true })}` });
  });

  it("says an unfinished rename whose identity is under neither name cannot be finished, and names the flag that discards its record", () => {
    const report = runDoctor(baseParams({ identities: [identity("personal")], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    const finding = findingsFor(report, "identity").find((entry) => entry.subject === "work" && entry.severity === "fail");
    expect(finding?.message).toContain("cannot be finished: there is no identity under either name");
    expect(finding?.message).not.toContain("Finish it with");
    expect(finding?.message).toContain("agent-shim identity rename work client --move --discard-journal");
  });

  it("says the same when both names are identities", () => {
    const report = runDoctor(baseParams({ identities: [identity("work"), identity("client")], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    const finding = findingsFor(report, "identity").find((entry) => entry.subject === "work" && entry.severity === "fail");
    expect(finding?.message).toContain("cannot be finished: both names are identities");
    expect(finding?.message).not.toContain("Finish it with");
    expect(finding?.message).toContain("agent-shim identity rename work client --move --discard-journal");
  });

  it("counts a name as an identity only when it has an identity.json, as the rename does, so a directory without one is not a name that exists", () => {
    const withoutRecord = identity("work", { raw: undefined });
    const neither = runDoctor(baseParams({ identities: [withoutRecord], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    expect(findingsFor(neither, "identity").find((entry) => entry.subject === "work" && entry.severity === "fail" && entry.message.includes("--discard-journal"))?.message).toContain("there is no identity under either name");
    const oneOfTwo = runDoctor(baseParams({ identities: [identity("work"), identity("client", { raw: undefined })], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    expect(findingsFor(oneOfTwo, "identity").every((entry) => !entry.message.includes("--discard-journal"))).toBe(true);
  });

  it("does not offer to discard one that running the rename again finishes", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], renameJournals: { journals: [JOURNAL], unreadable: [] } }));
    expect(findingsFor(report, "identity").every((entry) => !entry.message.includes("--discard-journal"))).toBe(true);
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
    addIdentity(paths, "work");
    writeRenameJournal(realFarmFs, renameJournalFile(paths.identityRenamesDir, "work", "client"), JOURNAL);
    const report = collectDoctorReport({ paths, env: { PATH: "" } });
    expect(findingsFor(report, "identity")).toContainEqual({ section: "identity", subject: "work", severity: "fail", message: `There is ${describeUnfinishedRename(JOURNAL, { finishable: true })}` });
  });

  it("agrees with the rename about which names exist: an empty directory is not an identity, and one holding an identity.json is", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    writeRenameJournal(realFarmFs, renameJournalFile(paths.identityRenamesDir, "work", "client"), JOURNAL);
    const hint = (): string | undefined => findingsFor(collectDoctorReport({ paths, env: { PATH: "" } }), "identity").find((entry) => entry.subject === "work" && entry.message.includes("--discard-journal"))?.message;
    expect(hint()).toContain("there is no identity under either name");
    fs.mkdirSync(path.join(paths.identitiesDir, "client"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "client", "identity.json"), `${JSON.stringify({ name: "client", allowAmbientCredential: false })}\n`);
    expect(hint()).toBeUndefined();
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), `${JSON.stringify({ name: "work", allowAmbientCredential: false })}\n`);
    expect(hint()).toContain("both names are identities");
  });

  it("reports a journal whose steps lack the begun mark as one it cannot read, naming the field", () => {
    const paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
    fs.mkdirSync(paths.identityRenamesDir, { recursive: true });
    const file = renameJournalFile(paths.identityRenamesDir, "work", "client");
    fs.writeFileSync(file, JSON.stringify({ version: 1, from: "work", to: "client", startedAt: JOURNAL.startedAt, pid: JOURNAL.pid, steps: [{ description: "move identities/work to identities/client", done: true }] }));
    const report = collectDoctorReport({ paths, env: { PATH: "" } });
    const finding = findingsFor(report, "identity").find((entry) => entry.severity === "fail" && entry.subject === path.basename(file));
    expect(finding?.message).toContain("is not a rename journal this agent-shim can read");
    expect(finding?.message).toContain("steps.0.started");
  });

  it("reports a damaged journal instead of failing to produce a report", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.identityRenamesDir, { recursive: true });
    fs.writeFileSync(path.join(paths.identityRenamesDir, "damaged.json"), "{ not json");
    const report = collectDoctorReport({ paths, env: { PATH: "" } });
    expect(findingsFor(report, "identity").some((finding) => finding.severity === "fail" && finding.subject === "damaged.json")).toBe(true);
  });
});
