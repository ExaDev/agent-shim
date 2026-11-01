import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeUnfinishedRename, readRenameJournal, readRenameJournals, removeRenameJournal, renameJournalFile, unfinishedRenameFor, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { createFakeFarmFs } from "./test-helpers";

const DIR = "/home/testuser/.agent-shim/identity-renames";
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIRECTORY = 0o700;

const JOURNAL: RenameJournal = {
  version: 1,
  from: "work",
  to: "client",
  startedAt: "2026-10-30T12:00:00.000Z",
  pid: 4242,
  steps: [
    { description: "copy the Keychain login", done: true },
    { description: "move identities/work to identities/client", done: true },
    { description: "rewrite config.json: pool subs", done: false },
  ],
};

describe("renameJournalFile", () => {
  it("is one file per pair, in the directory, that does not depend on how the names run together", () => {
    expect(renameJournalFile(DIR, "work", "client")).toBe(renameJournalFile(DIR, "work", "client"));
    expect(renameJournalFile(DIR, "work", "client").startsWith(`${DIR}/`)).toBe(true);
    expect(renameJournalFile(DIR, "work", "client")).not.toBe(renameJournalFile(DIR, "client", "work"));
    expect(renameJournalFile(DIR, "a.to.b", "c")).not.toBe(renameJournalFile(DIR, "a", "b.to.c"));
  });
});

describe("the rename journal", () => {
  it("is absent until a rename writes it, and reads back exactly what was written, owner-only, with its directory", () => {
    const fs = createFakeFarmFs();
    const file = renameJournalFile(DIR, "work", "client");
    expect(readRenameJournal(fs, file)).toBeUndefined();
    writeRenameJournal(fs, file, JOURNAL);
    expect(readRenameJournal(fs, file)).toEqual(JOURNAL);
    expect(fs.modeOf(file)).toBe(OWNER_ONLY_FILE);
    expect(fs.modeOf(DIR)).toBe(OWNER_ONLY_DIRECTORY);
  });

  it("is removed when the rename is over, and removing it twice is fine", () => {
    const fs = createFakeFarmFs();
    const file = renameJournalFile(DIR, "work", "client");
    writeRenameJournal(fs, file, JOURNAL);
    removeRenameJournal(fs, file);
    removeRenameJournal(fs, file);
    expect(readRenameJournal(fs, file)).toBeUndefined();
  });

  it("refuses a file that is there but is not a journal, saying where it is, since a damaged journal cannot say what was left half done", () => {
    for (const damaged of ["{ not json", JSON.stringify({ version: 2 }), JSON.stringify({ ...JOURNAL, steps: "none" })]) {
      const fs = createFakeFarmFs({ [`${DIR}/damaged.json`]: damaged });
      expect(() => readRenameJournals(fs, DIR)).toThrow(CliError);
      expect(() => readRenameJournals(fs, DIR)).toThrow(`${DIR}/damaged.json`);
    }
  });
});

describe("readRenameJournals", () => {
  it("reads every journal in the directory, none when there is no directory, and passes over a file that is not a .json", () => {
    const fs = createFakeFarmFs();
    expect(readRenameJournals(fs, DIR)).toEqual([]);
    writeRenameJournal(fs, renameJournalFile(DIR, "work", "client"), JOURNAL);
    writeRenameJournal(fs, renameJournalFile(DIR, "a", "b"), { ...JOURNAL, from: "a", to: "b" });
    fs.seed({ [`${DIR}/notes.txt`]: "not a journal" });
    expect(readRenameJournals(fs, DIR).map((journal) => `${journal.from}>${journal.to}`).sort()).toEqual(["a>b", "work>client"]);
  });
});

describe("unfinishedRenameFor", () => {
  const journals = [JOURNAL];

  it("resumes a journal of the same rename", () => {
    expect(unfinishedRenameFor(journals, "work", "client")).toEqual({ kind: "resume", journal: JOURNAL });
  });

  it("blocks the reverse direction, and either name paired with another, because the identities are partly moved", () => {
    expect(unfinishedRenameFor(journals, "client", "work")).toEqual({ kind: "blocked", journal: JOURNAL });
    expect(unfinishedRenameFor(journals, "work", "other")).toEqual({ kind: "blocked", journal: JOURNAL });
    expect(unfinishedRenameFor(journals, "other", "client")).toEqual({ kind: "blocked", journal: JOURNAL });
    expect(unfinishedRenameFor(journals, "client", "other")).toEqual({ kind: "blocked", journal: JOURNAL });
  });

  it("leaves a rename of two other identities alone", () => {
    expect(unfinishedRenameFor(journals, "personal", "home")).toBeUndefined();
    expect(unfinishedRenameFor([], "work", "client")).toBeUndefined();
  });
});

describe("describeUnfinishedRename", () => {
  it("names the pair, how far it got and the command that finishes it, and how to put the name back afterwards", () => {
    expect(describeUnfinishedRename(JOURNAL)).toBe(
      'an unfinished rename of identity "work" to "client" (2 of 3 steps recorded as done). Finish it with `agent-shim identity rename work client`; to put the name back afterwards, run `agent-shim identity rename client work`.',
    );
  });
});
