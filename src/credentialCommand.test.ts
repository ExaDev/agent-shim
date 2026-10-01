import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE, reportFatalError } from "./cliError";
import { CREDENTIAL_UNAVAILABLE_EXIT } from "./credential";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import type { CredentialCommandPorts } from "./credentialCommand";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps, fakeCredentials } from "./test-helpers";

const NOW = 5_000_000;
const SSH_CONNECTION_FAILED = 255;

function memoryCache(): CredentialCachePort & { readonly entries: Map<string, CachedCredential>; readonly removed: string[] } {
  const entries = new Map<string, CachedCredential>();
  const removed: string[] = [];
  return {
    entries,
    removed,
    read: (_store, owner) => entries.get(owner),
    write: (_store, owner, entry) => {
      entries.set(owner, entry);
    },
    remove: (store, owner) => {
      removed.push(`${store}:${owner}`);
      entries.delete(owner);
    },
  };
}

describe("credential cache commands", () => {
  let root: string;
  let paths: LayoutPaths;
  let cache: ReturnType<typeof memoryCache>;
  let ssh: ReturnType<typeof vi.fn<CredentialCommandPorts["ssh"]>>;
  let out: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-command-test-"));
    paths = buildLayoutPaths(root);
    cache = memoryCache();
    ssh = vi.fn<CredentialCommandPorts["ssh"]>().mockReturnValue(0);
    out = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Runs one invocation with fake ports and returns its exit status. */
  async function run(argv: readonly string[], command: Readonly<{ stdout: string; status?: number }> = { stdout: "secret-value\n" }): Promise<number> {
    const credentials = fakeCredentials({ command });
    const credentialPorts: CredentialCommandPorts = { credentials, cache, platform: "linux", now: () => NOW, ssh };
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), credentialPorts });
    try {
      await program.parseAsync([...argv], { from: "user" });
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    } catch (error) {
      return reportFatalError(error, {
        writeErr: (line) => {
          out.push(line);
        },
        env: {},
      });
    }
  }

  async function identityWithCache(): Promise<void> {
    expect(await run(["identity", "add", "work"])).toBe(0);
    expect(await run(["identity", "set", "work", "--credential", "op:op://vault/work/token", "--credential-target", "oauthToken", "--credential-cache-ttl", "12h", "--credential-cache-store", "file"])).toBe(0);
  }

  it("warm fills the cache from the sources and never prints the token", async () => {
    await identityWithCache();
    expect(await run(["credential", "warm", "work"])).toBe(0);
    expect(cache.entries.get("identity work")).toMatchObject({ token: "secret-value", fetchedAt: NOW });
    expect(out.join("\n")).toContain("file store");
    expect(out.join("\n")).not.toContain("secret-value");
  });

  it("warm refuses an identity whose credential is not cached, naming the flag that turns caching on", async () => {
    expect(await run(["identity", "add", "plain"])).toBe(0);
    expect(await run(["identity", "set", "plain", "--credential", "env:TOK"])).toBe(0);
    expect(await run(["credential", "warm", "plain"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("--credential-cache-ttl");
    expect(cache.entries.size).toBe(0);
  });

  it("warm exits with the credential-unavailable status when no source yields a token", async () => {
    await identityWithCache();
    expect(await run(["credential", "warm", "work"], { stdout: "" })).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
  });

  it("forget removes the cached credential", async () => {
    await identityWithCache();
    await run(["credential", "warm", "work"]);
    expect(await run(["credential", "forget", "work"])).toBe(0);
    expect(cache.entries.size).toBe(0);
    expect(cache.removed).toContain("file:identity work");
  });

  it("push writes the entry to the host over ssh on standard input, never in the command", async () => {
    await identityWithCache();
    expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
    expect(ssh).toHaveBeenCalledTimes(1);
    const [host, remoteCommand, input] = ssh.mock.calls[0] ?? [];
    expect(host).toBe("build-host");
    expect(remoteCommand).toContain("umask 077");
    expect(remoteCommand).not.toContain("secret-value");
    expect(JSON.parse(input ?? "")).toMatchObject({ token: "secret-value", fetchedAt: NOW });
    expect(out.join("\n")).not.toContain("secret-value");
  });

  it("push reports a failed ssh", async () => {
    await identityWithCache();
    ssh.mockReturnValue(SSH_CONNECTION_FAILED);
    expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
  });

  it("push refuses a host that ssh would read as an option", async () => {
    await identityWithCache();
    expect(await run(["credential", "push", "work", "-oProxyCommand=evil"])).toBe(EXIT_USAGE);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("works on a provider with --provider", async () => {
    expect(await run(["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "op:op://vault/z/key"])).toBe(0);
    expect(await run(["provider", "set", "z", "--credential-cache-ttl", "1h", "--credential-cache-store", "file"])).toBe(0);
    expect(await run(["credential", "warm", "--provider", "z"])).toBe(0);
    expect(cache.entries.get("provider z")?.token).toBe("secret-value");
    expect(await run(["credential", "forget", "--provider", "z"])).toBe(0);
    expect(cache.entries.size).toBe(0);
  });

  it("turns caching off with --no-credential-cache", async () => {
    await identityWithCache();
    expect(await run(["identity", "set", "work", "--no-credential-cache"])).toBe(0);
    expect(await run(["credential", "warm", "work"])).toBe(EXIT_FAILURE);
  });

  it("rejects a malformed ttl", async () => {
    await identityWithCache();
    expect(await run(["identity", "set", "work", "--credential-cache-ttl", "soon"])).toBe(EXIT_USAGE);
  });
});
