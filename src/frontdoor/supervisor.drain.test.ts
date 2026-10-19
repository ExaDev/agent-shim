import { describe, expect, it } from "vitest";

import { listDrainingFrontDoors, listFrontDoorDirectRecords, readFrontDoorState, writeFrontDoorSession, writeFrontDoorState } from "./state";
import { runFrontDoorSupervisor } from "./supervisor";
import { FRESH_PORT, IDLE_MINUTES, LEAK_PROBE_TICKS, LIVE_SESSION, OWN_PID, SESSION_TOKEN, SUCCESSOR_STATE, makeWorld, paths, settleMicrotasks } from "./supervisorTestWorld";

describe("retiring by draining", () => {
  const OTHER_PID = 5555;

  /** Runs the supervisor to its second tick, where the test asks it to exit, and returns its pending result. */
  async function runUntilRetired(world: ReturnType<typeof makeWorld>): Promise<number> {
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 2) {
        world.retire();
      }
    };
    return runFrontDoorSupervisor(IDLE_MINUTES, world.ports);
  }

  it("releases every listener's address before it does anything slow, stops naming itself the owner, and stays up until what the listeners carry has ended", async () => {
    const world = makeWorld();
    world.holdDrains();
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN, supervisorPid: OWN_PID });
    world.alive.add(LIVE_SESSION);
    let result: number | undefined;
    const running = runUntilRetired(world).then((code) => {
      result = code;
    });
    await settleMicrotasks();

    expect(world.stopOrder).toEqual(["background", "drain-direct", "drain-connect", "drain-provider", "hub"]);
    // Nothing was closed outright, and the state names no owner but keeps the sticky addresses for the successor.
    expect(world.closes).toEqual([]);
    const state = readFrontDoorState(world.fs, paths.frontdoorStateFile);
    expect(state?.supervisorPid).toBeUndefined();
    expect(state).toMatchObject({ lastPort: FRESH_PORT, lastConnectPort: FRESH_PORT, lastDirectPort: FRESH_PORT });
    // Still carrying its connections: the process has not returned, and its direct record still admits its origin to headroom.
    expect(result).toBeUndefined();
    expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir).map((record) => record.pid)).toEqual([OWN_PID]);

    world.releaseDrains();
    await running;
    expect(result).toBe(0);
    expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir)).toEqual([]);
    expect(world.hubCloses()).toBe(1);
  });

  it("stops the watchdog and its own background work before it releases anything, and releases every address before the state stops naming it", async () => {
    const world = makeWorld();
    await runUntilRetired(world);
    expect(world.timeline.slice(world.timeline.indexOf("watchdog-stop") - 0, world.timeline.indexOf("watchdog-stop") + 2)).toEqual(["watchdog-stop", "background"]);
    expect(world.timeline.indexOf("background")).toBeLessThan(world.timeline.indexOf("drain-direct"));
    // Each listener was told to drain while the state still named this door; the state was rewritten only afterwards.
    expect(world.ownerAtDrain).toEqual([OWN_PID, OWN_PID, OWN_PID]);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.supervisorPid).toBeUndefined();
  });

  it("marks itself draining while it carries connections and clears the mark when they have ended", async () => {
    const world = makeWorld();
    world.holdDrains();
    const running = runUntilRetired(world);
    await settleMicrotasks();
    expect(listDrainingFrontDoors(world.fs, paths.frontdoorDrainingDir, () => true)).toEqual([OWN_PID]);
    world.releaseDrains();
    await running;
    expect(listDrainingFrontDoors(world.fs, paths.frontdoorDrainingDir, () => true)).toEqual([]);
  });

  it("retires at its first tick when it was asked to exit before the loop ran", async () => {
    const world = makeWorld();
    world.retire();
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    expect(world.stopOrder).toEqual(["background", "drain-direct", "drain-connect", "drain-provider", "hub"]);
    expect(world.closes).toEqual([]);
  });

  it("attaches one abort listener for the length of a tick's wait and detaches it when the wait ends, so a door that serves for days accumulates nothing", async () => {
    const world = makeWorld();
    const signal = world.retireSignal;
    let attached = 0;
    let peak = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      attached += 1;
      peak = Math.max(peak, attached);
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      attached -= 1;
      remove(...args);
    };
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: LEAK_PROBE_TICKS });
    expect(peak).toBe(1);
    expect(attached).toBe(0);
  });

  it("wakes from its tick wait at once instead of serving until the next tick", async () => {
    const world = makeWorld();
    const running = runFrontDoorSupervisor(IDLE_MINUTES, { ...world.ports, sleep: async () => { await new Promise<void>(() => undefined); } });
    await settleMicrotasks();
    expect(world.stopOrder).toEqual([]);
    world.retire();
    expect(await running).toBe(0);
    expect(world.stopOrder).toEqual(["background", "drain-direct", "drain-connect", "drain-provider", "hub"]);
  });

  it("leaves the state file alone when another supervisor has already claimed it", async () => {
    const world = makeWorld();
    world.alive.add(OTHER_PID);
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 1) {
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { ...SUCCESSOR_STATE, supervisorPid: OTHER_PID });
      }
      if (ticks === 2) {
        world.retire();
      }
    };
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.supervisorPid).toBe(OTHER_PID);
  });
});
