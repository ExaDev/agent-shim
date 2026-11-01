import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity, provider } from "./doctorTestFixtures";
import type { RunPort } from "./launcher/ports";

describe("runDoctor: sign-in", () => {
  const minimaxProvider = { displayName: "MiniMax", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "placeholder" }] } };
  const keychainMissing: RunPort = { run: () => ({ status: 44, stdout: "", stderr: "" }) };
  const keychainPresent: RunPort = { run: () => ({ status: 0, stdout: "", stderr: "" }) };

  it("warns, never fails, for an identity with no stored login, naming the remedy", () => {
    const report = runDoctor(baseParams({ identities: [identity("work", { credentialsFilePresent: false })], platform: "linux" }));
    const findings = findingsFor(report, "sign-in");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.subject).toBe("work");
    expect(findings[0]?.message).toContain("work is signed out (no .credentials.json). Run `agent-shim run @work`");
    expect(report.ok).toBe(true);
  });

  it("passes with a credentials file, and with a Keychain item on macOS", () => {
    const withFile = runDoctor(baseParams({ identities: [identity("work", { credentialsFilePresent: true })], platform: "linux" }));
    expect(findingsFor(withFile, "sign-in")[0]?.severity).toBe("pass");
    expect(findingsFor(withFile, "sign-in")[0]?.message).toContain("is signed in");
    const withKeychain = runDoctor(baseParams({ identities: [identity("work", { credentialsFilePresent: false })], run: keychainPresent, platform: "darwin" }));
    expect(findingsFor(withKeychain, "sign-in")[0]?.severity).toBe("pass");
    expect(findingsFor(withKeychain, "sign-in")[0]?.message).toContain("Keychain");
  });

  it("lets the credentials file stand in when the Keychain holds nothing", () => {
    const report = runDoctor(baseParams({ identities: [identity("work", { credentialsFilePresent: true })], run: keychainMissing, platform: "darwin" }));
    expect(findingsFor(report, "sign-in")[0]?.severity).toBe("pass");
  });

  it("passes an identity that exists for a provider, whatever login it stores", () => {
    const raw = JSON.stringify({ name: "minimax", allowAmbientCredential: false, provider: "minimax" });
    const report = runDoctor(baseParams({ identities: [identity("minimax", { raw, credentialsFilePresent: false })], providers: [provider("minimax", minimaxProvider)], platform: "linux" }));
    const [finding] = findingsFor(report, "sign-in");
    expect(finding?.severity).toBe("pass");
    expect(finding?.message).toBe(
      'minimax exists for provider "minimax" (runs provider sessions with the provider\'s credential, so a stored login is not what a launch uses).',
    );
  });

  it("passes an identity that authenticates with its own credential block", () => {
    const raw = JSON.stringify({ name: "work", allowAmbientCredential: false, credential: { sources: [{ env: "WORK_TOKEN" }] } });
    const report = runDoctor(baseParams({ identities: [identity("work", { raw, credentialsFilePresent: false })], platform: "linux" }));
    expect(findingsFor(report, "sign-in")[0]?.severity).toBe("pass");
    expect(findingsFor(report, "sign-in")[0]?.message).toContain("uses a credential block");
  });
});
