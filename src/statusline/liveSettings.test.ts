import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cosmiconfigReader } from "../config/load";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFsPort } from "../realPorts";
import { statuslineSettingsForRender } from "./liveSettings";

let home: string;
let paths: LayoutPaths;
let project: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "statusline-live-")));
  paths = buildLayoutPaths(path.join(home, ".agent-shim"));
  project = path.join(home, "work", "project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(paths.configProfilesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** One render's settings: the session's environment and working directory are the only inputs that vary. */
function render(env: Readonly<Record<string, string | undefined>> = {}, cwd: string = project): ReturnType<typeof statuslineSettingsForRender> {
  return statuslineSettingsForRender({ env, cwd, home, paths, fs: { ...realFsPort, readConfigFile: cosmiconfigReader() } });
}

function addIdentity(name: string, defaultConfigProfile?: string): string {
  const dir = path.join(paths.identitiesDir, name);
  writeJson(path.join(dir, "identity.json"), { name, ...(defaultConfigProfile === undefined ? {} : { defaultConfigProfile }) });
  return dir;
}

function addProfile(name: string, statusline: unknown): void {
  writeJson(path.join(paths.configProfilesDir, `${name}.json`), { launch: { statusline } });
}

describe("statuslineSettingsForRender", () => {
  it("has no settings, and no problem, when nothing sets any", () => {
    expect(render()).toEqual({ settings: undefined });
  });

  it("reads launch.statusline from the config on every render, so an edit shows on the next one", () => {
    writeJson(paths.globalConfigFile, { launch: { statusline: { bar: { width: 6 } } } });
    expect(render().settings).toEqual({ bar: { width: 6 } });
    writeJson(paths.globalConfigFile, { launch: { statusline: { bar: { width: 9 } } } });
    expect(render().settings).toEqual({ bar: { width: 9 } });
  });

  it("merges the cascade's layers key by key, as a launch does", () => {
    writeJson(paths.globalConfigFile, { launch: { statusline: { bar: { width: 6 }, usage: { sevenDayThreshold: 10 } } } });
    writeJson(paths.directoryRulesFile, { rules: [{ path: project, launch: { statusline: { usage: { sevenDayThreshold: 50 } } } }] });
    expect(render().settings).toEqual({ bar: { width: 6 }, usage: { sevenDayThreshold: 50 } });
  });

  describe("AGENT_SHIM_STATUSLINE", () => {
    beforeEach(() => {
      writeJson(paths.globalConfigFile, { launch: { statusline: { bar: { width: 6 } } } });
    });

    it("wins over the config when it is set", () => {
      expect(render({ AGENT_SHIM_STATUSLINE: '{"bands":{"warnAt":50}}' })).toEqual({ settings: { bands: { warnAt: 50 } } });
    });

    it("counts as unset when it is empty", () => {
      expect(render({ AGENT_SHIM_STATUSLINE: "" }).settings).toEqual({ bar: { width: 6 } });
    });

    it("is not softened: a value that does not parse still throws, as it does today", () => {
      expect(() => render({ AGENT_SHIM_STATUSLINE: "{nope" })).toThrow("AGENT_SHIM_STATUSLINE: not valid JSON.");
    });

    it("is not replaced by a config that cannot be read", () => {
      fs.writeFileSync(paths.globalConfigFile, "{ not json");
      expect(render({ AGENT_SHIM_STATUSLINE: '{"bar":{"width":4}}' })).toEqual({ settings: { bar: { width: 4 } } });
    });
  });

  describe("a config that cannot be used", () => {
    it("reports an unparseable file and has no settings, without throwing", () => {
      fs.writeFileSync(paths.globalConfigFile, "{ not json");
      const result = render();
      expect(result.settings).toBeUndefined();
      expect(result.problem).toContain(paths.globalConfigFile);
    });

    it("reports a setting the schema refuses, naming the file", () => {
      writeJson(paths.globalConfigFile, { launch: { statusline: { bar: { width: 0 } } } });
      const result = render();
      expect(result.settings).toBeUndefined();
      expect(result.problem).toContain(paths.globalConfigFile);
    });

    it("reports settings that cannot be drawn together", () => {
      writeJson(paths.globalConfigFile, { launch: { statusline: { bands: { warnAt: 95 } } } });
      const result = render();
      expect(result.settings).toBeUndefined();
      expect(result.problem).toMatch(/^launch\.statusline: statusline bands\.warnAt \(95\)/);
    });

    it("reports a selected configuration profile that does not exist", () => {
      writeJson(paths.globalConfigFile, { defaultConfigProfile: "missing" });
      const result = render();
      expect(result.settings).toBeUndefined();
      expect(result.problem).toBeDefined();
    });

    it("reports an identity name that is not a file name", () => {
      const result = render({ ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: .." });
      expect(result.settings).toBeUndefined();
      expect(result.problem).toBeDefined();
    });
  });

  describe("the cascade's inputs come from the session", () => {
    it("takes the working directory as the project path: a rule or a project file applies only under it", () => {
      writeJson(paths.directoryRulesFile, { rules: [{ path: project, launch: { statusline: { bar: { width: 7 } } } }] });
      const elsewhere = path.join(home, "other");
      fs.mkdirSync(elsewhere, { recursive: true });
      expect(render({}, project).settings).toEqual({ bar: { width: 7 } });
      expect(render({}, path.join(project, "src")).settings).toEqual({ bar: { width: 7 } });
      expect(render({}, elsewhere).settings).toBeUndefined();
      writeJson(path.join(elsewhere, ".agent-shim.json"), { launch: { statusline: { bar: { width: 3 } } } });
      expect(render({}, elsewhere).settings).toEqual({ bar: { width: 3 } });
    });

    it("takes the identity from the configuration directory the launch pinned, and uses its default configuration profile", () => {
      addProfile("alice-profile", { bar: { width: 5 } });
      addProfile("bob-profile", { bar: { width: 8 } });
      const alice = addIdentity("alice", "alice-profile");
      const bob = addIdentity("bob", "bob-profile");
      expect(render({ CLAUDE_CONFIG_DIR: alice }).settings).toEqual({ bar: { width: 5 } });
      expect(render({ CLAUDE_CONFIG_DIR: bob }).settings).toEqual({ bar: { width: 8 } });
    });

    it("takes the identity from the session header the launch injected", () => {
      addProfile("alice-profile", { bar: { width: 5 } });
      addIdentity("alice", "alice-profile");
      expect(render({ ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: alice" }).settings).toEqual({ bar: { width: 5 } });
    });

    it("assumes no identity when the session names none, so no identity's default applies", () => {
      addProfile("alice-profile", { bar: { width: 5 } });
      addIdentity("alice", "alice-profile");
      expect(render({ CLAUDE_CONFIG_DIR: path.join(home, "somewhere-else") }).settings).toBeUndefined();
      expect(render({}).settings).toBeUndefined();
    });

    it("lets AGENT_SHIM_CONFIG_PROFILE choose the base profile ahead of the identity's default, under the profile a directory rule names", () => {
      addProfile("alice-profile", { bar: { width: 5 } });
      addProfile("rule-profile", { bar: { width: 6 } });
      addProfile("env-profile", { usage: { sevenDayThreshold: 30 } });
      const alice = addIdentity("alice", "alice-profile");
      writeJson(paths.directoryRulesFile, { rules: [{ path: project, configProfile: "rule-profile" }] });
      expect(render({ CLAUDE_CONFIG_DIR: alice }).settings).toEqual({ bar: { width: 6 } });
      expect(render({ CLAUDE_CONFIG_DIR: alice, AGENT_SHIM_CONFIG_PROFILE: "env-profile" }).settings).toEqual({ bar: { width: 6 }, usage: { sevenDayThreshold: 30 } });
    });

    it("falls back to the global default configuration profile when neither the rules nor the identity choose one", () => {
      addProfile("global-profile", { bar: { width: 4 } });
      writeJson(paths.globalConfigFile, { defaultConfigProfile: "global-profile" });
      expect(render().settings).toEqual({ bar: { width: 4 } });
    });
  });
});
