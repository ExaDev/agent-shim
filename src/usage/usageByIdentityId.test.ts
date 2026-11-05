import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityNotFoundError, goneIdentityLabel, unreadableIdentityLabel, usageSnapshotOfName } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { collectAccounts, collectUsageReport } from "./commands";

describe("usage filed by identity id", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-by-id-test-"));
    paths = buildLayoutPaths(root);
    // An identity renamed without --move: created as work, now called client, still in identities/work.
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
    fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.usageSnapshotsDir, "work.json"), JSON.stringify({ schemaVersion: 1, identity: "work", updatedAt: new Date().toISOString(), providers: { anthropic: { lastStatus: 200 } } }));
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    const record = (identity: string): string => `${JSON.stringify({ schemaVersion: 1, at, identity, provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
    // Requests the session made before the rename and after it carry the same id in their identity header.
    fs.writeFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${record("work")}${record("work")}${record("gone")}`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports an identity's usage, filed under its id, under its current name", () => {
    const report = collectUsageReport(realFarmFs, paths, { identity: "client" });
    expect(report.summaries.map((summary) => [summary.identity, summary.requests])).toEqual([["client", 2]]);
    expect(report.snapshots.map((snapshot) => snapshot.identity)).toEqual(["client"]);
  });

  it("names usage left by an identity that no longer exists by the id it was filed under, marked gone", () => {
    const report = collectUsageReport(realFarmFs, paths, {});
    expect(report.summaries.map((summary) => summary.identity)).toEqual(["client", goneIdentityLabel("gone")]);
  });

  it("keeps usage filed under a gone id apart from a live identity named as a gone label would be spelled without its directory", () => {
    // A record may hold any name a file name can, spaces and parentheses included.
    fs.mkdirSync(path.join(paths.identitiesDir, "other"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "other", "identity.json"), JSON.stringify({ name: "gone (gone)", allowAmbientCredential: false }));
    const at = new Date().toISOString();
    fs.appendFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "other", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    const report = collectUsageReport(realFarmFs, paths, {});
    expect(report.summaries.map((summary) => [summary.identity, summary.requests])).toEqual([["client", 2], ["gone (gone)", 1], ["identities/gone (gone)", 1]]);
  });

  it("keeps usage filed under a gone id apart from a live identity whose name is that id", () => {
    // Requests a removed identity stored under client made, before the identity stored under work was given its name.
    const at = new Date().toISOString();
    fs.appendFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "client", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    const report = collectUsageReport(realFarmFs, paths, {});
    expect(report.summaries.map((summary) => [summary.identity, summary.requests])).toEqual([["client", 2], [goneIdentityLabel("client"), 1], [goneIdentityLabel("gone"), 1]]);
  });

  it("names usage of an identity stored under an id whose name cannot be read as unreadable, not as gone", () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "gone"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "gone", "identity.json"), "{ not json");
    const report = collectUsageReport(realFarmFs, paths, {});
    expect(report.summaries.map((summary) => summary.identity)).toEqual(["client", unreadableIdentityLabel("gone")]);
    expect(unreadableIdentityLabel("gone")).toBe("identities/gone (unreadable)");
  });

  it("refuses the former name, which no identity has", () => {
    expect(() => collectUsageReport(realFarmFs, paths, { identity: "work" })).toThrow(IdentityNotFoundError);
  });
});

describe("account show for an identity filed under an id that is not its name", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "account-by-id-test-"));
    paths = buildLayoutPaths(root);
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
    fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.usageSnapshotsDir, "work.json"), JSON.stringify({ schemaVersion: 1, identity: "work", updatedAt: new Date().toISOString(), providers: {} }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the identity and its nested snapshot alike, by its name", () => {
    const [view] = collectAccounts(realFarmFs, paths, "client", { platform: "linux" });
    expect(view?.identity).toBe("client");
    expect(view?.usage?.identity).toBe("client");
  });

  it("reads the snapshot under the id for usageSnapshotOfName, and none for the former name", () => {
    expect(usageSnapshotOfName(paths, realFarmFs, "client")?.identity).toBe("work");
    expect(usageSnapshotOfName(paths, realFarmFs, "work")).toBeUndefined();
  });
});
