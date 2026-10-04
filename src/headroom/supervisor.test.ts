import { describe, expect, it } from "vitest";

import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { FAKE_UID, createFakeFarmFs, fakeSocketTrust } from "../test-helpers";
import {
  backoffForAttempt,
  HEADROOM_SUPERVISOR_STILL_RUNNING,
  HEADROOM_BACKOFF_BASE_MS,
  HEADROOM_BACKOFF_CAP_MS,
  HEADROOM_POLL_MS,
  HEADROOM_START_RETRY_BUDGET,
  KILL_GRACE_MS,
  resolveSupervisorConfig,
  runSupervisor,
  type HeadroomSupervisorConfig,
  type RunSupervisorOptions,
  stopSupervisedProcess,
  TERM_GRACE_MS,
  versionSatisfies,
  type SupervisorPorts,
} from "./supervisor";
import type { HeadroomSettings } from "./settings";
import { HEADROOM_SOCKET_DIR_MODE, headroomSocketPath, UNIX_SOCKET_PATH_MAX_BYTES, type SocketPathStat } from "./socket";
import { pinnedGitCommit } from "./source";
import { hashAllowlist, headroomAllowlist, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SESSION_PID = 321;
const ZOMBIE_SESSION_PID = 322;
const ORPHAN_DAEMON_PID = 888;
const OWN_PID = 4242;
const OTHER_SUPERVISOR_PID = 5151;
const OTHER_DAEMON_PID = 5152;
/** The socket this supervisor generation serves on. */
const OWN_SOCKET = headroomSocketPath(paths, OWN_PID);
/** The socket another live supervisor's daemon serves on. */
const OTHER_SOCKET = headroomSocketPath(paths, OTHER_SUPERVISOR_PID);
/** A supervisor pid nothing is running as: whatever socket it left is stale. */
const DEAD_SUPERVISOR_PID = 6161;
/** Another user's uid, for a socket directory this user does not own. */
const OTHER_UID = 0;
/** A socket directory mode other users can enter and list. */
const GROUP_READABLE_DIR_MODE = 0o750;
/** A full commit SHA that is not the default source's pinned commit. */
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TICKS_INSTALL_TEST = 3;
const TICKS_SHORT = 2;
const TICKS_CRASH_RESTART = 6;
const TICKS_DRIFT_TEST = 40;
const TICKS_LONG_SESSION = 100;
const IDLE_ONE_MINUTE = 1;
const IDLE_NEVER_MINUTES = 60;
const DEFERRAL_TICKS = 5;
const FIRST_BACKOFF_ATTEMPT = 1;
const LAST_BACKOFF_ATTEMPT = 5;
const BIG_ATTEMPT = 20;
const ATTEMPT_THREE = 3;
const ATTEMPT_FOUR = 4;
const DRIFT_DONE_PHASE = 3;

/**
 * The fake world `runSupervisor` runs against: a fake filesystem seeded with providers, a clock advanced only by the supervisor's own sleeps, a modelled process table, and controllable readiness, install, and version results. `onSleep` lets a test script the outside world (a provider file appearing, a session ending) between ticks.
 *
 * The process model distinguishes exactly what the real one does: `alive` is signal-0-style existence, `zombies` holds pids that exited without being reaped (still "existing", never running), and `kill` models the ChildProcess exit event (death observed and the child reaped, the way the real supervisor's exit listener does).
 */
function makeWorld(seededProviders: readonly { name: string; baseUrl: string }[] = []) {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  for (const provider of seededProviders) {
    fs.writeFileUtf8(
      `${paths.providersDir}/${provider.name}.json`,
      JSON.stringify({ displayName: provider.name, baseUrl: provider.baseUrl, credential: { sources: [{ env: "T" }] } }),
    );
  }

  let clock = 0;
  let nextPid = 1000;
  const readySockets = new Set<string>();
  let autoReady = true;
  let version: string | undefined = "headroom 0.39.1";
  let installOk = true;
  let installedCommit: string | undefined = pinnedGitCommit(HEADROOM_DEFAULT_SOURCE);
  const alive = new Set<number>([process.pid]);
  const zombies = new Set<number>();
  const spawns: { pid: number; socketPath: string; allowlist: readonly string[]; settings: HeadroomSettings }[] = [];
  let platform = "linux";
  let socketStatOverrides: Record<string, SocketPathStat> = {};
  let currentConfig: HeadroomSupervisorConfig = resolveSupervisorConfig({});
  const stops: number[] = [];
  const installs: string[] = [];
  const logLines: string[] = [];
  const sleepDelays: number[] = [];
  let onSleep: (() => void) | undefined;

  /** Resolves on a later microtask, the way a real readiness probe awaits I/O; also keeps the promise-shaped fakes honest under the async rules. */
  async function settled<T>(value: T): Promise<T> {
    return await Promise.resolve(value);
  }

  /** A dead daemon closes its listener: without this, a generation's reused socket path would keep answering /readyz from beyond the grave. */
  function dropReadySocket(pid: number): void {
    for (let index = spawns.length - 1; index >= 0; index -= 1) {
      const spawn = spawns[index];
      if (spawn?.pid === pid) {
        readySockets.delete(spawn.socketPath);
        return;
      }
    }
  }

  const world = {
    setConfig: (next: HeadroomSupervisorConfig) => {
      currentConfig = next;
    },
    fs,
    alive,
    zombies,
    spawns,
    stops,
    installs,
    logLines,
    sleepDelays,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** The platform the socket checks see. */
    set platform(value: string) {
      platform = value;
    },
    /** Socket-check stats that replace the fake filesystem's, keyed by resolved path: another owner, a wide mode, a symlink. */
    set socketStats(value: Record<string, SocketPathStat>) {
      socketStatOverrides = value;
    },
    /** When false, spawned proxies never answer /readyz. */
    set autoReady(value: boolean) {
      autoReady = value;
    },
    /** When set, the MITM proxy cannot bind, the way a poisoned port or a missing certificate would fail a real bind. */
    set version(value: string | undefined) {
      version = value;
    },
    set installOk(value: boolean) {
      installOk = value;
    },
    /** The commit the installed binary was built from, as its direct_url.json records it. Defaults to the default source's pinned commit, so a test that does not care sees a matching install. */
    set installedCommit(value: string | undefined) {
      installedCommit = value;
    },
    /** The ChildProcess exit event arriving: death observed, child reaped, no zombie remains. */
    kill(pid: number): void {
      alive.delete(pid);
      zombies.delete(pid);
      dropReadySocket(pid);
    },
    /** The observed macOS failure mode: the process died but nothing reaped it, so signal 0 still answers while nothing is running. */
    zombify(pid: number): void {
      zombies.add(pid);
      dropReadySocket(pid);
    },
    /** Registers a live launcher against `supervisorPid`: this supervisor unless a test says another one owns the session. */
    writeSessionFile(pid: number, supervisorPid: number = OWN_PID): void {
      alive.add(pid);
      writeSession(fs, paths.headroomSessionsDir, { pid, startedAt: clock, supervisorPid });
    },
    /** Another supervisor taking ownership of the state file: alive, with its own daemon and socket recorded, the way a second supervisor's startup or crash-restart leaves the file. */
    handOwnershipToAnotherSupervisor(): void {
      alive.add(OTHER_SUPERVISOR_PID);
      alive.add(OTHER_DAEMON_PID);
      writeHeadroomState(fs, paths.headroomStateFile, {
        supervisorPid: OTHER_SUPERVISOR_PID,
        headroomPid: OTHER_DAEMON_PID,
        socketPath: OTHER_SOCKET,
        installedSource: HEADROOM_DEFAULT_SOURCE,
      });
    },
    ports: {
      fs,
      paths,
      ownPid: OWN_PID,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        sleepDelays.push(ms);
        if (onSleep !== undefined) {
          onSleep();
        }
        await settled(undefined);
      },
      isRunning: (pid: number) => alive.has(pid) && !zombies.has(pid),
      // Read through getters, so a test can switch the platform or replace a stat after the world is built.
      socketTrust: {
        get platform() {
          return platform;
        },
        currentUid: () => FAKE_UID,
        lstat: (target: string) => fakeSocketTrust(fs, { overrides: socketStatOverrides }).lstat(target),
      },
      readConfig: () => currentConfig,
      spawnHeadroom: (socketPath: string, allowlist: readonly string[], settings: Readonly<HeadroomSettings>) => {
        nextPid += 1;
        alive.add(nextPid);
        zombies.delete(nextPid);
        spawns.push({ pid: nextPid, socketPath, allowlist: [...allowlist], settings });
        if (autoReady) {
          readySockets.add(socketPath);
        }
        return nextPid;
      },
      stopProcess: (pid: number) => {
        alive.delete(pid);
        stops.push(pid);
      },
      ready: async (socketPath: string) => await settled(readySockets.has(socketPath)),
      install: (spec: string) => {
        installs.push(spec);
        if (installOk) {
          installedCommit = pinnedGitCommit(spec);
          // A successful install puts the binary on PATH, like the real one does.
          version ??= "headroom 0.39.1";
          return { ok: true };
        }
        return { ok: false, error: "uv is not installed or not on PATH (spawn ENOENT)" };
      },
      headroomVersion: () => version,
      installedCommit: () => installedCommit,
      log: (line: string) => {
        logLines.push(line);
      },
    } satisfies SupervisorPorts,
  };
  return world;
}

const config = resolveSupervisorConfig({});

/** Runs the supervisor against `world` with `supervisorConfig` as both its starting configuration and what it reads from disk each tick. */
async function supervise(world: ReturnType<typeof makeWorld>, supervisorConfig: HeadroomSupervisorConfig, options?: RunSupervisorOptions): Promise<number> {
  world.setConfig(supervisorConfig);
  return await runSupervisor(supervisorConfig, world.ports, options);
}

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
    expect(spawn.allowlist).toEqual([
      "https://api.anthropic.com",
      "https://api.z.ai/api/anthropic",
    ]);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OWN_PID);
    expect(state.headroomPid).toBe(spawn.pid);
    expect(spawn.socketPath).toBe(OWN_SOCKET);
    expect(state.socketPath).toBe(OWN_SOCKET);
    expect(state.allowlistHash).toBe(hashAllowlist(headroomAllowlist([{ baseUrl: "https://api.z.ai/api/anthropic" }])));
    expect(state.installedSource).toBe(HEADROOM_DEFAULT_SOURCE);
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
    expect(state.headroomPid).toBeUndefined();
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
    const code = await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toContain(ORPHAN_DAEMON_PID);
    expect(world.spawns).toHaveLength(1);
    expect(world.alive.has(ORPHAN_DAEMON_PID)).toBe(false);
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
    expect(world.fs.readdir(paths.headroomSocketDir)).toEqual([`${String(OTHER_SUPERVISOR_PID)}.sock`, "notes.txt"]);
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

  it("defers a drift restart while a session is live and restarts once the registry empties", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    let phase = 0;
    world.onSleep = () => {
      if (phase === 0 && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        phase = 1;
        return;
      }
      if (phase === 1) {
        // A new provider appears: the allowlist drifts while a session is live.
        world.fs.writeFileUtf8(
          `${paths.providersDir}/m.json`,
          JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", credential: { sources: [{ env: "T" }] } }),
        );
        phase = 2;
        return;
      }
      if (phase === 2 && world.spawns.length === 1 && world.stops.length === 0) {
        // Give the deferral a few ticks to prove it does not restart under a live session.
        if (world.sleepDelays.filter((delay) => delay === HEADROOM_POLL_MS).length >= DEFERRAL_TICKS) {
          world.alive.delete(SESSION_PID);
          world.fs.removeRecursive(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`);
          phase = DRIFT_DONE_PHASE;
        }
      }
    };

    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_DRIFT_TEST });

    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
    const second = world.spawns[1];
    if (second === undefined) {
      throw new Error("expected a restart spawn");
    }
    expect(second.allowlist).toContain("https://api.minimax.io");
    expect(world.stops).toHaveLength(1);
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
