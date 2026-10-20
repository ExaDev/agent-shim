import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cosmiconfigReader } from "../config/load";
import { buildLayoutPaths } from "../paths";
import { flattenLayers } from "../resolve/flatten";
import { assembleCascade } from "../resolve/walk";
import { FAKE_HOME } from "../test-helpers";
import { loadCascadeInput, readDirectorySelections } from "./cascade";

const paths = buildLayoutPaths(`${FAKE_HOME}/.agent-shim`);

function fakeReader(files: Readonly<Record<string, unknown>>) {
  return (filepath: string): unknown => files[filepath];
}

describe("loadCascadeInput", () => {
  it("collects one level per ancestor holding a config, shallowest-first, folding the three sources most-personal-last", () => {
    const read = fakeReader({
      [`${FAKE_HOME}/work/.agent-shim.json`]: { categories: { history: false } },
      [`${FAKE_HOME}/work/acme/.agent-shim.json`]: { entries: { "knowledge/skills/commit": true } },
      [`${FAKE_HOME}/work/acme/.agent-shim.local.json`]: { categories: { history: true } },
      [paths.directoryRulesFile]: { rules: [{ path: "~/work/acme", categories: { knowledge: false } }] },
    });

    const loaded = loadCascadeInput({ paths, home: FAKE_HOME, cwd: `${FAKE_HOME}/work/acme`, read });
    const assembled = assembleCascade(loaded.input);

    expect(assembled.layers.map((layer) => `${layer.kind}:${layer.source}`)).toEqual([
      `portable:${FAKE_HOME}/work/.agent-shim.json`,
      `portable:${FAKE_HOME}/work/acme/.agent-shim.json`,
      `directory-rule:${paths.directoryRulesFile}`,
      `portable-local:${FAKE_HOME}/work/acme/.agent-shim.local.json`,
    ]);
  });

  describe("the statusline's extra command, which runs a program", () => {
    const launch = { statusline: { extra: { command: ["date"] } } };
    const statuslineOf = (read: ReturnType<typeof fakeReader>): unknown => {
      const loaded = loadCascadeInput({ paths, home: FAKE_HOME, cwd: `${FAKE_HOME}/work/acme`, read, baseConfigProfile: "mine" });
      return flattenLayers(assembleCascade(loaded.input).layers, { home: FAKE_HOME }).launch.statusline;
    };

    it("is read from the layers a person controls: the global config, a profile and a directory rule", () => {
      const profile = `${FAKE_HOME}/.agent-shim/config-profiles/mine.json`;
      expect(statuslineOf(fakeReader({ [paths.globalConfigFile]: { launch }, [profile]: {} }))).toEqual({ extra: { command: ["date"] } });
      expect(statuslineOf(fakeReader({ [profile]: { launch } }))).toEqual({ extra: { command: ["date"] } });
      expect(statuslineOf(fakeReader({ [profile]: {}, [paths.directoryRulesFile]: { rules: [{ path: "~/work/acme", launch }] } }))).toEqual({ extra: { command: ["date"] } });
    });

    describe("through the real loader, on a real directory", () => {
      const PROJECT_FILES = [".agent-shim.json", ".agent-shim.local.json", ".claude-use.json", ".claude-use.local.json"];
      let home: string;
      let real: ReturnType<typeof buildLayoutPaths>;
      let project: string;

      beforeEach(() => {
        home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cascade-extra-")));
        real = buildLayoutPaths(path.join(home, ".agent-shim"));
        project = path.join(home, "proj");
        fs.mkdirSync(project, { recursive: true });
        fs.mkdirSync(real.configProfilesDir, { recursive: true });
      });

      afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
      });

      const load = (baseConfigProfile?: string): ReturnType<typeof loadCascadeInput> => loadCascadeInput({ paths: real, home, cwd: project, read: cosmiconfigReader(), ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }) });
      const realStatuslineOf = (loaded: ReturnType<typeof loadCascadeInput>): unknown => flattenLayers(assembleCascade(loaded.input).layers, { home }).launch.statusline;

      it.each(PROJECT_FILES)("refuses the extra command in %s, naming the file, so a cloned repository cannot choose the program", (name) => {
        const file = path.join(project, name);
        for (const extra of [{ command: ["touch", "pwned"] }, { command: [] }, {}]) {
          fs.writeFileSync(file, JSON.stringify({ launch: { statusline: { extra } } }));
          expect(() => load(), JSON.stringify(extra)).toThrow(file);
        }
      });

      it.each(PROJECT_FILES)("cannot reach a profile outside the profiles directory by a path named in %s", (name) => {
        fs.writeFileSync(path.join(project, "evil.json"), JSON.stringify({ launch }));
        const file = path.join(project, name);
        for (const named of [{ configProfile: "../../proj/evil" }, { extends: ["../../proj/evil"] }]) {
          fs.writeFileSync(file, JSON.stringify(named));
          expect(() => load(), JSON.stringify(named)).toThrow(file);
        }
      });

      it("lets only the person's own profiles carry the command, even when a project file selects one and that profile extends one with a looser name", () => {
        fs.writeFileSync(path.join(real.configProfilesDir, "my base.json"), JSON.stringify({ launch }));
        fs.writeFileSync(path.join(real.configProfilesDir, "mine.json"), JSON.stringify({ extends: ["my base"] }));
        fs.writeFileSync(path.join(project, ".agent-shim.json"), JSON.stringify({ configProfile: "mine" }));
        expect(realStatuslineOf(load("mine"))).toEqual({ extra: { command: ["date"] } });
        fs.writeFileSync(path.join(project, ".agent-shim.json"), JSON.stringify({ configProfile: "my base" }));
        expect(() => load()).toThrow(path.join(project, ".agent-shim.json"));
      });
    });

    it("lets a project file set the settings that only draw", () => {
      const read = fakeReader({ [`${FAKE_HOME}/work/acme/.agent-shim.json`]: { launch: { statusline: { customLine: { text: "hello" } } } }, [`${FAKE_HOME}/.agent-shim/config-profiles/mine.json`]: {} });
      expect(statuslineOf(read)).toEqual({ customLine: { text: "hello" } });
    });
  });

  it("matches a directory rule written with a ~-rooted path against the real directory", () => {
    const read = fakeReader({
      [paths.directoryRulesFile]: { rules: [{ path: "~/work/", identity: "acme" }] },
    });

    const loaded = loadCascadeInput({ paths, home: FAKE_HOME, cwd: `${FAKE_HOME}/work/acme`, read });

    expect(loaded.input.levels?.map((level) => level.dir)).toEqual([`${FAKE_HOME}/work`]);
    expect(readDirectorySelections(loaded)).toEqual({ identity: "acme" });
  });

  it("loads a named configuration profile from the profiles directory", () => {
    const read = fakeReader({
      [`${FAKE_HOME}/.agent-shim/config-profiles/client-base.json`]: { categories: { history: false } },
    });

    const loaded = loadCascadeInput({
      paths,
      home: FAKE_HOME,
      cwd: FAKE_HOME,
      read,
      baseConfigProfile: "client-base",
    });
    const assembled = assembleCascade(loaded.input);

    expect(assembled.layers.map((layer) => layer.kind)).toEqual(["config-profile"]);
    expect(assembled.diagnostics).toEqual([]);
  });

  it("honours walkUpLimit from the global config so the walk can reach above home", () => {
    const read = fakeReader({
      [paths.globalConfigFile]: { walkUpLimit: "/" },
      ["/srv/.agent-shim.json"]: { categories: { history: false } },
    });

    const loaded = loadCascadeInput({ paths, home: FAKE_HOME, cwd: "/srv/project", read });

    expect(loaded.input.levels?.map((level) => level.dir)).toEqual(["/srv"]);
    expect(loaded.globalConfig?.walkUpLimit).toBe("/");
  });

  it("stops the walk at an unreadable ancestor rather than failing the launch", () => {
    const read = fakeReader({
      [`${FAKE_HOME}/work/.agent-shim.json`]: { categories: { history: false } },
      [`${FAKE_HOME}/work/acme/.agent-shim.json`]: { categories: { history: true } },
    });

    const loaded = loadCascadeInput({
      paths,
      home: FAKE_HOME,
      cwd: `${FAKE_HOME}/work/acme`,
      read,
      isReadable: (dir) => dir !== `${FAKE_HOME}/work`,
    });

    expect(loaded.input.levels?.map((level) => level.dir)).toEqual([`${FAKE_HOME}/work/acme`]);
  });

  it("reports the deepest identity pin and configuration profile selection", () => {
    const read = fakeReader({
      [paths.directoryRulesFile]: {
        rules: [
          { path: "~/work", identity: "work", configProfile: "work-default" },
          { path: "~/work/acme", configProfile: "client-acme" },
        ],
      },
    });

    const loaded = loadCascadeInput({ paths, home: FAKE_HOME, cwd: `${FAKE_HOME}/work/acme`, read });

    expect(readDirectorySelections(loaded)).toEqual({ identity: "work", configProfile: "client-acme" });
  });
});
