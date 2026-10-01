import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CachedCredential } from "./credentialCache";
import { cacheFileNameFor, createRealCredentialCache } from "./realCredentialCache";

const PERMISSION_BITS = 0o777;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const entry: CachedCredential = { token: "tok", fetchedAt: 42, source: { op: "op://vault/item/field" } };

describe("real file credential cache", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips an entry at owner-only permissions", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity work", entry);
    expect(cache.read("file", "identity work")).toEqual(entry);
    const file = path.join(root, "credential-cache", cacheFileNameFor("identity work"));
    expect(fs.statSync(file).mode & PERMISSION_BITS).toBe(OWNER_ONLY_FILE);
    expect(fs.statSync(path.dirname(file)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_DIR);
  });

  it("replaces an earlier entry for the same owner", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity work", entry);
    cache.write("file", "identity work", { ...entry, token: "newer" });
    expect(cache.read("file", "identity work")?.token).toBe("newer");
  });

  it("treats a missing or malformed entry as no entry", () => {
    const cache = createRealCredentialCache(root);
    expect(cache.read("file", "identity absent")).toBeUndefined();
    fs.mkdirSync(path.join(root, "credential-cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "credential-cache", cacheFileNameFor("identity bad")), "{not json");
    expect(cache.read("file", "identity bad")).toBeUndefined();
    fs.writeFileSync(path.join(root, "credential-cache", cacheFileNameFor("identity odd")), JSON.stringify({ token: "" }));
    expect(cache.read("file", "identity odd")).toBeUndefined();
  });

  it("removes an entry, and removing an absent one is not an error", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "provider z", entry);
    cache.remove("file", "provider z");
    expect(cache.read("file", "provider z")).toBeUndefined();
    expect(() => {
      cache.remove("file", "provider z");
    }).not.toThrow();
  });

  it("keeps an owner name that tries to climb out of the directory inside it", () => {
    expect(cacheFileNameFor("identity ../../etc/x")).not.toContain("/");
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity ../../escape", entry);
    expect(fs.readdirSync(path.join(root, "credential-cache"))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "..", "escape"))).toBe(false);
  });
});
