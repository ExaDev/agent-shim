import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "../config/load";
import { UnsafeNameError } from "../config/names";
import { decideConfigProfile, decideIdentity, loadIdentity, resolveIdentityId } from "./identity";
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

  it.each([
    ["the identity named on the command line", { argv0Identity: "../../x" }],
    ["AGENT_SHIM_IDENTITY", { env: { AGENT_SHIM_IDENTITY: "../../x" } }],
    ["a directory rule", { directoryPinnedIdentity: "a/b" }],
    ["the active-identity file", { readActiveIdentityFile: () => ".." }],
  ])("refuses a selector from %s that would name a path, naming where it came from", (source, override) => {
    expect(() => decideIdentity({ ...baseParams, ...override })).toThrow(UnsafeNameError);
    expect(() => decideIdentity({ ...baseParams, ...override })).toThrow(source);
  });

  it("refuses a pool selector whose pool name would name a path", () => {
    expect(() => decideIdentity({ ...baseParams, argv0Identity: "pool:../x" })).toThrow(UnsafeNameError);
    expect(decideIdentity({ ...baseParams, argv0Identity: "pool:fleet" })).toMatchObject({ pool: "fleet" });
  });

  it("refuses to load an identity file by a name that would leave the identities directory, reading nothing", () => {
    const reads: string[] = [];
    const fs = fakeFs({ readConfigFile: (file) => { reads.push(file); return {}; } });
    expect(() => loadIdentity("/home/.agent-shim/identities", "../../x", fs)).toThrow(UnsafeNameError);
    expect(reads).toEqual([]);
  });

  it("skips resolution when CLAUDE_CONFIG_DIR is already set and nothing on the command line names an identity, whatever else would resolve one", () => {
    const result = decideIdentity({
      ...baseParams,
      env: { CLAUDE_CONFIG_DIR: "/somewhere/else", AGENT_SHIM_IDENTITY: "from-env" },
      directoryPinnedIdentity: "pinned",
      readActiveIdentityFile: () => "persisted",
    });
    expect(result).toEqual({ source: "config-dir-escape-hatch", configDirEscapeHatch: true });
  });

  it("lets an identity named on the command line outrank an inherited CLAUDE_CONFIG_DIR, recording the directory it set aside", () => {
    const result = decideIdentity({
      ...baseParams,
      env: { CLAUDE_CONFIG_DIR: "/somewhere/else", AGENT_SHIM_IDENTITY: "from-env" },
      argv0Identity: "work",
      directoryPinnedIdentity: "pinned",
      readActiveIdentityFile: () => "persisted",
    });
    expect(result).toEqual({ name: "work", source: "argv", configDirEscapeHatch: false, supersededConfigDir: "/somewhere/else" });
  });

  it("lets a pool named on the command line outrank an inherited CLAUDE_CONFIG_DIR", () => {
    const result = decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "/somewhere/else" }, argv0Identity: "pool:fleet" });
    expect(result).toEqual({ pool: "fleet", source: "argv", configDirEscapeHatch: false, supersededConfigDir: "/somewhere/else" });
  });

  it("records no superseded directory when the identity is named and no CLAUDE_CONFIG_DIR is inherited", () => {
    expect(decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "" }, argv0Identity: "work" })).not.toHaveProperty("supersededConfigDir");
    expect(decideIdentity({ ...baseParams, argv0Identity: "work" })).not.toHaveProperty("supersededConfigDir");
  });

  it("applies the escape hatch above AGENT_SHIM_IDENTITY, since both are environment", () => {
    const result = decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "/somewhere/else", AGENT_SHIM_IDENTITY: "from-env" } });
    expect(result).toMatchObject({ source: "config-dir-escape-hatch", configDirEscapeHatch: true });
    expect(result.name).toBeUndefined();
  });

  it("still refuses an unsafe command-line selector when CLAUDE_CONFIG_DIR is inherited", () => {
    expect(() => decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "/somewhere/else" }, argv0Identity: "../../x" })).toThrow(UnsafeNameError);
  });

  it("treats an empty-string CLAUDE_CONFIG_DIR as unset, falling through to argv", () => {
    const result = decideIdentity({ ...baseParams, env: { CLAUDE_CONFIG_DIR: "" }, argv0Identity: "work" });
    expect(result).toEqual({ name: "work", source: "argv", configDirEscapeHatch: false });
  });

  it("prefers a leading @name argv positional over AGENT_SHIM_IDENTITY, a directory pin, and the active-identity file", () => {
    const result = decideIdentity({
      env: { AGENT_SHIM_IDENTITY: "env-identity" },
      argv0Identity: "argv-identity",
      directoryPinnedIdentity: "pinned-identity",
      readActiveIdentityFile: () => "persisted-identity",
    });
    expect(result).toEqual({ name: "argv-identity", source: "argv", configDirEscapeHatch: false });
  });

  it("prefers AGENT_SHIM_IDENTITY over a directory pin and the active-identity file when no argv identity is present", () => {
    const result = decideIdentity({
      env: { AGENT_SHIM_IDENTITY: "env-identity" },
      directoryPinnedIdentity: "pinned-identity",
      readActiveIdentityFile: () => "persisted-identity",
    });
    expect(result).toEqual({ name: "env-identity", source: "env", configDirEscapeHatch: false });
  });

  it("prefers a directory pin over the active-identity file when neither argv nor AGENT_SHIM_IDENTITY apply", () => {
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

  it("treats an empty AGENT_SHIM_IDENTITY as unset", () => {
    const result = decideIdentity({ ...baseParams, env: { AGENT_SHIM_IDENTITY: "" }, readActiveIdentityFile: () => "persisted" });
    expect(result).toEqual({ name: "persisted", source: "active-identity-file", configDirEscapeHatch: false });
  });
});

describe("decideConfigProfile", () => {
  const baseParams = { env: {} };

  it("prefers an explicit CLI flag over everything else", () => {
    const result = decideConfigProfile({
      env: { AGENT_SHIM_CONFIG_PROFILE: "env-profile" },
      cliFlagConfigProfile: "cli-profile",
      directoryRuleConfigProfile: "rule-profile",
      identityDefaultConfigProfile: "identity-profile",
      globalDefaultConfigProfile: "global-profile",
    });
    expect(result).toEqual({ name: "cli-profile", source: "cli-flag" });
  });

  it("prefers the AGENT_SHIM_CONFIG_PROFILE env var over a directory rule when no CLI flag is present", () => {
    const result = decideConfigProfile({
      env: { AGENT_SHIM_CONFIG_PROFILE: "env-profile" },
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
  it("reads the identity.json of the directory whose record carries the name, and nothing for a directory's own name the record does not carry", () => {
    const files: Record<string, unknown> = { "/state/identities/work/identity.json": { name: "client" }, "/state/identities/personal/identity.json": { name: "personal" } };
    const fs = fakeFs({ readdir: () => ["work", "personal"], readConfigFile: (filepath) => files[filepath] });
    expect(loadIdentity("/state/identities", "client", fs)?.filepath).toBe("/state/identities/work/identity.json");
    expect(loadIdentity("/state/identities", "work", fs)).toBeUndefined();
    expect(resolveIdentityId("/state/identities", "client", fs)).toBe("work");
  });

  it("returns undefined when the identity has no identity.json yet", () => {
    const fs = fakeFs({ readConfigFile: () => undefined });
    expect(loadIdentity("/home/testuser/.agent-shim/identities", "work", fs)).toBeUndefined();
  });

  it("reads and validates identity.json via IdentitySchema, applying the allowAmbientCredential default", () => {
    const fs = fakeFs({
      readdir: () => ["work"],
      readConfigFile: (filepath) => {
        expect(filepath).toBe("/home/testuser/.agent-shim/identities/work/identity.json");
        return { name: "work", defaultConfigProfile: "work-default" };
      },
    });
    const loaded = loadIdentity("/home/testuser/.agent-shim/identities", "work", fs);
    expect(loaded?.config).toEqual({
      name: "work",
      defaultConfigProfile: "work-default",
      allowAmbientCredential: false,
    });
  });

  it("throws ConfigValidationError when identity.json fails validation", () => {
    // A name no file could have makes the record claim its directory's, so loading by that name reports the file.
    const fs = fakeFs({ readdir: () => ["work"], readConfigFile: () => ({ name: "" }) });
    expect(() => loadIdentity("/home/testuser/.agent-shim/identities", "work", fs)).toThrow(ConfigValidationError);
  });
});
