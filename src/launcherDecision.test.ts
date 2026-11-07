import { describe, expect, it } from "vitest";

import { prepareLaunch, resolveLaunch } from "./launcher";
import { FAKE_CLAUDE_HOME, createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

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

  it("syncs the farm of an identity named on the command line even when CLAUDE_CONFIG_DIR is inherited", () => {
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs),
    });

    expect(fs.writes.length).toBeGreaterThan(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
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

  describe("the warning about an inherited CLAUDE_CONFIG_DIR an identity set aside", () => {
    const identityDir = `${paths.identitiesDir}/work`;

    /** The warnings of a launch of `@work` over an inherited `CLAUDE_CONFIG_DIR`, with `symlinks` as the directories the filesystem reaches through a link. */
    function warningsFor(inherited: string, symlinks: Readonly<Record<string, string>> = {}): readonly string[] {
      const log = fakeLog();
      prepareLaunch({ paths, namesLock: { fs: createFakeFarmFs(), nowMs: () => Date.now(), pid: process.pid, isRunning: () => true, sleep: () => undefined }, fs: fakeFs({}, symlinks), proc: fakeProc({ CLAUDE_CONFIG_DIR: inherited }, ["@work", "--print"]), log, resolveClaudeBinary: () => discovered, frontdoor: fakeFrontDoorPort() });
      return log.warns;
    }

    it("says nothing when the inherited directory is the identity's own spelled with a trailing separator", () => {
      expect(warningsFor(`${identityDir}/`)).toEqual([]);
    });

    it("says nothing when the inherited directory is a symlink to the identity's own", () => {
      expect(warningsFor("/home/testuser/link-to-work", { "/home/testuser/link-to-work": identityDir })).toEqual([]);
    });

    it("says so for a symlink to some other directory", () => {
      expect(warningsFor("/home/testuser/link-elsewhere", { "/home/testuser/link-elsewhere": "/somewhere/else" })).toHaveLength(1);
    });

    it("says so for a relative inherited path, which names no directory of the identities", () => {
      const [warning] = warningsFor("relative/dir");
      expect(warning).toContain("CLAUDE_CONFIG_DIR relative/dir");
    });

    it("says nothing in a read-only resolution, which changes nothing and is asked about, not run", () => {
      const log = fakeLog();
      const resolution = resolveLaunch({ paths, fs: fakeFs({}), proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/else" }, ["@work", "--print"]), log, resolveClaudeBinary: () => discovered, frontdoor: fakeFrontDoorPort() });
      expect(log.warns).toEqual([]);
      expect(resolution.decision).toMatchObject({ identity: "work", configDirEscapeHatch: false, configDir: identityDir });
    });
  });
});
