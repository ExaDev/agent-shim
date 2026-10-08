import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDirectoryRule } from "./directoryRulesStore";
import { addIdentity, setIdentityCredential } from "./identityStore";
import { createProfile } from "./configProfilesStore";
import { resolveLaunchSelection } from "./launchSelection";
import { PoolNotFoundError, addPool } from "./poolStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

describe("resolveLaunchSelection", () => {
  let root: string;
  let project: string;
  let claudeHome: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-selection-"));
    project = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-project-"));
    claudeHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
    addIdentity(paths, "personal");
    createProfile(paths, "strict");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [root, project, claudeHome]) {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const resolve = (env: Readonly<Record<string, string | undefined>> = {}, extra: { readonly identity?: string; readonly configProfile?: string } = {}): ReturnType<typeof resolveLaunchSelection> =>
    resolveLaunchSelection({ paths, cwd: project, env, ...extra });

  it("answers with no identity and no profile when nothing selects one", () => {
    const { identity, configProfile } = resolve();
    expect(identity.name).toBeUndefined();
    expect(configProfile.name).toBeUndefined();
  });

  it("follows a directory rule's identity and profile, and says each came from the directory", () => {
    addDirectoryRule(paths, project, { identity: "work", configProfile: "strict" });
    const { identity, configProfile } = resolve();
    expect(identity).toMatchObject({ name: "work", source: "directory-pin" });
    expect(configProfile).toMatchObject({ name: "strict", source: "directory-rule" });
  });

  it("follows a committed .agent-shim.json, and lets the gitignored local file beside it win", () => {
    nodeFs.writeFileSync(path.join(project, ".agent-shim.json"), JSON.stringify({ identity: "work" }));
    expect(resolve().identity).toMatchObject({ name: "work", source: "directory-pin" });
    nodeFs.writeFileSync(path.join(project, ".agent-shim.local.json"), JSON.stringify({ identity: "personal" }));
    expect(resolve().identity.name).toBe("personal");
  });

  it("weighs the command line, the environment and the directory in the launcher's order", () => {
    addDirectoryRule(paths, project, { identity: "work" });
    expect(resolve({ AGENT_SHIM_IDENTITY: "personal" }).identity).toMatchObject({ name: "personal", source: "env" });
    expect(resolve({ AGENT_SHIM_IDENTITY: "personal" }, { identity: "work" }).identity).toMatchObject({ name: "work", source: "argv" });
    expect(resolve({ CLAUDE_CONFIG_DIR: "/elsewhere" }).identity).toMatchObject({ source: "config-dir-escape-hatch", configDirEscapeHatch: true });
    expect(resolve({}, { configProfile: "strict" }).configProfile).toMatchObject({ name: "strict", source: "cli-flag" });
  });

  it("applies a directory rule's identity whatever its condition says, as the launcher does", () => {
    nodeFs.mkdirSync(path.dirname(paths.directoryRulesFile), { recursive: true });
    nodeFs.writeFileSync(paths.directoryRulesFile, JSON.stringify({ rules: [{ path: project, identity: "work", when: { env: { NEVER_SET_FOR_THIS_TEST: "1" } } }] }));
    expect(resolve().identity).toMatchObject({ name: "work", source: "directory-pin" });
  });

  it("names the pool a rule selects and the member a launch here would run as, with the pick's reasons", () => {
    addPool(paths, "main", ["work", "personal"], "listed");
    addDirectoryRule(paths, project, { identity: "pool:main" });
    const { identity, poolPick } = resolve();
    expect(identity).toMatchObject({ pool: "main", source: "directory-pin" });
    expect(identity.name).toBe(poolPick?.pick);
    expect(poolPick?.candidates.length).toBe(2);
  });

  it("refuses a pool that is not defined, with the error the commands raise", () => {
    addDirectoryRule(paths, project, { identity: "pool:ghost" });
    expect(() => resolve()).toThrow(PoolNotFoundError);
  });

  it("takes the chosen identity's own default profile into account", () => {
    nodeFs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false, defaultConfigProfile: "strict" }));
    expect(resolve({}, { identity: "work" }).configProfile).toMatchObject({ name: "strict", source: "identity-default" });
  });

  it("runs no credential command and touches no Keychain, though the identity has a credential block", () => {
    const marker = path.join(root, "credential-command-ran");
    setIdentityCredential(paths, "work", { sources: [{ command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] }] });
    addDirectoryRule(paths, project, { identity: "work" });
    expect(resolve().identity.name).toBe("work");
    expect(nodeFs.existsSync(marker)).toBe(false);
  });
});
