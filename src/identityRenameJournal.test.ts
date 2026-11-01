import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeUnfinishedRename, finishabilityOf, readRenameJournal, readRenameJournals, removeRenameJournal, renameJournalFile, requireNameFreeOfUnfinishedRename, unfinishedRenameFor, writeRenameJournal, type RenameJournal } from "./identityRenameJournal";
import { createFakeFarmFs } from "./test-helpers";

const DIR = "/home/testuser/.agent-shim/identity-renames";

/** The state a rename that can be finished is in. */
const FINISHABLE = { finishable: true } as const;

/** Which names are identities when only the old name is: a rename a run of the same command finishes. */
const onlyOldName = (name: string): boolean => name === "work";
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
    expect(describeUnfinishedRename(JOURNAL, FINISHABLE)).toBe(
      'an unfinished rename of identity "work" to "client" (2 of 3 steps recorded as done). Finish it with `agent-shim identity rename work client`; to put the name back afterwards, run `agent-shim identity rename client work`.',
    );
  });
});

describe("finishabilityOf and an unfinishable rename", () => {
  it("is finishable when the identity is under exactly one of the two names", () => {
    expect(finishabilityOf(JOURNAL, onlyOldName)).toEqual(FINISHABLE);
    expect(finishabilityOf(JOURNAL, (name) => name === "client")).toEqual(FINISHABLE);
  });

  it("is not when it is under neither name or under both, and says which", () => {
    expect(finishabilityOf(JOURNAL, () => false)).toEqual({ finishable: false, reason: "there is no identity under either name" });
    expect(finishabilityOf(JOURNAL, () => true)).toEqual({ finishable: false, reason: "both names are identities" });
  });

  it("is described without the command that finishes it, which would fail, and with the one that discards its record", () => {
    const described = describeUnfinishedRename(JOURNAL, finishabilityOf(JOURNAL, () => false));
    expect(described).toContain("cannot be finished: there is no identity under either name");
    expect(described).toContain("agent-shim identity rename work client --discard-journal");
    expect(described).not.toContain("Finish it with");
    expect(described).not.toContain("put the name back");
  });

  it("is described without the discarding command when it can be finished", () => {
    const described = describeUnfinishedRename(JOURNAL, FINISHABLE);
    expect(described).toContain("Finish it with `agent-shim identity rename work client`");
    expect(described).not.toContain("--discard-journal");
    expect(described).not.toContain("cannot be finished");
  });
});

describe("requireNameFreeOfUnfinishedRename", () => {
  /** What a filesystem that ignores case says of two names. */
  const foldsCase = (first: string, second: string): boolean => first.toLowerCase() === second.toLowerCase();
  const never = (): boolean => false;
  const seeded = (journal: RenameJournal) => {
    const fs = createFakeFarmFs();
    writeRenameJournal(fs, renameJournalFile(DIR, journal.from, journal.to), journal);
    return fs;
  };

  it("refuses either name of an unfinished rename, naming the command that finishes it", () => {
    const fs = seeded(JOURNAL);
    expect(() => {
      requireNameFreeOfUnfinishedRename(fs, DIR, "work", "remove", never, onlyOldName);
    }).toThrow(describeUnfinishedRename(JOURNAL, FINISHABLE));
    expect(() => {
      requireNameFreeOfUnfinishedRename(fs, DIR, "client", "add", never, onlyOldName);
    }).toThrow(/Cannot add identity "client"/);
  });

  it("names the command that discards the record, not one that finishes the rename, when nothing can finish it", () => {
    const refusal = (() => {
      try {
        requireNameFreeOfUnfinishedRename(seeded(JOURNAL), DIR, "work", "remove", never, () => false);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    })();
    expect(refusal).toContain("agent-shim identity rename work client --discard-journal");
    expect(refusal).not.toContain("Finish it with");
  });

  it("leaves a name the rename does not hold alone", () => {
    expect(() => {
      requireNameFreeOfUnfinishedRename(seeded(JOURNAL), DIR, "personal", "add", never, onlyOldName);
    }).not.toThrow();
  });

  it("refuses a name that is another spelling of either one when the names are told to be the same directory, as a case-insensitive filesystem does", () => {
    const renamingFromUpper = seeded({ ...JOURNAL, from: "Work" });
    expect(() => {
      requireNameFreeOfUnfinishedRename(renamingFromUpper, DIR, "work", "remove", foldsCase, onlyOldName);
    }).toThrow(/Cannot remove identity "work"/);
    const renamingToLower = seeded({ ...JOURNAL, from: "a", to: "b" });
    expect(() => {
      requireNameFreeOfUnfinishedRename(renamingToLower, DIR, "B", "add", foldsCase, onlyOldName);
    }).toThrow(/Cannot add identity "B"/);
  });

  it("does not take another spelling for the same name when the filesystem tells them apart", () => {
    expect(() => {
      requireNameFreeOfUnfinishedRename(seeded({ ...JOURNAL, from: "a", to: "b" }), DIR, "B", "add", never, onlyOldName);
    }).not.toThrow();
  });
});
