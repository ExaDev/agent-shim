import { describe, expect, it, vi } from "vitest";

import type { FarmStat, RunPort } from "../launcher/ports";
import { claudeCodeKeychainService, decideSignIn, identitySignIn, storedLoginUsable } from "./signIn";

const FARM_ROOT = "/state/identities/work";
const FILE_STAT: FarmStat = { kind: "file", mtimeMs: 0, sizeBytes: 2 };

/** A run port answering every command with `status`, and the spy that records what it was asked. */
function runWith(status: number) {
  const run = vi.fn<RunPort["run"]>(() => ({ status, stdout: "", stderr: "" }));
  const port: RunPort = { run };
  return { port, run };
}

describe("decideSignIn", () => {
  const base = { hasCredentialBlock: false, provider: undefined, keychainItem: undefined, credentialsFile: false, platform: "linux" } as const;

  it("is signed out with no stored login, whatever else is on disk", () => {
    expect(decideSignIn(base).state).toBe("signed-out");
    const onMac = decideSignIn({ ...base, platform: "darwin", keychainItem: false });
    expect(onMac.state).toBe("signed-out");
    expect(onMac.detail).toContain("Keychain");
  });

  it("counts a Keychain item or the credentials file as signed in", () => {
    const keychain = decideSignIn({ ...base, platform: "darwin", keychainItem: true });
    expect(keychain.state).toBe("signed-in");
    expect(keychain.detail).toContain("Keychain");
    const file = decideSignIn({ ...base, credentialsFile: true });
    expect(file.state).toBe("signed-in");
    expect(file.detail).toContain(".credentials.json");
    // The file stands in when the Keychain holds nothing.
    expect(decideSignIn({ ...base, platform: "darwin", keychainItem: false, credentialsFile: true }).state).toBe("signed-in");
  });

  it("does not call an identity with its own credential block signed out", () => {
    expect(decideSignIn({ ...base, hasCredentialBlock: true }).state).toBe("token");
  });

  it("does not call an identity that exists for a provider signed out", () => {
    const answer = decideSignIn({ ...base, provider: "minimax" });
    expect(answer.state).toBe("token");
    expect(answer.detail).toContain("provider's credential");
  });
});

describe("claudeCodeKeychainService", () => {
  it("names the item by the first eight hex digits of the directory path's SHA-256, as Claude Code does", () => {
    // Both values are the SHA-256 of the path as `shasum -a 256` computes it; the scheme itself was read off the Keychain items of identities known to be signed in.
    expect(claudeCodeKeychainService("/farm/work")).toBe("Claude Code-credentials-5e4594d0");
    expect(claudeCodeKeychainService("/home/testuser/.agent-shim/identities/work")).toBe("Claude Code-credentials-c4aa727c");
  });

  it("distinguishes directories and does not normalise the path it is given", () => {
    expect(claudeCodeKeychainService("/farm/work")).not.toBe(claudeCodeKeychainService("/farm/other"));
    expect(claudeCodeKeychainService("/farm/work/")).not.toBe(claudeCodeKeychainService("/farm/work"));
  });
});

describe("identitySignIn", () => {
  it("asks the Keychain for the item's existence only, never for its secret", () => {
    const { port, run } = runWith(0);
    const answer = identitySignIn({ lstat: () => undefined }, { platform: "darwin", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false, provider: undefined });
    expect(answer.state).toBe("signed-in");
    expect(run).toHaveBeenCalledWith("security", ["find-generic-password", "-s", claudeCodeKeychainService(FARM_ROOT)]);
  });

  it("does not ask the Keychain off macOS, and reads the file's presence only", () => {
    const { port, run } = runWith(0);
    const present = identitySignIn({ lstat: (target) => (target === `${FARM_ROOT}/.credentials.json` ? FILE_STAT : undefined) }, { platform: "linux", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false, provider: undefined });
    expect(present.state).toBe("signed-in");
    expect(run).not.toHaveBeenCalled();
    expect(identitySignIn({ lstat: () => undefined }, { platform: "linux", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false, provider: undefined }).state).toBe("signed-out");
  });

  it("runs nothing at all for an identity with a credential block", () => {
    const { port, run } = runWith(1);
    expect(identitySignIn({ lstat: () => undefined }, { platform: "darwin", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: true, provider: undefined }).state).toBe("token");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs nothing at all for an identity that exists for a provider", () => {
    const { port, run } = runWith(1);
    expect(identitySignIn({ lstat: () => undefined }, { platform: "darwin", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false, provider: "minimax" }).state).toBe("token");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("storedLoginUsable", () => {
  /** A run port that answers `claude auth status` with `stdout` and `status`. */
  function answering(stdout: string, status: number | null = 0) {
    const run = vi.fn<RunPort["run"]>(() => ({ status, stdout, stderr: "" }));
    return { port: { run } satisfies RunPort, run };
  }
  const env = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient-token", ANTHROPIC_AUTH_TOKEN: "ambient-bearer", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/somewhere/else" };

  it("is true when Claude Code reports a login and false when it reports none", () => {
    expect(storedLoginUsable(answering('{"loggedIn": true, "authMethod": "claude.ai"}').port, "/bin/claude", FARM_ROOT, env)).toBe(true);
    expect(storedLoginUsable(answering('{"loggedIn": false, "authMethod": "none"}').port, "/bin/claude", FARM_ROOT, env)).toBe(false);
  });

  it("asks the given binary about the identity's own directory, with no ambient credential in the child", () => {
    const { port, run } = answering('{"loggedIn": true}');
    storedLoginUsable(port, "/bin/claude", FARM_ROOT, env);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, input, options] = run.mock.calls[0] ?? [];
    expect(command).toBe("/bin/claude");
    expect(args).toEqual(["auth", "status"]);
    expect(input).toBeUndefined();
    expect(options?.env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: FARM_ROOT, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined });
    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  it("is undefined when Claude Code did not answer, so a launch is never changed on a guess", () => {
    expect(storedLoginUsable(answering("", null).port, "/bin/claude", FARM_ROOT, env)).toBeUndefined();
    expect(storedLoginUsable(answering("not json").port, "/bin/claude", FARM_ROOT, env)).toBeUndefined();
    expect(storedLoginUsable(answering('{"authMethod": "none"}').port, "/bin/claude", FARM_ROOT, env)).toBeUndefined();
    expect(storedLoginUsable(answering('{"loggedIn": "yes"}').port, "/bin/claude", FARM_ROOT, env)).toBeUndefined();
  });
});
