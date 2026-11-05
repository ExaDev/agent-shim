import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNameRenameRecord } from "./identityNameRenameRecord";
import { identityExists, IdentityNotFoundError, requireIdentityId } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { discovered, fakeFs, fakeLog, fakeProc, fakeSpawn, runAndCaptureExit } from "./test-helpers";

describe("the advice for a name no identity has yet", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-not-found-remedy-test-"));
    paths = buildLayoutPaths(root);
    // A rename of work to job interrupted before its last step: the identity is still named work under id work, and its record holds job.
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    writeNameRenameRecord(paths, { version: 1, id: "work", from: "work", to: "job", startedAt: "2026-10-30T10:00:00.000Z" });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the command that finishes the interrupted rename giving that name, not an add that would be refused", () => {
    expect(identityExists(paths, "job")).toBe(false);
    let failure: unknown;
    try {
      requireIdentityId(paths, "job");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(IdentityNotFoundError);
    expect(failure).toHaveProperty("message", expect.stringContaining("Finish it with `agent-shim identity rename work job`"));
    expect(failure).not.toHaveProperty("message", expect.stringContaining("identity add job"));
  });

  it("says the same when a launch names it", () => {
    const log = fakeLog();
    expect(runAndCaptureExit({ paths, fs: fakeFs({}), spawn: fakeSpawn(), proc: fakeProc({}, ["@job", "--print"]), log, resolveClaudeBinary: () => discovered })).toBe(1);
    expect(log.errors.join("\n")).toContain('no identity named "job"');
    expect(log.errors.join("\n")).toContain("Finish it with `agent-shim identity rename work job`");
  });

  it("still says to add a name no rename is giving", () => {
    expect(() => requireIdentityId(paths, "office")).toThrow("Run `agent-shim identity add office` first.");
  });
});
