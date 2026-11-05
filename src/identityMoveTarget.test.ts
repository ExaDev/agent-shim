import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEYCHAIN_CACHE_SERVICE } from "./credentialCache";
import { identityCacheKey } from "./credential";
import { describeIdentityMove, moveIdentity } from "./identityRename";
import { createWorld, treeOf, writeFile, writeJson, type World } from "./identityRenameTestWorld";
import { identityIdOf } from "./identityStore";
import { cacheFileNameFor } from "./realCredentialCache";

/** One usage-log line filed under `identity`. */
function logRecord(identity: string): string {
  const at = new Date().toISOString();
  return `${JSON.stringify({ schemaVersion: 1, at, identity, provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
}

/** Leftovers a removed identity can leave under the id `client`, each as it is filed on disk or in the Keychain, with the refusal it gives a `--move` to that id. */
const LEFTOVERS: readonly { readonly what: string; readonly platform: NodeJS.Platform; readonly leave: (world: World) => void; readonly says: (world: World) => string }[] = [
  {
    what: "records in the usage log",
    platform: "linux",
    leave: (world) => {
      writeFile(path.join(world.paths.usageLogDir, `${new Date().toISOString().slice(0, "YYYY-MM-DD".length)}.1.jsonl`), logRecord("client"));
    },
    says: () => '"client" is already in use: the usage log holds requests filed under "client".',
  },
  {
    what: "a credential cached in the file store, while the moving identity has none",
    platform: "linux",
    leave: (world) => {
      world.cache.delete("file:identity work");
      writeJson(path.join(world.paths.root, "credential-cache", cacheFileNameFor(identityCacheKey("client"))), { token: "a-made-up-leftover-token", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } });
    },
    says: (world) => `"client" is already in use: ${path.join(world.paths.root, "credential-cache", cacheFileNameFor(identityCacheKey("client")))} exists.`,
  },
  {
    what: "a credential cached in the Keychain store",
    platform: "darwin",
    leave: (world) => {
      world.keychain.seed(KEYCHAIN_CACHE_SERVICE, identityCacheKey("client"), "a-made-up-leftover-token");
    },
    says: () => `"client" is already in use: the Keychain caches a credential under "${identityCacheKey("client")}".`,
  },
  {
    what: "a stored token file, while the moving identity has none",
    platform: "linux",
    leave: (world) => {
      fs.rmSync(path.join(world.paths.root, "credentials", "work.token"));
      writeFile(path.join(world.paths.root, "credentials", "client.token"), "a-made-up-leftover-token\n");
    },
    says: (world) => `"client" is already in use: ${path.join(world.paths.root, "credentials", "client.token")} exists.`,
  },
  {
    what: "a usage snapshot",
    platform: "linux",
    leave: (world) => {
      writeJson(path.join(world.paths.usageSnapshotsDir, "client.json"), { schemaVersion: 1, identity: "client", updatedAt: "2025-01-01T00:00:00.000Z", providers: {} });
    },
    says: (world) => `"client" is already in use: ${path.join(world.paths.usageSnapshotsDir, "client.json")} exists.`,
  },
  {
    what: "a superseded farm",
    platform: "linux",
    leave: (world) => {
      fs.mkdirSync(path.join(world.paths.identitiesDir, ".client.previous.17.7c9e6679-7425-40de-944b-e07fc1f90ae7"));
    },
    says: (world) => `"client" is already in use: ${path.join(world.paths.identitiesDir, ".client.previous.17.7c9e6679-7425-40de-944b-e07fc1f90ae7")} exists.`,
  },
  {
    what: "the resync lock of an id that differs only in case",
    platform: "linux",
    leave: (world) => {
      writeFile(path.join(world.paths.identitiesDir, ".Client.lock"), "{}\n");
    },
    says: (world) => `"client" is already in use: ${path.join(world.paths.identitiesDir, ".Client.lock")} exists.`,
  },
];

/** A token file or usage snapshot a removed identity left under another spelling of `client`, with the refusal naming it as it is spelled on disk. */
const CASE_VARIANTS: readonly { readonly what: string; readonly leave: (world: World) => string; readonly expected: string }[] = [
  {
    what: "a token file spelled Client",
    leave: (world) => {
      fs.rmSync(path.join(world.paths.root, "credentials", "work.token"));
      writeFile(path.join(world.paths.root, "credentials", "Client.token"), "a-made-up-leftover-token\n");
      return path.join(world.paths.root, "credentials", "Client.token");
    },
    expected: "client.token",
  },
  {
    what: "a usage snapshot spelled CLIENT",
    leave: (world) => {
      writeJson(path.join(world.paths.usageSnapshotsDir, "CLIENT.json"), { schemaVersion: 1, identity: "CLIENT", updatedAt: "2025-01-01T00:00:00.000Z", providers: {} });
      return path.join(world.paths.usageSnapshotsDir, "CLIENT.json");
    },
    expected: "client.json",
  },
];

describe("identity rename --move to an id under which state is filed under another spelling", () => {
  let world: World | undefined;

  afterEach(() => {
    if (world !== undefined) {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it.each(CASE_VARIANTS)("names $what as it is spelled on disk, and says it differs only in case", ({ leave, expected }) => {
    const created = createWorld();
    world = created;
    const onDisk = leave(created);
    expect(() => describeIdentityMove(created.paths, "work", "client", created.ports())).toThrow(`"client" is already in use: ${onDisk} exists, and a file name that differs from ${expected} only in case is the same file on a filesystem that ignores case.`);
  });
});

describe("identity rename --move to an id under which a removed identity left state", () => {
  let world: World | undefined;

  afterEach(() => {
    if (world !== undefined) {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it.each(LEFTOVERS)("is refused, as identity add passes over the id, when $what is left: dry run and real run, with nothing changed", async ({ platform, leave, says }) => {
    const created = createWorld(platform);
    world = created;
    leave(created);
    expect(() => describeIdentityMove(created.paths, "work", "client", created.ports())).toThrow(says(created));
    const before = treeOf(created.root);
    await expect(moveIdentity(created.paths, "work", "client", created.ports())).rejects.toThrow(says(created));
    expect(treeOf(created.root)).toEqual(before);
    expect(identityIdOf(created.paths, "work")).toBe("work");
  });

});
