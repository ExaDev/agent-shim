import { describe, expect, it } from "vitest";

import { editableFakeFs, fakeFs } from "./test-helpers";

describe("the fake filesystem helpers", () => {
  it("never change the object they are given, so a constant shared between tests keeps what it holds", () => {
    const shared: Record<string, unknown> = { "/home/x/file.json": { kind: "x" }, "/explicit/undefined.json": undefined };
    const before = Object.keys(shared);
    fakeFs(shared);
    editableFakeFs(shared).set("/home/x/other.json", { kind: "y" });
    expect(Object.keys(shared)).toEqual(before);
    expect(shared["/home/x/other.json"]).toBeUndefined();
  });

  it("let a test edit a file between two reads, in that filesystem only", () => {
    const own = { "/a.json": { v: 1 } };
    const { fs, set } = editableFakeFs(own);
    expect(fs.readConfigFile("/a.json")).toEqual({ v: 1 });
    set("/a.json", { v: 2 });
    expect(fs.readConfigFile("/a.json")).toEqual({ v: 2 });
    expect(own["/a.json"]).toEqual({ v: 1 });
    expect(fakeFs(own).readConfigFile("/a.json")).toEqual({ v: 1 });
  });
});
