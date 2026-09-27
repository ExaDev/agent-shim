import { describe, expect, it } from "vitest";

import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
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
  stopSupervisedProcess,
  TERM_GRACE_MS,
  versionSatisfies,
  type SupervisorPorts,
} from "./supervisor";
import { hashAllowlist, headroomAllowlist, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const SESSION_PID = 321;
const ZOMBIE_SESSION_PID = 322;
const ORPHAN_DAEMON_PID = 888;
const ORPHAN_DAEMON_PORT = 4321;
const STICKY_PORT = 4100;
const STICKY_MITM_PORT = 4101;
const OWN_PID = 4242;
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
      JSON.stringify({ displayName: provider.name, baseUrl: provider.baseUrl, tokenEnv: "T" }),
    );
  }

  let clock = 0;
  let nextPid = 1000;
  let nextPort = 2000;
  let nextMitmPort = 3000;
  const readyPorts = new Set<number>();
  let autoReady = true;
  let version: string | undefined = "headroom 0.39.1";
  let installOk = true;
  let mitmStartError: Error | undefined;
  const alive = new Set<number>([process.pid]);
  const zombies = new Set<number>();
  const occupied = new Set<number>();
  let freePortCalls = 0;
  const spawns: { pid: number; port: number; allowlist: readonly string[] }[] = [];
  const mitmBinds: { port: number; preferred: number | undefined }[] = [];
  const mitmCloses: number[] = [];
  const stops: number[] = [];
  const installs: string[] = [];
  const logLines: string[] = [];
  const sleepDelays: number[] = [];
  let onSleep: (() => void) | undefined;

  /** Resolves on a later microtask, the way a real readiness probe awaits I/O; also keeps the promise-shaped fakes honest under the async rules. */
  async function settled<T>(value: T): Promise<T> {
    return await Promise.resolve(value);
  }

  /** A dead daemon closes its listener, whatever its port was: without this, a reused port would keep answering /readyz from beyond the grave. */
  function dropReadyPort(pid: number): void {
    for (let index = spawns.length - 1; index >= 0; index -= 1) {
      const spawn = spawns[index];
      if (spawn?.pid === pid) {
        readyPorts.delete(spawn.port);
        return;
      }
    }
  }

  const world = {
    fs,
    alive,
    zombies,
    occupied,
    spawns,
    mitmBinds,
    mitmCloses,
    stops,
    installs,
    logLines,
    sleepDelays,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** When false, spawned proxies never answer /readyz, whatever port they get. */
    set autoReady(value: boolean) {
      autoReady = value;
    },
    /** When set, the MITM proxy cannot bind, the way a poisoned port or a missing certificate would fail a real bind. */
    set mitmStartError(error: Error | undefined) {
      mitmStartError = error;
    },
    set version(value: string | undefined) {
      version = value;
    },
    set installOk(value: boolean) {
      installOk = value;
    },
    /** The ChildProcess exit event arriving: death observed, child reaped, no zombie remains. */
    kill(pid: number): void {
      alive.delete(pid);
      zombies.delete(pid);
      dropReadyPort(pid);
    },
    /** The observed macOS failure mode: the process died but nothing reaped it, so signal 0 still answers while nothing is running. */
    zombify(pid: number): void {
      zombies.add(pid);
      dropReadyPort(pid);
    },
    freePortCallCount: () => freePortCalls,
    writeSessionFile(pid: number): void {
      alive.add(pid);
      writeSession(fs, paths.headroomSessionsDir, { pid, startedAt: clock });
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
      freePort: async () => {
        freePortCalls += 1;
        nextPort += 1;
        return await settled(nextPort);
      },
      isPortFree: async (port: number) => await settled(!occupied.has(port)),
      spawnHeadroom: (port: number, allowlist: readonly string[]) => {
        nextPid += 1;
        alive.add(nextPid);
        zombies.delete(nextPid);
        spawns.push({ pid: nextPid, port, allowlist: [...allowlist] });
        if (autoReady) {
          readyPorts.add(port);
        }
        return nextPid;
      },
      stopProcess: (pid: number) => {
        alive.delete(pid);
        stops.push(pid);
      },
      ready: async (port: number) => await settled(readyPorts.has(port)),
      install: (spec: string) => {
        installs.push(spec);
        if (installOk) {
          // A successful install puts the binary on PATH, like the real one does.
          version ??= "headroom 0.39.1";
          return { ok: true };
        }
        return { ok: false, error: "uv is not installed or not on PATH (spawn ENOENT)" };
      },
      headroomVersion: () => version,
      startMitm: async (preferredPort: number | undefined) => {
        if (mitmStartError !== undefined) {
          throw mitmStartError;
        }
        const port = preferredPort !== undefined && !occupied.has(preferredPort) ? preferredPort : (nextMitmPort += 1);
        occupied.add(port);
        mitmBinds.push({ port, preferred: preferredPort });
        return await settled({
          port,
          close: async () => {
            await settled(undefined);
            occupied.delete(port);
            mitmCloses.push(port);
          },
        });
      },
      log: (line: string) => {
        logLines.push(line);
      },
    } satisfies SupervisorPorts,
  };
  return world;
}

const config = resolveSupervisorConfig({});

describe("resolveSupervisorConfig", () => {
  it("defaults source and idle shutdown from the named constants", () => {
    expect(resolveSupervisorConfig({})).toEqual({
      source: HEADROOM_DEFAULT_SOURCE,
      idleShutdownMinutes: HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES,
    });
    expect(resolveSupervisorConfig({ source: "headroom==0.39.0", idleShutdownMinutes: 5 })).toEqual({
      source: "headroom==0.39.0",
      idleShutdownMinutes: 5,
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

    const code = await runSupervisor(config, world.ports, { tickLimit: TICKS_INSTALL_TEST });

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
    expect(state.port).toBe(spawn.port);
    expect(state.allowlistHash).toBe(hashAllowlist(headroomAllowlist([{ baseUrl: "https://api.z.ai/api/anthropic" }])));
    expect(state.installedSource).toBe(HEADROOM_DEFAULT_SOURCE);
  });

  it("does not install when the installed version already satisfies the configured source", async () => {
    const world = makeWorld();
    await runSupervisor(resolveSupervisorConfig({ source: "headroom>=0.39" }), world.ports, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([]);
    expect(world.spawns).toHaveLength(1);
  });

  it("exits non-zero and records lastError when installing is impossible (uv absent)", async () => {
    const world = makeWorld();
    world.version = undefined;
    world.installOk = false;

    const code = await runSupervisor(config, world.ports);

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
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_CRASH_RESTART });
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
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_CRASH_RESTART });
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

  it("clears the daemon fields from state the moment a crash is detected, so status never claims a dead port", async () => {
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
    await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_SHORT });
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.port).toBeUndefined();
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
      port: ORPHAN_DAEMON_PORT,
      installedSource: HEADROOM_DEFAULT_SOURCE,
    });
    const code = await runSupervisor(config, world.ports, { tickLimit: TICKS_SHORT });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toContain(ORPHAN_DAEMON_PID);
    expect(world.spawns).toHaveLength(1);
    expect(world.alive.has(ORPHAN_DAEMON_PID)).toBe(false);
  });

  it("reuses the sticky port from state on start and on every restart while it stays free, so live sessions keep their address", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastPort: STICKY_PORT });
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
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
    expect(world.spawns.map((spawn) => spawn.port)).toEqual([STICKY_PORT, STICKY_PORT]);
    expect(world.freePortCallCount()).toBe(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.port).toBe(STICKY_PORT);
    expect(state.lastPort).toBe(STICKY_PORT);
  });

  it("falls back to a fresh port and records the move when the sticky port is occupied", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastPort: STICKY_PORT });
    world.occupied.add(STICKY_PORT);
    await runSupervisor(config, world.ports, { tickLimit: TICKS_SHORT });
    const fresh = world.spawns[0];
    if (fresh === undefined) {
      throw new Error("expected a spawn");
    }
    expect(fresh.port).not.toBe(STICKY_PORT);
    expect(world.freePortCallCount()).toBe(1);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.lastPort).toBe(fresh.port);
    expect(world.logLines.some((line) => line.includes(`sticky port ${String(STICKY_PORT)} was occupied`))).toBe(true);
  });

  it("keeps lastPort across an idle shutdown and seeds the next supervisor generation with it", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastPort: STICKY_PORT });
    const idleCode = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports);
    expect(idleCode).toBe(0);
    const shutDown = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(shutDown.port).toBeUndefined();
    expect(shutDown.lastPort).toBe(STICKY_PORT);
    const nextCode = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_SHORT });
    expect(nextCode).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns[0]?.port).toBe(STICKY_PORT);
    expect(world.freePortCallCount()).toBe(0);
  });

  it("binds the MITM proxy once per generation on its sticky port and keeps it serving across a daemon crash restart", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastPort: STICKY_PORT, lastMitmPort: STICKY_MITM_PORT });
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
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    // The daemon restarts; the proxy lives in this process, so it is bound exactly once and never moves.
    expect(world.spawns).toHaveLength(2);
    expect(world.spawns.map((spawn) => spawn.port)).toEqual([STICKY_PORT, STICKY_PORT]);
    expect(world.mitmBinds).toEqual([{ port: STICKY_MITM_PORT, preferred: STICKY_MITM_PORT }]);
    expect(world.mitmCloses).toEqual([]);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.mitmPort).toBe(STICKY_MITM_PORT);
    expect(state.lastMitmPort).toBe(STICKY_MITM_PORT);
  });

  it("falls back to a fresh MITM port and records the move when the sticky MITM port is occupied", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastMitmPort: STICKY_MITM_PORT });
    world.occupied.add(STICKY_MITM_PORT);
    await runSupervisor(config, world.ports, { tickLimit: TICKS_SHORT });
    const bound = world.mitmBinds[0];
    if (bound === undefined) {
      throw new Error("expected a MITM bind");
    }
    expect(bound.port).not.toBe(STICKY_MITM_PORT);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.mitmPort).toBe(bound.port);
    expect(state.lastMitmPort).toBe(bound.port);
    expect(world.logLines.some((line) => line.includes(`sticky MITM port ${String(STICKY_MITM_PORT)} was occupied`))).toBe(true);
  });

  it("closes the MITM proxy on idle shutdown and seeds the next generation with both sticky ports", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, { lastPort: STICKY_PORT, lastMitmPort: STICKY_MITM_PORT });
    const idleCode = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports);
    expect(idleCode).toBe(0);
    expect(world.mitmCloses).toEqual([STICKY_MITM_PORT]);
    const shutDown = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(shutDown.mitmPort).toBeUndefined();
    expect(shutDown.lastMitmPort).toBe(STICKY_MITM_PORT);
    const nextCode = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_SHORT });
    expect(nextCode).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns[0]?.port).toBe(STICKY_PORT);
    expect(world.mitmBinds.at(-1)?.port).toBe(STICKY_MITM_PORT);
  });

  it("exits non-zero and records lastError when the MITM proxy cannot bind, without starting the daemon", async () => {
    const world = makeWorld();
    world.mitmStartError = new Error("EADDRINUSE everywhere");
    const code = await runSupervisor(config, world.ports);
    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    expect(world.mitmBinds).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("could not start the MITM proxy");
  });

  it("gives up after the retry budget when the daemon never becomes ready, recording lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;

    const code = await runSupervisor(config, world.ports);

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
          JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", tokenEnv: "T" }),
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

    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_DRIFT_TEST });

    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
    const second = world.spawns[1];
    if (second === undefined) {
      throw new Error("expected a restart spawn");
    }
    expect(second.allowlist).toContain("https://api.minimax.io");
    expect(world.stops).toHaveLength(1);
  });

  it("shuts the daemon down after the idle period with an empty registry", async () => {
    const world = makeWorld();
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports);
    expect(code).toBe(0);
    expect(world.stops).toHaveLength(1);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBeUndefined();
    expect(state.port).toBeUndefined();
  });

  it("resets the idle clock while a session is live, so a long session never triggers shutdown", async () => {
    const world = makeWorld();
    world.onSleep = () => {
      if (world.spawns.length > 0) {
        world.writeSessionFile(SESSION_PID);
      }
    };
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports, { tickLimit: TICKS_LONG_SESSION });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toHaveLength(0);
  });

  it("prunes registry entries whose launcher pid has died, including a zombie the signal-0 table still lists", async () => {
    const world = makeWorld();
    world.writeSessionFile(SESSION_PID);
    world.alive.delete(SESSION_PID);
    world.writeSessionFile(ZOMBIE_SESSION_PID);
    world.zombify(ZOMBIE_SESSION_PID);
    await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_INSTALL_TEST });
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`)).toBeUndefined();
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/${String(ZOMBIE_SESSION_PID)}.json`)).toBeUndefined();
  });

  it("reinstalls when the configured source changed since the last install", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: 1,
      installedSource: "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/per-session-savings",
    });
    await runSupervisor(resolveSupervisorConfig({ source: "headroom==0.39.0" }), world.ports, { tickLimit: TICKS_SHORT });
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
