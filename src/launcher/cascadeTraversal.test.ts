import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cosmiconfigReader } from "../config/load";
import { UnsafeNameError } from "../config/names";
import { buildLayoutPaths } from "../paths";
import { flattenLayers } from "../resolve/flatten";
import { assembleCascade } from "../resolve/walk";
import { loadCascadeInput } from "./cascade";

/** A profile written outside the profiles directory, which a name containing `..` would reach, setting what only the person's own profile may: a program for the statusline to run and a provider. */
const EVIL_PROFILE = { launch: { provider: "evil", statusline: { extra: { command: ["touch", "pwned"] } } } };
const TRAVERSAL = "../../proj/evil";

describe("a name in a configuration file cannot leave the directory it names a file in", () => {
  let home: string;
  let project: string;
  let paths: ReturnType<typeof buildLayoutPaths>;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cascade-traversal-")));
    project = path.join(home, "proj");
    paths = buildLayoutPaths(path.join(home, ".agent-shim"));
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(paths.configProfilesDir, { recursive: true });
    fs.writeFileSync(path.join(project, "evil.json"), JSON.stringify(EVIL_PROFILE));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const load = (): ReturnType<typeof loadCascadeInput> => loadCascadeInput({ paths, home, cwd: project, read: cosmiconfigReader() });
  const writeProjectFile = (name: string, content: unknown): string => {
    const file = path.join(project, name);
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  it.each([".agent-shim.json", ".agent-shim.local.json", ".claude-use.json", ".claude-use.local.json"])("refuses a configProfile that climbs out of the profiles directory in %s, naming the file", (name) => {
    const file = writeProjectFile(name, { configProfile: TRAVERSAL });
    expect(load).toThrow(file);
  });

  it.each(["../..", "../../proj/evil", "a/b", "/etc/passwd", ".hidden", "a\u0000b"])("refuses %j as an extended profile in a project file, so the profile outside is never loaded", (name) => {
    const file = writeProjectFile(".agent-shim.json", { extends: [name] });
    expect(load).toThrow(file);
  });

  it("refuses a provider that climbs out of the providers directory in a project file", () => {
    const file = writeProjectFile(".agent-shim.json", { launch: { provider: TRAVERSAL } });
    expect(load).toThrow(file);
  });

  it("refuses the same names in a directory rule and as a default profile, which the schema holds to the same shape", () => {
    fs.writeFileSync(paths.directoryRulesFile, JSON.stringify({ rules: [{ path: project, configProfile: TRAVERSAL }] }));
    expect(load).toThrow(paths.directoryRulesFile);
    fs.writeFileSync(paths.directoryRulesFile, JSON.stringify({ rules: [] }));
    fs.writeFileSync(paths.globalConfigFile, JSON.stringify({ defaultConfigProfile: TRAVERSAL }));
    expect(load).toThrow(paths.globalConfigFile);
  });

  it("never loads a profile outside the profiles directory, whatever reaches the loader", () => {
    const loaded = load();
    for (const name of [TRAVERSAL, "../..", "..", ".", "", "a/b", ".hidden"]) {
      expect(() => loaded.input.loadProfile(name), JSON.stringify(name)).toThrow(UnsafeNameError);
    }
  });

  it("still loads profiles with the names people give them", () => {
    for (const name of ["client-base", "me@example.com", "a.b_c-d", "Work2"]) {
      fs.writeFileSync(path.join(paths.configProfilesDir, `${name}.json`), JSON.stringify({ launch: { statusline: { provider: { name } } } }));
    }
    writeProjectFile(".agent-shim.json", { configProfile: "client-base", extends: ["me@example.com", "a.b_c-d", "Work2"] });
    const loaded = loadCascadeInput({ paths, home, cwd: project, read: cosmiconfigReader(), baseConfigProfile: "client-base" });
    const layers = assembleCascade(loaded.input).layers;
    const sources = layers.map((layer) => path.basename(layer.source));
    expect(sources).toEqual(expect.arrayContaining(["client-base.json", ".agent-shim.json"]));
    expect(flattenLayers(layers, { home }).launch.statusline?.provider?.name).toBe("client-base");
  });
});
