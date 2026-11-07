import { describe, expect, it } from "vitest";

import { isRecord, readJsonObject } from "./jsonObjectFile";
import { createFakeFarmFs } from "./test-helpers";

describe("isRecord", () => {
  it("admits a plain object and refuses null, an array and any primitive", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, [], ["a"], "text", true, undefined]) {
      expect(isRecord(value)).toBe(false);
    }
    expect(isRecord(Number.parseInt("7", 10))).toBe(false);
  });
});

describe("readJsonObject", () => {
  it("reads one JSON object file, and is undefined for an absent file, one that is not JSON and JSON that is not one object", () => {
    const fs = createFakeFarmFs({ "/a.json": '{"k":"v"}', "/b.json": "not json", "/c.json": "[1]", "/d.json": "3" });
    expect(readJsonObject(fs, "/a.json")).toEqual({ k: "v" });
    expect(["/missing.json", "/b.json", "/c.json", "/d.json"].map((file) => readJsonObject(fs, file))).toEqual([undefined, undefined, undefined, undefined]);
  });
});
