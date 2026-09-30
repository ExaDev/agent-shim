import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { writeSession } from "../headroom/state";
import { ensureFrontDoor, FrontDoorStartError } from "./ensure";
import { writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const SUPERVISOR_PID = 500;
const OTHER_LAUNCHER_PID = 777;
const LAUNCHER_PID = 42;
const PORT = 4100;
/** A supervisor pid that is dead in every test that names it, distinct from the live fake's SUPERVISOR_PID. */
const DEAD_SUPERVISOR_PID = 999;
/** Polls before a lazily-written ready state appears, so the waiting path is exercised rather than the first-poll hit. */
const SLEEPS_BEFORE_READY = 2;
/** A launcher pid holding a start lock in the dead-holder test, distinct from every live fake. */
const DEAD_LOCK_HOLDER = 12345;
/** The bring-up timeout the implementation documents, asserted so the waiting path really ran its course. */
const START_TIMEOUT_MS = 30_000;

/**
 * The fake world `ensureFrontDoor` runs against: a fake filesystem, a clock that only advances when the code sleeps, a live-pid set, and a `spawnSupervisor` that records itself and can simulate the freshly spawned supervisor writing a ready state (immediately, or lazily on a later poll via `onSleep`).
 */
function makeWorld(options: { readonly spawnWritesReadyState?: boolean } = {}) {
  const fs = createFakeFarmFs({});
  let clock = 0;
  let onSleep: (() => void) | undefined;
  const alive = new Set<number>([SUPERVISOR_PID, process.pid, OTHER_LAUNCHER_PID]);
  const spawns: number[] = [];

  const world = {
    fs,
    alive,
    spawns,
    clock: () => clock,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    writeReadyState(port = PORT): void {
      writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR_PID, port, lastPort: port });
    },
    ports: {
      fs,
      isRunning: (pid: number) => alive.has(pid),
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

describe("ensureFrontDoor", () => {
  it("spawns the supervisor when nothing is serving and waits for its ready state, then registers the session", () => {
    const world = makeWorld();
    const result = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(result).toEqual({ port: PORT });
    expect(world.spawns).toHaveLength(1);
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(LAUNCHER_PID)}.json`)).toBeDefined();
  });

  it("waits for a supervisor it spawned whose ready state appears on a later poll", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_READY) {
        world.writeReadyState();
      }
    };
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toEqual({ port: PORT });
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_READY);
  });

  it("joins an already-serving front door without spawning anything", () => {
    const world = makeWorld();
    world.writeReadyState();
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toEqual({ port: PORT });
    expect(world.spawns).toHaveLength(0);
  });

  it("spawns a replacement supervisor when the recorded one is dead, the crash-recovery path every frozen base URL depends on", () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: DEAD_SUPERVISOR_PID, port: PORT, lastPort: PORT });
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toEqual({ port: PORT });
    expect(world.spawns).toHaveLength(1);
  });

  it("waits on another launcher's start lock while its holder lives, and takes over a dead holder's lock", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    world.fs.mkdirp(paths.frontdoorDir);
    world.fs.writeFileExclusive(paths.frontdoorLockFile, `${JSON.stringify({ pid: OTHER_LAUNCHER_PID, at: 0 })}\n`);
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_READY) {
        // The holder's supervisor has served by now: the lock is gone and the ready state is in place.
        world.fs.removeRecursive(paths.frontdoorLockFile);
        world.writeReadyState();
      }
    };
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toEqual({ port: PORT });
    expect(world.spawns).toHaveLength(0);

    // A dead holder's lock is litter, not a wait: the next ensure clears it and spawns.
    const litterWorld = makeWorld({ spawnWritesReadyState: false });
    litterWorld.fs.mkdirp(paths.frontdoorDir);
    litterWorld.fs.writeFileExclusive(paths.frontdoorLockFile, `${JSON.stringify({ pid: DEAD_LOCK_HOLDER, at: 0 })}\n`);
    litterWorld.alive.delete(DEAD_LOCK_HOLDER);
    litterWorld.onSleep = () => {
      litterWorld.writeReadyState();
    };
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: litterWorld.ports })).toEqual({ port: PORT });
    expect(litterWorld.spawns).toHaveLength(1);
  });

  it("refuses immediately when a live supervisor has recorded a fatal error", () => {
    const world = makeWorld();
    world.writeReadyState();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR_PID, lastPort: PORT, lastError: "gave up" });
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(FrontDoorStartError);
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow("gave up");
  });

  it("times out naming the daemon log when the front door never becomes ready", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(FrontDoorStartError);
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(paths.frontdoorLogPath);
    expect(world.clock()).toBeGreaterThanOrEqual(START_TIMEOUT_MS);
  });

  it("registers a session for a launcher joining a door another launcher already holds", () => {
    const world = makeWorld();
    world.writeReadyState();
    writeSession(world.fs, paths.frontdoorSessionsDir, { pid: OTHER_LAUNCHER_PID, startedAt: 0 });
    ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(LAUNCHER_PID)}.json`)).toBeDefined();
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(OTHER_LAUNCHER_PID)}.json`)).toBeDefined();
  });
});
