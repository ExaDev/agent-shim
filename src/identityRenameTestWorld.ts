import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IdentityRenamePorts } from "./identityRename";
import type { FarmFs } from "./launcher/ports";
import { TOKEN_FILE_MODE } from "./identityToken";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { createFakeKeychain, type FakeKeychain } from "./keychainTestWorld";
import type { SessionProcess } from "./identitySessions";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { sameDirectory } from "./realIdentityRename";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";

/** The shape of the suffix a resync gives its superseded and scratch farms: the launcher's process id, then a UUID. */
export const SUFFIX = "4242.0f8fad5b-d9cb-469f-a165-70867728950e";
export const OTHER_SUFFIX = "17.7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const NOW_MS = 1_000;
export const OWN_PID = 4242;
export const PERMISSION_BITS = 0o777;
const OCTAL = 8;

/** A made-up login blob; the tests assert it crosses the fake Keychain boundary only on standard input. */
export const LOGIN_SECRET = '{"claudeAiOauth":{"accessToken":"made-up-value-for-the-rename-test"}}';

export interface World {
  readonly root: string;
  readonly paths: LayoutPaths;
  readonly keychain: FakeKeychain;
  readonly cache: Map<string, CachedCredential>;
  readonly sessions: Map<string, readonly SessionProcess[]>;
  /** The launches in progress, by identity name: a launcher that has recorded itself and not yet exited. */
  readonly launches: Map<string, readonly SessionProcess[]>;
  /** Delivers a signal to the handlers the rename has installed, as the process would be sent one. */
  readonly interrupt: (signal: NodeJS.Signals) => void;
  /** How many signal handlers are installed now. */
  readonly handlers: () => number;
  readonly ports: (overrides?: Partial<IdentityRenamePorts>) => IdentityRenamePorts;
  readonly read: (relative: string) => string;
  readonly json: (relative: string) => unknown;
  readonly directory: (name: string) => string;
}

export function writeFile(file: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

export function writeJson(file: string, value: unknown, mode?: number): void {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** The owner-only mode the usage store gives the files it writes. */
export const PRIVATE_FILE_MODE = 0o600;

/** A temporary state root holding an identity `work` that is referenced from every place a name is kept, and a second identity `personal` that must be left alone. */
export function createWorld(platform: NodeJS.Platform = "linux"): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-rename-test-"));
  const paths = buildLayoutPaths(root);
  const keychain = createFakeKeychain();
  const cache = new Map<string, CachedCredential>();
  const sessions = new Map<string, readonly SessionProcess[]>();
  const launches = new Map<string, readonly SessionProcess[]>();
  const handlers = new Set<(signal: NodeJS.Signals) => void>();
  const tokenFile = path.join(root, "credentials", "work.token");

  writeJson(path.join(root, "identities", "work", "identity.json"), {
    name: "work",
    allowAmbientCredential: false,
    label: "Example Org",
    credential: { sources: [{ file: tokenFile }, { env: "EXAMPLE_TOKEN" }, { file: "/example/elsewhere/work.token" }], target: "oauthToken", cache: { store: "file" } },
  });
  writeJson(path.join(root, "identities", "work", ".agent-shim-farm.json"), { version: 1, builtAtMs: 1, identity: "work", cwd: "/example/project", claudeHome: "/example/claude", materialised: [], links: [] });
  writeFile(path.join(root, "identities", "work", ".credentials.json"), "{}\n");
  writeFile(path.join(root, "identities", `.work.previous.${SUFFIX}`, "left-over.txt"), "kept\n");
  writeJson(path.join(root, "identities", "personal", "identity.json"), { name: "personal", allowAmbientCredential: false });
  writeFile(tokenFile, "a-made-up-token-file-body\n", TOKEN_FILE_MODE);
  writeJson(paths.globalConfigFile, {
    pools: {
      subs: { identities: ["work", "personal", "pool:fleet"] },
      fleet: { identities: [{ identity: "work", when: { branch: "main" } }, "personal"] },
      other: { identities: ["personal"] },
    },
    jobs: {
      burn: { target: { identity: "work" }, trigger: { beforeReset: "fiveHour", lead: "1h" }, prompt: "go", cwd: "/work", timeout: "10m" },
      pooled: { target: { pool: "subs" }, trigger: { beforeReset: "sevenDay", lead: "2h" }, prompt: "go", cwd: "/work", timeout: "10m" },
    },
    models: { virtual: { fast: { mode: "ordered", members: ["acct:work/opus", "z/glm-5.3"] } }, tiers: { opus: "acct:work/opus", sonnet: "acct:personal/sonnet" } },
  });
  writeJson(path.join(paths.configProfilesDir, "client.json"), { models: { hide: ["acct:work/haiku"], show: ["acct:personal/haiku"] } });
  writeJson(path.join(paths.configProfilesDir, "plain.json"), { description: "no model refs" });
  writeJson(paths.directoryRulesFile, {
    rules: [
      { path: "/example/project", identity: "work" },
      { path: "/example/other", identity: "personal" },
      { path: "/example/pooled", identity: "pool:subs", models: { tiers: { opus: "acct:work/opus" } } },
    ],
  });
  writeFile(paths.activeIdentityFile, "work\n");
  writeJson(path.join(paths.usageSnapshotsDir, "work.json"), { schemaVersion: 1, identity: "work", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} }, PRIVATE_FILE_MODE);
  writeJson(path.join(paths.usageSnapshotsDir, "personal.json"), { schemaVersion: 1, identity: "personal", updatedAt: "2026-10-30T10:00:00.000Z", providers: {} }, PRIVATE_FILE_MODE);
  writeJson(
    paths.usagePicksFile,
    { schemaVersion: 1, picks: { "/example/project": { identity: "work", at: "2026-10-30T10:00:00.000Z" }, "/example/other": { identity: "personal", at: "2026-10-30T10:00:00.000Z" } } },
    PRIVATE_FILE_MODE,
  );
  writeJson(paths.usageAnchorsFile, { schemaVersion: 1, handled: { work: "2026-10-30T10:00:00.000Z", personal: "2026-10-30T11:00:00.000Z" } }, PRIVATE_FILE_MODE);
  cache.set("file:identity work", { token: "a-made-up-cached-token", fetchedAt: 1, source: { env: "EXAMPLE_TOKEN" } });
  if (platform === "darwin") {
    keychain.seed(claudeCodeKeychainService(path.join(root, "identities", "work")), "alex", LOGIN_SECRET);
  }

  const cachePort: CredentialCachePort = {
    read: (store, owner) => cache.get(`${store}:${owner}`),
    write: (store, owner, entry) => {
      cache.set(`${store}:${owner}`, entry);
    },
    remove: (store, owner) => {
      cache.delete(`${store}:${owner}`);
    },
  };
  const world: World = {
    root,
    paths,
    keychain,
    cache,
    sessions,
    launches,
    interrupt: (signal) => {
      for (const handler of handlers) {
        handler(signal);
      }
    },
    handlers: () => handlers.size,
    ports: (overrides = {}) => ({
      fs: realFarmFs,
      credentialCache: { port: cachePort, platform: "linux" },
      run: keychain.run,
      platform,
      home: "/example/home",
      sameDirectory,
      sessions: { sessionsOn: (configDir) => sessions.get(configDir) ?? [] },
      launches: { liveOn: (identity) => launches.get(identity) ?? [] },
      signals: {
        onInterrupt: (handler) => {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
        turn: async () => {
          await Promise.resolve();
        },
      },
      lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined },
      ...overrides,
    }),
    read: (relative) => fs.readFileSync(path.join(root, relative), "utf8"),
    json: (relative) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
      return parsed;
    },
    directory: (name) => path.join(root, "identities", name),
  };
  return world;
}

/** Every file and directory under `root`, with the file contents and mode, so two trees compare byte for byte. */
export function treeOf(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        tree[relative] = `symlink to ${fs.readlinkSync(full)}`;
      } else if (entry.isDirectory()) {
        // The directory the rename's journals live in stays once created; empty, it is no state.
        if (entry.name === "identity-renames" && fs.readdirSync(full).length === 0) {
          continue;
        }
        tree[`${relative}/`] = "dir";
        walk(full);
      } else {
        tree[relative] = `${(fs.statSync(full).mode & PERMISSION_BITS).toString(OCTAL)} ${fs.readFileSync(full, "utf8")}`;
      }
    }
  };
  walk(root);
  return tree;
}

/** A filesystem whose first write of the anchor stamps fails, as a transient fault does. The rollback's own rewrite of that file then succeeds, so the rollback is complete. */
export function failingOnce(world: World): FarmFs {
  let failed = false;
  return {
    ...realFarmFs,
    writeFilePrivate: (file: string, contents: string): void => {
      if (file === world.paths.usageAnchorsFile && !failed) {
        failed = true;
        throw new Error("disk full");
      }
      realFarmFs.writeFilePrivate(file, contents);
    },
  };
}
