import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYCHAIN_CACHE_SERVICE, KEYCHAIN_ITEM_NOT_FOUND_STATUS } from "./credentialCache";
import type { IdentityNamesLockPorts } from "./identityNamesLock";
import { addIdentity, addNewIdentity, identityIdOf, removeIdentity, requireIdentityAddable } from "./identityStore";
import { KeychainLookupError, type KeychainProbe } from "./keychainLogin";
import type { RunPort } from "./launcher/ports";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";

/** A failure `security` gives that is not an item it cannot find, as a locked Keychain gives. */
const LOCKED = 51;

/** A Keychain that holds a cached credential for each owner in `cached` and no Claude Code login, answering attribute lookups only. Every call is recorded. */
function keychainWith(cached: readonly string[]): KeychainProbe & { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run: RunPort = {
    run: (_command, args) => {
      calls.push(args);
      const account = args[args.indexOf("-a") + 1];
      const found = args[0] === "find-generic-password" && args.includes("-a") && account !== undefined && cached.includes(account) && !args.includes("-w") && !args.includes("-g");
      return { status: found ? 0 : KEYCHAIN_ITEM_NOT_FOUND_STATUS, stdout: "", stderr: "" };
    },
  };
  return { run, platform: "darwin", calls };
}

describe("the id a new identity is given", () => {
  let root: string;
  let paths: LayoutPaths;

  const store = (id: string, name: string): void => {
    fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name, allowAmbientCredential: false }));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-add-allocation-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes over an id whose cached credential the Keychain store still holds, asking by attributes only", () => {
    const keychain = keychainWith(["identity work"]);
    addNewIdentity(paths, "work", keychain, false);
    expect(identityIdOf(paths, "work")).toBe("work-2");
    expect(keychain.calls.some((args) => args.includes("-w") || args.includes("-g"))).toBe(false);
  });

  it("is not chosen, and nothing is created, when the Keychain could not be asked about a cached credential", () => {
    const locked: KeychainProbe = { run: { run: (_command, args) => ({ status: args.includes(KEYCHAIN_CACHE_SERVICE) ? LOCKED : KEYCHAIN_ITEM_NOT_FOUND_STATUS, stdout: "", stderr: "" }) }, platform: "darwin" };
    expect(() => addNewIdentity(paths, "work", locked, false)).toThrow(KeychainLookupError);
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it("is created under the id it was checked against, even when a remove frees a lower one before the names lock is taken", () => {
    store("work", "old");
    const checkedId = requireIdentityAddable(paths, "work", { run: keychainWith([]).run, platform: "linux" }, false);
    expect(checkedId).toBe("work-2");
    // Another process holds the names lock when the add asks for it, and removes old, freeing work, before it lets go.
    const lockFile = path.join(root, ".identity-names.lock");
    fs.writeFileSync(lockFile, `${JSON.stringify({ identity: "identity-names", pid: process.pid + 1, token: "another", acquiredAtMs: Date.now() })}\n`);
    const namesLock: IdentityNamesLockPorts = {
      fs: realFarmFs,
      nowMs: () => Date.now(),
      pid: process.pid,
      isRunning: () => true,
      sleep: () => {
        if (fs.existsSync(lockFile)) {
          fs.rmSync(lockFile);
          removeIdentity(paths, "old");
        }
      },
    };
    addIdentity(paths, "work", { namesLock, checkedId });
    expect(identityIdOf(paths, "work")).toBe("work-2");
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it("refuses when the id it was checked against is taken before the names lock is taken", () => {
    const checkedId = requireIdentityAddable(paths, "work", { run: keychainWith([]).run, platform: "linux" }, false);
    store(checkedId, "someone-else");
    expect(() => addIdentity(paths, "work", { checkedId })).toThrow("was taken while it was being added");
  });

  it("reads the usage log once for each pass over the ids, however many it tries: once for an add, twice for one checked first", () => {
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    const record = (identity: string): string => `${JSON.stringify({ schemaVersion: 1, at, identity, provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
    fs.writeFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), ["work", "work-2", "work-3"].map(record).join(""));
    const readdir = vi.spyOn(fs, "readdirSync");
    const logReads = (): number => readdir.mock.calls.filter(([directory]) => directory === paths.usageLogDir).length;
    addIdentity(paths, "work");
    expect(identityIdOf(paths, "work")).toBe("work-4");
    expect(logReads()).toBe(1);
    readdir.mockClear();
    // The check, then the write under the names lock, each make one pass.
    addNewIdentity(paths, "office", { run: keychainWith([]).run, platform: "linux" }, false);
    expect(logReads()).toBe(2);
  });
});
