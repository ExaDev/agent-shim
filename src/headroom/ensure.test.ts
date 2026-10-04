import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { ensureHeadroom, HeadroomStartError } from "./ensure";
import { writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SUPERVISOR_PID = 500;
const OTHER_LAUNCHER_PID = 777;
const SLEEPS_BEFORE_RECOVERY = 3;
const SLEEPS_BEFORE_OTHER_SUPERVENDOR_READY = 2;
const HEADROOM_PID = 501;
const SOCKET_PATH = "/home/testuser/.agent-shim/headroom/run/7.sock";
/** A supervisor pid that is dead in every test that names it, distinct from the live fake's SUPERVISOR_PID. */
const DEAD_SUPERVISOR_PID = 999;

/**
 * The fake world `ensureHeadroom` runs against: a fake filesystem, a clock that only advances when the code sleeps, a live-pid set, and a `spawnSupervisor` that records itself and can simulate the freshly spawned supervisor writing a ready state (immediately, or lazily on a later poll via `onSleep`).
 */
function makeWorld(options: { readonly spawnWritesReadyState?: boolean } = {}) {
  const fs = createFakeFarmFs({});
  let clock = 0;
  let onSleep: (() => void) | undefined;
  const alive = new Set<number>([SUPERVISOR_PID, HEADROOM_PID, process.pid]);
  const zombies = new Set<number>();
  const spawns: number[] = [];

  const world = {
    fs,
    alive,
    zombies,
    spawns,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    writeReadyState(socketPath = SOCKET_PATH, allowlistHash?: string): void {
      writeHeadroomState(fs, paths.headroomStateFile, {
        supervisorPid: SUPERVISOR_PID,
        headroomPid: HEADROOM_PID,
        socketPath,
        version: "headroom 0.39.1",
        ...(allowlistHash === undefined ? {} : { allowlistHash }),
      });
    },
    ports: {
      fs,
      isRunning: (pid: number) => alive.has(pid) && !zombies.has(pid),
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        if (onSleep !== undefined) {
          onSleep();
        }
      },
      spawnSupervisor: () => {
        spawns.push(SUPERVISOR_PID);
        if (options.spawnWritesReadyState !== false) {
          world.writeReadyState();
        }
        return SUPERVISOR_PID;
      },
    },
  };
  return world;
}

describe("ensureHeadroom", () => {
  it("starts a supervisor when nothing is running and waits for its ready state, then registers the session", () => {
    const world = makeWorld();
    const result = ensureHeadroom({ paths, launcherPid: 42, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/42.json`)).toBeDefined();
  });

  it("reuses an already-healthy daemon without spawning anything", () => {
    const world = makeWorld();
    world.writeReadyState();
    const result = ensureHeadroom({ paths, launcherPid: 43, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(0);
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/43.json`)).toBeDefined();
  });

  it("registers the session against the supervisor whose daemon socket it returns, so only that supervisor counts it as live", () => {
    const world = makeWorld();
    world.writeReadyState();
    ensureHeadroom({ paths, launcherPid: 44, ports: world.ports });
    const entry = JSON.parse(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/44.json`) ?? "{}") as Record<string, unknown>;
    expect(entry.supervisorPid).toBe(SUPERVISOR_PID);
  });

  it("spawns a replacement supervisor when the recorded one is dead", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: DEAD_SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
    });
    const result = ensureHeadroom({ paths, launcherPid: 44, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("spawns a replacement supervisor when the recorded one is an unreaped zombie that signal 0 still reports alive", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: DEAD_SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
    });
    // The supervisor died without being reaped: it still "exists" in the table, but nothing is running there.
    world.alive.add(DEAD_SUPERVISOR_PID);
    world.zombies.add(DEAD_SUPERVISOR_PID);
    const result = ensureHeadroom({ paths, launcherPid: 51, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("keeps waiting while a live supervisor has not yet recorded a serving socket, and returns once it has", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    // The supervisor half arrives first; the daemon's socket arrives partway through the wait.
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
    });
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 52, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_RECOVERY);
  });

  it("keeps waiting while a live supervisor restarts a dead daemon, and returns once it is back", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: DEAD_SUPERVISOR_PID,
      socketPath: SOCKET_PATH,
    });
    // The supervisor brings the daemon back partway through the wait.
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 45, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_RECOVERY);
  });

  it("does not spawn while another live launcher holds the start lock, and waits for that launcher's supervisor", () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.headroomDir);
    world.fs.writeFileUtf8(paths.headroomLockFile, JSON.stringify({ pid: OTHER_LAUNCHER_PID, at: 0 }));
    world.alive.add(OTHER_LAUNCHER_PID);
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_OTHER_SUPERVENDOR_READY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 46, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(0);
  });

  it("takes over a start lock whose holder is dead", () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.headroomDir);
    world.fs.writeFileUtf8(paths.headroomLockFile, JSON.stringify({ pid: OTHER_LAUNCHER_PID, at: 0 }));
    // 777 deliberately not in the alive set.
    const result = ensureHeadroom({ paths, launcherPid: 47, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("refuses immediately when a live supervisor has recorded a fatal lastError", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      lastError: "headroom failed to become ready 5 times in a row",
    });
    expect(() => ensureHeadroom({ paths, launcherPid: 48, ports: world.ports })).toThrow(HeadroomStartError);
    expect(world.spawns).toHaveLength(0);
  });

  it("times out loudly, naming the daemon log path, when nothing ever becomes ready", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    let error: unknown;
    try {
      ensureHeadroom({ paths, launcherPid: 49, ports: world.ports });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HeadroomStartError);
    expect((error as HeadroomStartError).message).toContain(paths.headroomLogPath);
    expect(world.spawns).toHaveLength(1);
  });

  it("does not re-register a session that already exists; writeSession is idempotent per pid", () => {
    const world = makeWorld();
    world.writeReadyState();
    writeSession(world.fs, paths.headroomSessionsDir, { pid: 50, startedAt: 123, supervisorPid: SUPERVISOR_PID });
    ensureHeadroom({ paths, launcherPid: 50, ports: world.ports });
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/50.json`)).toBeDefined();
  });
});

describe("ensureHeadroom allowlist gate", () => {
  const STALE_HASH = "hash-of-the-allowlist-the-daemon-started-with";
  const CURRENT_HASH = "hash-of-the-allowlist-this-launch-needs";
  /** The launch under test; each test has its own world, so one pid serves them all. */
  const GATED_LAUNCHER_PID = 61;
  const required = (): string => CURRENT_HASH;
  const sessionFile = (pid: number): string => `${paths.headroomSessionsDir}/${String(pid)}.json`;

  it("registers a provider launch at once when the daemon was started with the allowlist the launch needs", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, CURRENT_HASH);
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toEqual({ socketPath: SOCKET_PATH });
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
  });

  it("does not hold a launch that needs only Claude Code's own API to the allowlist, since every daemon admits it", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports })).toEqual({ socketPath: SOCKET_PATH });
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
  });

  it("refuses a provider launch whose daemon predates the allowlist while a live session holds it, naming that session and registering nothing", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    world.alive.add(OTHER_LAUNCHER_PID);
    writeSession(world.fs, paths.headroomSessionsDir, { pid: OTHER_LAUNCHER_PID, startedAt: 0, supervisorPid: SUPERVISOR_PID });
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toThrow(HeadroomStartError);
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toThrow(String(OTHER_LAUNCHER_PID));
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
  });

  it("ignores a registered session whose launcher has died, since the supervisor prunes it before restarting", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    writeSession(world.fs, paths.headroomSessionsDir, { pid: OTHER_LAUNCHER_PID, startedAt: 0, supervisorPid: SUPERVISOR_PID });
    world.onSleep = () => {
      world.writeReadyState(SOCKET_PATH, CURRENT_HASH);
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toEqual({ socketPath: SOCKET_PATH });
  });

  it("waits for the restart that brings the allowlist when no session holds the daemon, and registers only once it is back", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        world.writeReadyState(SOCKET_PATH, CURRENT_HASH);
      }
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBe(SLEEPS_BEFORE_RECOVERY);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
  });

  it("re-reads the required hash on every poll, so a front door that moves while the launch waits is followed", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    let needed = CURRENT_HASH;
    world.onSleep = () => {
      needed = STALE_HASH;
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: () => needed })).toEqual({ socketPath: SOCKET_PATH });
  });

  it("times out loudly, saying the allowlist is why, when the daemon never restarts", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, STALE_HASH);
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredAllowlistHash: required })).toThrow(/allowlist does not admit this launch's front door/);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
  });
});
