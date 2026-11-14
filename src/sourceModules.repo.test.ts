import fs from "node:fs";

import { expect, it } from "vitest";

import { isSourceModule } from "./sourceModules";

it("takes the source modules of src from a listing of it, with no test, test world or declaration file among them", () => {
  const modules = fs.readdirSync(__dirname, { recursive: true, encoding: "utf8" }).filter(isSourceModule);
  expect(modules).toContain("sourceModules.ts");
  expect(modules).toContain("frontdoor/capture.ts");
  expect(modules.filter((module) => module.endsWith(".test.ts") || module.endsWith("TestWorld.ts") || module.endsWith(".d.ts"))).toEqual([]);
});

it("takes a .ts file, and leaves out a test, a test world and a declaration file", () => {
  expect(isSourceModule("a.ts")).toBe(true);
  expect(isSourceModule("dir/a.ts")).toBe(true);
  expect(isSourceModule("a.test.ts")).toBe(false);
  expect(isSourceModule("aTestWorld.ts")).toBe(false);
  expect(isSourceModule("x.d.ts")).toBe(false);
  expect(isSourceModule("a.js")).toBe(false);
});
