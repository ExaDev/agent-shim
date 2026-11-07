import { describe, expect, it, vi } from "vitest";

import type { FarmStat, RunPort } from "../launcher/ports";
import { claudeCodeKeychainAccount, claudeCodeKeychainService, claudeCodeLoginService, decideSignIn, identitySignIn } from "./signIn";

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

describe("Claude Code's Keychain login derivation", () => {
  it("names the account USER, else the operating system's name, else claude-code-user when the lookup throws or the name fails the pattern", () => {
    expect(claudeCodeKeychainAccount({ USER: "alex" }, () => "other")).toBe("alex");
    expect(claudeCodeKeychainAccount({ USER: "" }, () => "other")).toBe("other");
    expect(claudeCodeKeychainAccount({}, () => {
      throw new Error("no user");
    })).toBe("claude-code-user");
    expect(claudeCodeKeychainAccount({ USER: "alex smith" }, () => "other")).toBe("claude-code-user");
  });

  it("hashes the directory path normalised to NFC, so a decomposed spelling names the item Claude Code files", () => {
    const composed = "/example/caf\u00e9";
    const decomposed = "/example/cafe\u0301";
    expect(composed).not.toBe(decomposed);
    expect(claudeCodeKeychainService(decomposed)).toBe(claudeCodeKeychainService(composed));
  });

  it("names the service CLAUDE_SECURESTORAGE_CONFIG_DIR picks: its own hash when set, the bare prefix when set empty", () => {
    expect(claudeCodeLoginService("/example/dir", {})).toBe(claudeCodeKeychainService("/example/dir"));
    expect(claudeCodeLoginService("/example/dir", { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/example/other" })).toBe(claudeCodeKeychainService("/example/other"));
    expect(claudeCodeLoginService("/example/dir", { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })).toBe("Claude Code-credentials");
  });
});

