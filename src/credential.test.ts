import { describe, expect, it } from "vitest";

import type { Credential } from "./config/schema";
import {
  commandArgv,
  CREDENTIAL_COMMAND_TIMEOUT_MS,
  CREDENTIAL_INTERACTIVE_TIMEOUT_MS,
  credentialVariables,
  describeCredential,
  isInteractiveSource,
  resolveCredential,
  summariseCredential,
} from "./credential";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { fakeCredentials } from "./test-helpers";

const resolve = (credential: Credential, env: Readonly<Record<string, string | undefined>>, port = fakeCredentials()) =>
  resolveCredential({ credential, env, port, subject: "provider z" });

/** The refusal message of a resolution, or the empty string when it resolved. */
const messageOf = (result: ReturnType<typeof resolve>): string => (result.ok ? "" : result.message);

describe("resolveCredential", () => {
  it("returns the first source that yields a token, with the block's target, and tries nothing after it", () => {
    const port = fakeCredentials({ command: { stdout: "from-op\n" } });
    const result = resolve({ sources: [{ env: "Z_API_TOKEN" }, { op: "op://vault/z/credential" }], target: "apiKey" }, { Z_API_TOKEN: "tok-z" }, port);
    expect(result).toEqual({ ok: true, credential: { target: "apiKey", token: "tok-z", source: { env: "Z_API_TOKEN" }, warnings: [] } });
    expect(port.runCommand).not.toHaveBeenCalled();
  });

  it("falls through an unset or empty env source to the next one", () => {
    const port = fakeCredentials({ command: { stdout: "  from-op  \n" } });
    for (const env of [{}, { Z_API_TOKEN: "" }]) {
      const result = resolve({ sources: [{ env: "Z_API_TOKEN" }, { op: "op://vault/z/credential" }] }, env, port);
      expect(result).toMatchObject({ ok: true, credential: { target: "bearer", token: "from-op", source: { op: "op://vault/z/credential" } } });
    }
  });

  it("compiles the op and keychain presets to their argv and runs a command source as given", () => {
    expect(commandArgv({ op: "op://vault/item/field" })).toEqual(["op", "read", "op://vault/item/field"]);
    expect(commandArgv({ keychain: { service: "claude-work", account: "joe" } })).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "claude-work",
      "-a",
      "joe",
      "-w",
    ]);
    expect(commandArgv({ keychain: { service: "claude-work" } })).toEqual(["security", "find-generic-password", "-s", "claude-work", "-w"]);
    expect(commandArgv({ command: ["pass", "show", "z"] })).toEqual(["pass", "show", "z"]);
  });

  it("runs a non-interactive command under the default timeout and an interactive one under the longer one, unless the source sets its own", () => {
    const port = fakeCredentials({ command: { stdout: "t" } });
    resolve({ sources: [{ command: ["pass", "show", "z"] }] }, {}, port);
    resolve({ sources: [{ op: "op://v/i/f" }] }, {}, port);
    resolve({ sources: [{ command: ["slow"], timeoutMs: 5 }] }, {}, port);
    expect(port.runCommand.mock.calls.map((call) => call[1])).toEqual([
      { timeoutMs: CREDENTIAL_COMMAND_TIMEOUT_MS, interactive: false },
      { timeoutMs: CREDENTIAL_INTERACTIVE_TIMEOUT_MS, interactive: true },
      { timeoutMs: 5, interactive: false },
    ]);
  });

  it("skips an interactive source when no person is present, and fails naming it rather than running it", () => {
    const port = fakeCredentials({ personPresent: false, command: { stdout: "never" } });
    const result = resolve({ sources: [{ op: "op://vault/z/credential" }] }, {}, port);
    expect(result).toEqual({
      ok: false,
      message: "claude-use: provider z has no usable credential: op op://vault/z/credential needs a person to approve it, but there is no terminal or desktop session",
    });
    expect(port.runCommand).not.toHaveBeenCalled();
  });

  it("treats op as non-interactive when a 1Password service account token is in the environment", () => {
    expect(isInteractiveSource({ op: "op://v/i/f" }, {})).toBe(true);
    expect(isInteractiveSource({ op: "op://v/i/f" }, { OP_SERVICE_ACCOUNT_TOKEN: "ops_x" })).toBe(false);
    expect(isInteractiveSource({ op: "op://v/i/f", interactive: true }, { OP_SERVICE_ACCOUNT_TOKEN: "ops_x" })).toBe(true);
    expect(isInteractiveSource({ command: ["pass"] }, {})).toBe(false);
    expect(isInteractiveSource({ keychain: { service: "s" }, interactive: true }, {})).toBe(true);
    const port = fakeCredentials({ personPresent: false, command: { stdout: "from-service-account" } });
    expect(resolve({ sources: [{ op: "op://v/i/f" }] }, { OP_SERVICE_ACCOUNT_TOKEN: "ops_x" }, port)).toMatchObject({
      ok: true,
      credential: { token: "from-service-account" },
    });
  });

  it("names each source and why it failed, with a command's status and stderr but never its stdout", () => {
    const port = fakeCredentials({ command: { status: 1, stdout: "sk-leaked", stderr: "item not found\n" } });
    const result = resolve({ sources: [{ env: "Z_API_TOKEN" }, { command: ["op", "read", "ref"] }] }, {}, port);
    expect(result).toEqual({
      ok: false,
      message: "claude-use: provider z has no usable credential: env Z_API_TOKEN is unset or empty; command op exited with status 1: item not found",
    });
    expect(JSON.stringify(result)).not.toContain("sk-leaked");
  });

  it("reports a command that could not run, timed out or printed nothing", () => {
    const failed = (command: Parameters<typeof fakeCredentials>[0]) => messageOf(resolve({ sources: [{ command: ["op"] }] }, {}, fakeCredentials(command)));
    expect(failed({ command: { status: null } })).toContain("command op could not be run or was killed by a signal");
    expect(failed({ command: { status: null, timedOut: true } })).toContain(`command op timed out after ${String(CREDENTIAL_COMMAND_TIMEOUT_MS)}ms`);
    expect(failed({ command: { stdout: " \n" } })).toContain("command op printed no token");
  });

  it("reads a file source trimmed, and refuses one readable by group or others with a warning naming the fix", () => {
    const ok = fakeCredentials({ files: { "~/.config/z.token": { content: "tok-file\n" } } });
    expect(resolve({ sources: [{ file: "~/.config/z.token" }] }, {}, ok)).toMatchObject({ ok: true, credential: { token: "tok-file" } });

    const loose = fakeCredentials({ files: { "/secrets/z.token": { content: "tok-file", mode: 0o100644 } }, command: { stdout: "from-op" } });
    const result = resolve({ sources: [{ file: "/secrets/z.token" }, { op: "op://v/i/f" }] }, {}, loose);
    expect(result).toMatchObject({ ok: true, credential: { token: "from-op" } });
    expect(result.ok && result.credential.warnings).toEqual([
      "claude-use: provider z: skipped file /secrets/z.token is readable or writable by group or others (mode 644); run `chmod 600 /secrets/z.token`",
    ]);
  });

  it("accepts a stricter mode than 600 and a platform that reports no mode", () => {
    const port = fakeCredentials({ files: { "/a": { content: "a", mode: 0o100400 } } });
    expect(resolve({ sources: [{ file: "/a" }] }, {}, port).ok).toBe(true);
    const noMode = fakeCredentials();
    noMode.readSecretFile.mockReturnValue({ found: true, content: "b", mode: undefined });
    expect(resolve({ sources: [{ file: "/b" }] }, {}, noMode).ok).toBe(true);
  });

  it("reports a missing or empty file", () => {
    expect(messageOf(resolve({ sources: [{ file: "/missing" }] }, {}))).toContain("file /missing does not exist");
    const empty = fakeCredentials({ files: { "/empty": { content: "\n" } } });
    expect(messageOf(resolve({ sources: [{ file: "/empty" }] }, {}, empty))).toContain("file /empty is empty");
  });

  it("takes a literal source's value as the token without describing it anywhere", () => {
    const result = resolve({ sources: [{ literal: "codex-local" }] }, {});
    expect(result).toMatchObject({ ok: true, credential: { token: "codex-local" } });
    expect(describeCredential({ sources: [{ literal: "codex-local" }] })).toBe("bearer from literal (non-secret placeholder)");
    expect(JSON.stringify(summariseCredential({ sources: [{ literal: "codex-local" }] }))).not.toContain("codex-local");
  });
});

describe("summariseCredential and describeCredential", () => {
  it("report each source's kind and identifying detail, and the default target", () => {
    const credential: Credential = {
      sources: [{ env: "Z" }, { file: "/f" }, { command: ["pass", "show", "secret-arg"] }, { op: "op://v/i/f" }, { keychain: { service: "s", account: "a" } }],
    };
    expect(summariseCredential(credential)).toEqual({
      target: "bearer",
      sources: [
        { kind: "env", variable: "Z" },
        { kind: "file", path: "/f" },
        { kind: "command", program: "pass" },
        { kind: "op", reference: "op://v/i/f" },
        { kind: "keychain", service: "s", account: "a" },
      ],
    });
    expect(describeCredential(credential)).toBe(
      "bearer from env Z, then file /f, then command pass, then op op://v/i/f, then keychain s (account a)",
    );
  });
});

describe("credentialVariables", () => {
  it("sets the target's variable and removes the other two credential variables when merged over an environment", () => {
    const ambient = { ANTHROPIC_API_KEY: "ambient", ANTHROPIC_AUTH_TOKEN: "ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient", KEEP: "1" };
    expect({ ...ambient, ...credentialVariables("oauthToken", "tok") }).toEqual({ KEEP: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect({ ...ambient, ...credentialVariables("apiKey", "key") }).toEqual({ KEEP: "1", ANTHROPIC_API_KEY: "key" });
    expect({ ...ambient, ...credentialVariables("bearer", "bear") }).toEqual({ KEEP: "1", ANTHROPIC_AUTH_TOKEN: "bear" });
  });
});

/** An in-memory cache port that records every write and removal. */
function memoryCache(initial: Record<string, CachedCredential> = {}): CredentialCachePort & { readonly entries: Map<string, CachedCredential> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    read: (_store, owner) => entries.get(owner),
    write: (_store, owner, entry) => {
      entries.set(owner, entry);
    },
    remove: (_store, owner) => {
      entries.delete(owner);
    },
  };
}

describe("resolveCredential with a cache", () => {
  const NOW = 1_000_000;
  const HOUR = 3_600_000;
  const block: Credential = { sources: [{ op: "op://vault/z/credential" }], cache: { ttl: "1h", store: "file" } };
  const portWith = (cache: CredentialCachePort, command = { stdout: "fetched\n" }) => ({
    ...fakeCredentials({ command }),
    cache: { port: cache, platform: "linux" as const, now: () => NOW },
  });

  it("returns a fresh cached token without running any source", () => {
    const cache = memoryCache({ "provider z": { token: "cached", fetchedAt: NOW - HOUR + 1, source: { op: "op://vault/z/credential" } } });
    const port = portWith(cache);
    const result = resolveCredential({ credential: block, env: {}, port, subject: "provider z" });
    expect(result).toMatchObject({ ok: true, credential: { token: "cached", cachedAt: NOW - HOUR + 1 } });
    expect(port.runCommand).not.toHaveBeenCalled();
  });

  it("fetches and stores when nothing is cached or the entry has expired", () => {
    const stale: Record<string, CachedCredential> = { "provider z": { token: "old", fetchedAt: NOW - HOUR, source: { env: "X" } } };
    for (const initial of [{}, stale]) {
      const cache = memoryCache(initial);
      const result = resolveCredential({ credential: block, env: {}, port: portWith(cache), subject: "provider z" });
      expect(result).toMatchObject({ ok: true, credential: { token: "fetched" } });
      expect(cache.entries.get("provider z")).toEqual({ token: "fetched", fetchedAt: NOW, source: { op: "op://vault/z/credential" } });
    }
  });

  it("skips a fresh entry and replaces it when asked to refresh", () => {
    const cache = memoryCache({ "provider z": { token: "cached", fetchedAt: NOW, source: { env: "X" } } });
    const result = resolveCredential({ credential: block, env: {}, port: portWith(cache), subject: "provider z", refresh: true });
    expect(result).toMatchObject({ ok: true, credential: { token: "fetched" } });
    expect(cache.entries.get("provider z")?.token).toBe("fetched");
  });

  it("never touches the cache for a block that does not ask for one", () => {
    const cache = memoryCache({ "provider z": { token: "cached", fetchedAt: NOW, source: { env: "X" } } });
    const result = resolveCredential({ credential: { sources: block.sources }, env: {}, port: portWith(cache), subject: "provider z" });
    expect(result).toMatchObject({ ok: true, credential: { token: "fetched" } });
    expect(cache.entries.get("provider z")?.token).toBe("cached");
  });

  it("caches nothing when every source fails, and names the warm command in the refusal", () => {
    const cache = memoryCache();
    const result = resolveCredential({ credential: block, env: {}, port: portWith(cache, { stdout: "" }), subject: "identity work" });
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain("claude-use credential warm work");
    expect(cache.entries.size).toBe(0);
  });

  it("names the provider flag in the warm command for a provider", () => {
    const result = resolveCredential({ credential: block, env: {}, port: portWith(memoryCache(), { stdout: "" }), subject: "provider z" });
    expect(messageOf(result)).toContain("claude-use credential warm --provider z");
  });
});

describe("describeCredential with a cache", () => {
  it("states the ttl and store, and no expiry when there is no ttl", () => {
    expect(describeCredential({ sources: [{ env: "X" }], cache: { ttl: "12h", store: "file" } })).toBe("bearer from env X, cached for 12h in the file store");
    expect(describeCredential({ sources: [{ env: "X" }], cache: {} })).toBe("bearer from env X, cached with no expiry");
    expect(describeCredential({ sources: [{ env: "X" }] })).toBe("bearer from env X");
  });
});
