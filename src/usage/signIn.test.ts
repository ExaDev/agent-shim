import { describe, expect, it, vi } from "vitest";

import type { FarmStat, RunPort } from "../launcher/ports";
import { claudeCodeKeychainService, decideSignIn, identitySignIn } from "./signIn";

const FARM_ROOT = "/state/identities/work";
const FILE_STAT: FarmStat = { kind: "file", mtimeMs: 0, sizeBytes: 2 };

/** A run port answering every command with `status`, and the spy that records what it was asked. */
function runWith(status: number) {
  const run = vi.fn<RunPort["run"]>(() => ({ status, stdout: "", stderr: "" }));
  const port: RunPort = { run };
  return { port, run };
}

describe("decideSignIn", () => {
  const base = { hasCredentialBlock: false, keychainItem: undefined, credentialsFile: false, platform: "linux" } as const;

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
    const answer = identitySignIn({ lstat: () => undefined }, { platform: "darwin", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false });
    expect(answer.state).toBe("signed-in");
    expect(run).toHaveBeenCalledWith("security", ["find-generic-password", "-s", claudeCodeKeychainService(FARM_ROOT)]);
  });

  it("does not ask the Keychain off macOS, and reads the file's presence only", () => {
    const { port, run } = runWith(0);
    const present = identitySignIn({ lstat: (target) => (target === `${FARM_ROOT}/.credentials.json` ? FILE_STAT : undefined) }, { platform: "linux", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false });
    expect(present.state).toBe("signed-in");
    expect(run).not.toHaveBeenCalled();
    expect(identitySignIn({ lstat: () => undefined }, { platform: "linux", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: false }).state).toBe("signed-out");
  });

  it("runs nothing at all for an identity with a credential block", () => {
    const { port, run } = runWith(1);
    expect(identitySignIn({ lstat: () => undefined }, { platform: "darwin", run: port }, { farmRoot: FARM_ROOT, hasCredentialBlock: true }).state).toBe("token");
    expect(run).not.toHaveBeenCalled();
  });
});
