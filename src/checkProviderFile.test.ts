import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkReportHasWarnings, checkReportToJson, collectCheckReport, formatCheckReport } from "./checkReport";
import { CheckReportJsonSchema } from "./checkReportSchema";
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

  /** A loopback server listening until `close` is called, and its port. */
  async function listening(): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
    const server = http.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }
    return {
      port: (address satisfies AddressInfo).port,
      close: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve(undefined);
          });
        });
      },
    };
  }

  /** Writes the provider the identity selects, at `baseUrl`. */
  const writeProvider = (baseUrl: string): void => {
    fs.writeFileSync(path.join(paths.providersDir, "garbled.json"), `${JSON.stringify({ displayName: "Spark", baseUrl, credential: { sources: [{ literal: "placeholder" }] } })}\n`);
  };

  it("fails a selected provider whose base URL accepts no connection, naming the URL, in the text, the JSON and --strict", async () => {
    const server = await listening();
    await server.close();
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    writeProvider(baseUrl);
    const report = collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
    const reachability = report.providerReachability;
    if (reachability === undefined || reachability.ok) {
      throw new Error(`expected an unreachable provider, got ${JSON.stringify(reachability)}`);
    }
    expect(reachability).toMatchObject({ name: "garbled", baseUrl });
    expect(reachability.message).toMatch(new RegExp(`^provider garbled could not connect to ${baseUrl.replaceAll(".", "\\.")}: .*ECONNREFUSED`));
    expect(formatCheckReport(report)).toContain(`  [FAIL] ${reachability.message}`);
    expect(CheckReportJsonSchema.parse(checkReportToJson(report)).providerReachability).toMatchObject({ ok: false });
    expect(checkReportHasWarnings(report)).toBe(true);
  });

  it("reports a reachable one as accepting connections", async () => {
    const server = await listening();
    try {
      const baseUrl = `http://127.0.0.1:${String(server.port)}`;
      writeProvider(baseUrl);
      const report = collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
      expect(report.providerReachability).toEqual({ name: "garbled", baseUrl, ok: true });
      expect(checkReportHasWarnings(report)).toBe(false);
    } finally {
      await server.close();
    }
  });
});
