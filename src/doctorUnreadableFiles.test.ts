import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import type { DoctorSection } from "./doctorReport";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

/** How a file is made one that exists and cannot be read: a directory in its place (EISDIR), or a file with no permissions (EACCES) where the reader lists only files. */
type Unreadable = "directory" | "no-permission";

/** Each file the doctor reads, with the section that reports it, how it is made unreadable, and the severity it is reported at: a failure, except the ChatGPT sign-in file, a warning as every sign-in problem is. */
const FILES: readonly (readonly [string, DoctorSection, (paths: LayoutPaths) => string, Unreadable, "fail" | "warn"])[] = [
  ["route-overrides.json", "route-overrides", (paths) => paths.routeOverridesFile, "directory", "fail"],
  ["config.json", "global-config", (paths) => paths.globalConfigFile, "directory", "fail"],
  ["directory-rules.json", "directory-rules", (paths) => paths.directoryRulesFile, "directory", "fail"],
  ["categories.local.json", "categories-local", (paths) => paths.categoriesLocalFile, "directory", "fail"],
  ["active-identity", "active-identity", (paths) => paths.activeIdentityFile, "directory", "fail"],
  ["headroom state.json", "headroom", (paths) => paths.headroomStateFile, "directory", "fail"],
  ["the headroom allowlist", "headroom", (paths) => paths.headroomAllowlistFile, "directory", "fail"],
  ["a profile's file", "config-profile", (paths) => path.join(paths.configProfilesDir, "client.json"), "no-permission", "fail"],
  ["a provider's file", "provider", (paths) => path.join(paths.providersDir, "z.json"), "no-permission", "fail"],
  ["an identity's identity.json", "identity", (paths) => path.join(paths.identitiesDir, "work", "identity.json"), "directory", "fail"],
  ["the ChatGPT sign-in file", "provider", (paths) => paths.chatgptSignInFile, "directory", "warn"],
  ["claude-shim.json", "claude-shim", (paths) => paths.claudeShimFile, "directory", "fail"],
  ["provider-aliases.json", "provider", (paths) => paths.providerAliasesFile, "directory", "fail"],
];

describe("a file doctor cannot read is a finding, never an abort", () => {

  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-unreadable-"));
    paths = buildLayoutPaths(root);
    // A codex provider that signs in with ChatGPT, so the sign-in file is read.
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "cx.json"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] }, codex: { login: "chatgpt-sign-in" } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A process running as root reads a file with no permissions, so a case that needs EACCES cannot be made there. */
  const root0 = process.getuid?.() === 0;

  it.each(FILES)("reports %s as unreadable in its section, naming the code, and goes on with the rest of the report", (_label: string, section: DoctorSection, fileOf: (paths: LayoutPaths) => string, how: Unreadable, severity: "fail" | "warn") => {
    if (how === "no-permission" && root0) return;
    // The allowlist is checked once a headroom state names a supervisor.
    if (section === "headroom" && fileOf(paths) === paths.headroomAllowlistFile) {
      fs.mkdirSync(path.dirname(paths.headroomStateFile), { recursive: true });
      fs.writeFileSync(paths.headroomStateFile, JSON.stringify({ supervisorPid: 2147483646 }));
    }
    if (how === "directory") {
      fs.mkdirSync(fileOf(paths), { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fileOf(paths)), { recursive: true });
      fs.writeFileSync(fileOf(paths), "{}");
      fs.chmodSync(fileOf(paths), 0);
    }
    const code = how === "directory" ? "EISDIR" : "EACCES";
    let report: ReturnType<typeof collectDoctorReport> | undefined;
    expect(() => {
      report = collectDoctorReport({ paths, env: { PATH: "" } });
    }).not.toThrow();
    const found = report === undefined ? [] : findingsFor(report, section);
    expect(found.filter((finding) => finding.message.includes("cannot be read") && finding.message.includes(code)).map((finding) => finding.severity)).toEqual([severity]);
    // The report goes on: another section is still there.
    expect(report === undefined ? [] : findingsFor(report, "models")).not.toEqual([]);
  });

  /** How a file is made one doctor cannot use: content that is not JSON, a file with no permissions, or a directory in its place. */
  const DAMAGE = ["malformed", "no-permission", "directory"] as const;

  /** Every other file collectDoctorReport reads outside readForDoctor, through the reader that reads it: an identity's .claude.json (readIdentityAccount), its usage snapshot (readUsageSnapshot), the door's state.json (readFrontDoorState), a rename journal (listRenameJournals) and claude-shim.json. */
  const RAW_READS: readonly (readonly [string, (layout: LayoutPaths) => string])[] = [
    ["an identity's .claude.json", (layout) => path.join(layout.identitiesDir, "work", ".claude.json")],
    ["an identity's usage snapshot", (layout) => path.join(layout.usageSnapshotsDir, "work.json")],
    ["the front door's state.json", (layout) => layout.frontdoorStateFile],
    ["a rename journal", (layout) => path.join(layout.identityRenamesDir, "work.json")],
    ["claude-shim.json", (layout) => layout.claudeShimFile],
  ];

  it.each(RAW_READS.flatMap(([label, fileOf]) => DAMAGE.map((damage) => [label, damage, fileOf] as const)))("goes on with the whole report when %s is %s", (_label, damage, fileOf) => {
    if (damage === "no-permission" && root0) return;
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    if (damage === "directory") {
      fs.mkdirSync(fileOf(paths), { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fileOf(paths)), { recursive: true });
      fs.writeFileSync(fileOf(paths), "{ not json");
      if (damage === "no-permission") fs.chmodSync(fileOf(paths), 0);
    }
    let report: ReturnType<typeof collectDoctorReport> | undefined;
    expect(() => {
      report = collectDoctorReport({ paths, env: { PATH: "" } });
    }).not.toThrow();
    expect(report === undefined ? [] : findingsFor(report, "identity")).not.toEqual([]);
    expect(report === undefined ? [] : findingsFor(report, "models")).not.toEqual([]);
  });
});
