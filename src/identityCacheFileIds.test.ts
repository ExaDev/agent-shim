import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityCacheKey } from "./credential";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { credentialCacheStep } from "./identityRenameSteps";
import { describeIdentityMove, moveIdentity } from "./identityRename";
import { createWorld, type World } from "./identityRenameTestWorld";
import { addIdentity, identityIdOf } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { cacheFileNameFor, createRealCredentialCache } from "./realCredentialCache";

/** A made-up cached credential. */
const ENTRY = { token: "a-made-up-cached-token", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } } as const;

describe("ids whose cached credentials the file store would file in one file", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-cache-file-ids-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("share one file name, which is why an id is refused when another identity's has it", () => {
    expect(cacheFileNameFor(identityCacheKey("a@b"))).toBe(cacheFileNameFor(identityCacheKey("a_b")));
  });

  it("are never both given out by identity add, in either order, before either has cached anything", () => {
    addIdentity(paths, "a_b");
    addIdentity(paths, "a@b");
    expect(identityIdOf(paths, "a_b")).toBe("a_b");
    expect(identityIdOf(paths, "a@b")).toBe("a@b-2");
    const other = buildLayoutPaths(path.join(root, "other"));
    addIdentity(other, "x@y");
    addIdentity(other, "x_y");
    expect(identityIdOf(other, "x_y")).toBe("x_y-2");
  });

  it("are never both given out when the other identity is displaced, its directory gone and its identity.json only in a superseded farm", () => {
    const farm = path.join(paths.identitiesDir, ".a_b.previous.17.7c9e6679-7425-40de-944b-e07fc1f90ae7");
    fs.mkdirSync(farm, { recursive: true });
    fs.writeFileSync(path.join(farm, "identity.json"), JSON.stringify({ name: "a_b", allowAmbientCredential: false }));
    addIdentity(paths, "a@b");
    expect(identityIdOf(paths, "a@b")).toBe("a@b-2");
    const world = createWorld();
    try {
      fs.mkdirSync(path.join(world.paths.identitiesDir, ".a_b.previous.17.7c9e6679-7425-40de-944b-e07fc1f90ae7"));
      fs.writeFileSync(path.join(world.paths.identitiesDir, ".a_b.previous.17.7c9e6679-7425-40de-944b-e07fc1f90ae7", "identity.json"), JSON.stringify({ name: "a_b", allowAmbientCredential: false }));
      expect(() => describeIdentityMove(world.paths, "work", "a@b", world.ports())).toThrow(`"a@b" is already in use: the credential cache would file it in ${cacheFileNameFor(identityCacheKey("a@b"))}, the file of identities/a_b.`);
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("say, refusing an id whose cache file name differs only in case from another's, which two files they are", () => {
    const world = createWorld();
    try {
      fs.mkdirSync(path.join(world.paths.identitiesDir, "x_y"));
      fs.writeFileSync(path.join(world.paths.identitiesDir, "x_y", "identity.json"), JSON.stringify({ name: "x_y", allowAmbientCredential: false }));
      expect(() => describeIdentityMove(world.paths, "work", "X@y", world.ports())).toThrow('"X@y" is already in use: the credential cache would file it in identity_X_y.json, which differs only in case from the file of identities/x_y, identity_x_y.json.');
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("compare the file names with case folded, since a filesystem that ignores case makes identity_A_B.json and identity_a_b.json one file", () => {
    addIdentity(paths, "A_B");
    addIdentity(paths, "a@b");
    expect(identityIdOf(paths, "a@b")).toBe("a@b-2");
  });

  it("refuse identity rename --move onto an id whose cached credential would share another identity's file", () => {
    const world = createWorld();
    try {
      addIdentity(world.paths, "a_b");
      expect(() => describeIdentityMove(world.paths, "work", "a@b", world.ports())).toThrow(`"a@b" is already in use: the credential cache would file it in ${cacheFileNameFor(identityCacheKey("a@b"))}, the file of identities/a_b.`);
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
});

describe("identity rename --move between two ids whose cached credentials the file store files in one file", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is not refused for the moving identity's own old id, and moves the credential to where the new id reads it", async () => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    cache.write("file", identityCacheKey("work"), ENTRY);
    await moveIdentity(world.paths, "work", "a@b", ports);
    expect(cache.read("file", identityCacheKey("a@b"))?.token).toBe(ENTRY.token);
    await moveIdentity(world.paths, "a@b", "a_b", ports);
    expect(identityIdOf(world.paths, "a_b")).toBe("a_b");
    expect(cache.read("file", identityCacheKey("a_b"))?.token).toBe(ENTRY.token);
  });

  it("is not refused for an identity with no credential cache configured, and rekeys a file-cached credential on disk even when caching is not configured", async () => {
    fs.writeFileSync(path.join(world.paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    await moveIdentity(world.paths, "work", "a@b", ports);
    cache.write("file", identityCacheKey("a@b"), ENTRY);
    expect(describeIdentityMove(world.paths, "a@b", "a_b", ports).steps).toContain("move the cached credential of identity a@b to identity a_b, if one is stored");
    await moveIdentity(world.paths, "a@b", "a_b", ports);
    expect(identityIdOf(world.paths, "a_b")).toBe("a_b");
    expect(cache.read("file", identityCacheKey("a_b"))).toEqual({ ...ENTRY, owner: identityCacheKey("a_b") });
  });

  it("reads and moves an entry left in the file store through the injected port, whether caching is off or in the Keychain", async () => {
    // Caching is off, with an entry left in the file store from before.
    fs.writeFileSync(path.join(world.paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    world.cache.set("file:identity work", ENTRY);
    expect(describeIdentityMove(world.paths, "work", "client", world.ports()).steps).toContain("move the cached credential of identity work to identity client, if one is stored");
    await moveIdentity(world.paths, "work", "client", world.ports());
    expect([...world.cache.keys()]).toEqual(["file:identity client"]);
    expect(fs.existsSync(path.join(world.root, "credential-cache"))).toBe(false);

    // Caching is in the Keychain on macOS, with entries in both stores: each moves in its own store.
    world.cache.clear();
    fs.writeFileSync(path.join(world.paths.identitiesDir, "client", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false, credential: { sources: [{ env: "EXAMPLE_TOKEN" }], target: "oauthToken", cache: { store: "keychain" } } }));
    world.cache.set("file:identity client", ENTRY);
    world.cache.set("keychain:identity client", { ...ENTRY, token: "a-made-up-keychain-token" });
    await moveIdentity(world.paths, "client", "other", world.ports({ credentialCache: { port: world.ports().credentialCache.port, platform: "darwin" } }));
    expect([...world.cache.keys()].sort()).toEqual(["file:identity other", "keychain:identity other"]);
    expect(world.cache.get("file:identity other")?.token).toBe(ENTRY.token);
    expect(world.cache.get("keychain:identity other")?.token).toBe("a-made-up-keychain-token");
  });

  it("refuses identity rename --move from a@b to a_b when identity_a_b.json on disk holds an entry recorded for a_b rather than a@b", async () => {
    await moveIdentity(world.paths, "work", "a@b", world.ports());
    const cache = createRealCredentialCache(world.root);
    cache.write("file", identityCacheKey("a_b"), { ...ENTRY, token: "foreign-token-of-a_b" });
    const file = path.join(world.root, "credential-cache", cacheFileNameFor(identityCacheKey("a_b")));
    expect(() => describeIdentityMove(world.paths, "a@b", "a_b", world.ports())).toThrow(`"a_b" is already in use: ${file} exists.`);
    await expect(moveIdentity(world.paths, "a@b", "a_b", world.ports())).rejects.toThrow(`"a_b" is already in use: ${file} exists.`);
    expect(identityIdOf(world.paths, "a@b")).toBe("a@b");
    expect(cache.read("file", identityCacheKey("a_b"))?.token).toBe("foreign-token-of-a_b");
  });
});

describe("identity rename --move between two ids whose cache file names differ only in case", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is not refused for the moving identity's own cache file, spelled in another case, in the real file store on this filesystem", async () => {
    const cache = createRealCredentialCache(world.root);
    const ports = world.ports({ credentialCache: { port: cache, platform: "linux" } });
    cache.write("file", identityCacheKey("work"), ENTRY);
    await moveIdentity(world.paths, "work", "A_B", ports);
    await moveIdentity(world.paths, "A_B", "a@b", ports);
    expect(cache.read("file", identityCacheKey("a@b"))?.token).toBe(ENTRY.token);
  });
});

describe("credentialCacheStep", () => {
  it("moves each store's entry to the new owner, and puts each back on undo, leaving a store with none alone", () => {
    const held = new Map<string, CachedCredential>([["file:identity a", ENTRY]]);
    const port: CredentialCachePort = {
      read: (store, owner) => held.get(`${store}:${owner}`),
      write: (store, owner, entry) => {
        held.set(`${store}:${owner}`, entry);
      },
      remove: (store, owner) => {
        held.delete(`${store}:${owner}`);
      },
    };
    const step = credentialCacheStep(port, "a", "b", [
      { store: "file", cached: ENTRY },
      { store: "keychain", cached: undefined },
    ]);
    step.apply();
    expect([...held.keys()]).toEqual(["file:identity b"]);
    step.undo();
    expect([...held.keys()]).toEqual(["file:identity a"]);
  });
});
