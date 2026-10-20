import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnsafeNameError } from "./config/names";
import { createProfile, listProfiles, profileExists, readProfile, removeProfile, requireProfileExists } from "./configProfilesStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

describe("the names the configuration profile store will join into a path", () => {
  let home: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profiles-names-")));
    paths = buildLayoutPaths(path.join(home, ".agent-shim"));
    fs.mkdirSync(paths.configProfilesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(["../outside", "../../outside", "a/b", "", ".."])("refuses %j everywhere a name is turned into a file, and touches nothing outside the directory", (name) => {
    const outside = path.join(paths.configProfilesDir, "..", "outside.json");
    fs.writeFileSync(outside, "{}");
    expect(() => profileExists(paths, name)).toThrow(UnsafeNameError);
    expect(() => readProfile(paths, name)).toThrow(UnsafeNameError);
    expect(() => {
      requireProfileExists(paths, name);
    }).toThrow(UnsafeNameError);
    expect(() => createProfile(paths, name)).toThrow(UnsafeNameError);
    expect(() => {
      removeProfile(paths, name);
    }).toThrow(UnsafeNameError);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readdirSync(paths.configProfilesDir)).toEqual([]);
  });

  it("creates a profile only under the shape new names are given", () => {
    expect(() => createProfile(paths, "my profile")).toThrow(UnsafeNameError);
    expect(() => createProfile(paths, "_old")).toThrow(UnsafeNameError);
    expect(createProfile(paths, "client-base").extends).toBeUndefined();
    expect(profileExists(paths, "client-base")).toBe(true);
  });

  it("still lists, reads and removes a profile stored under an older, looser name, so one stray file never aborts a command", () => {
    fs.writeFileSync(path.join(paths.configProfilesDir, "my profile.json"), JSON.stringify({}));
    fs.writeFileSync(path.join(paths.configProfilesDir, "_old.json"), JSON.stringify({}));
    fs.writeFileSync(path.join(paths.configProfilesDir, "client-base.json"), JSON.stringify({}));
    expect(listProfiles(paths).map((entry) => entry.name)).toEqual(["_old", "client-base", "my profile"]);
    expect(readProfile(paths, "my profile")).toEqual({});
    removeProfile(paths, "my profile");
    removeProfile(paths, "_old");
    expect(fs.readdirSync(paths.configProfilesDir)).toEqual(["client-base.json"]);
  });

  it("skips a file whose name cannot be used, and says so, instead of aborting the listing", () => {
    fs.writeFileSync(path.join(paths.configProfilesDir, ".json"), JSON.stringify({}));
    fs.writeFileSync(path.join(paths.configProfilesDir, "ok.json"), JSON.stringify({}));
    const skipped: string[] = [];
    expect(listProfiles(paths, (name, message) => {
      skipped.push(`${JSON.stringify(name)}: ${message}`);
    }).map((entry) => entry.name)).toEqual(["ok"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('""');
  });
});
