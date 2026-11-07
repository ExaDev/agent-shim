import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import { createFakeFarmFs, discovered, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

describe("prepareLaunch decision", () => {
  const plan = (env: Readonly<Record<string, string>>, argv: readonly string[], files: Readonly<Record<string, unknown>> = {}): ReturnType<typeof prepareLaunch> =>
    prepareLaunch({ paths, namesLock: { fs: createFakeFarmFs(), nowMs: () => Date.now(), pid: process.pid, isRunning: () => true, sleep: () => undefined }, fs: fakeFs(files), proc: fakeProc(env, argv), log: fakeLog(), resolveClaudeBinary: () => discovered, frontdoor: fakeFrontDoorPort() });

  it("reports the identity a launch runs as, how it was selected and the configuration directory the child gets", () => {
    const { decision } = plan({}, ["@work", "--print"]);
    expect(decision).toEqual({
      identity: "work",
      identityId: "work",
      identitySource: "argv",
      configDirEscapeHatch: false,
      configDir: `${paths.identitiesDir}/work`,
      configProfileSource: "none",
    });
  });

  it("reports an identity named by the environment with its own source", () => {
    expect(plan({ AGENT_SHIM_IDENTITY: "personal" }, ["--print"]).decision).toMatchObject({ identity: "personal", identitySource: "env" });
  });

  it("reports the escape hatch, with the directory the caller named and no identity", () => {
    const { decision } = plan({ CLAUDE_CONFIG_DIR: "/somewhere/else" }, ["--print"]);
    expect(decision).toMatchObject({ identitySource: "config-dir-escape-hatch", configDirEscapeHatch: true, configDir: "/somewhere/else" });
    expect(decision.identity).toBeUndefined();
  });

  it("lets an identity named on the command line outrank an inherited CLAUDE_CONFIG_DIR, and says which directory it set aside", () => {
    const log = fakeLog();
    const spawn = fakeSpawn();
    const env = { CLAUDE_CONFIG_DIR: "/somewhere/else", AGENT_SHIM_IDENTITY: "personal" };
    expect(runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc(env, ["@work", "--print"]), log, resolveClaudeBinary: () => discovered })).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    expect(log.warns).toEqual([`agent-shim: the identity named on the command line outranks the inherited CLAUDE_CONFIG_DIR /somewhere/else; running as work in ${paths.identitiesDir}/work`]);
  });

  it("reports the identity and configuration directory of a launch that set an inherited directory aside", () => {
    const { decision } = plan({ CLAUDE_CONFIG_DIR: "/somewhere/else" }, ["--identity", "work", "--print"]);
    expect(decision).toMatchObject({ identity: "work", identitySource: "argv", configDirEscapeHatch: false, configDir: `${paths.identitiesDir}/work` });
  });

  it("says nothing when the inherited CLAUDE_CONFIG_DIR already is the named identity's directory", () => {
    const log = fakeLog();
    const spawn = fakeSpawn();
    const env = { CLAUDE_CONFIG_DIR: `${paths.identitiesDir}/work` };
    expect(runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc(env, ["@work", "--print"]), log, resolveClaudeBinary: () => discovered })).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    expect(log.warns).toEqual([]);
  });

  it("keeps the inherited CLAUDE_CONFIG_DIR, silently, when nothing on the command line names an identity", () => {
    const log = fakeLog();
    const spawn = fakeSpawn();
    const env = { CLAUDE_CONFIG_DIR: "/somewhere/else", AGENT_SHIM_IDENTITY: "personal" };
    expect(runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc(env, ["--print"]), log, resolveClaudeBinary: () => discovered })).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe("/somewhere/else");
    expect(log.warns).toEqual([]);
  });

  it("reports the configuration profile that applied and how it was selected", () => {
    const { decision } = plan({}, ["@work", "--config-profile", "strict", "--print"], { [`${paths.configProfilesDir}/strict.json`]: {} });
    expect(decision).toMatchObject({ configProfile: "strict", configProfileSource: "cli-flag" });
  });
});
