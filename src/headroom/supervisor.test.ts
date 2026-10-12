import { describe, expect, it } from "vitest";

import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { FAKE_UID } from "../test-helpers";
import {
  backoffForAttempt,
  DAEMON_EXIT_LOG_LINE_CHARS,
  HEADROOM_SUPERVISOR_STILL_RUNNING,
  HEADROOM_BACKOFF_BASE_MS,
  HEADROOM_BACKOFF_CAP_MS,
  HEADROOM_POLL_MS,
  HEADROOM_START_RETRY_BUDGET,
  KILL_GRACE_MS,
  resolveSupervisorConfig,
  runSupervisor,
  type HeadroomSupervisorConfig,
  stopSupervisedProcess,
  type SupervisorPorts,
  TERM_GRACE_MS,
  versionSatisfies,
} from "./supervisor";
import type { HeadroomSettings } from "./settings";
import { HEADROOM_SOCKET_DIR_MODE, headroomSocketPath, UNIX_SOCKET_PATH_MAX_BYTES } from "./socket";
import { hashAllowlist, readHeadroomState, writeHeadroomState } from "./state";

import {
  paths,
  OWN_PID,
  OTHER_SUPERVISOR_PID,
  OTHER_DAEMON_PID,
  OWN_SOCKET,
  OTHER_SOCKET,
  SESSION_PID,
  TICKS_INSTALL_TEST,
  TICKS_SHORT,
  TICKS_DRIFT_TEST,
  IDLE_NEVER_MINUTES,
  makeWorld,
  config,
  supervise,
} from "./supervisorTestWorld";

const ZOMBIE_SESSION_PID = 322;
const ORPHAN_DAEMON_PID = 888;
/** A supervisor from the previous release whose generation has ended, recorded only under the legacy state name. */
const DRAINED_SUPERVISOR_PID = 424242;
/** A supervisor from the previous release still serving, recorded only under the legacy state name. */
const DRAINING_SUPERVISOR_PID = 424243;
/** A supervisor pid nothing is running as: whatever socket it left is stale. */
const DEAD_SUPERVISOR_PID = 6161;
/** Another user's uid, for a socket directory this user does not own. */
const OTHER_UID = 0;
/** A socket directory mode other users can enter and list. */
const GROUP_READABLE_DIR_MODE = 0o750;
/** A full commit SHA that is not the default source's pinned commit. */
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TICKS_CRASH_RESTART = 6;
const TICKS_LONG_SESSION = 100;
const IDLE_ONE_MINUTE = 1;
const DEFERRAL_TICKS = 5;
const FIRST_BACKOFF_ATTEMPT = 1;
const LAST_BACKOFF_ATTEMPT = 5;
const BIG_ATTEMPT = 20;
const ATTEMPT_THREE = 3;
const ATTEMPT_FOUR = 4;
const DRIFT_DONE_PHASE = 3;

describe("resolveSupervisorConfig", () => {
  it("defaults source and idle shutdown from the named constants", () => {
    expect(resolveSupervisorConfig({})).toEqual({
      source: HEADROOM_DEFAULT_SOURCE,
      idleShutdownMinutes: HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES,
      settings: {},
    });
    expect(resolveSupervisorConfig({ source: "headroom==0.39.0", idleShutdownMinutes: 5, mode: "token", ccr: "lossless" })).toEqual({
      source: "headroom==0.39.0",
      idleShutdownMinutes: 5,
      settings: { mode: "token", ccr: "lossless" },
    });
  });
});

describe("versionSatisfies", () => {
  it("rejects an absent version and accepts any version of an unversioned source", () => {
    expect(versionSatisfies(undefined, HEADROOM_DEFAULT_SOURCE)).toBe(false);
    expect(versionSatisfies("headroom 0.20.0", HEADROOM_DEFAULT_SOURCE)).toBe(true);
  });

  it("checks PEP 440 specifiers against the installed version", () => {
    expect(versionSatisfies("headroom 0.39.1", "headroom>=0.39")).toBe(true);
    expect(versionSatisfies("headroom 0.38.2", "headroom>=0.39")).toBe(false);
    expect(versionSatisfies("headroom 0.39.1", "headroom==0.39.1")).toBe(true);
    expect(versionSatisfies("headroom 0.39.1", "headroom==0.39.0")).toBe(false);
    expect(versionSatisfies("headroom 0.39.1", "headroom<0.40")).toBe(true);
  });

  it("treats an unparseable version or specifier as satisfied rather than reinstalling forever", () => {
    expect(versionSatisfies("garbage", "headroom==also-garbage")).toBe(true);
  });
});

describe("backoffForAttempt", () => {
  it("doubles from the base and caps", () => {
    expect(backoffForAttempt(FIRST_BACKOFF_ATTEMPT)).toBe(HEADROOM_BACKOFF_BASE_MS);
    expect(backoffForAttempt(2)).toBe(HEADROOM_BACKOFF_BASE_MS * 2);
    expect(backoffForAttempt(ATTEMPT_THREE)).toBe(HEADROOM_BACKOFF_BASE_MS * 2 * 2);
    expect(backoffForAttempt(BIG_ATTEMPT)).toBe(HEADROOM_BACKOFF_CAP_MS);
  });
});

describe("runSupervisor", () => {
  it("installs headroom when the binary is missing, then starts it and records ready state", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.version = undefined;

    const code = await supervise(world, config, { tickLimit: TICKS_INSTALL_TEST });

    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.installs).toEqual([HEADROOM_DEFAULT_SOURCE]);
    expect(world.spawns).toHaveLength(1);
    const spawn = world.spawns[0];
    if (spawn === undefined) {
      throw new Error("expected a headroom spawn");
    }
    // No front door has served yet, so there is no direct origin to admit.
    expect(spawn.allowlist).toEqual([]);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OWN_PID);
    expect(state.headroomPid).toBe(spawn.pid);
    expect(spawn.socketPath).toBe(OWN_SOCKET);
    expect(state.socketPath).toBe(OWN_SOCKET);
    expect(state.allowlistHash).toBe(hashAllowlist([]));
    expect(state.installedSource).toBe(HEADROOM_DEFAULT_SOURCE);
  });

  it("records the install in state while it runs and clears the record once headroom is up", async () => {
    const world = makeWorld();
    world.version = undefined;
    let duringInstall: Record<string, unknown> | undefined;
    world.onInstall = () => {
      duringInstall = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    };

    await supervise(world, config, { tickLimit: TICKS_INSTALL_TEST });

    expect(duringInstall).toMatchObject({ supervisorPid: OWN_PID, installing: HEADROOM_DEFAULT_SOURCE });
    expect(duringInstall?.socketPath).toBeUndefined();
    const after = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(after.installing).toBeUndefined();
    expect(after.socketPath).toBe(OWN_SOCKET);
  });

  it("names the install's own reason when it fails", async () => {
    const world = makeWorld();
    world.version = undefined;
    world.installOk = false;

    await supervise(world, config);

    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.lastError).toBe(`could not install headroom from ${HEADROOM_DEFAULT_SOURCE}: uv is not installed or not on PATH (spawn ENOENT)`);
    expect(state.installing).toBeUndefined();
  });

  it("does not install when the installed version already satisfies the configured source", async () => {
    const world = makeWorld();
    await supervise(world, resolveSupervisorConfig({ source: "headroom>=0.39" }), { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([]);
    expect(world.spawns).toHaveLength(1);
  });

  it("exits non-zero and records lastError when installing is impossible (uv absent)", async () => {
    const world = makeWorld();
    world.version = undefined;
    world.installOk = false;

    const code = await supervise(world, config);

    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("could not install headroom");
  });

  it("restarts a daemon whose exit event reports the crash while sessions were live", async () => {
    const world = makeWorld();
    let crashed = false;
    world.onSleep = () => {
      if (!crashed && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        const first = world.spawns[0];
        if (first !== undefined) {
          world.kill(first.pid);
          crashed = true;
        }
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
  });

  it("treats a zombie daemon as dead and restarts it even though a signal-0 existence check would still report it alive", async () => {
    const world = makeWorld();
    let zombified = false;
    world.onSleep = () => {
      if (!zombified && world.spawns.length === 1) {
        const first = world.spawns[0];
        if (first !== undefined) {
          world.zombify(first.pid);
          zombified = true;
        }
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    const first = world.spawns[0];
    if (first === undefined) {
      throw new Error("expected a first spawn");
    }
    // The zombie still "exists" in the modelled table, which is exactly what made the signal-0 check miss it.
    expect(world.alive.has(first.pid)).toBe(true);
    expect(world.zombies.has(first.pid)).toBe(true);
    expect(world.spawns).toHaveLength(2);
  });

  it("clears the daemon fields from state the moment a crash is detected, so status never claims a dead socket", async () => {
    const world = makeWorld();
    let zombified = false;
    world.onSleep = () => {
      if (!zombified && world.spawns.length === 1) {
        const first = world.spawns[0];
        if (first !== undefined) {
          // The replacement never becomes ready, so the run stops in the crashed-and-restarting window where the cleared state is observable.
          world.autoReady = false;
          world.zombify(first.pid);
          zombified = true;
        }
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_SHORT });
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.socketPath).toBeUndefined();
    // The replacement is recorded the moment it is spawned, and its socket only once it is ready, which it never is here.
    expect(state.headroomPid).toBe(world.spawns.at(-1)?.pid);
    expect(state.supervisorPid).toBe(OWN_PID);
    expect(world.spawns.length).toBeGreaterThanOrEqual(2);
  });

  it("stops an orphan daemon left behind by a dead predecessor before starting its own", async () => {
    const world = makeWorld();
    world.alive.add(ORPHAN_DAEMON_PID);
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: 1,
      headroomPid: ORPHAN_DAEMON_PID,
      socketPath: headroomSocketPath(paths, 1),
      installedSource: HEADROOM_DEFAULT_SOURCE,
    });
    world.commandLines.set(ORPHAN_DAEMON_PID, `python -m headroom.cli proxy --uds ${headroomSocketPath(paths, 1)} --allowed-base-urls-file ${paths.headroomAllowlistFile}`);
    const code = await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toContain(ORPHAN_DAEMON_PID);
    expect(world.spawns).toHaveLength(1);
    expect(world.alive.has(ORPHAN_DAEMON_PID)).toBe(false);
  });

  it("stops an orphan recorded before its daemon was ready, identified by its generation's socket", async () => {
    const world = makeWorld();
    world.alive.add(ORPHAN_DAEMON_PID);
    // The predecessor died between spawning its daemon and that daemon's readiness: the pid is recorded, the socket not yet.
    writeHeadroomState(world.fs, paths.headroomStateFile, { supervisorPid: 1, headroomPid: ORPHAN_DAEMON_PID, installedSource: HEADROOM_DEFAULT_SOURCE });
    world.commandLines.set(ORPHAN_DAEMON_PID, `python -m headroom.cli proxy --uds ${headroomSocketPath(paths, 1)} --allowed-base-urls-file ${paths.headroomAllowlistFile}`);
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.stops).toContain(ORPHAN_DAEMON_PID);
  });

  it("never signals a recorded orphan pid that is now running something else, or whose command line cannot be read", async () => {
    for (const commandLine of ["/usr/bin/vim notes.md", undefined]) {
      const world = makeWorld();
      world.alive.add(ORPHAN_DAEMON_PID);
      writeHeadroomState(world.fs, paths.headroomStateFile, { supervisorPid: 1, headroomPid: ORPHAN_DAEMON_PID, socketPath: headroomSocketPath(paths, 1), installedSource: HEADROOM_DEFAULT_SOURCE });
      if (commandLine !== undefined) {
        world.commandLines.set(ORPHAN_DAEMON_PID, commandLine);
      }
      await supervise(world, config, { tickLimit: TICKS_SHORT });
      expect(world.stops).not.toContain(ORPHAN_DAEMON_PID);
      expect(world.alive.has(ORPHAN_DAEMON_PID)).toBe(true);
    }
  });

  it("records the daemon's pid as soon as it is spawned, before it is ready, so a successor can find it", async () => {
    const world = makeWorld();
    world.autoReady = false;
    const recorded: (number | undefined)[] = [];
    world.onSleep = () => {
      if (world.spawns.length === 1 && recorded.length === 0) {
        const state = readHeadroomState(world.fs, paths.headroomStateFile);
        recorded.push(state?.headroomPid);
        expect(state?.socketPath).toBeUndefined();
      }
    };
    await supervise(world, config, { tickLimit: 1 });
    expect(recorded).toEqual([world.spawns[0]?.pid]);
  });

  it("removes a temporary allowlist file whose writer has exited when it starts, and keeps a live writer's", async () => {
    const world = makeWorld();
    world.fs.mkdirPrivate(paths.headroomSocketDir);
    world.fs.writeFileUtf8(`${paths.headroomAllowlistFile}.${String(DEAD_SUPERVISOR_PID)}.tmp`, "partial");
    world.fs.writeFileUtf8(`${paths.headroomAllowlistFile}.${String(OTHER_SUPERVISOR_PID)}.tmp`, "partial");
    world.alive.add(OTHER_SUPERVISOR_PID);
    await supervise(world, config, { tickLimit: 1 });
    expect(world.fs.readdir(paths.headroomSocketDir)).toEqual(["allowlist.txt", `allowlist.txt.${String(OTHER_SUPERVISOR_PID)}.tmp`]);
  });

  it("serves every restart in one generation on the same socket, inside a directory created owner-only", async () => {
    const world = makeWorld();
    let crashed = false;
    world.onSleep = () => {
      if (!crashed && world.spawns.length === 1) {
        const first = world.spawns[0];
        if (first !== undefined) {
          world.kill(first.pid);
          crashed = true;
        }
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns.map((spawn) => spawn.socketPath)).toEqual([OWN_SOCKET, OWN_SOCKET]);
    expect(world.fs.modeOf(paths.headroomSocketDir)).toBe(HEADROOM_SOCKET_DIR_MODE);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.socketPath).toBe(OWN_SOCKET);
    expect(state.headroomPid).toBe(world.spawns[1]?.pid);
  });

  it("removes the sockets dead supervisor generations left behind and keeps a live supervisor's", async () => {
    const world = makeWorld();
    world.alive.add(OTHER_SUPERVISOR_PID);
    world.fs.mkdirPrivate(paths.headroomSocketDir);
    world.fs.writeFileUtf8(headroomSocketPath(paths, DEAD_SUPERVISOR_PID), "");
    world.fs.writeFileUtf8(OTHER_SOCKET, "");
    world.fs.writeFileUtf8(`${paths.headroomSocketDir}/notes.txt`, "");
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.fs.readdir(paths.headroomSocketDir)).toEqual([`${String(OTHER_SUPERVISOR_PID)}.sock`, "allowlist.txt", "notes.txt"]);
    expect(world.spawns).toHaveLength(1);
  });

  it("refuses to start on a platform without unix sockets, recording why, and never installs or spawns", async () => {
    const world = makeWorld();
    world.platform = "win32";
    world.version = undefined;
    const code = await supervise(world, config);
    expect(code).toBe(1);
    expect(world.installs).toEqual([]);
    expect(world.spawns).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("headroom routing needs a unix domain socket, which headroom cannot serve on win32");
  });

  it("refuses a socket directory that is a symlink without creating anything through it", async () => {
    const world = makeWorld();
    world.fs.seed({ [paths.headroomSocketDir]: { symlink: "/somewhere/else" } });
    const code = await supervise(world, config);
    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toBe(`the headroom socket directory ${paths.headroomSocketDir} is a symlink; it must be the real directory`);
  });

  it("refuses a socket directory another user owns, or that stays group accessible, before any daemon starts", async () => {
    for (const [stat, reason] of [
      [{ kind: "dir", uid: OTHER_UID, mode: HEADROOM_SOCKET_DIR_MODE }, `is owned by uid ${String(OTHER_UID)}, not by this user (uid ${String(FAKE_UID)})`],
      [{ kind: "dir", uid: FAKE_UID, mode: GROUP_READABLE_DIR_MODE }, "has mode 0750, which lets other users reach it; it must be accessible to its owner only"],
    ] as const) {
      const world = makeWorld();
      world.socketStats = { [paths.headroomSocketDir]: stat };
      const code = await supervise(world, config);
      expect(code).toBe(1);
      expect(world.spawns).toHaveLength(0);
      const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
      expect(String(state.lastError)).toBe(`the headroom socket directory ${paths.headroomSocketDir} ${reason}`);
    }
  });

  it("refuses a state root so deep that the socket path cannot fit in a unix socket address", async () => {
    const deepPaths = buildLayoutPaths(`/home/testuser/${"d".repeat(UNIX_SOCKET_PATH_MAX_BYTES)}`);
    const world = makeWorld();
    const code = await runSupervisor(config, { ...world.ports, paths: deepPaths });
    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(deepPaths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain(`longer than the ${String(UNIX_SOCKET_PATH_MAX_BYTES)} a unix socket path can hold`);
  });

  it("gives up after the retry budget when the daemon never becomes ready, recording lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;

    const code = await supervise(world, config);

    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(HEADROOM_START_RETRY_BUDGET);
    // The backoff schedule: 500ms, 1000ms, 2000ms, 4000ms, 8000ms between the failed attempts.
    for (const attempt of [FIRST_BACKOFF_ATTEMPT, 2, ATTEMPT_THREE, ATTEMPT_FOUR, LAST_BACKOFF_ATTEMPT]) {
      const expected = backoffForAttempt(attempt);
      expect(world.sleepDelays).toContain(expected);
    }
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("failed to become ready");
  });

  it("ends an attempt the moment the daemon exits before it is ready, and gives up with the end of the daemon's log in lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;
    world.fs.mkdirp(paths.logsDir);
    world.fs.writeFileUtf8(paths.headroomLogPath, "earlier output that predates every attempt\n");
    const ports: SupervisorPorts = {
      ...world.ports,
      spawnHeadroom: (socketPath, allowlistFile, settings) => {
        const pid = world.ports.spawnHeadroom(socketPath, allowlistFile, settings);
        // A build without the flag: click prints its usage error and the process exits at once. Each attempt is marked, so the report can be checked to hold only the last attempt's own output.
        world.fs.writeFileUtf8(paths.headroomLogPath, `${world.fs.readFileUtf8(paths.headroomLogPath) ?? ""}attempt ${String(world.spawns.length)}\nUsage: headroom proxy [OPTIONS]\nTry 'headroom proxy --help' for help.\n\nError: No such option: --allowed-base-urls-file\n`);
        world.kill(pid);
        return pid;
      },
    };
    // The log is never read whole: nothing rotates it, so each attempt reads only its size and a bounded tail through the ports.
    const wholeLogReads: string[] = [];
    const readFileUtf8 = world.fs.readFileUtf8;
    const guarded: SupervisorPorts = {
      ...ports,
      fs: {
        ...world.fs,
        readFileUtf8: (file: string) => {
          if (file === paths.headroomLogPath) {
            wholeLogReads.push(file);
          }
          return readFileUtf8(file);
        },
      },
    };
    world.setConfig(config);
    const code = await runSupervisor(config, guarded);
    expect(code).toBe(1);
    expect(wholeLogReads).toEqual([]);
    expect(world.spawns).toHaveLength(HEADROOM_START_RETRY_BUDGET);
    // No readiness poll ever waited on a daemon that had already exited: the only sleeps are the backoffs between attempts.
    expect(world.sleepDelays).toEqual(Array.from({ length: HEADROOM_START_RETRY_BUDGET }, (_, index) => backoffForAttempt(index + 1)));
    const lastError = readHeadroomState(world.fs, paths.headroomStateFile)?.lastError ?? "";
    expect(lastError).toContain("failed to become ready");
    expect(lastError).toContain(`its log ends: attempt ${String(HEADROOM_START_RETRY_BUDGET)} | Usage: headroom proxy [OPTIONS] |`);
    expect(lastError).toContain("Error: No such option: --allowed-base-urls-file");
    expect(lastError).not.toContain("earlier output that predates every attempt");
  });

  it("redacts credential-shaped text from the daemon output it records in lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;
    // Assembled at run time so no credential-shaped literal sits in the source.
    const token = ["sk", "ant", "e2e0leaked0value0x"].join("-");
    const ports: SupervisorPorts = {
      ...world.ports,
      spawnHeadroom: (socketPath, allowlistFile, settings) => {
        const pid = world.ports.spawnHeadroom(socketPath, allowlistFile, settings);
        world.fs.mkdirp(paths.logsDir);
        world.fs.writeFileUtf8(paths.headroomLogPath, `${world.fs.readFileUtf8(paths.headroomLogPath) ?? ""}Traceback: upstream refused key ${token}\n`);
        world.kill(pid);
        return pid;
      },
    };
    world.setConfig(config);
    expect(await runSupervisor(config, ports)).toBe(1);
    const lastError = readHeadroomState(world.fs, paths.headroomStateFile)?.lastError ?? "";
    expect(lastError).toContain("Traceback: upstream refused key <redacted>");
    expect(lastError).not.toContain(token);
  });

  it("caps each line of daemon output it records in lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;
    const longLine = "x".repeat(DAEMON_EXIT_LOG_LINE_CHARS * 2);
    const ports: SupervisorPorts = {
      ...world.ports,
      spawnHeadroom: (socketPath, allowlistFile, settings) => {
        const pid = world.ports.spawnHeadroom(socketPath, allowlistFile, settings);
        world.fs.mkdirp(paths.logsDir);
        world.fs.writeFileUtf8(paths.headroomLogPath, `${world.fs.readFileUtf8(paths.headroomLogPath) ?? ""}${longLine}\n`);
        world.kill(pid);
        return pid;
      },
    };
    world.setConfig(config);
    expect(await runSupervisor(config, ports)).toBe(1);
    const lastError = readHeadroomState(world.fs, paths.headroomStateFile)?.lastError ?? "";
    expect(lastError).toContain(`${"x".repeat(DAEMON_EXIT_LOG_LINE_CHARS)}...`);
    expect(lastError).not.toContain("x".repeat(DAEMON_EXIT_LOG_LINE_CHARS + 1));
  });

  it("starts the daemon with the configured settings", async () => {
    const world = makeWorld();
    const settings: HeadroomSettings = { mode: "token", targetRatio: 0.4, ccr: "lossless" };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES, settings }, { tickLimit: TICKS_SHORT });
    expect(world.spawns).toHaveLength(1);
    expect(world.spawns[0]?.settings).toEqual(settings);
  });

  it("restarts with the new settings once no session is live after the config changes, and defers while one is", async () => {
    const world = makeWorld();
    const next: HeadroomSupervisorConfig = { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES, settings: { mode: "token" } };
    let phase = 0;
    world.onSleep = () => {
      if (phase === 0 && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        world.setConfig(next);
        phase = 1;
        return;
      }
      if (phase === 1 && world.sleepDelays.filter((delay) => delay === HEADROOM_POLL_MS).length >= DEFERRAL_TICKS) {
        expect(world.spawns).toHaveLength(1);
        world.alive.delete(SESSION_PID);
        world.fs.removeRecursive(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`);
        phase = DRIFT_DONE_PHASE;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_DRIFT_TEST });
    expect(world.spawns).toHaveLength(2);
    expect(world.spawns[1]?.settings).toEqual({ mode: "token" });
    expect(world.stops).toHaveLength(1);
  });

  it("shuts the daemon down after the idle period with an empty registry", async () => {
    const world = makeWorld();
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_ONE_MINUTE });
    expect(code).toBe(0);
    expect(world.stops).toHaveLength(1);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBeUndefined();
    expect(state.socketPath).toBeUndefined();
  });

  it("resets the idle clock while a session is live, so a long session never triggers shutdown", async () => {
    const world = makeWorld();
    world.onSleep = () => {
      if (world.spawns.length > 0) {
        world.writeSessionFile(SESSION_PID);
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_ONE_MINUTE }, { tickLimit: TICKS_LONG_SESSION });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toHaveLength(0);
  });

  it("migrates a dead generation's legacy state record onto the shared name before claiming it", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomLegacyStateFile, { supervisorPid: DRAINED_SUPERVISOR_PID, socketPath: `${paths.headroomSocketDir}/${String(DRAINED_SUPERVISOR_PID)}.sock`, installedSource: "headroom>=0.39" });
    world.kill(DRAINED_SUPERVISOR_PID);
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: 1 });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    // The legacy file is gone and this supervisor's claim owns the shared name, one file instead of two.
    expect(world.fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeUndefined();
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OWN_PID);
  });

  it("exits without touching either file when a live previous-release supervisor owns the legacy record and the shared name is absent", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomLegacyStateFile, { supervisorPid: DRAINING_SUPERVISOR_PID, socketPath: `${paths.headroomSocketDir}/${String(DRAINING_SUPERVISOR_PID)}.sock` });
    world.alive.add(DRAINING_SUPERVISOR_PID);
    const before = world.fs.readFileUtf8(paths.headroomLegacyStateFile);
    const code = await supervise(world, config);
    expect(code).toBe(0);
    expect(world.spawns).toHaveLength(0);
    expect(world.stops).toHaveLength(0);
    expect(world.fs.readFileUtf8(paths.headroomLegacyStateFile)).toBe(before);
    expect(world.fs.readFileUtf8(paths.headroomStateFile)).toBeUndefined();
  });

  it("exits at once, touching neither the state file nor the other daemon, when another live supervisor already owns it", async () => {
    const world = makeWorld();
    world.handOwnershipToAnotherSupervisor();
    const before = world.fs.readFileUtf8(paths.headroomStateFile);
    const code = await supervise(world, config);
    expect(code).toBe(0);
    expect(world.spawns).toHaveLength(0);
    expect(world.stops).toHaveLength(0);
    expect(world.fs.readFileUtf8(paths.headroomStateFile)).toBe(before);
  });

  it("keeps serving its own sessions but stops writing the state file once another supervisor owns it, so a crash-restart cannot repoint new launches at it", async () => {
    const world = makeWorld();
    world.writeSessionFile(SESSION_PID);
    let handedOver = false;
    world.onSleep = () => {
      if (world.spawns.length > 0 && !handedOver) {
        handedOver = true;
        world.handOwnershipToAnotherSupervisor();
        world.kill(world.spawns[0]?.pid ?? 0);
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OTHER_SUPERVISOR_PID);
    expect(state.socketPath).toBe(OTHER_SOCKET);
  });

  it("retires once its own sessions are gone after losing ownership, without clearing the new owner's state", async () => {
    const world = makeWorld();
    let handedOver = false;
    world.onSleep = () => {
      if (world.spawns.length > 0 && !handedOver) {
        handedOver = true;
        world.handOwnershipToAnotherSupervisor();
      }
    };
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_ONE_MINUTE });
    expect(code).toBe(0);
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OTHER_SUPERVISOR_PID);
    expect(state.headroomPid).toBe(OTHER_DAEMON_PID);
  });

  it("does not count another supervisor's sessions as keeping this daemon alive, so a superseded daemon idles out while the owner's sessions run", async () => {
    const world = makeWorld();
    world.writeSessionFile(SESSION_PID, OTHER_SUPERVISOR_PID);
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_ONE_MINUTE });
    expect(code).toBe(0);
    expect(world.stops).toHaveLength(1);
  });

  it("prunes registry entries whose launcher pid has died, including a zombie the signal-0 table still lists", async () => {
    const world = makeWorld();
    world.writeSessionFile(SESSION_PID);
    world.alive.delete(SESSION_PID);
    world.writeSessionFile(ZOMBIE_SESSION_PID);
    world.zombify(ZOMBIE_SESSION_PID);
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`)).toBeUndefined();
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/${String(ZOMBIE_SESSION_PID)}.json`)).toBeUndefined();
  });

  it("reinstalls a pinned source whose commit differs from the installed build even when no install is recorded and the version satisfies it", async () => {
    const world = makeWorld();
    world.installedCommit = OTHER_COMMIT;
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([HEADROOM_DEFAULT_SOURCE]);
  });

  it("does not reinstall a pinned source whose commit matches the installed build", async () => {
    const world = makeWorld();
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([]);
  });

  it("does not compare commits for a source that follows a moving ref", async () => {
    const world = makeWorld();
    world.installedCommit = undefined;
    await supervise(world, { ...config, source: "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@main" }, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([]);
  });

  it("reinstalls when the configured source changed since the last install", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: 1,
      installedSource: "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/per-session-savings",
    });
    await supervise(world, resolveSupervisorConfig({ source: "headroom==0.39.0" }), { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual(["headroom==0.39.0"]);
  });
});

describe("stopSupervisedProcess", () => {
  const STOP_PID = 900;

  /** How the modelled target responds: exiting on SIGTERM, ignoring SIGTERM until killed, surviving even SIGKILL, or being gone before the first signal. */
  type StopBehaviour = "dies-on-term" | "ignores-term" | "unkillable" | "already-gone";

  function stopWorld(behaviour: StopBehaviour) {
    const signals: NodeJS.Signals[] = [];
    let clock = 0;
    return {
      signals,
      elapsed: () => clock,
      primitives: {
        signal: (pid: number, signal: NodeJS.Signals) => {
          signals.push(signal);
          if (behaviour === "already-gone") {
            throw new Error(`kill(${String(pid)}) failed: no such process`);
          }
        },
        isRunning: () => {
          if (behaviour === "already-gone") {
            return false;
          }
          if (behaviour === "dies-on-term") {
            return !signals.includes("SIGTERM");
          }
          if (behaviour === "ignores-term") {
            return !signals.includes("SIGKILL");
          }
          return true;
        },
        waitMs: (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      },
    };
  }

  it("never escalates when the process exits on SIGTERM", () => {
    const world = stopWorld("dies-on-term");
    expect(stopSupervisedProcess(STOP_PID, world.primitives)).toBe("exited-on-term");
    expect(world.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL once the SIGTERM grace expires, because this proxy ignores SIGTERM", () => {
    const world = stopWorld("ignores-term");
    expect(stopSupervisedProcess(STOP_PID, world.primitives)).toBe("killed");
    expect(world.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(world.elapsed()).toBeGreaterThanOrEqual(TERM_GRACE_MS);
  });

  it("reports still-running when even SIGKILL does not clear the process within its grace", () => {
    const world = stopWorld("unkillable");
    expect(stopSupervisedProcess(STOP_PID, world.primitives)).toBe("still-running");
    expect(world.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(world.elapsed()).toBeGreaterThanOrEqual(TERM_GRACE_MS + KILL_GRACE_MS);
  });

  it("sends nothing further when the process is already gone", () => {
    const world = stopWorld("already-gone");
    expect(stopSupervisedProcess(STOP_PID, world.primitives)).toBe("exited-on-term");
    expect(world.signals).toEqual(["SIGTERM"]);
  });

  it("isRunning is consulted with the zombie-aware notion: a defunct target reads as gone", () => {
    // The dies-on-term model above exercises the happy path; this pins the contract the real implementation relies on: isRunning false means no escalation, whatever signal-0 would say.
    const world = stopWorld("already-gone");
    expect(stopSupervisedProcess(STOP_PID, world.primitives)).toBe("exited-on-term");
    expect(world.signals).not.toContain("SIGKILL");
  });
});
