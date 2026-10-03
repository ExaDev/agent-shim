import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
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
