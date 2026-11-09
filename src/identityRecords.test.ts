import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renameIdentity } from "./identityRename";
import { addIdentity, identityIdOf } from "./identityStore";
import { resolveIdentityId } from "./launcher/identity";
import { buildLayoutPaths } from "./paths";
import { realIdentityRenamePorts } from "./realIdentityRename";
import { realFsPort } from "./realPorts";
import { MAX_NAME_BYTES } from "./config/names";
import { countSteps, growsLinearly } from "./test-helpers";
import { DuplicateIdentityNameError, duplicateIdentityNames, identityIdLookup, freeIdentityId, identityIdIn, identityNameIn, readIdentityRecords, textRecordsPort, type IdentityRecord, type IdentityNameRead } from "./identityRecords";

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
  return { readdir: () => entries, readName: (file: string) => names[file] ?? "absent", directoryKey: (file: string) => real(file), isSymlink: (entry: string) => entry.slice(DIR.length + 1) in links };
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
  const ID_DIGITS = 5;
  const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `id${String(index).padStart(ID_DIGITS, "0")}`);
  const SMALL = 10;
  const LARGE = 100;
  const LARGER = 200;

  it.each([
    ["identities with a readable name each", (index: number) => JSON.stringify({ name: `n${String(index)}` })],
    ["identities whose identity.json is not JSON, none of which has a name", () => "{ not json"],
    ["identities that all claim one name", () => JSON.stringify({ name: "same" })],
  ])("makes a number of directory reads that grows linearly with %s, not with their square", (_label, contentsOf) => {
    // `contentsOf` gives each identity's file; a fixed text is the same for all.
    const statsFor = (count: number): number => {
      let index = 0;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "records-linear-"));
      try {
        for (const name of names(count)) {
          fs.mkdirSync(path.join(root, name));
          fs.writeFileSync(path.join(root, name, "identity.json"), contentsOf(index));
          index += 1;
        }
        const spy = vi.spyOn(fs, "statSync");
        try {
          readIdentityRecords(textRecordsPort({ readdir: (directory) => fs.readdirSync(directory), readFileUtf8: (file) => fs.readFileSync(file, "utf8") }), root);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    const perRecord = statsFor(SMALL) / SMALL;
    expect(statsFor(LARGE)).toBeLessThanOrEqual(perRecord * LARGE);
    expect(statsFor(LARGER)).toBeLessThanOrEqual(perRecord * LARGER);
  });

  it("still takes a symlink twin for one identity, with or without a readable name", () => {
    const entries = ["work", "work-link", "other"];
    const files = { [`${DIR}/work/identity.json`]: { name: "work" }, [`${DIR}/work-link/identity.json`]: { name: "work" }, [`${DIR}/other/identity.json`]: { name: "other" } } as const;
    expect(readIdentityRecords(port(entries, files, { "work-link": "work" }), DIR).map((record) => record.id)).toEqual(["other", "work"]);
    const nameless: Record<string, IdentityNameRead> = { [`${DIR}/a/identity.json`]: "unreadable", [`${DIR}/a-link/identity.json`]: "unreadable", [`${DIR}/b/identity.json`]: "unreadable" };
    expect(readIdentityRecords(port(["a", "a-link", "b"], nameless, { "a-link": "a" }), DIR).map((record) => record.id)).toEqual(["a", "b"]);
  });
});

describe("symlink twins at the size of a large farm", () => {
  const SMALL_TWINS = 10;
  const MEDIUM_TWINS = 100;
  const LARGE_TWINS = 200;
  const SIZES = [SMALL_TWINS, MEDIUM_TWINS, LARGE_TWINS] as const;
  const TOLERANCE = 1.5;
  const INDEX_DIGITS = 5;

  /** The `lstatSync` calls reading an identities directory holding `count` symlinks to one real directory, which sorts last in the directory or lies outside it. */
  function lstatsReading(count: number, layout: "real-sorts-last" | "real-outside"): number {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "records-twins-"));
    try {
      const identities = path.join(root, "identities");
      const real = layout === "real-outside" ? path.join(root, "elsewhere") : path.join(identities, "zzz");
      fs.mkdirSync(identities, { recursive: true });
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "identity.json"), JSON.stringify({ name: "shared" }));
      for (let index = 0; index < count; index += 1) {
        fs.symlinkSync(real, path.join(identities, `a${String(index).padStart(INDEX_DIGITS, "0")}`));
      }
      const spy = vi.spyOn(fs, "lstatSync");
      try {
        const records = readIdentityRecords(textRecordsPort({ readdir: (directory) => fs.readdirSync(directory), readFileUtf8: (file) => fs.readFileSync(file, "utf8") }), identities);
        expect(records.filter((record) => record.name === "shared")).toHaveLength(1);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it.each(["real-sorts-last", "real-outside"] as const)("makes a number of symlink checks that grows linearly with the twins when the real directory is %s", (layout) => {
    const counts = SIZES.map((size) => lstatsReading(size, layout));
    expect(growsLinearly(SIZES, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0], TOLERANCE), `lstat counts ${counts.join(", ")}`).toBe(true);
  });
});

describe("duplicateIdentityNames and identityIdLookup at the size of a large farm", () => {
  const FIRST_SIZE = 100;
  const SECOND_SIZE = 200;
  const THIRD_SIZE = 400;
  const SIZES = [FIRST_SIZE, SECOND_SIZE, THIRD_SIZE] as const;
  const TOLERANCE = 1.5;
  const sameNamed = (count: number): IdentityRecord[] => Array.from({ length: count }, (_, index) => ({ id: `id${String(index)}`, name: "same" }));

  it("finds the names several records claim in steps that grow linearly with the records", () => {
    const counts = SIZES.map((size) => countSteps(() => { expect(duplicateIdentityNames(sameNamed(size))).toHaveLength(1); }));
    expect(growsLinearly(SIZES, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0], TOLERANCE), `steps ${counts.join(", ")}`).toBe(true);
  });

  it("answers a lookup for each of many names in steps that grow linearly with the identities", () => {
    const distinct = (count: number): IdentityRecord[] => Array.from({ length: count }, (_, index) => ({ id: `id${String(index)}`, name: `n${String(index)}` }));
    const counts = SIZES.map((size) => countSteps(() => {
      const records = distinct(size);
      const lookup = identityIdLookup(records);
      for (const record of records) {
        expect(lookup(record.name ?? "")).toBe(record.id);
      }
    }));
    expect(growsLinearly(SIZES, [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0], TOLERANCE), `steps ${counts.join(", ")}`).toBe(true);
  });

  it("applies the same rules as identityIdIn: a duplicated name throws, a nameless record is reached by its id", () => {
    const records: IdentityRecord[] = [{ id: "a", name: "dup" }, { id: "b", name: "dup" }, { id: "c", name: undefined }, { id: "d", name: "solo" }];
    const lookup = identityIdLookup(records);
    expect(() => lookup("dup")).toThrow(DuplicateIdentityNameError);
    expect(lookup("c")).toBe("c");
    expect(lookup("solo")).toBe("d");
    expect(lookup("missing")).toBeUndefined();
    expect(identityIdIn(records, "solo")).toBe("d");
  });
});
