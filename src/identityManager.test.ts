import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import type { PromptsPort, SelectParams } from "./configure";
import { fakeCommandDeps, scriptedPrompts as scriptedIdentityPrompts } from "./test-helpers";
import {
  IdentityAlreadyExistsError,
  IdentityNotFoundError,
  InvalidIdentityNameError,
  addIdentity,
  isIdentityDirectoryName,
  listIdentities,
  readActiveIdentity,
  readIdentity,
  runIdentityWizard,
  setAllowAmbientCredential,
  setDefaultConfigProfile,
  tryRunAtIdentityShortcut,
  useIdentity,
} from "./identityManager";

describe("identityManager", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-manager-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("addIdentity", () => {
    it("creates a fresh identity.json with the expected defaults", () => {
      const identity = addIdentity(paths, "work");
      expect(identity).toEqual({ name: "work", allowAmbientCredential: false });
      expect(readIdentity(paths, "work")).toEqual(identity);
    });

    it("throws IdentityAlreadyExistsError when the identity already exists", () => {
      addIdentity(paths, "work");
      expect(() => addIdentity(paths, "work")).toThrow(IdentityAlreadyExistsError);
    });

    it("throws InvalidIdentityNameError, not a raw ZodError, for a name that fails IdentitySchema's own naming rule", () => {
      expect(() => addIdentity(paths, "-bad-start")).toThrow(InvalidIdentityNameError);
    });

    it("creates an identity for an email-shaped name — `@` is valid in the body, so the `@name` shortcut's first-`@` split lands here intact", () => {
      const identity = addIdentity(paths, "joseph.mearman@exadev.io");
      expect(identity.name).toBe("joseph.mearman@exadev.io");
      expect(readIdentity(paths, "joseph.mearman@exadev.io")?.name).toBe("joseph.mearman@exadev.io");
    });

    it("throws InvalidIdentityNameError for a leading `@` — the first character stays strictly alphanumeric so the `@name` selector syntax's first-`@` split stays unambiguous", () => {
      expect(() => addIdentity(paths, "@exadev")).toThrow(InvalidIdentityNameError);
    });
  });

  describe("readIdentity", () => {
    it("returns undefined for an identity that does not exist", () => {
      expect(readIdentity(paths, "nope")).toBeUndefined();
    });
  });

  describe("useIdentity / readActiveIdentity", () => {
    it("throws IdentityNotFoundError when selecting an identity that was never created", () => {
      expect(() => { useIdentity(paths, "ghost"); }).toThrow(IdentityNotFoundError);
    });

    it("persists the active identity as plain trimmed text", () => {
      addIdentity(paths, "personal");
      useIdentity(paths, "personal");
      expect(fs.readFileSync(paths.activeIdentityFile, "utf8")).toBe("personal\n");
      expect(readActiveIdentity(paths)).toBe("personal");
    });

    it("returns undefined when no active identity has been set", () => {
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("switching the active identity overwrites the previous selection", () => {
      addIdentity(paths, "personal");
      addIdentity(paths, "work");
      useIdentity(paths, "personal");
      useIdentity(paths, "work");
      expect(readActiveIdentity(paths)).toBe("work");
    });
  });

  describe("tryRunAtIdentityShortcut", () => {
    it("switches the active identity for a bare @<name> argument", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@exadev"])).toBe(true);
      expect(readActiveIdentity(paths)).toBe("exadev");
    });

    it("splits an @<name> token at the first `@` only, so an email-shaped identity name survives intact", async () => {
      addIdentity(paths, "joseph.mearman@exadev.io");
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@joseph.mearman@exadev.io"])).toBe(true);
      expect(readActiveIdentity(paths)).toBe("joseph.mearman@exadev.io");
    });

    it("propagates IdentityNotFoundError for an unknown @<name> in a non-interactive context", async () => {
      await expect(tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@ghost"])).rejects.toThrow(IdentityNotFoundError);
    });

    it("returns false and touches nothing for a bare name with no @ prefix", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["exadev"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for a lone @ with no name", async () => {
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@"])).toBe(false);
    });

    it("returns false when there is more than one argument, even if the first is @<name>", async () => {
      addIdentity(paths, "exadev");
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["@exadev", "extra"])).toBe(false);
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("returns false for no arguments at all", async () => {
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), [])).toBe(false);
    });

    it("returns false for a real subcommand name, leaving it to Commander's own dispatch", async () => {
      expect(await tryRunAtIdentityShortcut(fakeCommandDeps(paths), ["identity"])).toBe(false);
    });
  });

  describe("runIdentityWizard", () => {
    it("creates the identity, a profile, and sets it as active when the user accepts every step", async () => {
      const prompts = scriptedIdentityPrompts(["create", "create", "work", ["history"]]);
      const result = await runIdentityWizard(prompts, paths, "scienap");

      expect(result).toBe(true);
      expect(readIdentity(paths, "scienap")).toBeDefined();
      expect(readActiveIdentity(paths)).toBe("scienap");
      expect(readIdentity(paths, "scienap")?.defaultConfigProfile).toBe("work");
    });

    it("creates only the identity when the user skips profile creation", async () => {
      const prompts = scriptedIdentityPrompts(["create", "skip"]);
      const result = await runIdentityWizard(prompts, paths, "personal");

      expect(result).toBe(true);
      expect(readIdentity(paths, "personal")).toBeDefined();
      expect(readActiveIdentity(paths)).toBe("personal");
      expect(readIdentity(paths, "personal")?.defaultConfigProfile).toBeUndefined();
    });

    it("creates nothing and returns false when the user declines at the initial confirm", async () => {
      const prompts = scriptedIdentityPrompts(["cancel"]);
      const result = await runIdentityWizard(prompts, paths, "ghost");

      expect(result).toBe(false);
      expect(readIdentity(paths, "ghost")).toBeUndefined();
      expect(readActiveIdentity(paths)).toBeUndefined();
    });

    it("throws InvalidIdentityNameError before any prompt appears, not a raw ZodError after the user confirms, when the name fails IdentitySchema's own naming rule", async () => {
      const prompts = scriptedIdentityPrompts([]);
      await expect(runIdentityWizard(prompts, paths, "@exadev")).rejects.toThrow(InvalidIdentityNameError);
    });

    it("offers the wizard for an email-shaped name, whose `@` is valid in the body", async () => {
      const prompts = scriptedIdentityPrompts(["create", "skip"]);
      const result = await runIdentityWizard(prompts, paths, "joseph.mearman@exadev.io");

      expect(result).toBe(true);
      expect(readIdentity(paths, "joseph.mearman@exadev.io")).toBeDefined();
      expect(readActiveIdentity(paths)).toBe("joseph.mearman@exadev.io");
    });

    it("defaults the profile-creation prompt's cursor to skip, so a bare Enter creates no profile", async () => {
      const selectCalls: SelectParams<string>[] = [];
      const base = scriptedIdentityPrompts(["create", "skip"]);
      const spying: PromptsPort = {
        ...base,
        select: async (params) => {
          selectCalls.push(params);
          return base.select(params);
        },
      };

      await runIdentityWizard(spying, paths, "work");

      const profilePrompt = selectCalls.find((call) => call.message.includes("configuration profile"));
      expect(profilePrompt?.initialValue).toBe("skip");
      // The option order stays create-then-skip regardless — initialValue moves the default answer without reordering what's read on screen.
      expect(profilePrompt?.options.map((option) => option.value)).toEqual(["create", "skip"]);
    });
  });

  describe("isIdentityDirectoryName", () => {
    it("accepts a name IdentitySchema itself would accept", () => {
      expect(isIdentityDirectoryName("work")).toBe(true);
      expect(isIdentityDirectoryName("joseph.mearman@exadev.io")).toBe(true);
    });

    it("rejects both farm-bookkeeping shapes, which an identity name could never take", () => {
      expect(isIdentityDirectoryName(".work.previous.123.abc")).toBe(false);
      expect(isIdentityDirectoryName(".work.scratch.123.abc")).toBe(false);
    });
  });

  describe("listIdentities", () => {
    it("returns an empty list when no identities exist", () => {
      expect(listIdentities(paths)).toEqual([]);
    });

    it("lists every identity sorted by name and marks the active one", () => {
      addIdentity(paths, "work");
      addIdentity(paths, "personal");
      useIdentity(paths, "personal");

      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["personal", "work"]);
      expect(entries.find((entry) => entry.name === "personal")?.isActive).toBe(true);
      expect(entries.find((entry) => entry.name === "work")?.isActive).toBe(false);
    });

    it("skips a directory under identitiesDir that has no identity.json at all", () => {
      addIdentity(paths, "work");
      fs.mkdirSync(path.join(paths.identitiesDir, "not-an-identity"), { recursive: true });
      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["work"]);
    });

    it("skips a retained superseded farm even when a crash left a readable identity.json inside it", () => {
      addIdentity(paths, "work");
      const retained = path.join(paths.identitiesDir, ".work.previous.123.abc");
      fs.mkdirSync(retained, { recursive: true });
      fs.writeFileSync(
        path.join(retained, "identity.json"),
        JSON.stringify({ name: "work", allowAmbientCredential: false }),
        "utf8",
      );
      fs.mkdirSync(path.join(paths.identitiesDir, ".work.scratch.456.def"), { recursive: true });

      expect(listIdentities(paths).map((entry) => entry.name)).toEqual(["work"]);
    });

    it("reports an identity.json this version's schema rejects as its own unreadable entry instead of aborting the whole listing", () => {
      addIdentity(paths, "work");
      const rejectedDir = path.join(paths.identitiesDir, "written-by-a-newer-claude-use");
      fs.mkdirSync(rejectedDir, { recursive: true });
      fs.writeFileSync(
        path.join(rejectedDir, "identity.json"),
        JSON.stringify({ name: "a name a future naming rule allows!", allowAmbientCredential: false }),
        "utf8",
      );

      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["work", "written-by-a-newer-claude-use"]);

      const rejected = entries.find((entry) => entry.name === "written-by-a-newer-claude-use");
      expect(rejected?.identity).toBeUndefined();
      expect(rejected?.problem).toContain("must match pattern");
      expect(rejected?.problem).not.toContain("\n");
      expect(entries.find((entry) => entry.name === "work")?.identity?.name).toBe("work");
    });

    it("reports malformed JSON as an unreadable entry too, rather than letting the SyntaxError escape", () => {
      const brokenDir = path.join(paths.identitiesDir, "broken");
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, "identity.json"), "{ not json", "utf8");

      const entries = listIdentities(paths);
      expect(entries.map((entry) => entry.name)).toEqual(["broken"]);
      expect(entries[0]?.problem).toBeDefined();
    });

    it("still marks an unreadable identity as active when active-identity names it", () => {
      const brokenDir = path.join(paths.identitiesDir, "broken");
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, "identity.json"), "{ not json", "utf8");
      fs.writeFileSync(paths.activeIdentityFile, "broken", "utf8");

      expect(listIdentities(paths)[0]?.isActive).toBe(true);
    });
  });

  describe("setDefaultConfigProfile", () => {
    it("patches defaultConfigProfile on an existing identity", () => {
      addIdentity(paths, "work");
      const updated = setDefaultConfigProfile(paths, "work", "client-acme");
      expect(updated.defaultConfigProfile).toBe("client-acme");
      expect(readIdentity(paths, "work")?.defaultConfigProfile).toBe("client-acme");
    });

    it("throws IdentityNotFoundError for a missing identity", () => {
      expect(() => setDefaultConfigProfile(paths, "ghost", "client-acme")).toThrow(IdentityNotFoundError);
    });

    it("preserves the identity's other fields when patching", () => {
      addIdentity(paths, "work");
      setAllowAmbientCredential(paths, "work", true);
      const updated = setDefaultConfigProfile(paths, "work", "client-acme");
      expect(updated.allowAmbientCredential).toBe(true);
    });
  });

  describe("setAllowAmbientCredential", () => {
    it("patches allowAmbientCredential to true", () => {
      addIdentity(paths, "work");
      const updated = setAllowAmbientCredential(paths, "work", true);
      expect(updated.allowAmbientCredential).toBe(true);
    });

    it("patches allowAmbientCredential back to false", () => {
      addIdentity(paths, "work");
      setAllowAmbientCredential(paths, "work", true);
      const updated = setAllowAmbientCredential(paths, "work", false);
      expect(updated.allowAmbientCredential).toBe(false);
    });

    it("throws IdentityNotFoundError for a missing identity", () => {
      expect(() => setAllowAmbientCredential(paths, "ghost", true)).toThrow(IdentityNotFoundError);
    });
  });
});
