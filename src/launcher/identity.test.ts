import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "../config/load";
import { decideConfigProfile, decideIdentity, loadIdentity } from "./identity";
import type { FsPort } from "./ports";

function fakeFs(overrides: Partial<FsPort> = {}): FsPort {
  return {
    readFileUtf8: () => undefined,
    readConfigFile: () => undefined,
    readdir: () => [],
    ...overrides,
  };
}

describe("decideIdentity", () => {
  const baseParams = {
    env: {},
    readActiveIdentityFile: () => undefined,
  };

  it("skips resolution entirely when CLAUDE_CONFIG_DIR is already set, even if every other source would resolve one", () => {
    const result = decideIdentity({
      ...baseParams,
      env: { CLAUDE_CONFIG_DIR: "/somewhere/else" },
      argv0Identity: "work",
      directoryPinnedIdentity: "pinned",
      readActiveIdentityFile: () => "persisted",
    });
    expect(result).toEqual({ source: "config-dir-escape-hatch", configDirEscapeHatch: true });
  });

  it("treats an empty-string CLAUDE_CONFIG_DIR as unset, falling through to argv", () => {
    const result = decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "" }, argv0Identity: "work" });
    expect(result).toEqual({ name: "work", source: "argv", configDirEscapeHatch: false });
  });

  it("prefers a leading @name argv positional over CLAUDE_USE_IDENTITY, a directory pin, and the active-identity file", () => {
    const result = decideIdentity({
      env: { CLAUDE_USE_IDENTITY: "env-identity" },
      argv0Identity: "argv-identity",
      directoryPinnedIdentity: "pinned-identity",
      readActiveIdentityFile: () => "persisted-identity",
    });
    expect(result).toEqual({ name: "argv-identity", source: "argv", configDirEscapeHatch: false });
  });

  it("prefers CLAUDE_USE_IDENTITY over a directory pin and the active-identity file when no argv identity is present", () => {
    const result = decideIdentity({
      env: { CLAUDE_USE_IDENTITY: "env-identity" },
      directoryPinnedIdentity: "pinned-identity",
      readActiveIdentityFile: () => "persisted-identity",
    });
    expect(result).toEqual({ name: "env-identity", source: "env", configDirEscapeHatch: false });
  });

  it("prefers a directory pin over the active-identity file when neither argv nor CLAUDE_USE_IDENTITY apply", () => {
    const result = decideIdentity({
      ...baseParams,
      directoryPinnedIdentity: "pinned-identity",
      readActiveIdentityFile: () => "persisted-identity",
    });
    expect(result).toEqual({ name: "pinned-identity", source: "directory-pin", configDirEscapeHatch: false });
  });

  it("falls back to the persisted active-identity file when nothing more specific applies", () => {
    const result = decideIdentity({ ...baseParams, readActiveIdentityFile: () => "persisted-identity" });
    expect(result).toEqual({ name: "persisted-identity", source: "active-identity-file", configDirEscapeHatch: false });
  });

  it("resolves to 'none' when nothing at all applies", () => {
    const result = decideIdentity(baseParams);
    expect(result).toEqual({ source: "none", configDirEscapeHatch: false });
  });

  it("treats an empty CLAUDE_USE_IDENTITY as unset", () => {
    const result = decideIdentity({ ...baseParams, env: { CLAUDE_USE_IDENTITY: "" }, readActiveIdentityFile: () => "persisted" });
    expect(result).toEqual({ name: "persisted", source: "active-identity-file", configDirEscapeHatch: false });
  });
});

describe("decideConfigProfile", () => {
  const baseParams = { env: {} };

  it("prefers an explicit CLI flag over everything else", () => {
    const result = decideConfigProfile({
      env: { CLAUDE_USE_CONFIG_PROFILE: "env-profile" },
      cliFlagConfigProfile: "cli-profile",
      directoryRuleConfigProfile: "rule-profile",
      identityDefaultConfigProfile: "identity-profile",
      globalDefaultConfigProfile: "global-profile",
    });
    expect(result).toEqual({ name: "cli-profile", source: "cli-flag" });
  });

  it("prefers the CLAUDE_USE_CONFIG_PROFILE env var over a directory rule when no CLI flag is present", () => {
    const result = decideConfigProfile({
      env: { CLAUDE_USE_CONFIG_PROFILE: "env-profile" },
      directoryRuleConfigProfile: "rule-profile",
      identityDefaultConfigProfile: "identity-profile",
      globalDefaultConfigProfile: "global-profile",
    });
    expect(result).toEqual({ name: "env-profile", source: "env" });
  });

  it("prefers a directory rule's configProfile over the identity default", () => {
    const result = decideConfigProfile({
      ...baseParams,
      directoryRuleConfigProfile: "rule-profile",
      identityDefaultConfigProfile: "identity-profile",
      globalDefaultConfigProfile: "global-profile",
    });
    expect(result).toEqual({ name: "rule-profile", source: "directory-rule" });
  });

  it("prefers the identity default over the global default", () => {
    const result = decideConfigProfile({
      ...baseParams,
      identityDefaultConfigProfile: "identity-profile",
      globalDefaultConfigProfile: "global-profile",
    });
    expect(result).toEqual({ name: "identity-profile", source: "identity-default" });
  });

  it("falls back to the global default when nothing more specific applies", () => {
    const result = decideConfigProfile({ ...baseParams, globalDefaultConfigProfile: "global-profile" });
    expect(result).toEqual({ name: "global-profile", source: "global-default" });
  });

  it("resolves to 'none' when nothing at all applies", () => {
    expect(decideConfigProfile(baseParams)).toEqual({ source: "none" });
  });
});

describe("loadIdentity", () => {
  it("returns undefined when the identity has no identity.json yet", () => {
    const fs = fakeFs({ readConfigFile: () => undefined });
    expect(loadIdentity("/home/testuser/.claude-use/identities", "work", fs)).toBeUndefined();
  });

  it("reads and validates identity.json via IdentitySchema, applying the allowAmbientCredential default", () => {
    const fs = fakeFs({
      readConfigFile: (filepath) => {
        expect(filepath).toBe("/home/testuser/.claude-use/identities/work/identity.json");
        return { name: "work", defaultConfigProfile: "work-default" };
      },
    });
    const loaded = loadIdentity("/home/testuser/.claude-use/identities", "work", fs);
    expect(loaded?.config).toEqual({
      name: "work",
      defaultConfigProfile: "work-default",
      allowAmbientCredential: false,
    });
  });

  it("throws ConfigValidationError when identity.json fails validation", () => {
    const fs = fakeFs({ readConfigFile: () => ({ name: "" }) });
    expect(() => loadIdentity("/home/testuser/.claude-use/identities", "work", fs)).toThrow(ConfigValidationError);
  });
});
