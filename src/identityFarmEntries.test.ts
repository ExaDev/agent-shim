import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addIdentity, identityExists, identityFarmEntries, removeIdentity, renamedFarmEntry } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

/** The shape of the suffix a resync gives its scratch and superseded farms: the launcher's process id, then a UUID. */
const SUFFIX_ONE = "4242.0f8fad5b-d9cb-469f-a165-70867728950e";
const SUFFIX_TWO = "17.7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("an identity's farm entries", () => {
  let root: string;
  let paths: LayoutPaths;

  const touch = (entry: string): void => {
    fs.mkdirSync(path.join(paths.identitiesDir, entry), { recursive: true });
  };
  const entries = (): string[] => fs.readdirSync(paths.identitiesDir).sort();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-farm-entries-test-"));
    paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
    addIdentity(paths, "work.previous.old");
    touch(`.work.previous.${SUFFIX_ONE}`);
    touch(`.work.scratch.${SUFFIX_TWO}`);
    touch(`.work.previous.old.previous.${SUFFIX_ONE}`);
    touch(`.work.previous.old.scratch.${SUFFIX_TWO}`);
    fs.writeFileSync(path.join(paths.identitiesDir, ".work.lock"), "{}");
    fs.writeFileSync(path.join(paths.identitiesDir, ".work.previous.old.lock"), "{}");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("are the identity's directory and its own scratch and superseded farms, and no other identity's whose name starts the same way", () => {
    expect(identityFarmEntries(paths, "work")).toEqual([`.work.previous.${SUFFIX_ONE}`, `.work.scratch.${SUFFIX_TWO}`, "work"]);
    expect(identityFarmEntries(paths, "work.previous.old")).toEqual([`.work.previous.old.previous.${SUFFIX_ONE}`, `.work.previous.old.scratch.${SUFFIX_TWO}`, "work.previous.old"]);
  });

  it("do not include a directory that only looks like one, whose process id or UUID is not what a resync writes", () => {
    touch(".work.previous.crashed");
    touch(".work.previous.12.not-a-uuid");
    touch(`.work.previous.${SUFFIX_ONE}.extra`);
    touch(`.work-other.previous.${SUFFIX_ONE}`);
    expect(identityFarmEntries(paths, "work")).toEqual([`.work.previous.${SUFFIX_ONE}`, `.work.scratch.${SUFFIX_TWO}`, "work"]);
  });

  it("are renamed to the new identity's, keeping the suffix", () => {
    expect(renamedFarmEntry("work", "work", "client")).toBe("client");
    expect(renamedFarmEntry(`.work.previous.${SUFFIX_ONE}`, "work", "client")).toBe(`.client.previous.${SUFFIX_ONE}`);
    expect(renamedFarmEntry(`.work.scratch.${SUFFIX_TWO}`, "work", "a.b")).toBe(`.a.b.scratch.${SUFFIX_TWO}`);
  });

  it("are all that identity remove deletes of an identity, with its lock, leaving another identity whose name starts the same way untouched", () => {
    removeIdentity(paths, "work");
    expect(identityExists(paths, "work")).toBe(false);
    expect(entries()).toEqual([`.work.previous.old.lock`, `.work.previous.old.previous.${SUFFIX_ONE}`, `.work.previous.old.scratch.${SUFFIX_TWO}`, "work.previous.old"]);
    expect(identityExists(paths, "work.previous.old")).toBe(true);
  });

  it("are all that identity remove deletes of the longer-named identity too, leaving the shorter one untouched", () => {
    removeIdentity(paths, "work.previous.old");
    expect(entries()).toEqual([".work.lock", `.work.previous.${SUFFIX_ONE}`, `.work.scratch.${SUFFIX_TWO}`, "work"]);
  });
});
