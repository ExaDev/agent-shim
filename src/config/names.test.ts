import { describe, expect, it } from "vitest";

import { FileNameSchema, isFileName, namedFilePath, UnsafeNameError } from "./names";

const SAFE = ["client-base", "me@example.com", "a.b_c-d", "Work2", "0", "x..y", "a.json"];
const UNSAFE = ["", ".", "..", ".hidden", "../x", "a/b", "a\\b", "/abs", "../../proj/evil", "a b", "a\u0000b", "a\nb", "-leading", "_leading", "@leading"];

describe("isFileName and FileNameSchema", () => {
  it.each(SAFE)("accept %j", (name) => {
    expect(isFileName(name)).toBe(true);
    expect(FileNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(UNSAFE)("refuse %j", (name) => {
    expect(isFileName(name)).toBe(false);
    expect(FileNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("namedFilePath", () => {
  it("places a safe name directly inside the directory", () => {
    expect(namedFilePath("/home/.agent-shim/providers", "z.ai", ".json", "provider")).toBe("/home/.agent-shim/providers/z.ai.json");
  });

  it.each(UNSAFE)("throws for %j, naming the kind of thing", (name) => {
    expect(() => namedFilePath("/home/.agent-shim/providers", name, ".json", "provider")).toThrow(UnsafeNameError);
    expect(() => namedFilePath("/home/.agent-shim/providers", name, ".json", "provider")).toThrow(/not a valid provider name/);
  });
});
