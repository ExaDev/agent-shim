import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { isFileName, MAX_NAME_BYTES } from "./config/names";
import { reportFatalError } from "./cliReport";
import { CREDENTIAL_UNAVAILABLE_EXIT, identityCacheKey } from "./credential";
import { CachedCredentialSchema, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import type { CredentialCommandPorts } from "./credentialCommand";
import { spawnSync } from "node:child_process";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps, fakeCredentials } from "./test-helpers";
import { identityIdOver } from "./identityRecords";
import { realFarmFs } from "./realPorts";
import { cacheFileNameFor, createRealCredentialCache, serialisedFor } from "./realCredentialCache";

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

/** A locale whose collation orders a glob without regard to case, as the default locale of most hosts does. */
const COLLATING_LOCALE = "en_US.UTF-8";
const EXECUTABLE_MODE = 0o755;

describe("credential cache commands", () => {
  let remoteBundleDir: string;
  let remoteBundle: string;
  let root: string;
  let paths: LayoutPaths;
  let cache: ReturnType<typeof memoryCache>;
  let ssh: ReturnType<typeof vi.fn<CredentialCommandPorts["ssh"]>>;
  let out: string[];
  /** What `credential store` reads from standard input. */
  let stdinText = "";

  beforeAll(async () => {
    remoteBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-remote-cli-"));
    remoteBundle = path.join(remoteBundleDir, "cli.cjs");
    await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: remoteBundle, banner: { js: '#!/usr/bin/env node\nconst __agentShimImportMetaUrl = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;' }, define: { "import.meta.url": "__agentShimImportMetaUrl" }, logLevel: "silent" });
    fs.chmodSync(remoteBundle, EXECUTABLE_MODE);
  });

  afterAll(() => { fs.rmSync(remoteBundleDir, { recursive: true, force: true }); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-command-test-"));
    paths = buildLayoutPaths(root);
    cache = memoryCache();
    ssh = vi.fn<CredentialCommandPorts["ssh"]>().mockReturnValue({ status: 0, stdout: "\u0000agent-shim-identity-lock-v1\u0000" });
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
    const credentialPorts: CredentialCommandPorts = { credentials, cache, platform: "linux", now: () => NOW, ssh, readInput: async () => await Promise.resolve(stdinText) };
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

  it("warm exits with the credential-unavailable status when no source yields a token, printing the agent-shim prefix once", async () => {
    await identityWithCache();
    expect(await run(["credential", "warm", "work"], { stdout: "" })).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
    expect(out.filter((line) => line.includes("has no usable credential"))).toEqual([
      "agent-shim: identity work has no usable credential: op op://vault/work/token printed no token; fill the cache from a terminal with `agent-shim credential warm work`",
    ]);
  });

  it("push exits with the credential-unavailable status when no source yields a token, printing the agent-shim prefix once", async () => {
    await identityWithCache();
    expect(await run(["credential", "push", "work", "build-host"], { stdout: "" })).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
    expect(out.filter((line) => line.includes("has no usable credential"))).toEqual([
      "agent-shim: identity work has no usable credential: op op://vault/work/token printed no token; fill the cache from a terminal with `agent-shim credential warm work`",
    ]);
    expect(ssh).not.toHaveBeenCalled();
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
    expect(remoteCommand).toContain("__identity-lock-v1");
    expect(remoteCommand).not.toContain("secret-value");
    // The remote host writes the owner, with the id it finds there, ahead of the rest of the entry.
    expect(JSON.parse(`{"owner":"identity work",${input ?? ""}`)).toMatchObject({ owner: "identity work", token: "secret-value", fetchedAt: NOW });
    expect(out.join("\n")).not.toContain("secret-value");
  });

  /** Renames work to client by name alone, so the identity client is stored under the id work. */
  async function renamedWithCache(): Promise<void> {
    await identityWithCache();
    expect(await run(["identity", "rename", "work", "client"])).toBe(0);
  }

  /** An ssh port that runs the remote command under a real `sh` with its state root at `remoteRoot`, as the remote host would, so the script's own resolution is what is tested. */
  function remotePath(remoteRoot: string): string {
    const bin = path.join(remoteRoot, ".test-bin");
    fs.mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, "agent-shim");
    if (!fs.existsSync(executable)) fs.symlinkSync(remoteBundle, executable);
    const systemPath = process.env.PATH;
    if (systemPath === undefined) throw new Error("PATH is not set");
    return `${bin}:${systemPath}`;
  }

  function remoteHost(remoteRoot: string): CredentialCommandPorts["ssh"] {
    const remoteExecutablePath = remotePath(remoteRoot);
    return (_host, remoteCommand, input) => {
      const result = spawnSync("sh", ["-c", remoteCommand], { input, encoding: "utf8", env: { PATH: remoteExecutablePath, HOME: remoteRoot, AGENT_SHIM_HOME: remoteRoot } });
      return { status: result.status, stdout: result.stdout };
    };
  }

  /** Stores an identity named `name` under id `id` in the remote root. */
  function remoteIdentity(remoteRoot: string, id: string, name: string): void {
    fs.mkdirSync(path.join(remoteRoot, "identities", id), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot, "identities", id, "identity.json"), `${JSON.stringify({ name, allowAmbientCredential: false }, null, 2)}\n`);
  }

  it("refuses a remote identity cache push while the destination names lock is held", async () => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-locked-"));
    try {
      remoteIdentity(remoteRoot, "work", "work");
      fs.writeFileSync(path.join(remoteRoot, ".identity-names.lock"), JSON.stringify({ identity: "identity-names", pid: process.pid, token: "held", acquiredAtMs: NOW }));
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain("identity operation is in progress on build-host");
      expect(fs.existsSync(path.join(remoteRoot, "credential-cache", cacheFileNameFor(identityCacheKey("work"))))).toBe(false);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("does not treat a nested name as the destination identity's name", async () => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-nested-name-"));
    try {
      remoteIdentity(remoteRoot, "other", "other");
      fs.writeFileSync(path.join(remoteRoot, "identities", "other", "identity.json"), JSON.stringify({ name: "other", nested: { name: "work" } }));
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(fs.existsSync(path.join(remoteRoot, "credential-cache", cacheFileNameFor(identityCacheKey("other"))))).toBe(false);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("resolves an escaped identity name using the canonical JSON reader", async () => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-escaped-name-"));
    try {
      remoteIdentity(remoteRoot, "work", "work");
      fs.writeFileSync(path.join(remoteRoot, "identities", "work", "identity.json"), '{"name":"\\u0077ork"}\n');
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
      expect(createRealCredentialCache(remoteRoot).read("file", "identity work")?.token).toBe("secret-value");
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("files a renamed identity's token, cache entry and refresh under its id, and clears it from there", async () => {
    await renamedWithCache();
    expect(await run(["credential", "warm", "client"])).toBe(0);
    expect([...cache.entries.keys()]).toEqual(["identity work"]);
    expect(await run(["credential", "forget", "client"])).toBe(0);
    expect(cache.removed).toContain("file:identity work");
  });

  it("stores a renamed identity's setup token in the file of its id, and points its credential there", async () => {
    await renamedWithCache();
    // Built from parts so the redaction filter, which rewrites token-shaped literals, leaves the fixture alone.
    const token = ["sk", "ant", "oat01", "made-up-body"].join("-");
    stdinText = `${token}\n`;
    expect(await run(["credential", "store", "client"])).toBe(0);
    expect(fs.readFileSync(path.join(root, "credentials", "work.token"), "utf8")).toBe(`${token}\n`);
    expect(fs.existsSync(path.join(root, "credentials", "client.token"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(paths.identitiesDir, "work", "identity.json"), "utf8"))).toMatchObject({ name: "client", credential: { sources: [{ file: path.join(root, "credentials", "work.token") }] } });
  });

  it("store leaves the token file as it was when its identity.json fails its schema or is only in a superseded farm", async () => {
    await renamedWithCache();
    // Built from parts so the redaction filter, which rewrites token-shaped literals, leaves the fixture alone.
    const token = ["sk", "ant", "oat01", "made-up-body"].join("-");
    const tokenFile = path.join(root, "credentials", "work.token");
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, "previous-token\n");
    stdinText = `${token}\n`;
    const identityJson = path.join(paths.identitiesDir, "work", "identity.json");
    const original = fs.readFileSync(identityJson, "utf8");

    // An identity.json that names the identity and fails its schema.
    fs.writeFileSync(identityJson, JSON.stringify({ name: "client", allowAmbientCredential: "yes" }));
    expect(await run(["credential", "store", "client"])).toBe(EXIT_FAILURE);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe("previous-token\n");

    // The record only in a superseded farm an interrupted resync left, the directory of the id holding none.
    fs.writeFileSync(identityJson, original);
    const superseded = path.join(paths.identitiesDir, ".work.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e");
    fs.mkdirSync(superseded);
    fs.renameSync(identityJson, path.join(superseded, "identity.json"));
    expect(await run(["credential", "store", "client"])).toBe(EXIT_FAILURE);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe("previous-token\n");
  });

  it("push finds the identity's id on the remote host by its name, which can differ from this host's", async () => {
    await renamedWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // On the remote host client is stored under client-2, and work is another identity.
      remoteIdentity(remoteRoot, "work", "other");
      remoteIdentity(remoteRoot, "client-2", "client");
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "client", "build-host"])).toBe(0);
      expect(fs.readdirSync(path.join(remoteRoot, "credential-cache"))).toEqual(["identity_client-2.json"]);
      expect(JSON.parse(fs.readFileSync(path.join(remoteRoot, "credential-cache", "identity_client-2.json"), "utf8"))).toMatchObject({ token: "secret-value" });
      expect(out.join("\n")).toContain("agent-shim identity set client --credential-cache-store file");
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push refuses, writing nothing, when no identity on the remote host has the name or more than one claims it, and takes a symlinked entry for its target", async () => {
    await renamedWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      remoteIdentity(remoteRoot, "work", "other");
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "client", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(
        'No identity on build-host is named "client", so nothing was written there. Create it there with `agent-shim identity add client`, then push again; if `agent-shim identity list` there already shows the name, do what it says for that identity there first instead, and push again.',
      );
      // The directory is client-1 and the symlink beside it, a-link, sorts first; the directory is the identity's id whatever the names.
      remoteIdentity(remoteRoot, "client-1", "client");
      fs.symlinkSync(path.join(remoteRoot, "identities", "client-1"), path.join(remoteRoot, "identities", "a-link"));
      expect(await run(["credential", "push", "client", "build-host"])).toBe(0);
      expect(fs.readdirSync(path.join(remoteRoot, "credential-cache"))).toEqual(["identity_client-1.json"]);
      remoteIdentity(remoteRoot, "client-2", "client");
      fs.rmSync(path.join(remoteRoot, "credential-cache"), { recursive: true });
      expect(await run(["credential", "push", "client", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain('More than one identity on build-host is named "client"');
      expect(fs.existsSync(path.join(remoteRoot, "credential-cache"))).toBe(false);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push reports a failed ssh", async () => {
    await identityWithCache();
    ssh.mockReturnValue({ status: SSH_CONNECTION_FAILED, stdout: "" });
    expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
  });

  it("push refuses a host that ssh would read as an option", async () => {
    await identityWithCache();
    expect(await run(["credential", "push", "work", "-oProxyCommand=evil"])).toBe(EXIT_USAGE);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("push takes the twin the local resolver keeps when both entries are symlinks, whatever the remote host's locale collates first", async (context) => {
    await renamedWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // One directory outside the identities directory, reached by two symlinks: by code unit "Bee" comes before "ant", which a locale's collation puts first.
      fs.mkdirSync(path.join(remoteRoot, "store"), { recursive: true });
      fs.writeFileSync(path.join(remoteRoot, "store", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
      const identitiesDir = path.join(remoteRoot, "identities");
      fs.mkdirSync(identitiesDir, { recursive: true });
      fs.symlinkSync(path.join(remoteRoot, "store"), path.join(identitiesDir, "ant"));
      fs.symlinkSync(path.join(remoteRoot, "store"), path.join(identitiesDir, "Bee"));
      expect(identityIdOver(realFarmFs, identitiesDir, "client")).toBe("Bee");
      // bash orders a glob by the locale's collation (dash, the sh of many Linux hosts, always by byte), so bash under a collating locale is what tells the script's own byte order from the shell's.
      const globbed = spawnSync("bash", ["-c", 'cd "$1" && printf "%s " *', "glob", identitiesDir], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: COLLATING_LOCALE } }).stdout.trim();
      if (globbed !== "ant Bee") {
        context.skip(`bash under ${COLLATING_LOCALE} lists "${globbed}", not "ant Bee": the locale's collation is not available here, so nothing can tell byte order from it`);
      }
      ssh.mockImplementation((_host, remoteCommand, input) => {
        const result = spawnSync("bash", ["-c", remoteCommand], { input, encoding: "utf8", env: { PATH: remotePath(remoteRoot), HOME: remoteRoot, AGENT_SHIM_HOME: remoteRoot, LC_ALL: COLLATING_LOCALE } });
        return { status: result.status, stdout: result.stdout };
      });
      expect(await run(["credential", "push", "client", "build-host"])).toBe(0);
      expect(fs.readdirSync(path.join(remoteRoot, "credential-cache"))).toEqual(["identity_Bee.json"]);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("works on a provider with --provider", async () => {
    expect(await run(["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "op:op://vault/z/key"])).toBe(0);
    expect(await run(["provider", "set", "z", "--credential-cache-ttl", "1h", "--credential-cache-store", "file"])).toBe(0);
    expect(await run(["credential", "warm", "--provider", "z"])).toBe(0);
    expect(cache.entries.get("provider z")?.token).toBe("secret-value");
    expect(await run(["credential", "forget", "--provider", "z"])).toBe(0);
    expect(cache.entries.size).toBe(0);
  });

  it("push records the owner of the entry it writes: the identity's id on the remote host, which no other id naming the same file there reads", async () => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // On the remote host work is stored under a_b, beside an identity stored under a@b, whose id names the same cache file.
      remoteIdentity(remoteRoot, "a@b", "other");
      remoteIdentity(remoteRoot, "a_b", "work");
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
      const written = fs.readFileSync(path.join(remoteRoot, "credential-cache", cacheFileNameFor(identityCacheKey("a_b"))), "utf8");
      expect(written).toBe(serialisedFor({ token: "secret-value", fetchedAt: NOW, source: { op: "op://vault/work/token" } }, identityCacheKey("a_b")));
      expect(CachedCredentialSchema.parse(JSON.parse(written))).toMatchObject({ owner: identityCacheKey("a_b") });
      const remoteCache = createRealCredentialCache(remoteRoot);
      expect(remoteCache.read("file", identityCacheKey("a_b"))?.token).toBe("secret-value");
      expect(remoteCache.read("file", identityCacheKey("a@b"))).toBeUndefined();
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  /** Runs `argv` against the remote root as agent-shim on the remote host would, returning its exit status: how these tests follow a refusal's route there, with agent-shim alone. */
  async function onRemote(remoteRoot: string, argv: readonly string[]): Promise<number> {
    const program = buildProgram({ ...fakeCommandDeps(buildLayoutPaths(remoteRoot)), runClaude: vi.fn() });
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

  /** The route a refusal gives for an identity named work that a push cannot write for there. */
  const ASIDE_ROUTE =
    "On that host, give that identity another name with `agent-shim identity rename work work-old` (or another unused name), create the one to push to with `agent-shim identity add work`, which picks an id a push can write for, and push again. The identity renamed aside keeps its id, credential, cached entry and sign-in as they were.";

  /** Every file under the remote root's credentials/ and credential-cache/ directories with its bytes. */
  function credentialFiles(remoteRoot: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const dir of ["credentials", "credential-cache"]) {
      for (const name of fs.existsSync(path.join(remoteRoot, dir)) ? fs.readdirSync(path.join(remoteRoot, dir)) : []) {
        files[`${dir}/${name}`] = fs.readFileSync(path.join(remoteRoot, dir, name), "utf8");
      }
    }
    return files;
  }

  /** An identity's identity.json in the remote root, parsed. */
  function remoteRecord(remoteRoot: string, id: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(remoteRoot, "identities", id, "identity.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`identities/${id}/identity.json is not an object`);
    }
    return { ...parsed };
  }

  /** Lays out a remote host where the identity named work is stored under `remoteId`, with a credential block reading credentials/old.token, beside identities under w_rk and a_b with cached entries, and caches work's own entry where its file is no other's. */
  function remoteWithOthers(remoteRoot: string, remoteId: string): void {
    remoteIdentity(remoteRoot, "w_rk", "other");
    remoteIdentity(remoteRoot, "a_b", "ab");
    fs.mkdirSync(path.join(remoteRoot, "identities", remoteId), { recursive: true });
    fs.writeFileSync(
      path.join(remoteRoot, "identities", remoteId, "identity.json"),
      `${JSON.stringify({ name: "work", allowAmbientCredential: false, credential: { sources: [{ file: path.join(remoteRoot, "credentials", "old.token") }], target: "oauthToken", cache: { ttl: "12h", store: "file" } } }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(remoteRoot, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot, "credentials", "old.token"), "old-token\n");
    const remoteCache = createRealCredentialCache(remoteRoot);
    remoteCache.write("file", identityCacheKey("w_rk"), { token: "w_rk-token", fetchedAt: NOW, source: { env: "T" } });
    remoteCache.write("file", identityCacheKey("a_b"), { token: "a_b-token", fetchedAt: NOW, source: { env: "T" } });
    if (![identityCacheKey("w_rk"), identityCacheKey("a_b")].map(cacheFileNameFor).includes(cacheFileNameFor(identityCacheKey(remoteId)))) {
      remoteCache.write("file", identityCacheKey(remoteId), { token: "old-cached", fetchedAt: NOW, source: { env: "T" } });
    }
  }

  it.each(["wörk", 'wo"rk', "-work"])(
    "push refuses, writing nothing, an identity stored on the remote host under the id %s, which it cannot write for, and lands after the route the refusal gives, which runs only agent-shim there and leaves that identity's files as they were",
    async (remoteId) => {
      await identityWithCache();
      const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
      try {
        remoteWithOthers(remoteRoot, remoteId);
        const filesBefore = credentialFiles(remoteRoot);
        const recordBefore = remoteRecord(remoteRoot, remoteId);
        ssh.mockImplementation(remoteHost(remoteRoot));
        expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
        expect(out.join("\n")).toContain(`The identity named "work" on build-host is stored under the id ${JSON.stringify(remoteId)}, which a push cannot write for, so nothing was written there. ${ASIDE_ROUTE}`);
        expect(credentialFiles(remoteRoot)).toEqual(filesBefore);
        // The route, followed with agent-shim alone on the remote host.
        expect(await onRemote(remoteRoot, ["identity", "rename", "work", "work-old"])).toBe(0);
        expect(await onRemote(remoteRoot, ["identity", "add", "work"])).toBe(0);
        expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
        // The identity renamed aside changed only its name; every credential and cache file there is as it was, beside the new identity's entry, which that identity reads.
        expect(remoteRecord(remoteRoot, remoteId)).toEqual({ ...recordBefore, name: "work-old" });
        const newId = identityIdOver(realFarmFs, path.join(remoteRoot, "identities"), "work");
        expect(newId).toBe("work");
        const newFile = `credential-cache/${cacheFileNameFor(identityCacheKey("work"))}`;
        expect(Object.keys(filesBefore)).not.toContain(newFile);
        const { [newFile]: written, ...rest } = credentialFiles(remoteRoot);
        expect(rest).toEqual(filesBefore);
        expect(written).toBeDefined();
        expect(createRealCredentialCache(remoteRoot).read("file", identityCacheKey("work"))).toMatchObject({ owner: identityCacheKey("work"), token: "secret-value" });
      } finally {
        fs.rmSync(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it("push to an identity whose only directory there has a leading dot refuses as having no identity of the name, and lands once identity add creates one, leaving that directory as it was", async () => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      remoteIdentity(remoteRoot, ".work", "work");
      const hidden = fs.readFileSync(path.join(remoteRoot, "identities", ".work", "identity.json"), "utf8");
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain('No identity on build-host is named "work", so nothing was written there.');
      expect(await onRemote(remoteRoot, ["identity", "add", "work"])).toBe(0);
      expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
      expect(fs.readFileSync(path.join(remoteRoot, "identities", ".work", "identity.json"), "utf8")).toBe(hidden);
      expect(createRealCredentialCache(remoteRoot).read("file", identityCacheKey(identityIdOver(realFarmFs, path.join(remoteRoot, "identities"), "work") ?? ""))).toMatchObject({ token: "secret-value" });
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it.each([".work", "-work", "work-", "a@b", "w\u00f6rk", 'a"b', "work\n", "wo\nrk", "Work.2_x", "a".repeat(MAX_NAME_BYTES), "a".repeat(MAX_NAME_BYTES + 1)])(
    "push to an identity stored on the remote host under id %s lands exactly when isFileName accepts that id, and otherwise writes nothing",
    async (remoteId) => {
      await identityWithCache();
      const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
      try {
        remoteIdentity(remoteRoot, remoteId, "work");
        ssh.mockImplementation(remoteHost(remoteRoot));
        const accepted = isFileName(remoteId);
        expect(await run(["credential", "push", "work", "build-host"])).toBe(accepted ? 0 : EXIT_FAILURE);
        expect(fs.existsSync(path.join(remoteRoot, "credential-cache"))).toBe(accepted);
      } finally {
        fs.rmSync(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  /** The shells a host's `/bin/sh` can be, as far as they are installed here: the push script is written in POSIX `sh` and must read the same under each. */
  const POSIX_SHELLS = ["/bin/sh", "dash", "bash", "ksh", "zsh"].filter((shell) => spawnSync(shell, ["-c", "true"]).status === 0);

  it.each(POSIX_SHELLS)("under %s, push to an id with a newline refuses it, shown as a JSON string, and never writes for the identity whose id is the same without the newline", async (shell) => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // work is stored under "work\n", and another identity, other, under work, with a cached credential that is perhaps the host's only copy.
      remoteIdentity(remoteRoot, "work\n", "work");
      remoteIdentity(remoteRoot, "work", "other");
      const remoteCache = createRealCredentialCache(remoteRoot);
      remoteCache.write("file", identityCacheKey("work"), { token: "other-token", fetchedAt: NOW, source: { op: "op://vault/other/token" } });
      const filesBefore = credentialFiles(remoteRoot);
      ssh.mockImplementation((_host, remoteCommand, input) => {
        const result = spawnSync(shell, ["-c", remoteCommand.replace(/^exec \/bin\/sh /u, `exec ${shell} `)], { input, encoding: "utf8", env: { PATH: remotePath(remoteRoot), HOME: remoteRoot, AGENT_SHIM_HOME: remoteRoot } });
        return { status: result.status, stdout: result.stdout };
      });
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain('The identity named "work" on build-host is stored under the id "work\\n", which a push cannot write for');
      expect(credentialFiles(remoteRoot)).toEqual(filesBefore);
      expect(remoteCache.read("file", identityCacheKey("work"))).toMatchObject({ token: "other-token" });

      // An id the pattern accepts still lands under the same shell, beside the other identity stored under work.
      fs.rmSync(path.join(remoteRoot, "identities", "work\n"), { recursive: true });
      remoteIdentity(remoteRoot, "client", "work");
      expect(await run(["credential", "push", "work", "build-host"])).toBe(0);
      expect(remoteCache.read("file", identityCacheKey("client"))).toMatchObject({ token: "secret-value" });
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push refuses, writing nothing, when the cache file of the identity's id there holds another identity's credential, names that file under the remote root, and lands after the same route, leaving that credential as it was", async () => {
    expect(await run(["identity", "add", "joe@x.io"])).toBe(0);
    expect(await run(["identity", "set", "joe@x.io", "--credential", "op:op://vault/work/token", "--credential-target", "oauthToken", "--credential-cache-ttl", "12h", "--credential-cache-store", "file"])).toBe(0);
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // On the remote host joe@x.io is stored under its own name as id, beside another identity under joe_x.io, whose cached credential (perhaps the host's only copy) is in the file both ids name.
      remoteIdentity(remoteRoot, "joe_x.io", "other");
      remoteIdentity(remoteRoot, "joe@x.io", "joe@x.io");
      const remoteCache = createRealCredentialCache(remoteRoot);
      remoteCache.write("file", identityCacheKey("joe_x.io"), { token: "other-token", fetchedAt: NOW, source: { op: "op://vault/other/token" } });
      const filesBefore = credentialFiles(remoteRoot);
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "joe@x.io", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(
        `The cache file ${remoteRoot}/credential-cache/identity_joe_x.io.json on build-host already holds a credential recorded for identity joe_x.io, not for identity joe@x.io, so nothing was written there, and that entry is left as it is. On that host, give that identity another name with \`agent-shim identity rename joe@x.io joe@x.io-old\` (or another unused name), create the one to push to with \`agent-shim identity add joe@x.io\`, which picks an id a push can write for, and push again. The identity renamed aside keeps its id, credential, cached entry and sign-in as they were.`,
      );
      expect(credentialFiles(remoteRoot)).toEqual(filesBefore);
      expect(await onRemote(remoteRoot, ["identity", "rename", "joe@x.io", "joe@x.io-old"])).toBe(0);
      expect(await onRemote(remoteRoot, ["identity", "add", "joe@x.io"])).toBe(0);
      expect(await run(["credential", "push", "joe@x.io", "build-host"])).toBe(0);
      const newId = identityIdOver(realFarmFs, path.join(remoteRoot, "identities"), "joe@x.io");
      expect(newId).toBe("joe@x.io-2");
      expect(remoteCache.read("file", identityCacheKey("joe@x.io-2"))).toMatchObject({ token: "secret-value" });
      expect(remoteCache.read("file", identityCacheKey("joe_x.io"))).toMatchObject({ token: "other-token" });
      const { [`credential-cache/${cacheFileNameFor(identityCacheKey("joe@x.io-2"))}`]: written, ...rest } = credentialFiles(remoteRoot);
      expect(written).toBeDefined();
      expect(rest).toEqual(filesBefore);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { held: "an entry with no owner", content: JSON.stringify({ token: "old", fetchedAt: 1, source: { env: "T" } }), lands: true },
    { held: "the identity's own entry", content: JSON.stringify({ owner: "identity a_b", token: "old", fetchedAt: 1, source: { env: "T" } }), lands: true },
    { held: "a file that is not an entry", content: "not json", lands: true },
    { held: "another identity's entry", content: JSON.stringify({ owner: "identity a@b", token: "old", fetchedAt: 1, source: { env: "T" } }), lands: false },
    { held: "another identity's entry with its owner after the token", content: JSON.stringify({ token: "old", fetchedAt: 1, source: { env: "T" }, owner: "identity a@b" }), lands: false },
    { held: "another identity's entry with spaces around its owner", content: '{ "owner" : "identity a@b", "token": "old", "fetchedAt": 1, "source": { "env": "T" } }', lands: false },
    { held: "an owner that is not a string", content: '{"owner":null,"token":"old","fetchedAt":1,"source":{"env":"T"}}', lands: false },
    { held: "an entry naming its own owner and another's", content: '{"owner":"identity a_b","token":"old","fetchedAt":1,"source":{"env":"T"},"owner":"identity a@b"}', lands: false },
  ])("push to an id whose cache file there holds $held writes the entry exactly when lands is $lands", async ({ content, lands }) => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      remoteIdentity(remoteRoot, "a_b", "work");
      const file = path.join(remoteRoot, "credential-cache", cacheFileNameFor(identityCacheKey("a_b")));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(lands ? 0 : EXIT_FAILURE);
      if (lands) {
        expect(createRealCredentialCache(remoteRoot).read("file", identityCacheKey("a_b"))).toMatchObject({ owner: identityCacheKey("a_b"), token: "secret-value" });
      } else {
        expect(fs.readFileSync(file, "utf8")).toBe(content);
        expect(out.join("\n")).toContain(`already holds a credential recorded for ${content.includes("null") ? "an owner that is not a string" : "identity a@b"}, not for identity work,`);
      }
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("says in the help of push that a host on a release from before owners were recorded reads the entry as no entry", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() });
    const push = program.commands.find((command) => command.name() === "credential")?.commands.find((command) => command.name() === "push");
    expect(push?.description()).toContain("The entry records its owner, which a host running a release from before owners were recorded reads as no entry, so upgrade that host first.");
  });

  it("push of a provider's credential records the provider as the owner", async () => {
    expect(await run(["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "op:op://vault/z/key"])).toBe(0);
    expect(await run(["provider", "set", "z", "--credential-cache-ttl", "1h", "--credential-cache-store", "file"])).toBe(0);
    expect(await run(["credential", "push", "x", "build-host", "--provider", "z"])).toBe(0);
    const [, , input] = ssh.mock.calls[0] ?? [];
    expect(CachedCredentialSchema.parse(JSON.parse(input ?? ""))).toMatchObject({ owner: "provider z", token: "secret-value" });
  });

  /** Defines provider `name` with a file-cached credential in `paths`' state root, as `provider add` and `provider set` there do. */
  async function cachedProvider(argvRun: (argv: readonly string[]) => Promise<number>, name: string): Promise<void> {
    expect(await argvRun(["provider", "add", name, "--display-name", name, "--base-url", "https://api.example.com/anthropic", "--credential", "op:op://vault/z/key"])).toBe(0);
    expect(await argvRun(["provider", "set", name, "--credential-cache-ttl", "1h", "--credential-cache-store", "file"])).toBe(0);
  }

  /** Stores a provider under `name`, which can be one an older release allowed: added under a plain name, then its file renamed. */
  async function legacyProvider(argvRun: (argv: readonly string[]) => Promise<number>, providersDir: string, name: string): Promise<void> {
    await cachedProvider(argvRun, "legacy-source");
    fs.renameSync(path.join(providersDir, "legacy-source.json"), path.join(providersDir, `${name}.json`));
  }

  it.each(['p"q', "a!b", "my provider", "line\nbreak"])("push of the provider %j, stored under a name provider add does not give, is refused before anything is read or sent, and the name is renamed here first", async (name) => {
    await legacyProvider(run, paths.providersDir, name);
    expect(await run(["credential", "push", "x", "build-host", "--provider", name])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain(`Provider ${JSON.stringify(name)} cannot be pushed: its name must start with a letter or digit, contain only letters, digits, dots, dashes, underscores and at signs, and be at most`);
    expect(out.join("\n")).toContain("agent-shim provider rename <name> <new name>");
    expect(ssh).not.toHaveBeenCalled();
  });

  it.each([
    { remoteName: 'p"q', pushed: "p_q", rename: `agent-shim provider rename 'p"q' 'p"q-2'`, found: 'Whether a provider "p\\"q" is defined' },
    { remoteName: "my provider", pushed: "my_provider", rename: "agent-shim provider rename 'my provider' 'my provider-2'", found: 'give provider "my provider" another name' },
  ])("push of the provider $pushed over the entry of the legacy provider $remoteName there prints the remedy with that name quoted for a shell", async ({ remoteName, pushed, rename, found }) => {
    await cachedProvider(run, pushed);
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      await legacyProvider(async (argv) => await onRemote(remoteRoot, argv), path.join(remoteRoot, "providers"), remoteName);
      createRealCredentialCache(remoteRoot).write("file", `provider ${remoteName}`, { token: "legacy-token", fetchedAt: NOW, source: { env: "T" } });
      const filesBefore = credentialFiles(remoteRoot);
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "x", "build-host", "--provider", pushed])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(rename);
      expect(out.join("\n")).toContain(found);
      expect(credentialFiles(remoteRoot)).toEqual(filesBefore);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push of the provider z over the entry of the provider Z there says to rename Z, which reads that entry where the filesystem ignores case, not that no provider does", async () => {
    await cachedProvider(run, "z");
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      await cachedProvider(async (argv) => await onRemote(remoteRoot, argv), "Z");
      const file = path.join(remoteRoot, "credential-cache", cacheFileNameFor("provider z"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ owner: "provider Z", token: "z-upper-token", fetchedAt: NOW, source: { env: "T" } }));
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "x", "build-host", "--provider", "z"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain('give provider "Z" another name with `agent-shim provider rename Z Z-2`');
      expect(out.join("\n")).not.toContain("No provider reads that entry");
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push of a provider refuses, writing nothing, when its cache file there holds another provider's credential, whose name names the same file, and lands once that provider is renamed there, which keeps its credential", async () => {
    await cachedProvider(run, "a@b");
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      await cachedProvider(async (argv) => await onRemote(remoteRoot, argv), "a_b");
      const remoteCache = createRealCredentialCache(remoteRoot);
      remoteCache.write("file", "provider a_b", { token: "a_b-token", fetchedAt: NOW, source: { env: "T" } });
      const filesBefore = credentialFiles(remoteRoot);
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(
        `The cache file ${remoteRoot}/credential-cache/provider_a_b.json on build-host already holds a credential recorded for provider a_b, not for provider a@b, so nothing was written there, and that entry is left as it is. On that host, give provider "a_b" another name with \`agent-shim provider rename a_b a_b-2\` (or another unused name), which moves its cached credential to that name's file, and push again.`,
      );
      expect(credentialFiles(remoteRoot)).toEqual(filesBefore);
      expect(await onRemote(remoteRoot, ["provider", "rename", "a_b", "a_b-2"])).toBe(0);
      expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(0);
      expect(remoteCache.read("file", "provider a@b")).toMatchObject({ owner: "provider a@b", token: "secret-value" });
      expect(remoteCache.read("file", "provider a_b-2")).toMatchObject({ token: "a_b-token" });
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { held: "an entry with no owner", content: JSON.stringify({ token: "old", fetchedAt: 1, source: { env: "T" } }), lands: true },
    { held: "the provider's own entry", content: JSON.stringify({ owner: "provider a@b", token: "old", fetchedAt: 1, source: { env: "T" } }), lands: true },
    { held: "a file that is not an entry", content: "not json", lands: true },
    { held: "another provider's entry", content: JSON.stringify({ owner: "provider a_b", token: "old", fetchedAt: 1, source: { env: "T" } }), lands: false },
    { held: "an owner that is not a string", content: '{"owner":null,"token":"old","fetchedAt":1,"source":{"env":"T"}}', lands: false },
  ])("push of a provider whose cache file there holds $held writes the entry exactly when lands is $lands", async ({ content, lands }) => {
    await cachedProvider(run, "a@b");
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      const file = path.join(remoteRoot, "credential-cache", cacheFileNameFor("provider a@b"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      ssh.mockImplementation(remoteHost(remoteRoot));
      expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(lands ? 0 : EXIT_FAILURE);
      if (lands) {
        expect(createRealCredentialCache(remoteRoot).read("file", "provider a@b")).toMatchObject({ owner: "provider a@b", token: "secret-value" });
      } else {
        expect(fs.readFileSync(file, "utf8")).toBe(content);
      }
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("push of a provider over an entry whose owner is not a provider's or is a provider not defined on the remote host says to forget it there, and lands once that is done even before the provider is added there", async () => {
    await cachedProvider(run, "a@b");
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      const file = path.join(remoteRoot, "credential-cache", cacheFileNameFor("provider a@b"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      ssh.mockImplementation(remoteHost(remoteRoot));

      for (const [content, held] of [
        ['{"owner":null,"token":"old","fetchedAt":1,"source":{"env":"T"}}', "an owner that is not a string"],
        [JSON.stringify({ owner: "identity work", token: "old", fetchedAt: 1, source: { env: "T" } }), "identity work"],
      ] as const) {
        out.length = 0;
        fs.writeFileSync(file, content);
        expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(EXIT_FAILURE);
        expect(out.join("\n")).toContain(
          `already holds a credential recorded for ${held}, not for provider a@b, so nothing was written there, and that entry is left as it is. No provider reads that entry: remove it there with \`agent-shim credential forget --provider a@b\`, and push again.`,
        );
        expect(await onRemote(remoteRoot, ["credential", "forget", "--provider", "a@b"])).toBe(0);
        expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(0);
        expect(createRealCredentialCache(remoteRoot).read("file", "provider a@b")).toMatchObject({ token: "secret-value" });
      }

      // A cached entry recorded for provider a_b on a host where providers/a_b.json does not exist.
      out.length = 0;
      fs.writeFileSync(file, JSON.stringify({ owner: "provider a_b", token: "old", fetchedAt: 1, source: { env: "T" } }));
      expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(
        `already holds a credential recorded for provider a_b, not for provider a@b, so nothing was written there, and that entry is left as it is. No provider on that host is named "a_b": remove that entry there with \`agent-shim credential forget --provider a_b\`, and push again.`,
      );
      expect(await onRemote(remoteRoot, ["credential", "forget", "--provider", "a_b"])).toBe(0);
      expect(await run(["credential", "push", "x", "build-host", "--provider", "a@b"])).toBe(0);
      expect(createRealCredentialCache(remoteRoot).read("file", "provider a@b")).toMatchObject({ token: "secret-value" });
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("runs the push script under /bin/sh, so a remote login shell that refuses an unmatched glob (zsh) and prints at start-up still gets each refusal", async (context) => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      const commands: string[] = [];
      ssh.mockImplementation((_host, remoteCommand, input) => {
        commands.push(remoteCommand);
        // As OpenSSH runs a remote command: in the account's login shell, whose start-up files can print to standard output first.
        const result = spawnSync("zsh", ["-c", `print -- 'a start-up line'; ${remoteCommand}`], { input, encoding: "utf8", env: { PATH: remotePath(remoteRoot), HOME: remoteRoot, AGENT_SHIM_HOME: remoteRoot } });
        return { status: result.status, stdout: result.stdout };
      });
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      // Whatever shell answered, the command hands the script to /bin/sh.
      expect(commands[0]?.startsWith("exec /bin/sh -c '")).toBe(true);
      if (spawnSync("zsh", ["-c", "true"]).status !== 0) {
        context.skip("zsh is not installed here, so only the command's form is checked");
      }
      // A host with no identities directory: the glob matches nothing, which zsh alone would refuse.
      expect(out.join("\n")).toContain('No identity on build-host is named "work", so nothing was written there.');
      remoteIdentity(remoteRoot, "wörk", "work");
      out.length = 0;
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain('The identity named "work" on build-host is stored under the id "wörk", which a push cannot write for');
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it("runs the push script under a tcsh login shell without history-expansion or newline quoting errors, frames the reply marker against field collisions, and treats a markerless status 5 or 6 as a failed ssh", async (context) => {
    await identityWithCache();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credential-push-remote-"));
    try {
      // An existing foreign entry whose owner ends with the reply marker string.
      remoteIdentity(remoteRoot, "a_b", "work");
      const file = path.join(remoteRoot, "credential-cache", cacheFileNameFor(identityCacheKey("a_b")));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ owner: "identity agent-shim-push-reply", token: "old", fetchedAt: 1, source: { env: "T" } }));
      const available = spawnSync("/bin/tcsh", ["-c", "exit 0"]).status === 0;
      // The remote command's form is asserted by the mock below on every platform that can run tcsh.
      if (!available) {
        context.skip("tcsh is not installed here, so only the command's form is checked");
      }
      const shell = "/bin/tcsh";
      ssh.mockImplementation((_host, remoteCommand, input) => {
        expect(remoteCommand).not.toContain("!");
        expect(remoteCommand).not.toContain("\n");
        const result = spawnSync(shell, ["-c", remoteCommand], { input, encoding: "utf8", env: { PATH: remotePath(remoteRoot), HOME: remoteRoot, AGENT_SHIM_HOME: remoteRoot } });
        return { status: result.status, stdout: result.stdout };
      });
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain(
        `The cache file ${remoteRoot}/credential-cache/identity_a_b.json on build-host already holds a credential recorded for identity agent-shim-push-reply, not for identity work,`,
      );

      out.length = 0;
      fs.writeFileSync(file, JSON.stringify({ owner: "agent-shim-push-reply", token: "old", fetchedAt: 1, source: { env: "T" } }));
      expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
      expect(out.join("\n")).toContain("already holds a credential recorded for agent-shim-push-reply, not for identity work,");

      // The remote script's refusal statuses (unsafe id, foreign entry), here without the reply it prints with them.
      const unsafeIdStatus = 5;
      const foreignEntryStatus = 6;
      for (const status of [unsafeIdStatus, foreignEntryStatus]) {
        out.length = 0;
        ssh.mockReturnValueOnce({ status, stdout: "" });
        expect(await run(["credential", "push", "work", "build-host"])).toBe(EXIT_FAILURE);
        expect(out.join("\n")).toContain("remote identity lock receiver");
      }
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
    }
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
