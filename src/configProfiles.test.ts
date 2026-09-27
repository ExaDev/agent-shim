import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config/load";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import {
  InvalidCategoryNameError,
  ProfileAlreadyExistsError,
  ProfileNotFoundError,
  createProfile,
  listProfiles,
  readGlobalConfig,
  readProfile,
  setGlobalDefaultProfile,
  setProfileCategories,
  setProfileEntries,
  setProfileLaunchFlags,
} from "./configProfiles";

describe("configProfiles", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "config-profiles-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("createProfile", () => {
    it("creates an empty profile with no extends by default", () => {
      const profile = createProfile(paths, "base");
      expect(profile).toEqual({});
      expect(readProfile(paths, "base")).toEqual({});
    });

    it("creates a profile that extends others", () => {
      createProfile(paths, "base");
      const profile = createProfile(paths, "work", ["base"]);
      expect(profile.extends).toEqual(["base"]);
    });

    it("throws ProfileAlreadyExistsError when the profile already exists", () => {
      createProfile(paths, "base");
      expect(() => createProfile(paths, "base")).toThrow(ProfileAlreadyExistsError);
    });

    it("throws ConfigValidationError, not a raw ZodError, for an extends list containing an empty name (e.g. from a stray `,,` in --extends)", () => {
      expect(() => createProfile(paths, "work", ["base", "", "other"])).toThrow(ConfigValidationError);
    });
  });

  describe("readProfile", () => {
    it("returns undefined for a profile that does not exist", () => {
      expect(readProfile(paths, "nope")).toBeUndefined();
    });

    it("throws ConfigValidationError for a malformed profile file", () => {
      fs.mkdirSync(paths.configProfilesDir, { recursive: true });
      fs.writeFileSync(path.join(paths.configProfilesDir, "broken.json"), JSON.stringify({ categories: { secret: true } }));
      expect(() => readProfile(paths, "broken")).toThrow(ConfigValidationError);
    });
  });

  describe("listProfiles", () => {
    it("returns an empty list when no profiles exist", () => {
      expect(listProfiles(paths)).toEqual([]);
    });

    it("lists every profile sorted by name", () => {
      createProfile(paths, "work");
      createProfile(paths, "base");
      const entries = listProfiles(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["base", "work"]);
    });
  });

  describe("setGlobalDefaultProfile / readGlobalConfig", () => {
    it("creates the global config file on first use", () => {
      expect(readGlobalConfig(paths)).toBeUndefined();
      setGlobalDefaultProfile(paths, "base");
      expect(readGlobalConfig(paths)).toEqual({ defaultConfigProfile: "base" });
    });

    it("overwrites a previously set default", () => {
      setGlobalDefaultProfile(paths, "base");
      setGlobalDefaultProfile(paths, "work");
      expect(readGlobalConfig(paths)?.defaultConfigProfile).toBe("work");
    });
  });

  describe("setProfileCategories", () => {
    it("merges a category patch into an empty profile", () => {
      createProfile(paths, "base");
      const updated = setProfileCategories(paths, "base", { history: false, knowledge: true });
      expect(updated.categories).toEqual({ history: false, knowledge: true });
    });

    it("merges a second patch over the first, preserving untouched categories", () => {
      createProfile(paths, "base");
      setProfileCategories(paths, "base", { history: false, knowledge: true });
      const updated = setProfileCategories(paths, "base", { settings: false });
      expect(updated.categories).toEqual({ history: false, knowledge: true, settings: false });
    });

    it("overwrites a single category's own value on a later call", () => {
      createProfile(paths, "base");
      setProfileCategories(paths, "base", { history: true });
      const updated = setProfileCategories(paths, "base", { history: false });
      expect(updated.categories).toEqual({ history: false });
    });

    it("throws ProfileNotFoundError for a profile that does not exist", () => {
      expect(() => setProfileCategories(paths, "ghost", { history: true })).toThrow(ProfileNotFoundError);
    });

    it("throws InvalidCategoryNameError for 'secret'", () => {
      createProfile(paths, "base");
      expect(() => setProfileCategories(paths, "base", { secret: true })).toThrow(InvalidCategoryNameError);
    });

    it("throws InvalidCategoryNameError for an unrecognised category name", () => {
      createProfile(paths, "base");
      expect(() => setProfileCategories(paths, "base", { bogus: true })).toThrow(InvalidCategoryNameError);
    });

    it("never writes anything when validation fails", () => {
      createProfile(paths, "base");
      expect(() => setProfileCategories(paths, "base", { secret: true })).toThrow();
      expect(readProfile(paths, "base")).toEqual({});
    });

    it("expands all=true into every overridable category via --category", () => {
      createProfile(paths, "base");
      const updated = setProfileCategories(paths, "base", { all: true });
      expect(updated.categories).toEqual({ runtime: true, history: true, knowledge: true, settings: true });
    });

    it("lets an explicit category value narrow what all=true opened", () => {
      createProfile(paths, "base");
      const updated = setProfileCategories(paths, "base", { all: true, runtime: false });
      expect(updated.categories).toEqual({ runtime: false, history: true, knowledge: true, settings: true });
    });
  });

  describe("setProfileEntries", () => {
    it("merges an entry patch into an empty profile", () => {
      createProfile(paths, "base");
      const updated = setProfileEntries(paths, "base", { "knowledge/skills/commit": true });
      expect(updated.entries).toEqual({ "knowledge/skills/commit": true });
    });

    it("merges a second patch over the first, preserving untouched entries", () => {
      createProfile(paths, "base");
      setProfileEntries(paths, "base", { "knowledge/skills/commit": true });
      const updated = setProfileEntries(paths, "base", { "knowledge/skills/pr-feedback": true });
      expect(updated.entries).toEqual({
        "knowledge/skills/commit": true,
        "knowledge/skills/pr-feedback": true,
      });
    });

    it("throws when an entry key lacks the required category prefix", () => {
      createProfile(paths, "base");
      expect(() => setProfileEntries(paths, "base", { "skills/commit": true })).toThrow(ConfigValidationError);
    });

    it("throws ProfileNotFoundError for a profile that does not exist", () => {
      expect(() => setProfileEntries(paths, "ghost", { "knowledge/skills/commit": true })).toThrow(
        ProfileNotFoundError,
      );
    });
  });

  describe("setProfileLaunchFlags", () => {
    it("merges skipPermissions and remoteControl independently", () => {
      createProfile(paths, "base");
      setProfileLaunchFlags(paths, "base", { skipPermissions: true });
      const updated = setProfileLaunchFlags(paths, "base", { remoteControl: true });
      expect(updated.launch).toEqual({ skipPermissions: true, remoteControl: true });
    });

    it("merges headroom with the other launch flags", () => {
      createProfile(paths, "base");
      setProfileLaunchFlags(paths, "base", { skipPermissions: true });
      expect(setProfileLaunchFlags(paths, "base", { headroom: true }).launch).toEqual({
        skipPermissions: true,
        headroom: true,
      });
    });

    it("throws ProfileNotFoundError for a profile that does not exist", () => {
      expect(() => setProfileLaunchFlags(paths, "ghost", { skipPermissions: true })).toThrow(ProfileNotFoundError);
    });
  });
});
