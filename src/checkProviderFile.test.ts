import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectCheckReport } from "./checkReport";
import { addIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

/** Text standing in for a secret beside the syntax error, which the parser's own message would quote. */
const SECRET = "madeupsecretvalue";

describe("collectCheckReport and the provider file the identity selects", () => {
  let root: string;
  let claudeHome: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "check-provider-file-test-"));
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "check-provider-file-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), `${JSON.stringify({ name: "work", allowAmbientCredential: false, provider: "garbled" })}\n`);
    fs.mkdirSync(paths.providersDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it("reports a provider file that is not JSON as a problem with the provider, as it does one that fails its schema, and does not abort", () => {
    fs.writeFileSync(path.join(paths.providersDir, "garbled.json"), "{ not json");
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
    expect(report.credential.provider?.name).toBe("garbled");
    expect(report.credential.provider?.problem).toMatch(/garbled\.json is not valid JSON/);
  });

  it("says nothing of the file's text in that problem", () => {
    fs.writeFileSync(path.join(paths.providersDir, "garbled.json"), `{ "credential": { "sources": [{ "literal": ${SECRET} }] } }\n`);
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
    expect(report.credential.provider?.problem).toBeDefined();
    expect(JSON.stringify(report)).not.toContain("madeup");
  });

  it("still reports a provider file that fails its schema", () => {
    fs.writeFileSync(path.join(paths.providersDir, "garbled.json"), `${JSON.stringify({ displayName: "z.ai", baseUrl: 42 })}\n`);
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
    expect(report.credential.provider?.problem).toMatch(/Invalid configuration/);
  });
});
