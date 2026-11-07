import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectCheckReport } from "./checkReport";
import { addIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

/** What a `claude @work` launcher left in the session's environment: its credential, the directory it set and the marker naming the credential. */
const TOKEN = "oauth-work-token";
const SESSION = {
  CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  AGENT_SHIM_INJECTED: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: createHash("sha256").update(TOKEN).digest("hex") }),
};

describe("collectCheckReport and the escape hatch", () => {
  let root: string;
  let claudeHome: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "check-hatch-test-"));
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "check-hatch-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  const env = (inherited: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({ ...SESSION, ...inherited });

  it("does not call the parent launcher's credential ambient for an identity named on the command line, whatever directory is inherited", () => {
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: env({ CLAUDE_CONFIG_DIR: "/inherited/session" }) });
    expect(report.ambientCredential.ok).toBe(true);
  });

  it("calls it ambient for a bare check that would take the escape hatch and keep the session as it is", () => {
    const report = collectCheckReport({ paths, cwd: root, env: env({ CLAUDE_CONFIG_DIR: "/inherited/session" }) });
    expect(report.ambientCredential.ok).toBe(false);
  });

  it("does not call it ambient for a check that resolves an identity without the inherited directory", () => {
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: env({}) });
    expect(report.ambientCredential.ok).toBe(true);
  });
});
