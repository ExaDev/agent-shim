import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CREDENTIAL_UNAVAILABLE_EXIT } from "./credential";
import { buildLayoutPaths } from "./paths";
import { realIdentityNamesLockPorts } from "./identityNamesLock";
import { createFakeFarmFs, discovered, FAKE_HOME, fakeCredentials, fakeFarm, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv , fakeFrontDoorPort, reportedRow } from "./test-helpers";

const WORK_TOKEN = "oauth-work-token";

/** Identity `work` with an `oauthToken` credential from 1Password, as `identity set work --credential-target oauthToken --credential op:...` writes it. */
const workWithCredential = {
  [`${paths.identitiesDir}/work/identity.json`]: {
    name: "work",
    allowAmbientCredential: false,
    credential: { sources: [{ op: "op://vault/claude-work/token" }], target: "oauthToken" },
  },
};

describe("runLauncher identity credential", () => {
  it("registers an identity launch while holding the names lock", () => {
    const farmFs = createFakeFarmFs();
    const original = farmFs.mkdirPrivate;
    let locked = false;
    const farm = fakeFarm({ ...farmFs, mkdirPrivate: (directory) => {
      if (directory === paths.launchesDir) locked = farmFs.lstat(`${paths.root}/.identity-names.lock`) !== undefined;
      original(directory);
    } });
    runAndCaptureExit({ paths, fs: fakeFs(workWithCredential), farm, spawn: fakeSpawn(), proc: fakeProc({}, ["@work"]), log: fakeLog(), resolveClaudeBinary: () => discovered, credentials: fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } }) });
    expect(locked).toBe(true);
  });
  it("uses the caller's non-waiting names lock when a farm is present", () => {
    const lockFs = createFakeFarmFs();
    const credentials = fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } });
    let locked = false;
    credentials.runCommand.mockImplementation(() => {
      locked = lockFs.lstat(`${paths.root}/.identity-names.lock`) !== undefined;
      return { status: 0, stdout: `${WORK_TOKEN}\n`, stderr: "", timedOut: false };
    });
    runAndCaptureExit({ paths, namesLock: { fs: lockFs, nowMs: () => Date.now(), pid: process.pid, isRunning: () => true, sleep: () => undefined, maxAttempts: 1 }, fs: fakeFs(workWithCredential), farm: fakeFarm(createFakeFarmFs()), spawn: fakeSpawn(), proc: fakeProc({}, ["@work"]), log: fakeLog(), resolveClaudeBinary: () => discovered, credentials });
    expect(locked).toBe(true);
  });
  it("locks identity credential resolution by default without a farm runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-launch-lock-default-"));
    try {
      const localPaths = buildLayoutPaths(root);
      const credentials = fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } });
      let locked = false;
      credentials.runCommand.mockImplementation(() => {
        locked = fs.existsSync(path.join(root, ".identity-names.lock"));
        return { status: 0, stdout: `${WORK_TOKEN}\n`, stderr: "", timedOut: false };
      });
      runAndCaptureExit({ paths: localPaths, fs: fakeFs({ [`${localPaths.identitiesDir}/work/identity.json`]: workWithCredential[`${paths.identitiesDir}/work/identity.json`] }), spawn: fakeSpawn(), proc: fakeProc({}, ["@work"]), log: fakeLog(), resolveClaudeBinary: () => discovered, credentials });
      expect(locked).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("locks identity credential resolution even without a farm runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-launch-lock-"));
    try {
      const localPaths = buildLayoutPaths(root);
      const credentials = fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } });
      let locked = false;
      credentials.runCommand.mockImplementation(() => {
        locked = fs.existsSync(path.join(root, ".identity-names.lock"));
        return { status: 0, stdout: `${WORK_TOKEN}\n`, stderr: "", timedOut: false };
      });
      runAndCaptureExit({ paths: localPaths, namesLock: realIdentityNamesLockPorts, fs: fakeFs({ [`${localPaths.identitiesDir}/work/identity.json`]: workWithCredential[`${paths.identitiesDir}/work/identity.json`] }), spawn: fakeSpawn(), proc: fakeProc({}, ["@work"]), log: fakeLog(), resolveClaudeBinary: () => discovered, credentials });
      expect(locked).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("holds the names lock while resolving an identity credential", () => {
    const farmFs = createFakeFarmFs();
    const credentials = fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } });
    let locked = false;
    credentials.runCommand.mockImplementation(() => {
      locked = farmFs.lstat(`${paths.root}/.identity-names.lock`) !== undefined;
      return { status: 0, stdout: `${WORK_TOKEN}\n`, stderr: "", timedOut: false };
    });
    runAndCaptureExit({ paths, fs: fakeFs(workWithCredential), farm: fakeFarm(farmFs), spawn: fakeSpawn(), proc: fakeProc({}, ["@work", "--print"]), log: fakeLog(), resolveClaudeBinary: () => discovered, credentials });
    expect(locked).toBe(true);
  });
  it("exports the identity's resolved token as CLAUDE_CODE_OAUTH_TOKEN in the child's environment only", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const credentials = fakeCredentials({ command: { stdout: `${WORK_TOKEN}\n` } });

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({}, ["@work", "--print"]),
      log,
      resolveClaudeBinary: () => discovered,
      credentials,
    });

    expect(code).toBe(0);
    expect(credentials.runCommand.mock.calls[0]?.[0]).toEqual(["op", "read", "op://vault/claude-work/token"]);
    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${FAKE_HOME}/.agent-shim/identities/work`);
    expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["--print"]);
    expect([...log.infos, ...log.warns, ...log.errors].join("\n")).not.toContain(WORK_TOKEN);
    expect(reportedRow(log, "credential")).toEqual({ label: "credential", value: "oauthToken from op op://vault/claude-work/token", detail: "the identity's own" });
  });

  it("does not trip the ambient-credential guard on the same token a agent-shim launch of this identity left in the environment", () => {
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({ CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      credentials: fakeCredentials({ command: { stdout: WORK_TOKEN } }),
    });

    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  });

  it("still trips the guard on a different CLAUDE_CODE_OAUTH_TOKEN already in the environment", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({ CLAUDE_CODE_OAUTH_TOKEN: "some-other-login" }, ["@work"]),
      log,
      resolveClaudeBinary: () => discovered,
      credentials: fakeCredentials({ command: { stdout: WORK_TOKEN } }),
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN is set in the environment");
  });

  it("still trips the guard on an injected-looking token for an identity with no credential of its own", () => {
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN }, ["@personal"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      credentials: fakeCredentials(),
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("refuses with exit 64 naming the identity and source when its credential yields no token", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({}, ["@work"]),
      log,
      resolveClaudeBinary: () => discovered,
      credentials: fakeCredentials({ personPresent: false }),
    });

    expect(code).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors).toEqual([
      "agent-shim: identity work has no usable credential: op op://vault/claude-work/token needs a person to approve it, but there is no terminal or desktop session",
    ]);
  });

  it("leaves the identity's credential unresolved when a provider supplies the launch's credential", () => {
    const spawn = fakeSpawn();
    const credentials = fakeCredentials({ command: { stdout: WORK_TOKEN } });

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        ...workWithCredential,
        [`${FAKE_HOME}/.agent-shim/providers/z.json`]: {
          displayName: "GLM",
          baseUrl: "https://api.z.ai/api/anthropic",
          credential: { sources: [{ env: "Z_API_TOKEN" }] },
        },
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["@work", "--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(),
      credentials,
    });

    expect(credentials.runCommand).not.toHaveBeenCalled();
    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("leaves the identity's credential unapplied under the CLAUDE_CONFIG_DIR escape hatch, where the directory's own login is the caller's", () => {
    const spawn = fakeSpawn();
    const credentials = fakeCredentials({ command: { stdout: WORK_TOKEN } });

    runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit", AGENT_SHIM_IDENTITY: "work" }, []),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      credentials,
    });

    expect(credentials.runCommand).not.toHaveBeenCalled();
    expect(spawnedEnv(spawn).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("applies the credential of an identity named on the command line even when CLAUDE_CONFIG_DIR is inherited, since the identity then owns the directory", () => {
    const spawn = fakeSpawn();
    const credentials = fakeCredentials({ command: { stdout: WORK_TOKEN } });

    runAndCaptureExit({
      paths,
      fs: fakeFs(workWithCredential),
      spawn,
      proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      credentials,
    });

    expect(credentials.runCommand).toHaveBeenCalled();
    expect(spawnedEnv(spawn).CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  });
});
