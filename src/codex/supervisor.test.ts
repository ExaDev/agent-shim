import { describe, expect, it } from "vitest";

import { writeSession, listSessions, removeSession } from "../headroom/state";
import { HEADROOM_START_RETRY_BUDGET } from "../headroom/supervisor";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { CodexStartError, ensureCodex } from "./ensure";
import { codexDaemonOrigin, readCodexState, writeCodexState } from "./state";
import { CODEX_POLL_MS, CODEX_SUPERVISOR_STILL_RUNNING, runCodexSupervisor, type CodexSupervisorPorts } from "./supervisor";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const OWN_PID = 4242;
const FIRST_SESSION = 301;
const SECOND_SESSION = 302;
const STICKY_PORT = 4100;
const IDLE_MINUTES = 1;
const MS_PER_MINUTE = 60_000;
const TICKS = 10;
const WORKER_PID = 1001;

/**
 * The fake world the supervisor runs against: an in-memory filesystem, a clock advanced only by the supervisor's own sleeps, a modelled process table, and workers that answer their health check unless told otherwise. `onSleep` lets a test act between ticks (a session ending, a worker being killed).
 */
function makeWorld() {
  const fs = createFakeFarmFs({});
  let clock = 0;
  let nextPid = 1000;
  let nextPort = 5000;
  const alive = new Set<number>([OWN_PID]);
  const occupied = new Set<number>();
  const listening = new Map<number, number>();
  const spawns: { pid: number; port: number }[] = [];
  const stops: number[] = [];
  const logs: string[] = [];
  let healthy = true;
  let onSleep: (() => void) | undefined;

  /** The process dies and its listener with it, the way SIGKILL mid-stream leaves things. */
  const kill = (pid: number): void => {
    alive.delete(pid);
    for (const [port, owner] of listening) {
      if (owner === pid) {
        listening.delete(port);
      }
    }
  };

  const ports: CodexSupervisorPorts = {
    fs,
    paths,
    ownPid: OWN_PID,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep?.();
      await Promise.resolve();
    },
    isRunning: (pid) => alive.has(pid),
    freePort: async () => await Promise.resolve((nextPort += 1)),
    isPortFree: async (port) => await Promise.resolve(!occupied.has(port) && !listening.has(port)),
    spawnWorker: (port) => {
      nextPid += 1;
      alive.add(nextPid);
      if (healthy) {
        listening.set(port, nextPid);
      }
      spawns.push({ pid: nextPid, port });
      return nextPid;
    },
    stopProcess: (pid) => {
      stops.push(pid);
      kill(pid);
    },
    ready: async (port) => await Promise.resolve(listening.has(port)),
    log: (line) => {
      logs.push(line);
    },
  };

  const world = {
    fs,
    ports,
    alive,
    occupied,
    spawns,
    stops,
    logs,
    set healthy(value: boolean) {
      healthy = value;
    },
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    clock: () => clock,
    kill,
  };
  return world;
}

function session(world: ReturnType<typeof makeWorld>, pid: number): void {
  world.alive.add(pid);
  writeSession(world.fs, paths.codexSessionsDir, { pid, startedAt: 0 });
}

describe("runCodexSupervisor", () => {
  it("starts the worker on a free port, records it, and clears the start lock", async () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.codexDir);
    world.fs.writeFileUtf8(paths.codexLockFile, "{}");
    session(world, FIRST_SESSION);
    expect(await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 })).toBe(CODEX_SUPERVISOR_STILL_RUNNING);
    const [spawn] = world.spawns;
    expect(readCodexState(world.fs, paths.codexStateFile)).toEqual({ supervisorPid: OWN_PID, workerPid: spawn?.pid, port: spawn?.port, lastPort: spawn?.port });
    expect(world.fs.readFileUtf8(paths.codexLockFile)).toBeUndefined();
  });

  it("reuses the sticky port from the previous generation", async () => {
    const world = makeWorld();
    writeCodexState(world.fs, paths.codexStateFile, { lastPort: STICKY_PORT });
    session(world, FIRST_SESSION);
    await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.spawns.map((spawn) => spawn.port)).toEqual([STICKY_PORT]);
  });

  it("moves off an occupied sticky port and says so", async () => {
    const world = makeWorld();
    writeCodexState(world.fs, paths.codexStateFile, { lastPort: STICKY_PORT });
    world.occupied.add(STICKY_PORT);
    session(world, FIRST_SESSION);
    await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.spawns[0]?.port).not.toBe(STICKY_PORT);
    expect(world.logs.some((line) => line.includes("was occupied"))).toBe(true);
  });

  it("restarts a worker killed mid-stream on the same port, so live sessions keep their address", async () => {
    const world = makeWorld();
    session(world, FIRST_SESSION);
    let killed = false;
    world.onSleep = () => {
      const first = world.spawns[0];
      if (!killed && first !== undefined) {
        killed = true;
        world.kill(first.pid);
      }
    };
    await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 3 });
    expect(world.spawns).toHaveLength(2);
    expect(world.spawns[1]?.port).toBe(world.spawns[0]?.port);
    expect(readCodexState(world.fs, paths.codexStateFile)?.workerPid).toBe(world.spawns[1]?.pid);
    expect(world.logs.some((line) => line.includes("died"))).toBe(true);
  });

  it("keeps serving a second session after the first one exits", async () => {
    const world = makeWorld();
    session(world, FIRST_SESSION);
    session(world, SECOND_SESSION);
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 2) {
        world.alive.delete(FIRST_SESSION);
      }
    };
    const idleTicks = (IDLE_MINUTES * MS_PER_MINUTE) / CODEX_POLL_MS;
    expect(await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: idleTicks + TICKS })).toBe(CODEX_SUPERVISOR_STILL_RUNNING);
    expect(listSessions(world.fs, paths.codexSessionsDir).map((entry) => entry.pid)).toEqual([SECOND_SESSION]);
    expect(world.spawns).toHaveLength(1);
    expect(world.stops).toEqual([]);
  });

  it("stops the worker and exits once no session has been live for the idle window, keeping the sticky port", async () => {
    const world = makeWorld();
    session(world, FIRST_SESSION);
    world.onSleep = () => {
      removeSession(world.fs, paths.codexSessionsDir, FIRST_SESSION);
    };
    expect(await runCodexSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    const port = world.spawns[0]?.port;
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    expect(readCodexState(world.fs, paths.codexStateFile)).toEqual({ lastPort: port });
    expect(world.clock()).toBeGreaterThanOrEqual(IDLE_MINUTES * MS_PER_MINUTE);
  });

  it("gives up after the retry budget and records the error", async () => {
    const world = makeWorld();
    world.healthy = false;
    expect(await runCodexSupervisor(IDLE_MINUTES, world.ports)).toBe(1);
    expect(world.spawns).toHaveLength(HEADROOM_START_RETRY_BUDGET);
    expect(readCodexState(world.fs, paths.codexStateFile)?.lastError).toContain("giving up");
  });

  it("takes over a worker its predecessor left behind", async () => {
    const world = makeWorld();
    const orphan = 999;
    world.alive.add(orphan);
    writeCodexState(world.fs, paths.codexStateFile, { supervisorPid: 1, workerPid: orphan, port: STICKY_PORT, lastPort: STICKY_PORT });
    session(world, FIRST_SESSION);
    await runCodexSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.stops[0]).toBe(orphan);
  });
});

describe("ensureCodex", () => {
  function launcherWorld() {
    const fs = createFakeFarmFs({});
    let clock = 0;
    const alive = new Set<number>();
    const spawned: number[] = [];
    let onSleep: (() => void) | undefined;
    return {
      fs,
      alive,
      spawned,
      set onSleep(hook: (() => void) | undefined) {
        onSleep = hook;
      },
      ports: {
        fs,
        isRunning: (pid: number) => alive.has(pid),
        now: () => clock,
        sleep: (ms: number) => {
          clock += ms;
          onSleep?.();
        },
        spawnSupervisor: () => {
          spawned.push(OWN_PID);
          alive.add(OWN_PID);
          return OWN_PID;
        },
      },
    };
  }

  it("spawns one supervisor under the lock, waits for it to report ready, and registers the launcher", () => {
    const world = launcherWorld();
    world.onSleep = () => {
      world.alive.add(WORKER_PID);
      writeCodexState(world.fs, paths.codexStateFile, { supervisorPid: OWN_PID, workerPid: WORKER_PID, port: STICKY_PORT, lastPort: STICKY_PORT });
    };
    expect(ensureCodex({ paths, launcherPid: FIRST_SESSION, ports: world.ports })).toEqual({ port: STICKY_PORT });
    expect(world.spawned).toEqual([OWN_PID]);
    expect(listSessions(world.fs, paths.codexSessionsDir).map((entry) => entry.pid)).toEqual([FIRST_SESSION]);
  });

  it("joins a running daemon without spawning", () => {
    const world = launcherWorld();
    world.alive.add(OWN_PID);
    world.alive.add(WORKER_PID);
    writeCodexState(world.fs, paths.codexStateFile, { supervisorPid: OWN_PID, workerPid: WORKER_PID, port: STICKY_PORT });
    expect(ensureCodex({ paths, launcherPid: SECOND_SESSION, ports: world.ports })).toEqual({ port: STICKY_PORT });
    expect(world.spawned).toEqual([]);
  });

  it("waits for another launcher's start instead of spawning a second supervisor", () => {
    const world = launcherWorld();
    const other = 777;
    world.alive.add(other);
    world.fs.mkdirp(paths.codexDir);
    world.fs.writeFileUtf8(paths.codexLockFile, JSON.stringify({ pid: other, at: 0 }));
    world.onSleep = () => {
      world.alive.add(OWN_PID);
      world.alive.add(WORKER_PID);
      writeCodexState(world.fs, paths.codexStateFile, { supervisorPid: OWN_PID, workerPid: WORKER_PID, port: STICKY_PORT });
    };
    expect(ensureCodex({ paths, launcherPid: FIRST_SESSION, ports: world.ports })).toEqual({ port: STICKY_PORT });
    expect(world.spawned).toEqual([]);
  });

  it("clears a dead launcher's lock and starts the daemon itself", () => {
    const world = launcherWorld();
    world.fs.mkdirp(paths.codexDir);
    world.fs.writeFileUtf8(paths.codexLockFile, JSON.stringify({ pid: 888, at: 0 }));
    world.onSleep = () => {
      world.alive.add(WORKER_PID);
      writeCodexState(world.fs, paths.codexStateFile, { supervisorPid: OWN_PID, workerPid: WORKER_PID, port: STICKY_PORT });
    };
    ensureCodex({ paths, launcherPid: FIRST_SESSION, ports: world.ports });
    expect(world.spawned).toEqual([OWN_PID]);
  });

  it("fails loudly on a recorded fatal error, and on a daemon that never comes up", () => {
    const failed = launcherWorld();
    failed.alive.add(OWN_PID);
    writeCodexState(failed.fs, paths.codexStateFile, { supervisorPid: OWN_PID, lastError: "worker broken" });
    expect(() => ensureCodex({ paths, launcherPid: FIRST_SESSION, ports: failed.ports })).toThrow(CodexStartError);
    const silent = launcherWorld();
    expect(() => ensureCodex({ paths, launcherPid: FIRST_SESSION, ports: silent.ports })).toThrow("did not become ready");
  });
});

describe("codexDaemonOrigin", () => {
  it("names the serving port, else the sticky one, else nothing", () => {
    expect(codexDaemonOrigin({ port: 1, lastPort: 2 })).toBe("http://127.0.0.1:1");
    expect(codexDaemonOrigin({ lastPort: 2 })).toBe("http://127.0.0.1:2");
    expect(codexDaemonOrigin({})).toBeUndefined();
    expect(codexDaemonOrigin(undefined)).toBeUndefined();
  });
});
