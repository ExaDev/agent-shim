import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CredentialCacheStore } from "./config/schema";
import type { AsyncCredentialCacheEnv, CredentialCacheEnv } from "./credential";
import type { LayoutPaths } from "./paths";
import { CachedCredentialSchema, type AsyncCredentialCachePort, type CachedCredential, type CredentialCachePort } from "./credentialCache";

/** The Keychain service every cached credential is filed under; the owner (`identity work`) is the account. */
const KEYCHAIN_CACHE_SERVICE = "agent-shim-credential-cache";

/** Owner-only permissions for the cache directory and its files. */
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/** A file name for an owner such as `identity work`: every character outside letters, digits, `.`, `_` and `-` becomes `_`, so no owner can name a path outside the cache directory. */
export function cacheFileNameFor(owner: string): string {
  return `${owner.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
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

function requireKeychain(): void {
  if (process.platform !== "darwin") {
    throw new Error("the keychain credential store needs macOS; use --credential-cache-store file");
  }
}

/** Runs one `security` subcommand. `stdin`, when given, feeds `security -i` so a token never appears in the process list. */
function security(args: readonly string[], stdin?: string): { status: number | null; stdout: string } {
  const result = spawnSync("security", args, { encoding: "utf8", ...(stdin === undefined ? {} : { input: stdin }), stdio: ["pipe", "pipe", "ignore"] });
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

/**
 * The real `CredentialCachePort`. The file store keeps one JSON file per owner under `<root>/credential-cache`, directory 0700 and file 0600. The Keychain store keeps the entry (base64 of its JSON, which has no spaces or quotes to escape) as a generic password under `KEYCHAIN_CACHE_SERVICE`, written through `security -i` on standard input so the token is never an argument. Both treat a missing or malformed entry as no entry.
 */
export function createRealCredentialCache(root: string): CredentialCachePort {
  const dir = path.join(root, "credential-cache");
  const filePath = (owner: string): string => path.join(dir, cacheFileNameFor(owner));
  return {
    read(store: CredentialCacheStore, owner: string): CachedCredential | undefined {
      if (store === "file") {
        try {
          return parseEntry(fs.readFileSync(filePath(owner), "utf8"));
        } catch {
          return undefined;
        }
      }
      requireKeychain();
      const result = security(["find-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner, "-w"]);
      return result.status === 0 ? parseEntry(Buffer.from(result.stdout.trim(), "base64").toString("utf8")) : undefined;
    },
    write(store: CredentialCacheStore, owner: string, entry: CachedCredential): void {
      const serialised = JSON.stringify(entry);
      if (store === "file") {
        fs.mkdirSync(dir, { recursive: true, mode: CACHE_DIR_MODE });
        fs.chmodSync(dir, CACHE_DIR_MODE);
        const target = filePath(owner);
        const temp = `${target}.${String(process.pid)}.tmp`;
        fs.writeFileSync(temp, serialised, { mode: CACHE_FILE_MODE });
        fs.renameSync(temp, target);
        return;
      }
      requireKeychain();
      const encoded = Buffer.from(serialised, "utf8").toString("base64");
      const result = security(["-i"], `add-generic-password -U -s ${KEYCHAIN_CACHE_SERVICE} -a ${JSON.stringify(owner)} -w ${encoded}\n`);
      if (result.status !== 0) {
        throw new Error(`could not write the keychain credential cache for ${owner}`);
      }
    },
    remove(store: CredentialCacheStore, owner: string): void {
      if (store === "file") {
        fs.rmSync(filePath(owner), { force: true });
        return;
      }
      requireKeychain();
      security(["delete-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner]);
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
          return parseEntry(await fs.promises.readFile(filePath(owner), "utf8"));
        } catch {
          return undefined;
        }
      }
      requireKeychain();
      const result = await securityAsync(["find-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner, "-w"]);
      return result.status === 0 ? parseEntry(Buffer.from(result.stdout.trim(), "base64").toString("utf8")) : undefined;
    },
    async write(store: CredentialCacheStore, owner: string, entry: CachedCredential): Promise<void> {
      const serialised = JSON.stringify(entry);
      if (store === "file") {
        await fs.promises.mkdir(dir, { recursive: true, mode: CACHE_DIR_MODE });
        await fs.promises.chmod(dir, CACHE_DIR_MODE);
        const target = filePath(owner);
        const temp = `${target}.${String(process.pid)}.tmp`;
        await fs.promises.writeFile(temp, serialised, { mode: CACHE_FILE_MODE });
        await fs.promises.rename(temp, target);
        return;
      }
      requireKeychain();
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
