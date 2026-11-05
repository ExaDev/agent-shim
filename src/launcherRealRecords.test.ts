import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadIdentity, resolveIdentityId } from "./launcher/identity";
import { buildLayoutPaths } from "./paths";
import { realFsPort } from "./realPorts";
import { discovered, fakeLog, fakeProc, fakeSpawn, runAndCaptureExit, spawnedEnv } from "./test-helpers";

/** A directory nobody can enter, and the owner-only mode it is given back so it can be removed. */
const NO_ACCESS_MODE = 0o000;
const OWNER_ONLY_DIR_MODE = 0o700;

describe("the launcher's identity records over the real configuration port", () => {
  let dir: string;

  const write = (id: string, name: string): void => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, "identity.json"), `${JSON.stringify({ name, allowAmbientCredential: false })}\n`);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-real-records-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("follows a rename written to disk after the first read, as a long-lived supervisor or front door must", () => {
    write("work", "work");
    expect(resolveIdentityId(dir, "work", realFsPort)).toBe("work");
    write("work", "client");
    expect(resolveIdentityId(dir, "client", realFsPort)).toBe("work");
    expect(resolveIdentityId(dir, "work", realFsPort)).toBeUndefined();
    expect(loadIdentity(dir, "client", realFsPort)?.config.name).toBe("client");
  });

  it("takes a stray plain file, an entry nobody can enter and a symlink loop for no identity, and still resolves the identities beside them", () => {
    write("work", "work");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an identity\n");
    fs.symlinkSync(path.join(dir, "loop-b"), path.join(dir, "loop-a"));
    fs.symlinkSync(path.join(dir, "loop-a"), path.join(dir, "loop-b"));
    write("closed", "closed");
    fs.chmodSync(path.join(dir, "closed"), NO_ACCESS_MODE);
    try {
      expect(resolveIdentityId(dir, "work", realFsPort)).toBe("work");
      expect(loadIdentity(dir, "work", realFsPort)?.config.name).toBe("work");
      expect(resolveIdentityId(dir, "notes.txt", realFsPort)).toBeUndefined();
    } finally {
      fs.chmodSync(path.join(dir, "closed"), OWNER_ONLY_DIR_MODE);
    }
  });

  it("launches an identity beside a stray file, an entry nobody can enter and a symlink loop in the identities directory, through the real ports", () => {
    const paths = buildLayoutPaths(dir);
    fs.mkdirSync(paths.identitiesDir, { recursive: true });
    const store = (id: string, name: string): void => {
      fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
      fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), `${JSON.stringify({ name, allowAmbientCredential: false })}\n`);
    };
    store("work-2", "work");
    fs.writeFileSync(path.join(paths.identitiesDir, "notes.txt"), "not an identity\n");
    fs.symlinkSync(path.join(paths.identitiesDir, "loop-b"), path.join(paths.identitiesDir, "loop-a"));
    fs.symlinkSync(path.join(paths.identitiesDir, "loop-a"), path.join(paths.identitiesDir, "loop-b"));
    store("closed", "closed");
    fs.chmodSync(path.join(paths.identitiesDir, "closed"), NO_ACCESS_MODE);
    try {
      const spawn = fakeSpawn();
      expect(runAndCaptureExit({ paths, fs: realFsPort, spawn, proc: fakeProc({}, ["@work", "--print"]), log: fakeLog(), resolveClaudeBinary: () => discovered })).toBe(0);
      expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(path.join(paths.identitiesDir, "work-2"));
    } finally {
      fs.chmodSync(path.join(paths.identitiesDir, "closed"), OWNER_ONLY_DIR_MODE);
    }
  });
});
