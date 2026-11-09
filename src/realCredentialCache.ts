import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { spawnSyncBlocking } from "./blockingSpawn";
import { isStoredName } from "./config/names";
import type { CredentialCacheStore } from "./config/schema";
import type { LayoutPaths } from "./paths";
import type { AsyncCredentialCacheEnv, CredentialCacheEnv } from "./credential";
import { requireKeychainCacheDeleted } from "./keychainLogin";
import { systemErrorCode } from "./sameDirectory";
import { CachedCredentialSchema, KEYCHAIN_CACHE_SERVICE, type AsyncCredentialCachePort, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import { BLOCKING_STEP_TIMEOUTS_MS } from "./doorBounds";

/** The `security` arguments that delete the credential cached for `owner` in the Keychain store, for a caller that runs `security` itself (the front door, without blocking). */
export function keychainCacheDeleteArgs(owner: string): readonly string[] {
  return ["delete-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner];
}

/** Owner-only permissions for the cache directory and its files. */
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/** A file name for an owner such as `identity work`: every character outside letters, digits, `.`, `_` and `-` becomes `_`, so no owner can name a path outside the cache directory. */
export function cacheFileNameFor(owner: string): string {
  return `${owner.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** The entry `raw` holds, for `owner`: undefined when it cannot be parsed or is recorded for another owner, so no owner reads another's recorded credential, whatever the store's file names do (two ids such as `a@b` and `a_b` name one file). An entry cached before owners were recorded names no owner and is treated as its own by every owner whose key names its file. */
function entryFor(raw: string, owner: string): CachedCredential | undefined {
  const entry = parseEntry(raw);
  return entry === undefined || (entry.owner !== undefined && entry.owner !== owner) ? undefined : entry;
}

/** `entry` as the file store keeps it for `owner`, with the owner recorded: the file store's file names are lossy (`cacheFileNameFor`), so the entry says whose it is. `credential push` writes the same bytes on another host. */
export function serialisedFor(entry: CachedCredential, owner: string): string {
  return JSON.stringify({ owner, ...withoutOwner(entry) });
}

/** How a cache write's temporary file is named: `TEMP_PREFIX`, the writing process's pid, `-` and a UUID. */
const TEMP_PREFIX = ".tmp-";
const TEMP_NAME = /^\.tmp-(?<pid>\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** How a release from before temporary files were named apart named one: the entry's file, `.`, the writing process's pid and `.tmp`. An entry's own file ends `.json`, so it never matches. */
const RELEASED_TEMP_NAME = /^.+\.json\.(?<pid>\d+)\.tmp$/u;

/** A temporary file beside `target` that no other write uses, in this process or another: two writes of one file can overlap (two owners whose keys name it, from the front door's concurrent requests), and each renames its own temporary file into place. */
function tempPathFor(target: string): string {
  // Named apart from the target, so it fits whatever the length of the owner's key, and in its directory, so the rename into place is atomic.
  return path.join(path.dirname(target), `${TEMP_PREFIX}${String(process.pid)}-${randomUUID()}`);
}

/** Whether process `pid` is running: signal 0 is refused with ESRCH only for a process that does not exist (EPERM is one that does, of another user). */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) !== "ESRCH";
  }
}

/** The temporary files among `entries` of the cache directory that a process no longer running left there (killed between its write and its rename), named as this release or a release before it named them, which hold a token and that nothing else will remove. */
function abandonedTempFiles(entries: readonly string[]): readonly string[] {
  return entries.filter((entry) => {
    const pid = (TEMP_NAME.exec(entry) ?? RELEASED_TEMP_NAME.exec(entry))?.groups?.pid;
    return pid !== undefined && !processRuns(Number(pid));
  });
}

/** Removes the temporary files a process no longer running left in `dir` (`abandonedTempFiles`); one gone meanwhile is no matter. */
function sweepAbandonedTempFiles(dir: string): void {
  for (const entry of abandonedTempFiles(fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    fs.rmSync(path.join(dir, entry), { force: true });
  }
}

/** `sweepAbandonedTempFiles`, without blocking the event loop. */
async function sweepAbandonedTempFilesAsync(dir: string): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(abandonedTempFiles(entries).map(async (entry) => fs.promises.rm(path.join(dir, entry), { force: true })));
}

/** What `store` keeps for `owner`'s `entry`, which the synchronous and the asynchronous store both write. The file store records the owner, its file names being lossy (`serialisedFor`); the Keychain files each entry under its exact owner account already, so its entry records none and stays readable by a release from before owners were recorded, whose entry schema rejects an `owner`. */
function storedEntry(store: CredentialCacheStore, entry: CachedCredential, owner: string): string {
  return store === "file" ? serialisedFor(entry, owner) : JSON.stringify(withoutOwner(entry));
}

/** `entry` with no owner recorded. */
function withoutOwner(entry: CachedCredential): Omit<CachedCredential, "owner"> {
  return { token: entry.token, fetchedAt: entry.fetchedAt, source: entry.source };
}

/**
 * The file-store entry for an identity whose id is not known here, which a remote host completes: the text of `serialisedFor(entry, identityCacheKey(id))` after its owner, so writing `{"owner":"identity <id>",` before it gives exactly the bytes `serialisedFor` gives for owner `identity <id>` (`identityCacheKey`). An id that `identity add` or `--move` gives out is letters, digits and `.`, `_`, `@`, `-`, none of which JSON escapes; the remote push script refuses any other id.
 */
export function identityEntryAfterOwner(entry: CachedCredential): string {
  return JSON.stringify(withoutOwner(entry)).slice("{".length);
}

function parseEntry(raw: string): CachedCredential | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = CachedCredentialSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Whether owners `first` and `second` name one cache file on a filesystem that ignores case: the file names `cacheFileNameFor` gives them are equal with case folded. A host's filesystem is not known from here, so this is what a refusal or a read that must hold on either kind of filesystem compares. */
export function sharesCacheFile(first: string, second: string): boolean {
  return cacheFileNameFor(first).toLowerCase() === cacheFileNameFor(second).toLowerCase();
}

/** Whether `parsed` is recorded for another owner of the same kind (`identity ` or `provider `) whose key names the same file as `owner`, so that other owner can read it back from `filePath(owner)`. An entry with no recorded owner, `owner`'s own entry, or an entry whose recorded owner is of another kind or does not name `filePath(owner)` is read by no other owner from that file. */
function isReadableByAnotherOwner(parsed: CachedCredential, owner: string): boolean {
  if (parsed.owner === undefined || parsed.owner === owner) {
    return false;
  }
  const prefix = owner.startsWith("provider ") ? "provider " : "identity ";
  return parsed.owner.startsWith(prefix) && isStoredName(parsed.owner.slice(prefix.length)) && sharesCacheFile(parsed.owner, owner);
}

function requireKeychain(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("the keychain credential store needs macOS; use --credential-cache-store file");
  }
}

/** Runs one `security` subcommand. `stdin`, when given, feeds `security -i` so a token never appears in the process list. */
function security(args: readonly string[], stdin?: string): { status: number | null; stdout: string } {
  const result = spawnSyncBlocking("a keychain call", "security", args, { encoding: "utf8", timeout: BLOCKING_STEP_TIMEOUTS_MS.keychain, ...(stdin === undefined ? {} : { input: stdin }), stdio: ["pipe", "pipe", "ignore"] });
  return { status: result.status, stdout: result.stdout };
}

/** `security`, run without blocking the calling thread. `stdin`, when given, feeds `security -i` so a token never appears in the process list. */
async function securityAsync(args: readonly string[], stdin?: string): Promise<{ status: number | null; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const settle = (status: number | null): void => {
      if (!settled) {
        settled = true;
        resolve({ status, stdout });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.on("error", () => {
      // The program exited before reading its input; its exit status says what happened.
    });
    child.stdin.end(stdin);
    child.once("error", () => {
      settle(null);
    });
    child.once("close", settle);
  });
}

/** How the synchronous Keychain store runs `security` and which platform it is on: the real ones unless a test supplies others, so a failed call can be tested with no Keychain. */
interface KeychainStorePorts {
  readonly run: (args: readonly string[], stdin?: string) => { status: number | null; stdout: string };
  readonly platform: NodeJS.Platform;
}

/**
 * The real `CredentialCachePort`. The file store keeps one JSON file per owner under `<root>/credential-cache`, directory 0700 and file 0600. The Keychain store keeps the entry (base64 of its JSON, which has no spaces or quotes to escape) as a generic password under `KEYCHAIN_CACHE_SERVICE`, written through `security -i` on standard input so the token is never an argument. Both treat a missing or malformed entry as no entry.
 */
export function createRealCredentialCache(root: string, keychain: KeychainStorePorts = { run: security, platform: process.platform }): CredentialCachePort {
  const dir = path.join(root, "credential-cache");
  const filePath = (owner: string): string => path.join(dir, cacheFileNameFor(owner));
  return {
    read(store: CredentialCacheStore, owner: string): CachedCredential | undefined {
      if (store === "file") {
        try {
          return entryFor(fs.readFileSync(filePath(owner), "utf8"), owner);
        } catch {
          return undefined;
        }
      }
      requireKeychain(keychain.platform);
      const result = keychain.run(["find-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner, "-w"]);
      return result.status === 0 ? entryFor(Buffer.from(result.stdout.trim(), "base64").toString("utf8"), owner) : undefined;
    },
    write(store: CredentialCacheStore, owner: string, entry: CachedCredential): void {
      const serialised = storedEntry(store, entry, owner);
      if (store === "file") {
        fs.mkdirSync(dir, { recursive: true, mode: CACHE_DIR_MODE });
        fs.chmodSync(dir, CACHE_DIR_MODE);
        sweepAbandonedTempFiles(dir);
        const target = filePath(owner);
        const temp = tempPathFor(target);
        fs.writeFileSync(temp, serialised, { mode: CACHE_FILE_MODE });
        try {
          fs.renameSync(temp, target);
        } finally {
          fs.rmSync(temp, { force: true });
        }
        return;
      }
      requireKeychain(keychain.platform);
      const encoded = Buffer.from(serialised, "utf8").toString("base64");
      const result = keychain.run(["-i"], `add-generic-password -U -s ${KEYCHAIN_CACHE_SERVICE} -a ${JSON.stringify(owner)} -w ${encoded}\n`);
      if (result.status !== 0) {
        throw new Error(`could not write the keychain credential cache for ${owner}`);
      }
    },
    remove(store: CredentialCacheStore, owner: string): void {
      if (store === "file") {
        sweepAbandonedTempFiles(dir);
        // An entry recorded for another owner whose key names the same file is that owner's, and stays; one with no recorded owner is deleted, as is one that cannot be parsed, which is no entry, since a lost credential is fetched again while one left for the wrong owner is not noticed.
        let raw: string;
        try {
          raw = fs.readFileSync(filePath(owner), "utf8");
        } catch {
          return;
        }
        const parsed = parseEntry(raw);
        if (parsed === undefined || !isReadableByAnotherOwner(parsed, owner)) {
          fs.rmSync(filePath(owner), { force: true });
        }
        return;
      }
      requireKeychain(keychain.platform);
      // An item that is not there is already forgotten; any other failure leaves the entry in the Keychain, so it is reported with the command that deletes it.
      requireKeychainCacheDeleted(owner, keychain.run([...keychainCacheDeleteArgs(owner)]).status);
    },
  };
}

/** The cache environment the real launcher hands the resolver: the real stores under this layout's root, this platform, and the wall clock. */
export function realCredentialCacheEnv(paths: LayoutPaths): CredentialCacheEnv {
  return { port: createRealCredentialCache(paths.root), platform: process.platform, now: () => Date.now() };
}

/**
 * The `AsyncCredentialCachePort` over the same stores as `createRealCredentialCache`, for a process whose event loop serves others: the file store reads and writes through the promise file API and the Keychain store runs `security` without blocking.
 */
export function createAsyncRealCredentialCache(root: string): AsyncCredentialCachePort {
  const dir = path.join(root, "credential-cache");
  const filePath = (owner: string): string => path.join(dir, cacheFileNameFor(owner));
  return {
    async read(store: CredentialCacheStore, owner: string): Promise<CachedCredential | undefined> {
      if (store === "file") {
        try {
          return entryFor(await fs.promises.readFile(filePath(owner), "utf8"), owner);
        } catch {
          return undefined;
        }
      }
      requireKeychain(process.platform);
      const result = await securityAsync(["find-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner, "-w"]);
      return result.status === 0 ? entryFor(Buffer.from(result.stdout.trim(), "base64").toString("utf8"), owner) : undefined;
    },
    async write(store: CredentialCacheStore, owner: string, entry: CachedCredential): Promise<void> {
      const serialised = storedEntry(store, entry, owner);
      if (store === "file") {
        await fs.promises.mkdir(dir, { recursive: true, mode: CACHE_DIR_MODE });
        await fs.promises.chmod(dir, CACHE_DIR_MODE);
        await sweepAbandonedTempFilesAsync(dir);
        const target = filePath(owner);
        const temp = tempPathFor(target);
        await fs.promises.writeFile(temp, serialised, { mode: CACHE_FILE_MODE });
        try {
          await fs.promises.rename(temp, target);
        } finally {
          await fs.promises.rm(temp, { force: true });
        }
        return;
      }
      requireKeychain(process.platform);
      const encoded = Buffer.from(serialised, "utf8").toString("base64");
      const result = await securityAsync(["-i"], `add-generic-password -U -s ${KEYCHAIN_CACHE_SERVICE} -a ${JSON.stringify(owner)} -w ${encoded}\n`);
      if (result.status !== 0) {
        throw new Error(`could not write the keychain credential cache for ${owner}`);
      }
    },
  };
}

/** The cache environment the front door resolves a request's credential with: `realCredentialCacheEnv`'s stores, this platform and the wall clock, read and written without blocking. */
export function realAsyncCredentialCacheEnv(paths: LayoutPaths): AsyncCredentialCacheEnv {
  return { port: createAsyncRealCredentialCache(paths.root), platform: process.platform, now: () => Date.now() };
}
