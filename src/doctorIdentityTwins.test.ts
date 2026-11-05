import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import { identityIdOf, listIdentities, removeIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

describe("doctor and list with an entry that is a symlink to an identity's directory", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-identity-twins-test-"));
    paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.identitiesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Every identity finding of the real doctor over this state root. */
  function identityFindings(): readonly { readonly severity: string; readonly message: string }[] {
    return findingsFor(collectDoctorReport({ paths, env: { PATH: "" } }), "identity").map((finding) => ({ severity: finding.severity, message: finding.message }));
  }

  it("reports one identity for a readable identity.json, under the directory that holds it, as list does", () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "good"));
    fs.writeFileSync(path.join(paths.identitiesDir, "good", "identity.json"), JSON.stringify({ name: "good", allowAmbientCredential: false }));
    fs.symlinkSync(path.join(paths.identitiesDir, "good"), path.join(paths.identitiesDir, "alias"));
    expect(listIdentities(paths).map((listing) => listing.id)).toEqual(["good"]);
    const findings = identityFindings();
    expect(findings.filter((finding) => finding.message.includes("alias"))).toEqual([]);
    expect(findings.filter((finding) => finding.severity === "pass").map((finding) => finding.message)).toEqual([expect.stringMatching(/^good\b/u)]);
  });

  it("reports an identity.json that cannot be read once, under the directory that holds it, in list and doctor alike", () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "bad"));
    fs.writeFileSync(path.join(paths.identitiesDir, "bad", "identity.json"), "{ not json");
    fs.symlinkSync(path.join(paths.identitiesDir, "bad"), path.join(paths.identitiesDir, "badlink"));
    expect(listIdentities(paths).map((listing) => [listing.id, "problem" in listing])).toEqual([["bad", true]]);
    const failed = identityFindings().filter((finding) => finding.severity === "fail");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain("bad");
    expect(failed[0]?.message).not.toContain("badlink");
  });
});

describe("identity remove of an identity reached through more than one entry", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-remove-links-test-"));
    paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.identitiesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes every entry that is its directory, so the name no longer resolves, and leaves a directory outside the identities directory in place", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "identity.json"), JSON.stringify({ name: "ext", allowAmbientCredential: false }));
    fs.symlinkSync(outside, path.join(paths.identitiesDir, "a"));
    fs.symlinkSync(outside, path.join(paths.identitiesDir, "b"));
    expect(removeIdentity(paths, "ext")).toBe("a");
    expect(identityIdOf(paths, "ext")).toBeUndefined();
    expect(fs.readdirSync(paths.identitiesDir).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect(fs.existsSync(path.join(outside, "identity.json"))).toBe(true);
  });

  it("removes a symlink beside the identity's own directory with the directory, leaving no link to nothing", () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "work"));
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    fs.symlinkSync(path.join(paths.identitiesDir, "work"), path.join(paths.identitiesDir, "alias"));
    expect(removeIdentity(paths, "work")).toBe("work");
    expect(fs.readdirSync(paths.identitiesDir).filter((entry) => !entry.startsWith("."))).toEqual([]);
  });
});
