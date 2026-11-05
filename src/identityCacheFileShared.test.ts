import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityCacheKey } from "./credential";
import { describeIdentityMove, moveIdentity } from "./identityRename";
import { createWorld, type World } from "./identityRenameTestWorld";
import { removeIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import type { CredentialCachePort } from "./credentialCache";
import { cacheFileNameFor, createRealCredentialCache } from "./realCredentialCache";

/** A directory its owner can list and enter but not write in, and the owner-only mode it is put back to. */
const READ_ONLY_DIRECTORY_MODE = 0o500;
const OWNER_DIRECTORY_MODE = 0o700;

/** A made-up cached credential of each identity of the pair. */
const OF_A_AT_B = { token: "a-made-up-token-of-a@b", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } } as const;
const OF_A_UNDERSCORE_B = { token: "a-made-up-token-of-a_b", fetchedAt: 2, source: { env: "EXAMPLE_TOKEN" } } as const;

/** Stores an identity named `id` under id `id` whose credential block caches in the file store. */
function stored(paths: LayoutPaths, id: string): void {
  fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
  fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name: id, allowAmbientCredential: false, credential: { sources: [{ env: "EXAMPLE_TOKEN" }], target: "oauthToken", cache: { store: "file" } } }));
}

/** What a kill between two of the cache step's writes looks like to the step: it stops there. */
class KilledError extends Error {}

describe("two identities, given before that was refused, whose ids name one file of the file store", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-cache-file-shared-test-"));
    paths = buildLayoutPaths(root);
    stored(paths, "a@b");
    stored(paths, "a_b");
    expect(cacheFileNameFor(identityCacheKey("a@b"))).toBe(cacheFileNameFor(identityCacheKey("a_b")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("each reads only the credential cached for itself, the other's being a miss", () => {
    const cache = createRealCredentialCache(root);
    cache.write("file", identityCacheKey("a_b"), OF_A_UNDERSCORE_B);
    expect(cache.read("file", identityCacheKey("a@b"))).toBeUndefined();
    expect(cache.read("file", identityCacheKey("a_b"))?.token).toBe(OF_A_UNDERSCORE_B.token);
  });

  it("removing one leaves the other's cached credential readable by the other", () => {
    createRealCredentialCache(root).write("file", identityCacheKey("a_b"), OF_A_UNDERSCORE_B);
    expect(removeIdentity(paths, "a@b")).toBe("a@b");
    expect(createRealCredentialCache(root).read("file", identityCacheKey("a_b"))?.token).toBe(OF_A_UNDERSCORE_B.token);
  });

  it("removing one deletes its own cached credential", () => {
    createRealCredentialCache(root).write("file", identityCacheKey("a@b"), OF_A_AT_B);
    removeIdentity(paths, "a@b");
    expect(fs.existsSync(path.join(root, "credential-cache", cacheFileNameFor(identityCacheKey("a@b"))))).toBe(false);
  });

  it("removing one deletes an entry cached before owners were recorded, which both read, since its owner cannot be told", () => {
    const file = path.join(root, "credential-cache", cacheFileNameFor(identityCacheKey("a@b")));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(OF_A_AT_B));
    const cache = createRealCredentialCache(root);
    expect(cache.read("file", identityCacheKey("a@b"))?.token).toBe(OF_A_AT_B.token);
    expect(cache.read("file", identityCacheKey("a_b"))?.token).toBe(OF_A_AT_B.token);
    removeIdentity(paths, "a@b");
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("identity rename --move and a cached credential whose file another identity's id names", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("moves its own entry to the new id, recording the new owner", async () => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    cache.write("file", identityCacheKey("work"), OF_A_AT_B);
    await moveIdentity(world.paths, "work", "fresh", ports);
    expect(cache.read("file", identityCacheKey("fresh"))).toEqual({ ...OF_A_AT_B, owner: identityCacheKey("fresh") });
    expect(cache.read("file", identityCacheKey("work"))).toBeUndefined();
  });

  it("moves nothing of an entry recorded for another identity whose id names its file, which keeps it", async () => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    world.cache.delete("file:identity work");
    await moveIdentity(world.paths, "work", "a@b", ports);
    stored(world.paths, "a_b");
    cache.write("file", identityCacheKey("a_b"), OF_A_UNDERSCORE_B);
    await moveIdentity(world.paths, "a@b", "fresh", ports);
    expect(cache.read("file", identityCacheKey("fresh"))).toBeUndefined();
    expect(cache.read("file", identityCacheKey("a_b"))?.token).toBe(OF_A_UNDERSCORE_B.token);
  });

  it("moves its own entry between two ids that name one file, so the new id reads it", async () => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    cache.write("file", identityCacheKey("work"), OF_A_AT_B);
    await moveIdentity(world.paths, "work", "a@b", ports);
    expect(describeIdentityMove(world.paths, "a@b", "a_b", ports).steps).toContain("move the cached credential of identity a@b to identity a_b, if one is stored");
    await moveIdentity(world.paths, "a@b", "a_b", ports);
    expect(cache.read("file", identityCacheKey("a_b"))).toEqual({ ...OF_A_AT_B, owner: identityCacheKey("a_b") });
  });

  it.each([
    ["after the new owner's entry is written and before the old one is removed", 1],
    ["after the old owner's entry is removed", 2],
  ] as const)("is finished by running it again after a kill %s, which leaves the rename's journal, and never gives the other identity of the pair the moved one's entry", async (_when, callsBeforeKill) => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    cache.write("file", identityCacheKey("work"), OF_A_AT_B);
    await moveIdentity(world.paths, "work", "a@b", ports);
    // The other identity of the pair, whose id names the same file, which holds the moving identity's entry: it reads none, before and after.
    stored(world.paths, "a_b");
    expect(cache.read("file", identityCacheKey("a_b"))).toBeUndefined();
    // A port that does the first `callsBeforeKill` writes or removes and is killed as the last of them returns, staying gone through the rollback, as a process killed there would be: the rollback cannot undo the cache step, so the rename's journal is left for the next run.
    let calls = 0;
    const dead = (): never => {
      throw new KilledError("the process was killed");
    };
    /** Runs `call` while the process lives, and kills it once the `callsBeforeKill`-th call is done. */
    const whileAlive = (call: () => void): void => {
      calls += 1;
      if (calls > callsBeforeKill) {
        dead();
      }
      call();
      if (calls === callsBeforeKill) {
        dead();
      }
    };
    const dying: CredentialCachePort = {
      read: cache.read,
      write: (store, owner, entry) => {
        whileAlive(() => {
          cache.write(store, owner, entry);
        });
      },
      remove: (store, owner) => {
        whileAlive(() => {
          cache.remove(store, owner);
        });
      },
    };
    await expect(moveIdentity(world.paths, "a@b", "fresh", world.ports({ credentialCache: { port: dying, platform: "linux" } }))).rejects.toThrow();
    expect(fs.readdirSync(world.paths.identityRenamesDir)).not.toEqual([]);
    await moveIdentity(world.paths, "a@b", "fresh", ports);
    expect(fs.existsSync(world.paths.identityRenamesDir) ? fs.readdirSync(world.paths.identityRenamesDir) : []).toEqual([]);
    expect(cache.read("file", identityCacheKey("fresh"))).toEqual({ ...OF_A_AT_B, owner: identityCacheKey("fresh") });
    expect(cache.read("file", identityCacheKey("a@b"))).toBeUndefined();
    expect(cache.read("file", identityCacheKey("a_b"))).toBeUndefined();
  });
});

describe("a credential-cache directory that cannot be written", () => {
  let root: string;
  let paths: LayoutPaths;
  let cacheDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-cache-dir-locked-test-"));
    paths = buildLayoutPaths(root);
    stored(paths, "a@b");
    fs.mkdirSync(path.join(root, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(root, "credentials", "a@b.token"), "a-made-up-token\n");
    createRealCredentialCache(root).write("file", identityCacheKey("a@b"), OF_A_AT_B);
    cacheDir = path.join(root, "credential-cache");
    fs.chmodSync(cacheDir, READ_ONLY_DIRECTORY_MODE);
  });

  afterEach(() => {
    fs.chmodSync(cacheDir, OWNER_DIRECTORY_MODE);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("makes identity remove refuse before it deletes anything, leaving the identity whole", () => {
    expect(() => removeIdentity(paths, "a@b")).toThrow(/EACCES/u);
    expect(fs.existsSync(path.join(paths.identitiesDir, "a@b", "identity.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "credentials", "a@b.token"))).toBe(true);
  });
});
