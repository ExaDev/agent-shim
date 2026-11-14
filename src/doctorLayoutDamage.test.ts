import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

/** How a path of the layout is damaged: a directory in its place, a file that is not JSON, or such a file with no permissions. */
const DAMAGE = ["directory", "malformed", "no-permission"] as const;
type Damage = (typeof DAMAGE)[number];

/**
 * The state directories doctor still stops at when a file stands where the directory belongs (`ENOTDIR`): no command writes a file at any of them (every writer creates the directory), so the damage is one made by hand, and it is tracked in https://github.com/ExaDev/agent-shim/issues/837. Each is held to still stopping, so the list shrinks as each is fixed and never names one that no longer does.
 */
const FILE_IN_A_DIRECTORY_PLACE: ReadonlySet<keyof LayoutPaths> = new Set<keyof LayoutPaths>(["identitiesDir", "configProfilesDir", "providersDir", "frontdoorDir", "identityNameRenamesDir"]);

/** Every path of the layout under the root, by its key. */
const KEYS = (Object.keys(buildLayoutPaths("/layout")) as (keyof LayoutPaths)[]).filter((key) => key !== "root");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh root with the path `key` names damaged as `damage`. */
function damaged(key: keyof LayoutPaths, damage: Damage): LayoutPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-layout-"));
  roots.push(root);
  const paths = buildLayoutPaths(root);
  const target = paths[key];
  if (damage === "directory") {
    fs.mkdirSync(target, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ not json");
    if (damage === "no-permission") fs.chmodSync(target, 0);
  }
  return paths;
}

describe("doctor over a damaged layout", () => {
  it("knows every path of the layout as a string under the root", () => {
    const paths = buildLayoutPaths("/layout");
    for (const key of KEYS) {
      expect(paths[key], key).toMatch(/^\/layout\//u);
    }
  });

  it.each(KEYS.flatMap((key) => DAMAGE.map((damage) => [key, damage] as const)))("reports %s as %s and goes on with the whole report", (key, damage) => {
    if (damage === "no-permission" && process.getuid?.() === 0) return;
    const paths = damaged(key, damage);
    const audit = (): unknown => collectDoctorReport({ paths, env: { PATH: "" } });
    if (damage !== "directory" && FILE_IN_A_DIRECTORY_PLACE.has(key)) {
      expect(audit).toThrow(/ENOTDIR/u);
      return;
    }
    expect(audit).not.toThrow();
  });
});
