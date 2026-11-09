import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renameIdentity } from "./identityRename";
import { addIdentity, identityIdOf } from "./identityStore";
import { resolveIdentityId } from "./launcher/identity";
import { buildLayoutPaths } from "./paths";
import { realIdentityRenamePorts } from "./realIdentityRename";
import { realFsPort } from "./realPorts";
import { MAX_NAME_BYTES } from "./config/names";
import { DuplicateIdentityNameError, duplicateIdentityNames, freeIdentityId, identityIdIn, identityNameIn, readIdentityRecords, textRecordsPort, type IdentityNameRead } from "./identityRecords";

const DIR = "/root/identities";

/** A system error as the filesystem throws one: a message and its code. */
class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const SUFFIX = "4242.0f8fad5b-d9cb-469f-a165-70867728950e";

/** A records port over a listing and the names each `identity.json` gives. */
function port(entries: readonly string[], names: Readonly<Record<string, IdentityNameRead>>, links: Readonly<Record<string, string>> = {}) {
  // `links` maps an entry to the entry it is a symlink to.
  const real = (file: string): string => links[file.slice(DIR.length + 1)] ?? file.slice(DIR.length + 1);
  return { readdir: () => entries, readName: (file: string) => names[file] ?? "absent", sameDirectory: (first: string, second: string) => real(first) === real(second), isSymlink: (entry: string) => entry.slice(DIR.length + 1) in links };
}

describe("readIdentityRecords", () => {
  it("takes each identity's name from its identity.json and its id from its directory, sorted by id", () => {
    const records = readIdentityRecords(port(["work", "personal"], { [`${DIR}/work/identity.json`]: { name: "client" }, [`${DIR}/personal/identity.json`]: { name: "personal" } }), DIR);
    expect(records).toEqual([
      { id: "personal", name: "personal" },
      { id: "work", name: "client" },
    ]);
  });

  it("leaves out an entry with no identity.json, and a scratch or lock entry", () => {
    expect(readIdentityRecords(port(["stray", ".work.lock", `.work.scratch.${SUFFIX}`, "work"], { [`${DIR}/work/identity.json`]: { name: "work" } }), DIR)).toEqual([{ id: "work", name: "work" }]);
  });

  it("gives an identity.json whose name cannot be read no name, so it claims none", () => {
    expect(readIdentityRecords(port(["work"], { [`${DIR}/work/identity.json`]: "unreadable" }), DIR)).toEqual([{ id: "work", name: undefined }]);
  });

  it("reads the record of an identity whose directory is missing from the superseded farm an interrupted resync left, the first in name order", () => {
    const later = "9.7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const records = readIdentityRecords(
      port([`.work.previous.${SUFFIX}`, `.work.previous.${later}`], { [`${DIR}/.work.previous.${SUFFIX}/identity.json`]: { name: "client" }, [`${DIR}/.work.previous.${later}/identity.json`]: { name: "other" } }),
      DIR,
    );
    expect(records).toEqual([{ id: "work", name: "client" }]);
  });

  it("ignores a superseded farm whose identity's directory is there, and reads an id that contains dots whole", () => {
    const records = readIdentityRecords(
      port(["work.previous.old", `.work.previous.old.previous.${SUFFIX}`, `.work.previous.${SUFFIX}`, "work"], {
        [`${DIR}/work.previous.old/identity.json`]: { name: "dotted" },
        [`${DIR}/.work.previous.old.previous.${SUFFIX}/identity.json`]: { name: "stale" },
        [`${DIR}/.work.previous.${SUFFIX}/identity.json`]: { name: "stale" },
        [`${DIR}/work/identity.json`]: { name: "work" },
      }),
      DIR,
    );
    expect(records).toEqual([
      { id: "work", name: "work" },
      { id: "work.previous.old", name: "dotted" },
    ]);
  });
});

describe("readIdentityRecords with an entry that is a symlink to another", () => {
  it("is one record, the entry that is the directory rather than the symlink, whatever the name, so the name it shares with its target is no duplicate", () => {
    const names = { [`${DIR}/alias/identity.json`]: { name: "alias" }, [`${DIR}/work/identity.json`]: { name: "alias" } };
    expect(readIdentityRecords(port(["alias", "work"], names, { alias: "work" }), DIR)).toEqual([{ id: "work", name: "alias" }]);
  });

  it("is one record when the identity.json both entries read cannot be read, the entry that is the directory, so the file is reported once", () => {
    const names = { [`${DIR}/bad/identity.json`]: "unreadable", [`${DIR}/badlink/identity.json`]: "unreadable" } as const;
    expect(readIdentityRecords(port(["bad", "badlink"], names, { badlink: "bad" }), DIR)).toEqual([{ id: "bad", name: undefined }]);
  });

  it("keeps two unreadable identity.json files in two directories that are not one as two records", () => {
    const names = { [`${DIR}/bad/identity.json`]: "unreadable", [`${DIR}/worse/identity.json`]: "unreadable" } as const;
    expect(readIdentityRecords(port(["bad", "worse"], names), DIR)).toEqual([{ id: "bad", name: undefined }, { id: "worse", name: undefined }]);
  });

  it("keeps two directories that are not one as a duplicate", () => {
    const names = { [`${DIR}/b-dir/identity.json`]: { name: "client" }, [`${DIR}/a-dir/identity.json`]: { name: "client" } };
    expect(readIdentityRecords(port(["b-dir", "a-dir"], names), DIR)).toHaveLength(2);
  });

  it("keeps the same entry over the real filesystem before and after a rename, even to the symlink's own name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-records-symlink-test-"));
    try {
      const paths = buildLayoutPaths(root);
      addIdentity(paths, "work");
      fs.symlinkSync(path.join(paths.identitiesDir, "work"), path.join(paths.identitiesDir, "alias"));
      expect(identityIdOf(paths, "work")).toBe("work");
      const ports = { ...realIdentityRenamePorts(paths), sessions: { sessionsOn: () => [] }, launches: { liveOn: () => [] } };
      await renameIdentity(paths, "work", "client", ports);
      expect(identityIdOf(paths, "client")).toBe("work");
      await renameIdentity(paths, "client", "alias", ports);
      expect(identityIdOf(paths, "alias")).toBe("work");
      expect(resolveIdentityId(paths.identitiesDir, "alias", realFsPort)).toBe("work");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("identityIdIn and identityNameIn", () => {
  const records = [
    { id: "personal", name: "personal" },
    { id: "work", name: "client" },
  ];

  it("resolves a name to its id and an id to its name, and an unknown one to nothing", () => {
    expect(identityIdIn(records, "client")).toBe("work");
    expect(identityIdIn(records, "work")).toBeUndefined();
    expect(identityNameIn(records, "work")).toBe("client");
    expect(identityNameIn(records, "client")).toBeUndefined();
  });

  it("reaches a record whose name cannot be read by its id only when no record claims that as a name", () => {
    const unreadable = { id: "client", name: undefined };
    expect(identityIdIn([unreadable], "client")).toBe("client");
    // After client was renamed to old and work to client, a corrupt identities/client/identity.json must not block the healthy client.
    expect(identityIdIn([unreadable, { id: "work", name: "client" }], "client")).toBe("work");
    expect(duplicateIdentityNames([unreadable, { id: "work", name: "client" }])).toEqual([]);
  });

  it("refuses a name two records claim, naming both directories", () => {
    const twice = [...records, { id: "work-2", name: "client" }];
    expect(() => identityIdIn(twice, "client")).toThrow(DuplicateIdentityNameError);
    // The words doctor uses for the same fault.
    expect(() => identityIdIn(twice, "client")).toThrow("is claimed by more than one identity (the directories identities/work, identities/work-2), so nothing that names it can be resolved. Rename all but one by its id:");
    expect(() => identityIdIn(twice, "client")).toThrow("identities/work, identities/work-2");
    expect(identityIdIn(twice, "personal")).toBe("personal");
    expect(duplicateIdentityNames(twice)).toEqual([{ name: "client", ids: ["work", "work-2"] }]);
  });
});

describe("freeIdentityId", () => {
  it("is the name itself when nothing is filed under it, and otherwise the first free numbered variant", () => {
    expect(freeIdentityId("work", () => false)).toBe("work");
    const taken = new Set(["work", "work-2"]);
    expect(freeIdentityId("work", (id) => taken.has(id))).toBe("work-3");
  });

  it("shortens the base so a variant of the longest name is still a valid file name", () => {
    const longest = "a".repeat(MAX_NAME_BYTES);
    const id = freeIdentityId(longest, (candidate) => candidate === longest);
    expect(id).toBe(`${"a".repeat(MAX_NAME_BYTES - 2)}-2`);
    expect(id).toHaveLength(MAX_NAME_BYTES);
  });
});

describe("textRecordsPort", () => {
  it("reads a plain file under the identities directory as no identity, and a file whose identity.json cannot be reached as unreadable", () => {
    const errorWith = (code: string): never => {
      throw new CodedError(code);
    };
    const notDirectory = textRecordsPort({ readdir: () => [], readFileUtf8: () => errorWith("ENOTDIR") });
    const denied = textRecordsPort({ readdir: () => [], readFileUtf8: () => errorWith("EACCES") });
    expect(notDirectory.readName(`${DIR}/file/identity.json`)).toBe("absent");
    expect(denied.readName(`${DIR}/locked/identity.json`)).toBe("unreadable");
    expect(textRecordsPort({ readdir: () => [], readFileUtf8: () => "{ not json" }).readName("x")).toBe("unreadable");
    expect(textRecordsPort({ readdir: () => [], readFileUtf8: () => '{"name":"work"}' }).readName("x")).toEqual({ name: "work" });
  });
});

describe("readIdentityRecords at the size of a large farm", () => {
  const IDENTITIES = 300;
  const ID_DIGITS = 5;
  /** The most passes over the identities the reading makes: the entries, the ones that name an identity, and the twin search. */
  const PASSES_ALLOWED = 5;
  const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `id${String(index).padStart(ID_DIGITS, "0")}`);

  it("does a number of callback visits that grows linearly with the identities, not with their square", () => {
    const entries = names(IDENTITIES);
    const files = Object.fromEntries(entries.map((entry) => [`${DIR}/${entry}/identity.json`, { name: `name-${entry}` }]));
    const original = Array.prototype.filter;
    let visits = 0;
    Array.prototype.filter = function (this: readonly unknown[], callback: (value: unknown, index: number, array: readonly unknown[]) => unknown, thisArg?: unknown): unknown[] {
      return original.call(this, (value: unknown, index: number, array: readonly unknown[]) => { visits += 1; return callback.call(thisArg, value, index, array); });
    } as typeof Array.prototype.filter;
    let records: readonly unknown[];
    try {
      records = readIdentityRecords(port(entries, files), DIR);
    } finally {
      Array.prototype.filter = original;
    }
    expect(records).toHaveLength(IDENTITIES);
    // A few passes over the identities, each visiting a record once; a pass for every record would visit IDENTITIES squared.
    expect(visits).toBeLessThan(IDENTITIES * PASSES_ALLOWED);
  });

  it("still compares the records that share a name, so a symlink twin is one identity", () => {
    const entries = ["work", "work-link", ...names(IDENTITIES)];
    const files = Object.fromEntries(entries.map((entry) => [`${DIR}/${entry}/identity.json`, { name: entry === "work-link" ? "work" : `name-${entry}` }]));
    files[`${DIR}/work/identity.json`] = { name: "work" };
    const records = readIdentityRecords(port(entries, files, { "work-link": "work" }), DIR);
    expect(records.filter((record) => record.name === "work")).toEqual([{ id: "work", name: "work" }]);
    expect(records).toHaveLength(IDENTITIES + 1);
  });
});
