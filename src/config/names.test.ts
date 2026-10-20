import { describe, expect, it } from "vitest";

import { FileNameSchema, MAX_NAME_BYTES, InvalidProviderNameError, isFileName, isStoredName, profileFilePath, providerFilePath, requireNewProviderName, StoredNameSchema, UnsafeNameError } from "./names";

const SAFE = ["client-base", "me@example.com", "a.b_c-d", "Work2", "0", "x..y", "a.json", "x".repeat(MAX_NAME_BYTES)];
/** Names that cannot stay inside their directory, or are empty or over-long: no rule accepts them. */
const ESCAPING = ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "../../proj/evil", "a\u0000b", "x".repeat(MAX_NAME_BYTES + 1)];
/** Names that stay inside their directory but have not the shape new names are given: an older, looser rule allowed them. */
const OLDER_SHAPES = [".hidden", "my profile", "_old", "-leading", "@leading", "a\nb", "a\n", "tab\there"];

describe("isFileName and FileNameSchema (what a project file or a new name may use)", () => {
  it.each(SAFE)("accept %j", (name) => {
    expect(isFileName(name)).toBe(true);
    expect(FileNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([...ESCAPING, ...OLDER_SHAPES])("refuse %j", (name) => {
    expect(isFileName(name)).toBe(false);
    expect(FileNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("isStoredName and StoredNameSchema (what the person's own configuration may use)", () => {
  it.each([...SAFE, ...OLDER_SHAPES])("accept %j", (name) => {
    expect(isStoredName(name)).toBe(true);
    expect(StoredNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(ESCAPING)("refuse %j", (name) => {
    expect(isStoredName(name)).toBe(false);
    expect(StoredNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("profileFilePath and providerFilePath", () => {
  it("place a name directly inside the directory, including one stored under an older rule", () => {
    expect(profileFilePath("/home/.agent-shim/config-profiles", "client-base")).toBe("/home/.agent-shim/config-profiles/client-base.json");
    expect(profileFilePath("/home/.agent-shim/config-profiles", "my profile")).toBe("/home/.agent-shim/config-profiles/my profile.json");
    expect(providerFilePath("/home/.agent-shim/providers", "_old")).toBe("/home/.agent-shim/providers/_old.json");
  });

  it.each(ESCAPING)("refuse %j", (name) => {
    expect(() => profileFilePath("/d", name)).toThrow(UnsafeNameError);
    expect(() => profileFilePath("/d", name)).toThrow(/not a valid configuration profile name/);
    expect(() => providerFilePath("/d", name)).toThrow(InvalidProviderNameError);
    expect(() => providerFilePath("/d", name)).toThrow(/not a valid provider name/);
  });

  it("name where the name came from, when the caller says", () => {
    expect(() => profileFilePath("/d", "../x", "--config-profile")).toThrow(/^--config-profile: "\.\.\/x" is not a valid configuration profile name/);
    expect(() => providerFilePath("/d", "../x", "launch.provider")).toThrow(/^launch\.provider: /);
  });
});

describe("requireNewProviderName", () => {
  it.each([...ESCAPING, ...OLDER_SHAPES])("refuses %j, which a new provider may not be named", (name) => {
    expect(() => {
      requireNewProviderName(name);
    }).toThrow(InvalidProviderNameError);
  });

  it.each(SAFE)("accepts %j", (name) => {
    expect(() => {
      requireNewProviderName(name);
    }).not.toThrow();
  });
});
