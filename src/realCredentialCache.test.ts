import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_NAME_BYTES } from "./config/names";

import type { CachedCredential } from "./credentialCache";
import { cacheFileNameFor, createAsyncRealCredentialCache, createRealCredentialCache } from "./realCredentialCache";

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
    expect(cache.read("file", "identity work")).toEqual({ ...entry, owner: "identity work" });
    const file = path.join(root, "credential-cache", cacheFileNameFor("identity work"));
    expect(fs.statSync(file).mode & PERMISSION_BITS).toBe(OWNER_ONLY_FILE);
    expect(fs.statSync(path.dirname(file)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_DIR);
  });

  it("records the owner an entry was cached for, and reads it back for that owner", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity a@b", entry);
    expect(JSON.parse(fs.readFileSync(path.join(root, "credential-cache", cacheFileNameFor("identity a@b")), "utf8"))).toMatchObject({ owner: "identity a@b" });
    expect(cache.read("file", "identity a@b")).toEqual({ ...entry, owner: "identity a@b" });
  });

  it("is a miss for another owner whose key names the same file, sync and async, so no owner reads another's credential", async () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity a@b", entry);
    expect(cacheFileNameFor("identity a_b")).toBe(cacheFileNameFor("identity a@b"));
    expect(cache.read("file", "identity a_b")).toBeUndefined();
    expect(await createAsyncRealCredentialCache(root).read("file", "identity a_b")).toBeUndefined();
  });

  it("leaves an entry recorded for another owner when asked to remove its own, and deletes its own or one no owner of that file can read", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", "identity a_b", entry);
    cache.remove("file", "identity a@b");
    expect(cache.read("file", "identity a_b")).toEqual({ ...entry, owner: "identity a_b" });
    cache.remove("file", "identity a_b");
    expect(cache.read("file", "identity a_b")).toBeUndefined();

    const providerFile = path.join(root, "credential-cache", cacheFileNameFor("provider z"));
    fs.writeFileSync(providerFile, JSON.stringify({ ...entry, owner: "identity work" }));
    cache.remove("file", "provider z");
    expect(fs.existsSync(providerFile)).toBe(false);

    fs.writeFileSync(providerFile, JSON.stringify({ ...entry, owner: "provider other" }));
    cache.remove("file", "provider z");
    expect(fs.existsSync(providerFile)).toBe(false);
  });

  it("reads an entry written before owners were recorded for every owner whose key names its file, and removes it for any of them", () => {
    const file = path.join(root, "credential-cache", cacheFileNameFor("identity a_b"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
    const cache = createRealCredentialCache(root);
    expect(cache.read("file", "identity a@b")).toEqual(entry);
    expect(cache.read("file", "identity a_b")).toEqual(entry);
    cache.remove("file", "identity a@b");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes overlapping entries of two owners whose keys name one file, each to its own temporary file, leaving none behind", async () => {
    const cache = createAsyncRealCredentialCache(root);
    const writes = Array.from({ length: 20 }, async (_, index) => cache.write("file", index % 2 === 0 ? "identity a@b" : "identity a_b", { ...entry, token: `token-${String(index)}` }));
    await expect(Promise.all(writes)).resolves.toBeDefined();
    expect(fs.readdirSync(path.join(root, "credential-cache"))).toEqual([cacheFileNameFor("identity a@b")]);
  });

  it("removes its temporary file when the rename into place fails, sync and async", async () => {
    // A non-empty directory where the entry's file belongs, which no rename can replace.
    const target = path.join(root, "credential-cache", cacheFileNameFor("identity work"));
    fs.mkdirSync(path.join(target, "occupied"), { recursive: true });
    expect(() => {
      createRealCredentialCache(root).write("file", "identity work", entry);
    }).toThrow();
    await expect(createAsyncRealCredentialCache(root).write("file", "identity work", entry)).rejects.toThrow();
    expect(fs.readdirSync(path.join(root, "credential-cache"))).toEqual([cacheFileNameFor("identity work")]);
  });

  it("keeps two providers whose names name one file apart: each reads only its own, and the other's write is a miss for it", () => {
    const cache = createRealCredentialCache(root);
    expect(cacheFileNameFor("provider a@b")).toBe(cacheFileNameFor("provider a_b"));
    cache.write("file", "provider a@b", { ...entry, token: "of-a@b" });
    expect(cache.read("file", "provider a@b")?.token).toBe("of-a@b");
    expect(cache.read("file", "provider a_b")).toBeUndefined();
    cache.write("file", "provider a_b", { ...entry, token: "of-a_b" });
    expect(cache.read("file", "provider a_b")?.token).toBe("of-a_b");
    expect(cache.read("file", "provider a@b")).toBeUndefined();
  });

  it.each(["identity", "provider"])("writes and reads the entry of the %s whose name is as long as a name may be, sync and async", async (kind) => {
    const owner = `${kind} ${"a".repeat(MAX_NAME_BYTES)}`;
    createRealCredentialCache(root).write("file", owner, entry);
    expect(createRealCredentialCache(root).read("file", owner)?.token).toBe(entry.token);
    await createAsyncRealCredentialCache(root).write("file", owner, { ...entry, token: "newer" });
    expect(await createAsyncRealCredentialCache(root).read("file", owner)).toMatchObject({ token: "newer" });
  });

  it("removes, before it writes or removes an entry, the temporary files a process no longer running left, and keeps a running one's", async () => {
    const dir = path.join(root, "credential-cache");
    fs.mkdirSync(dir, { recursive: true });
    // A process that has exited and been reaped, whose pid is no longer running, and this test's own, which is.
    const deadPid = spawnSync("true").pid;
    const abandoned = path.join(dir, `.tmp-${String(deadPid)}-0f8fad5b-d9cb-469f-a165-70867728950e`);
    const live = path.join(dir, `.tmp-${String(process.pid)}-7c9e6679-7425-40de-944b-e07fc1f90ae7`);
    const leave = (): void => {
      fs.writeFileSync(abandoned, "a-made-up-token");
      fs.writeFileSync(live, "a-made-up-token");
    };
    leave();
    createRealCredentialCache(root).write("file", "identity work", entry);
    expect([fs.existsSync(abandoned), fs.existsSync(live)]).toEqual([false, true]);
    leave();
    await createAsyncRealCredentialCache(root).write("file", "identity work", entry);
    expect([fs.existsSync(abandoned), fs.existsSync(live)]).toEqual([false, true]);
    leave();
    createRealCredentialCache(root).remove("file", "identity work");
    expect([fs.existsSync(abandoned), fs.existsSync(live)]).toEqual([false, true]);
  });

  /** The three calls that sweep the cache directory first, each run once against the cache under `root`. */
  const SWEEPING_CALLS: readonly (readonly [string, (root: string) => Promise<void>])[] = [
    [
      "a write",
      async (cacheRoot) => {
        createRealCredentialCache(cacheRoot).write("file", "identity work", entry);
        await Promise.resolve();
      },
    ],
    ["an asynchronous write", async (cacheRoot) => createAsyncRealCredentialCache(cacheRoot).write("file", "identity work", entry)],
    [
      "a removal",
      async (cacheRoot) => {
        createRealCredentialCache(cacheRoot).remove("file", "identity work");
        await Promise.resolve();
      },
    ],
  ];

  it.each(SWEEPING_CALLS)("removes, before %s, a temporary file a release from before temporary files were named apart left for a process no longer running, and keeps one of a running process and an entry file", async (_call, sweep) => {
    const dir = path.join(root, "credential-cache");
    fs.mkdirSync(dir, { recursive: true });
    const deadPid = spawnSync("true").pid;
    const abandoned = path.join(dir, `${cacheFileNameFor("identity work")}.${String(deadPid)}.tmp`);
    const live = path.join(dir, `${cacheFileNameFor("identity work")}.${String(process.pid)}.tmp`);
    const entryFile = path.join(dir, cacheFileNameFor("identity other"));
    fs.writeFileSync(abandoned, "a-made-up-token");
    fs.writeFileSync(live, "a-made-up-token");
    fs.writeFileSync(entryFile, JSON.stringify(entry));
    await sweep(root);
    expect([fs.existsSync(abandoned), fs.existsSync(live), fs.existsSync(entryFile)]).toEqual([false, true, true]);
  });

  it.each(SWEEPING_CALLS)("never removes, before %s, an entry file whose owner's id has dots and digits like a temporary file's", async (_call, sweep) => {
    const dir = path.join(root, "credential-cache");
    const deadPid = String(spawnSync("true").pid);
    // Owners whose entry files end `.json` after a `.json.<pid>` or a `.<pid>.tmp`, as a temporary file's name does.
    const owners = [`identity a.json.${deadPid}`, `identity x.json.${deadPid}.tmp`];
    const cache = createRealCredentialCache(root);
    for (const owner of owners) {
      cache.write("file", owner, entry);
    }
    await sweep(root);
    expect(owners.map((owner) => fs.existsSync(path.join(dir, cacheFileNameFor(owner))))).toEqual([true, true]);
  });

  // Process 1 always runs; for a test not run as root it belongs to another user, so asking it with signal 0 is refused with EPERM, not ESRCH.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(SWEEPING_CALLS)("keeps, before %s, a temporary file of a running process another user owns, which signal 0 is refused for with EPERM", async (_call, sweep) => {
    const dir = path.join(root, "credential-cache");
    fs.mkdirSync(dir, { recursive: true });
    const otherUsers = path.join(dir, ".tmp-1-0f8fad5b-d9cb-469f-a165-70867728950e");
    fs.writeFileSync(otherUsers, "a-made-up-token");
    await sweep(root);
    expect(fs.existsSync(otherUsers)).toBe(true);
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

describe("real asynchronous file credential cache", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-cache-async-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips an entry at owner-only permissions, in the file the synchronous cache reads", async () => {
    const cache = createAsyncRealCredentialCache(root);
    await cache.write("file", "provider z", entry);
    expect(await cache.read("file", "provider z")).toEqual({ ...entry, owner: "provider z" });
    expect(createRealCredentialCache(root).read("file", "provider z")).toEqual({ ...entry, owner: "provider z" });
    const file = path.join(root, "credential-cache", cacheFileNameFor("provider z"));
    expect(fs.statSync(file).mode & PERMISSION_BITS).toBe(OWNER_ONLY_FILE);
    expect(fs.statSync(path.dirname(file)).mode & PERMISSION_BITS).toBe(OWNER_ONLY_DIR);
  });

  it("reads an entry the synchronous cache wrote, and treats a missing or malformed one as no entry", async () => {
    createRealCredentialCache(root).write("file", "provider z", entry);
    const cache = createAsyncRealCredentialCache(root);
    expect(await cache.read("file", "provider z")).toEqual({ ...entry, owner: "provider z" });
    expect(await cache.read("file", "provider absent")).toBeUndefined();
    fs.writeFileSync(path.join(root, "credential-cache", cacheFileNameFor("provider bad")), "{not json");
    expect(await cache.read("file", "provider bad")).toBeUndefined();
  });
});
