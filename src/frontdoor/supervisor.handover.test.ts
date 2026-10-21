import net from "node:net";
import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { DOOR_HEALTH_EVENT_SOURCE } from "./eventSchemas";
import type { HandoverListenerName, Predecessor } from "./handover";
import { FRONT_DOOR_PROTOCOL, readFrontDoorState, writeFrontDoorState } from "./state";
import { runFrontDoorSupervisor } from "./supervisor";
import { IDLE_MINUTES, OWN_PID, STICKY_CONNECT_PORT, STICKY_DIRECT_PORT, STICKY_PORT, SUCCESSOR_PID, SUCCESSOR_STATE, makeWorld, paths, settleMicrotasks } from "./supervisorTestWorld";

/** The door a successor replaces, serving the sticky ports. */
const OLD_DOOR_PID = 4000;
const OLD_DOOR_STATE = { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: OLD_DOOR_PID, port: STICKY_PORT, connectPort: STICKY_CONNECT_PORT, directPort: STICKY_DIRECT_PORT, lastPort: STICKY_PORT, lastConnectPort: STICKY_CONNECT_PORT, lastDirectPort: STICKY_DIRECT_PORT };
const DRAIN_ORDER = ["background", "drain-direct", "drain-connect", "drain-provider", "hub"];

describe("a door asked to hand its listeners over", () => {
  /** Runs the supervisor to its second tick, where the test makes the request, and returns its pending result. */
  async function runUntilHandover(world: ReturnType<typeof makeWorld>): Promise<number> {
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 2) {
        world.requestHandover();
      }
    };
    return runFrontDoorSupervisor(IDLE_MINUTES, world.ports);
  }

  it("hands over exactly the sockets it serves on while still accepting on them, and drains only once the successor serves", async () => {
    const world = makeWorld();
    world.onHandover = () => {
      // Nothing has stopped accepting while the successor takes over.
      expect(world.stopOrder).toEqual([]);
      // The successor records itself as the owner before it reports serving.
      world.alive.add(SUCCESSOR_PID);
      writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
    };
    expect(await runUntilHandover(world)).toBe(0);
    expect(world.handedOver).toEqual([world.sockets]);
    expect(world.timeline.indexOf("handover")).toBeLessThan(world.timeline.indexOf("drain-direct"));
    expect(world.stopOrder).toEqual(DRAIN_ORDER);
    expect(world.closes).toEqual([]);
    // The drain left the successor's record exactly as it wrote it.
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toEqual(SUCCESSOR_STATE);
    expect(world.ownerAtDrain).toEqual([SUCCESSOR_PID, SUCCESSOR_PID, SUCCESSOR_PID]);
    expect(world.logs.some((line) => line.includes(`successor ${String(SUCCESSOR_PID)} serves`))).toBe(true);
  });

  it("publishes the successor as the door that now owns the front door", async () => {
    const world = makeWorld();
    const seen: unknown[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      seen.push(event.payload);
    });
    world.onHandover = () => {
      world.alive.add(SUCCESSOR_PID);
      writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
    };
    await runUntilHandover(world);
    detach();
    expect(seen).toContainEqual(expect.objectContaining({ kind: "superseded", pid: OWN_PID, ownerPid: SUCCESSOR_PID }));
  });

  it("drains the ordinary way when the handover fails, clearing the owner so a launch starts a successor on the released addresses", async () => {
    const world = makeWorld();
    world.handoverOutcome = { ok: false, reason: "successor 4243 exited (code 1) before it was serving" };
    expect(await runUntilHandover(world)).toBe(0);
    expect(world.stopOrder).toEqual(DRAIN_ORDER);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.supervisorPid).toBeUndefined();
    expect(world.logs.some((line) => line.includes("the handover failed (successor 4243 exited (code 1) before it was serving)"))).toBe(true);
  });

  it("wakes from its tick wait at once instead of waiting for the next tick", async () => {
    const world = makeWorld();
    const running = runFrontDoorSupervisor(IDLE_MINUTES, { ...world.ports, sleep: async () => { await new Promise<void>(() => undefined); } });
    await settleMicrotasks();
    expect(world.handedOver).toEqual([]);
    world.requestHandover();
    expect(await running).toBe(0);
    expect(world.handedOver).toHaveLength(1);
  });

  it("ignores the request once another door owns the front door, since it no longer serves the addresses launches are sent to", async () => {
    const world = makeWorld();
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 1) {
        world.alive.add(SUCCESSOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
      }
      if (ticks === 2) {
        world.requestHandover();
      }
    };
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 4 });
    expect(world.handedOver).toEqual([]);
  });
});

/** A predecessor that hands over the sockets the test supplies and records what the successor did, and what the state file named, at each step. */
function fakePredecessor(fs: ReturnType<typeof createFakeFarmFs>, options: { readonly refuse?: HandoverListenerName } = {}) {
  const takes: HandoverListenerName[] = [];
  const ownerAtTake: (number | undefined)[] = [];
  const servingStates: unknown[] = [];
  const predecessor: Predecessor = {
    take: async (listener) => {
      takes.push(listener);
      ownerAtTake.push(readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid);
      if (listener === options.refuse) {
        throw new Error("the replaced door's channel closed before it handed over every listener");
      }
      return await Promise.resolve(new net.Server());
    },
    serving: () => {
      servingStates.push(readFrontDoorState(fs, paths.frontdoorStateFile));
    },
  };
  return { predecessor, takes, ownerAtTake, servingStates };
}

describe("a door started to take over from another", () => {
  it("adopts every listener from the old door instead of binding, leaving the old door the owner until it serves all three, then reports serving", async () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, OLD_DOOR_STATE);
    const old = fakePredecessor(fs);
    const world = makeWorld({ fs, predecessor: old.predecessor });
    world.alive.add(OLD_DOOR_PID);
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(old.takes).toEqual(["provider", "connect", "direct"]);
    expect(world.binds).toEqual([{ adopted: "provider" }]);
    expect(world.connectBinds).toEqual([{ adopted: "connect" }]);
    expect(world.directBinds).toEqual([{ adopted: "direct" }]);
    // The state file named the old door through every take: nothing pointed a launch at this one before it accepted.
    expect(old.ownerAtTake).toEqual([OLD_DOOR_PID, OLD_DOOR_PID, OLD_DOOR_PID]);
    // By the time it reported serving, the state named this door on the same sticky addresses.
    expect(old.servingStates).toEqual([{ protocol: FRONT_DOOR_PROTOCOL, supervisorPid: OWN_PID, port: STICKY_PORT, connectPort: STICKY_CONNECT_PORT, directPort: STICKY_DIRECT_PORT, lastPort: STICKY_PORT, lastConnectPort: STICKY_CONNECT_PORT, lastDirectPort: STICKY_DIRECT_PORT }]);
  });

  it("leaves another launcher's start lock in place", async () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, OLD_DOOR_STATE);
    fs.mkdirp(paths.frontdoorDir);
    fs.writeFileExclusive(paths.frontdoorLockFile, "{}\n");
    const world = makeWorld({ fs, predecessor: fakePredecessor(fs).predecessor });
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(fs.readFileUtf8(paths.frontdoorLockFile)).toBe("{}\n");
  });

  it("fails without touching the state file the old door still owns, closing what it had adopted, and never reports serving", async () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, OLD_DOOR_STATE);
    const old = fakePredecessor(fs, { refuse: "connect" });
    const world = makeWorld({ fs, predecessor: old.predecessor });
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(1);
    expect(readFrontDoorState(fs, paths.frontdoorStateFile)).toEqual(OLD_DOOR_STATE);
    expect(world.closes).toEqual([STICKY_PORT]);
    expect(old.servingStates).toEqual([]);
  });
});
