import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_FAILURE } from "./cliError";
import { reportFatalError } from "./cliReport";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import type { CredentialCommandPorts } from "./credentialCommand";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps, fakeCredentials } from "./test-helpers";
import { nonWaitingIdentityNamesLockPorts } from "./identityNamesLock";
import { addIdentity, removeIdentity } from "./identityStore";

const NOW = 5_000_000;

describe("identity credential locking", () => {
  let root: string;
  let paths: LayoutPaths;
  let cache: CredentialCachePort;
  let ssh: ReturnType<typeof vi.fn<CredentialCommandPorts["ssh"]>>;
  let out: string[];
  let stdinText: string;
  let duringInput: (() => void) | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-lock-test-"));
    paths = buildLayoutPaths(root);
    const entries = new Map<string, CachedCredential>();
    cache = { read: (_store, owner) => entries.get(owner), write: (_store, owner, entry) => { entries.set(owner, entry); }, remove: (_store, owner) => { entries.delete(owner); } };
    ssh = vi.fn<CredentialCommandPorts["ssh"]>().mockReturnValue({ status: 0, stdout: "\u0000agent-shim-identity-lock-v1\u0000" });
    out = [];
    stdinText = "";
    duringInput = undefined;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => { out.push(args.map(String).join(" ")); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(argv: readonly string[]): Promise<number> {
    const credentialPorts: CredentialCommandPorts = { credentials: fakeCredentials({ command: { stdout: "secret-value\n" } }), cache, platform: "linux", now: () => NOW, ssh, readInput: async () => { duringInput?.(); return await Promise.resolve(stdinText); } };
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), credentialPorts });
    try {
      await program.parseAsync([...argv], { from: "user" });
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    } catch (error) {
      return reportFatalError(error, { writeErr: (line) => { out.push(line); }, env: {} });
    }
  }

  async function identityWithCache(): Promise<void> {
    expect(await run(["identity", "add", "work"])).toBe(0);
    expect(await run(["identity", "set", "work", "--credential", "op:op://vault/work/token", "--credential-target", "oauthToken", "--credential-cache-ttl", "12h", "--credential-cache-store", "file"])).toBe(0);
  }

  it("runs a remote identity cache operation under the names lock", async () => {
    await identityWithCache();
    stdinText = '"token":"test","fetchedAt":1,"source":{"env":"TEST"}}';
    const original = cache.write;
    let locked = false;
    vi.spyOn(cache, "write").mockImplementation((store, owner, entry) => { locked = fs.existsSync(path.join(paths.root, ".identity-names.lock")); original(store, owner, entry); });
    expect(await run(["__identity-lock-v1", "work"])).toBe(0);
    expect(locked).toBe(true);
    expect(fs.existsSync(path.join(paths.root, ".identity-names.lock"))).toBe(false);
  });

  it("refuses malformed receiver input before running the cache operation", async () => {
    stdinText = "not a credential";
    expect(await run(["__identity-lock-v1", "work"])).toBe(EXIT_FAILURE);
    expect(fs.existsSync(path.join(root, "written"))).toBe(false);
  });

  it("does not execute a caller-supplied receiver script", async () => {
    await identityWithCache();
    stdinText = '"token":"test","fetchedAt":1,"source":{"env":"TEST"}}';
    await run(["__identity-lock-v1", "work", 'touch "$AGENT_SHIM_HOME/written"']);
    expect(fs.existsSync(path.join(root, "written"))).toBe(false);
  });

  it("publishes a validated remote credential in the lock-holding process", async () => {
    await identityWithCache();
    stdinText = '"token":"test","fetchedAt":1,"source":{"env":"TEST"}}';
    expect(await run(["__identity-lock-v1", "work"])).toBe(0);
    expect(cache.read("file", "identity work")?.token).toBe("test");
  });

  it("holds the identity names lock while warming an identity credential", async () => {
    await identityWithCache();
    const original = cache.write;
    let locked = false;
    vi.spyOn(cache, "write").mockImplementation((store, owner, entry) => {
      locked = fs.existsSync(path.join(paths.root, ".identity-names.lock"));
      original(store, owner, entry);
    });
    expect(await run(["credential", "warm", "work"])).toBe(0);
    expect(locked).toBe(true);
  });

  it("holds the identity names lock while storing an identity token", async () => {
    await identityWithCache();
    stdinText = ["sk", "ant", "oat1", "test-token"].join("-");
    const original = fs.renameSync;
    let locked = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".token")) locked = fs.existsSync(path.join(paths.root, ".identity-names.lock"));
      original(from, to);
    });
    try {
      expect(await run(["credential", "store", "work"]), out.join("\n")).toBe(0);
      expect(locked).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to store a token if the selected identity is replaced while reading it", async () => {
    await identityWithCache();
    stdinText = ["sk", "ant", "oat1", "test-token"].join("-");
    let replaced = false;
    duringInput = () => {
      removeIdentity(paths, "work", nonWaitingIdentityNamesLockPorts);
      addIdentity(paths, "work", { namesLock: nonWaitingIdentityNamesLockPorts });
      replaced = true;
    };
    expect(await run(["credential", "store", "work"])).toBe(EXIT_FAILURE);
    expect(replaced).toBe(true);
    expect(fs.existsSync(path.join(paths.root, "credentials", "work.token"))).toBe(false);
  });

  it("holds the identity names lock while forgetting an identity credential", async () => {
    await identityWithCache();
    const original = cache.remove;
    let locked = false;
    vi.spyOn(cache, "remove").mockImplementation((store, owner) => {
      locked = fs.existsSync(path.join(paths.root, ".identity-names.lock"));
      original(store, owner);
    });
    expect(await run(["credential", "forget", "work"])).toBe(0);
    expect(locked).toBe(true);
  });

  it("holds the identity names lock while resolving a credential to push", async () => {
    await identityWithCache();
    const original = cache.write;
    let locked = false;
    vi.spyOn(cache, "write").mockImplementation((store, owner, entry) => {
      locked = fs.existsSync(path.join(paths.root, ".identity-names.lock"));
      original(store, owner, entry);
    });
    expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
    expect(locked).toBe(true);
  });

  it("holds the source identity names lock throughout the SSH transfer", async () => {
    await identityWithCache();
    let locked = false;
    ssh.mockImplementation(() => {
      locked = fs.existsSync(path.join(paths.root, ".identity-names.lock"));
      return { status: 0, stdout: "\u0000agent-shim-identity-lock-v1\u0000" };
    });
    expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
    expect(locked).toBe(true);
  });

  it("uses the remote agent-shim lock receiver for an identity push", async () => {
    await identityWithCache();
    expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
    expect(ssh.mock.calls[0]?.[1]).toContain("__identity-lock-v1");
  });

  it("refuses a successful SSH response that does not confirm the remote lock receiver", async () => {
    await identityWithCache();
    ssh.mockReturnValue({ status: 0, stdout: "" });
    expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("remote identity lock receiver");
  });

  it("does not interpret an unconfirmed receiver's exit status as an identity result", async () => {
    await identityWithCache();
    ssh.mockReturnValue({ status: 3, stdout: "" });
    expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("remote identity lock receiver");
    expect(out.join("\n")).not.toContain("No identity on build-host");
  });
});
