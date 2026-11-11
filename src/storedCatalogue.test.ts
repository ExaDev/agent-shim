import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "./paths";
import { catalogueBindingPath, catalogueCachePath, catalogueSettingsPath } from "./providerCatalogue";
import { StoredCatalogue, TolerantReader, UnreadableCatalogueError, catalogueFailureFile, catalogueReadFault, catalogueStatusFile, raiseUnreadableCatalogue, skipUnreadableCatalogue } from "./storedCatalogue";
import { errorWithCode } from "./test-helpers";

const LONGER_THAN_ANY_CODE = 33;
const NOT_A_STRING = 13;
const SECRET_PATH = "/home/someone/.agent-shim/catalogues/p.json";
const withCode = (code: unknown): Error => errorWithCode(`failed at ${SECRET_PATH}`, code);
const GENERATION = "10000000-0000-4000-8000-000000000001";
const OWNER = { pid: 4242, generation: GENERATION };
const paths = buildLayoutPaths("/home/user/.agent-shim");

describe("the fault a stored file's failed read is reported as", () => {
  it.each([
    ["a system error's code", withCode("EACCES"), "EACCES"],
    ["a code with digits and underscores", withCode("ERR_FS_9"), "ERR_FS_9"],
    ["a code that is lower case, which no system error has", withCode(`denied at ${SECRET_PATH}`), "Error"],
    ["a code longer than any system error's", withCode("E".repeat(LONGER_THAN_ANY_CODE)), "Error"],
    ["a code that is no string", withCode(NOT_A_STRING), "Error"],
    ["an error with no code, by its class", new TypeError(`bad ${SECRET_PATH}`), "TypeError"],
    ["a value that is no error", SECRET_PATH, "an error"],
    ["a fault an earlier read already named", new UnreadableCatalogueError("ELOOP"), "ELOOP"],
  ])("is, for %s, %s", (_label, error, fault) => {
    expect(catalogueReadFault(error)).toBe(fault);
  });

  it("carries the fault and no path in the error a caller raises", () => {
    const error = new UnreadableCatalogueError("EISDIR");
    expect(error.message).toBe("stored catalogue cannot be read (EISDIR)");
    expect(error.fault).toBe("EISDIR");
    expect(() => {
      raiseUnreadableCatalogue("EACCES");
    }).toThrow(UnreadableCatalogueError);
    skipUnreadableCatalogue();
  });
});

describe("a TolerantReader", () => {
  const failing = (): string => {
    throw withCode("EACCES");
  };

  it("tells the caller the fault and reads the file as absent, and a file that is merely absent is no fault", () => {
    const told: string[] = [];
    const note = (fault: string): void => {
      told.push(fault);
    };
    expect(new TolerantReader(failing, note).read("file")).toBeUndefined();
    expect(told).toEqual(["EACCES"]);
    expect(new TolerantReader(() => undefined, note).read("file")).toBeUndefined();
    expect(new TolerantReader(() => "text", note).read("file")).toBe("text");
    expect(told).toEqual(["EACCES"]);
  });

  it("lets the caller's policy throw, which no other provider's read sees", () => {
    expect(() => new TolerantReader(failing, raiseUnreadableCatalogue).read("file")).toThrow(UnreadableCatalogueError);
  });

  it("reports a failed stat as a failed read, and takes a stat that works as it is", () => {
    const told: string[] = [];
    const reader = new TolerantReader(() => undefined, (fault) => {
      told.push(fault);
    });
    expect(reader.attempt(failing)).toBeUndefined();
    expect(reader.attempt(() => "r1")).toBe("r1");
    expect(told).toEqual(["EACCES"]);
  });
});

describe("a provider's stored catalogue state", () => {
  /** A store whose every read answers the path it was asked for. */
  const store = new StoredCatalogue(paths, new TolerantReader((file) => file, skipUnreadableCatalogue));

  it("is read from the file each kind of state is kept in: an http provider's shared, a codex provider's in its supervisor generation", () => {
    expect(store.cacheText("spark")).toBe(catalogueCachePath(paths, "spark"));
    expect(store.cacheText("codex", OWNER)).toBe(catalogueCachePath(paths, "codex", OWNER.pid, OWNER.generation));
    expect(store.digestText("spark")).toBe(catalogueSettingsPath(paths, "spark"));
    expect(store.bindingText("spark")).toBe(catalogueBindingPath(paths, "spark"));
    expect(store.bindingText("codex", OWNER)).toBe(catalogueBindingPath(paths, "codex", OWNER.pid, OWNER.generation));
    expect(store.statusText(OWNER, "spark")).toBe(catalogueStatusFile(paths, OWNER, "spark"));
    expect(store.failureText(OWNER, "spark")).toBe(catalogueFailureFile(paths, OWNER, "spark"));
  });

  it("keeps a failure record out of the namespace of any provider's status or catalogue file", () => {
    expect(catalogueFailureFile(paths, OWNER, "foo.failure")).not.toBe(catalogueCachePath(paths, "foo.failure", OWNER.pid, OWNER.generation));
    expect(catalogueFailureFile(paths, OWNER, "foo")).not.toBe(catalogueStatusFile(paths, OWNER, "foo"));
  });

  it("names the revision of the catalogue and its digest together, and none when either cannot be named", () => {
    const revisionOf = (file: string): string | undefined => (file === catalogueCachePath(paths, "spark") ? "c1" : file === catalogueSettingsPath(paths, "spark") ? "d1" : undefined);
    expect(store.revision("spark", revisionOf)).toBe("c1\u0000d1");
    expect(store.revision("other", revisionOf)).toBeUndefined();
    expect(store.revision("spark", (file) => (file === catalogueSettingsPath(paths, "spark") ? undefined : "c1"))).toBeUndefined();
  });

  it("reports a revision that cannot be taken as a failed read, with no revision", () => {
    const told: string[] = [];
    const reporting = new StoredCatalogue(paths, new TolerantReader(() => undefined, (fault) => {
      told.push(fault);
    }));
    expect(reporting.revision("spark", () => {
      throw withCode("ELOOP");
    })).toBeUndefined();
    expect(told).toContain("ELOOP");
  });
});
