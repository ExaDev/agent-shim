import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";
import type { RunPort } from "./launcher/ports";

describe("runDoctor: sign-in", () => {
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

  it("passes an identity that authenticates with its own credential block", () => {
    const raw = JSON.stringify({ name: "work", allowAmbientCredential: false, credential: { sources: [{ env: "WORK_TOKEN" }] } });
    const report = runDoctor(baseParams({ identities: [identity("work", { raw, credentialsFilePresent: false })], platform: "linux" }));
    expect(findingsFor(report, "sign-in")[0]?.severity).toBe("pass");
    expect(findingsFor(report, "sign-in")[0]?.message).toContain("uses a credential block");
  });
});
