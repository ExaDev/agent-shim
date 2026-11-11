import { describe, expect, it } from "vitest";

import { pushKeychainFindings } from "./doctorKeychain";
import type { DoctorIdentityInput, DoctorSection, DoctorSeverity } from "./doctorReport";
import type { RunPort } from "./launcher/ports";

const identity = (name: string): DoctorIdentityInput => ({ name, id: name, path: `/identities/${name}/identity.json`, raw: undefined, farmRoot: `/identities/${name}`, credentialsFilePresent: false, account: undefined });

/** A run port whose command exits `status`, and the services it was asked about. */
function runPort(status: number): { readonly run: RunPort; readonly asked: () => number } {
  let asked = 0;
  return {
    run: {
      run: () => {
        asked += 1;
        return { status, stdout: "", stderr: "" };
      },
    },
    asked: () => asked,
  };
}

/** `section:subject:severity:message` of each finding. */
function findingsOf(platform: string, run: RunPort | undefined, identities: readonly DoctorIdentityInput[], agents: ReadonlyMap<string, "claude" | "codex">): string[] {
  const lines: string[] = [];
  pushKeychainFindings((section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => {
    lines.push(`${section}:${subject ?? ""}:${severity}:${message}`);
  }, platform, run, identities, agents);
  return lines;
}

const NOTE_FOUND = /^keychain:claude-one:pass:Keychain service name for this identity: "Claude Code-credentials-[0-9a-f]+"\.$/;

describe("the Keychain section of doctor", () => {
  it("reports a found item as its note alone, at pass severity", () => {
    const port = runPort(0);
    const lines = findingsOf("darwin", port.run, [identity("claude-one")], new Map([["claude-one", "claude"]]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(NOTE_FOUND);
  });

  it("reports a missing item with its note and the pointer to the sign-in section, at pass severity", () => {
    const lines = findingsOf("darwin", runPort(1).run, [identity("claude-one")], new Map([["claude-one", "claude"]]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^keychain:claude-one:pass:No Keychain entry found for service "Claude Code-credentials-[0-9a-f]+" \(security exited 1\)\. The sign-in section reports whether a login is stored elsewhere\.$/);
  });

  it("leaves a Codex identity out whatever its place, asking about each Claude identity after it", () => {
    const port = runPort(0);
    const lines = findingsOf("darwin", port.run, [identity("codex-one"), identity("claude-one")], new Map([["claude-one", "claude"], ["codex-one", "codex"]]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(NOTE_FOUND);
    expect(port.asked()).toBe(1);
  });

  it("is skipped on macOS when there is no way to run the lookup", () => {
    expect(findingsOf("darwin", undefined, [identity("claude-one")], new Map([["claude-one", "claude"]]))).toEqual(["keychain::pass:Skipped (not macOS)."]);
  });

  it("is skipped off macOS, whatever the identities", () => {
    const port = runPort(0);
    expect(findingsOf("linux", port.run, [identity("claude-one")], new Map())).toEqual(["keychain::pass:Skipped (not macOS)."]);
    expect(port.asked()).toBe(0);
  });
});
