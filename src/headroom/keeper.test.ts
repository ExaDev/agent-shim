import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { startSupervisorUnderLock, HEADROOM_START_TIMEOUT_MS } from "./ensure";
import { createHeadroomKeeper } from "./keeper";
import { listSessions, readStartLock, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const DOOR_PID = 100;
const DEAD_SUPERVISOR_PID = 200;
const NEW_SUPERVISOR_PID = 300;
const OTHER_LIVE_SUPERVISOR_PID = 400;
const LAUNCHER_A = 11;
const LAUNCHER_B = 12;
const DEAD_LAUNCHER = 13;
/** One tick of the keeper, and the margin either side of the start bound the back-off tests step across. */
const TICK_MS = 1_000;
const SOCKET_PATH = "/home/testuser/.agent-shim/headroom/run/200.sock";

/** The fake world a keeper tick runs against: a fake filesystem, a clock the test moves, a live-pid set, and a `spawnSupervisor` that records itself. */
function makeWorld() {
  const fs = createFakeFarmFs({});
  let clock = 1_000_000;
  const alive = new Set<number>([DOOR_PID, LAUNCHER_A, LAUNCHER_B]);
  const spawns: number[] = [];
  const logs: string[] = [];
  const ports = {
    fs,
    now: () => clock,
    runningAmong: async (pids: readonly number[]) => Promise.resolve(new Set(pids.filter((pid) => alive.has(pid)))),
    spawnSupervisor: () => {
      spawns.push(clock);
      return NEW_SUPERVISOR_PID;
    },
  };
  const keeper = createHeadroomKeeper({ paths, ownPid: DOOR_PID, ports, log: (message) => {
      logs.push(message);
    } });
  return {
    fs,
    alive,
    spawns,
    logs,
    ports,
    /** The ports a launch starts a supervisor through, which read liveness one pid at a time. */
    launchPorts: { ...ports, isRunning: (pid: number) => alive.has(pid) },
    keeper,
    advance: (ms: number) => {
      clock += ms;
    },
    register: (pid: number, supervisorPid: number) => {
      writeSession(fs, paths.headroomSessionsDir, { pid, startedAt: clock, supervisorPid });
    },
    /** The state file as a crashed supervisor leaves it: still naming the supervisor and its socket, with the supervisor not running. */
    recordDeadSupervisor: () => {
      writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: DEAD_SUPERVISOR_PID, headroomPid: DEAD_SUPERVISOR_PID + 1, socketPath: SOCKET_PATH, version: "headroom 0.40.0" });
    },
    recordSupervisor: (supervisorPid: number) => {
      writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid, headroomPid: supervisorPid + 1, socketPath: SOCKET_PATH, version: "headroom 0.40.0" });
    },
  };
}

describe("createHeadroomKeeper", () => {
  it("starts the supervisor when launchers are registered against one that is no longer running", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    world.register(LAUNCHER_B, DEAD_SUPERVISOR_PID);

    const outcome = await world.keeper.tick();

    expect(outcome).toEqual({ kind: "starting", start: "spawned", waiting: 2 });
    expect(world.spawns).toHaveLength(1);
  });

  it("starts at most one supervisor however many ticks pass inside one start bound, and tries again once the bound has passed", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);

    await world.keeper.tick();
    world.advance(TICK_MS);
    const second = await world.keeper.tick();
    world.advance(HEADROOM_START_TIMEOUT_MS - 2 * TICK_MS);
    const third = await world.keeper.tick();

    expect(second).toEqual({ kind: "backing-off", waiting: 1 });
    expect(third).toEqual({ kind: "backing-off", waiting: 1 });
    expect(world.spawns).toHaveLength(1);

    world.advance(2 * TICK_MS);
    const fourth = await world.keeper.tick();

    expect(fourth).toEqual({ kind: "starting", start: "spawned", waiting: 1 });
    expect(world.spawns).toHaveLength(2);
  });

  it("starts a supervisor when no state file is recorded at all but a launcher is registered against a supervisor that is gone", async () => {
    const world = makeWorld();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);

    expect(await world.keeper.tick()).toEqual({ kind: "starting", start: "spawned", waiting: 1 });
  });

  it("leaves a supervisor that shut itself down alone: no live launcher is registered against it", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(DEAD_LAUNCHER, DEAD_SUPERVISOR_PID);

    expect(await world.keeper.tick()).toEqual({ kind: "idle" });
    expect(world.spawns).toHaveLength(0);
  });

  it("does nothing when no launcher is registered", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();

    expect(await world.keeper.tick()).toEqual({ kind: "idle" });
    expect(world.spawns).toHaveLength(0);
  });

  it("re-registers launchers bound to a dead supervisor against the live one, so the new supervisor does not idle out", async () => {
    const world = makeWorld();
    world.alive.add(NEW_SUPERVISOR_PID);
    world.recordSupervisor(NEW_SUPERVISOR_PID);
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    world.register(LAUNCHER_B, DEAD_SUPERVISOR_PID);

    const outcome = await world.keeper.tick();

    expect(outcome).toEqual({ kind: "serving", rebound: [LAUNCHER_A, LAUNCHER_B] });
    expect(listSessions(world.fs, paths.headroomSessionsDir).map((session) => session.supervisorPid)).toEqual([NEW_SUPERVISOR_PID, NEW_SUPERVISOR_PID]);
  });

  it("leaves launchers bound to another supervisor that is still running where they are", async () => {
    const world = makeWorld();
    world.alive.add(NEW_SUPERVISOR_PID);
    world.alive.add(OTHER_LIVE_SUPERVISOR_PID);
    world.recordSupervisor(NEW_SUPERVISOR_PID);
    world.register(LAUNCHER_A, OTHER_LIVE_SUPERVISOR_PID);

    expect(await world.keeper.tick()).toEqual({ kind: "serving", rebound: [] });
    expect(listSessions(world.fs, paths.headroomSessionsDir)[0]?.supervisorPid).toBe(OTHER_LIVE_SUPERVISOR_PID);
  });

  it("releases the start lock it took once the supervisor is serving, so a later launch can start one", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    await world.keeper.tick();
    expect(readStartLock(world.fs, paths.headroomLockFile)?.pid).toBe(DOOR_PID);

    world.alive.add(NEW_SUPERVISOR_PID);
    world.recordSupervisor(NEW_SUPERVISOR_PID);
    await world.keeper.tick();

    expect(readStartLock(world.fs, paths.headroomLockFile)).toBeUndefined();
    world.alive.delete(NEW_SUPERVISOR_PID);
    expect(startSupervisorUnderLock({ paths, holderPid: LAUNCHER_B, ports: world.launchPorts })).toBe("spawned");
  });

  it("does not spawn a second supervisor while a live launch holds the start lock", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    expect(startSupervisorUnderLock({ paths, holderPid: LAUNCHER_B, ports: world.launchPorts })).toBe("spawned");
    world.spawns.length = 0;

    const outcome = await world.keeper.tick();

    expect(outcome).toEqual({ kind: "starting", start: "held", waiting: 1 });
    expect(world.spawns).toHaveLength(0);
  });

  it("asks about every pid it decides on in one liveness read per tick", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    world.register(LAUNCHER_B, DEAD_SUPERVISOR_PID);
    const reads: (readonly number[])[] = [];
    const keeper = createHeadroomKeeper({
      paths,
      ownPid: DOOR_PID,
      ports: {
        ...world.ports,
        runningAmong: async (pids) => {
          reads.push(pids);
          return world.ports.runningAmong(pids);
        },
      },
      log: () => undefined,
    });

    await keeper.tick();

    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual(expect.arrayContaining([DEAD_SUPERVISOR_PID, LAUNCHER_A, LAUNCHER_B]));
  });

  it("counts a start lock taken while the liveness read was running as held, never as a dead launch's litter", async () => {
    const world = makeWorld();
    world.recordDeadSupervisor();
    world.register(LAUNCHER_A, DEAD_SUPERVISOR_PID);
    const keeper = createHeadroomKeeper({
      paths,
      ownPid: DOOR_PID,
      ports: {
        ...world.ports,
        runningAmong: async (pids) => {
          world.fs.writeFileExclusive(paths.headroomLockFile, `${JSON.stringify({ pid: DEAD_LAUNCHER, at: 0 })}\n`);
          return world.ports.runningAmong(pids);
        },
      },
      log: () => undefined,
    });

    const outcome = await keeper.tick();

    expect(outcome).toEqual({ kind: "starting", start: "held", waiting: 1 });
    expect(readStartLock(world.fs, paths.headroomLockFile)?.pid).toBe(DEAD_LAUNCHER);
  });
});
