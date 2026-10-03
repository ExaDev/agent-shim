import { describe, expect, it } from "vitest";

import { CREDENTIAL_UNAVAILABLE_EXIT } from "./credential";
import { discovered, FAKE_HOME, fakeCredentials, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv , fakeFrontDoorPort } from "./test-helpers";

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
    expect(log.infos.join("\n")).toContain("identity credential oauthToken from op op://vault/claude-work/token");
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
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("leaves the identity's credential unapplied under the CLAUDE_CONFIG_DIR escape hatch, where the directory's own login is the caller's", () => {
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

    expect(credentials.runCommand).not.toHaveBeenCalled();
    expect(spawnedEnv(spawn).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
