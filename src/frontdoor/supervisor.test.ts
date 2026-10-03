import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { FRONT_DOOR_PROTOCOL, listFrontDoorSessions, readFrontDoorState, writeFrontDoorSession, writeFrontDoorState } from "./state";
import { FRONTDOOR_POLL_MS, FRONTDOOR_SUPERVISOR_STILL_RUNNING, runFrontDoorSupervisor, type FrontDoorSupervisorPorts } from "./supervisor";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

/** A stand-in capability: the registry records one per launch, and the supervisor must see a record that carries it. */
const SESSION_TOKEN = "test-capability";
const OWN_PID = 4242;
const SUCCESSOR_PID = 4243;
const LIVE_SESSION = 301;
const NEW_SESSION = 303;
const DEAD_SESSION = 302;
const STICKY_PORT = 4100;
const STICKY_CONNECT_PORT = 4300;
const STICKY_DIRECT_PORT = 4400;
const OCCUPIED_PORT = 4200;
const FRESH_PORT = 5001;
const IDLE_MINUTES = 1;
const MS_PER_MINUTE = 60_000;
/** Ticks beyond the idle window itself, so an unwanted shutdown cannot hide behind the tick limit. */
const SLACK_TICKS = 5;
const FULL_IDLE_WINDOW_TICKS = Math.ceil((IDLE_MINUTES * MS_PER_MINUTE) / FRONTDOOR_POLL_MS) + SLACK_TICKS;

/**
 * The fake world the supervisor runs against: an in-memory filesystem, a clock advanced only by the supervisor's own sleeps, a modelled process table, and listeners that bind the preferred port when it is free and the fresh one otherwise (the real listeners' bind-time fallback). `onSleep` lets a test act between ticks.
 */
function makeWorld(options: { readonly ownPid?: number; readonly fs?: HeadroomFs } = {}) {
  const fs = options.fs ?? createFakeFarmFs({});
  const ownPid = options.ownPid ?? OWN_PID;
  let clock = 0;
  const alive = new Set<number>([ownPid]);
  const occupied = new Set<number>([OCCUPIED_PORT]);
  const binds: (number | undefined)[] = [];
  const connectBinds: (number | undefined)[] = [];
  const directBinds: (number | undefined)[] = [];
  const closes: number[] = [];
  const logs: string[] = [];
  let failListener = false;
  let failConnect = false;
  let failDirect = false;
  let onSleep: (() => void) | undefined;

  const ports: FrontDoorSupervisorPorts = {
    fs,
    paths,
    ownPid,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep?.();
      await Promise.resolve();
    },
    isRunning: (pid) => alive.has(pid),
    startProviderListener: async (preferred) => {
      if (failListener) {
        throw new Error("port chaos");
      }
      binds.push(preferred);
      const port = preferred !== undefined && !occupied.has(preferred) ? preferred : FRESH_PORT;
      return await Promise.resolve({
        port,
        close: async () => {
          closes.push(port);
          await Promise.resolve();
        },
      });
    },
    startConnectListener: async (preferred) => {
      if (failConnect) {
        throw new Error("connect chaos");
      }
      connectBinds.push(preferred);
      const port = preferred !== undefined && !occupied.has(preferred) ? preferred : FRESH_PORT;
      return await Promise.resolve({
        port,
        close: async () => {
          closes.push(port);
          await Promise.resolve();
        },
      });
    },
    startDirectListener: async (preferred) => {
      if (failDirect) {
        throw new Error("direct chaos");
      }
      directBinds.push(preferred);
      const port = preferred !== undefined && !occupied.has(preferred) ? preferred : FRESH_PORT;
      return await Promise.resolve({
        port,
        close: async () => {
          closes.push(port);
          await Promise.resolve();
        },
      });
    },
    log: (line) => {
      logs.push(line);
    },
  };

  return {
    fs,
    ports,
    alive,
    occupied,
    binds,
    connectBinds,
    closes,
    logs,
    clock: () => clock,
    set failListener(value: boolean) {
      failListener = value;
    },
    set failConnect(value: boolean) {
      failConnect = value;
    },
    set failDirect(value: boolean) {
      failDirect = value;
    },
    directBinds,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
  };
}

describe("runFrontDoorSupervisor", () => {
  it("binds both sticky ports the previous generation served on and records a serving state", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT, lastConnectPort: STICKY_CONNECT_PORT, lastDirectPort: STICKY_DIRECT_PORT });
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(code).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.binds).toEqual([STICKY_PORT]);
    expect(world.connectBinds).toEqual([STICKY_CONNECT_PORT]);
    expect(world.directBinds).toEqual([STICKY_DIRECT_PORT]);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toMatchObject({ supervisorPid: OWN_PID, port: STICKY_PORT, lastPort: STICKY_PORT, connectPort: STICKY_CONNECT_PORT, lastConnectPort: STICKY_CONNECT_PORT, directPort: STICKY_DIRECT_PORT, lastDirectPort: STICKY_DIRECT_PORT });
    expect(world.logs.some((line) => line.includes(`front door on 127.0.0.1:${String(STICKY_PORT)}`))).toBe(true);
  });

  it("records the wire protocol it speaks once it is serving, so a launcher can tell an older door from its own", async () => {
    const world = makeWorld();
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.protocol).toBe(FRONT_DOOR_PROTOCOL);
  });

  it("moves the plain listener off an occupied sticky port, logs the move, and keeps the new address as the sticky one", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: OCCUPIED_PORT });
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.binds).toEqual([OCCUPIED_PORT]);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toMatchObject({ port: FRESH_PORT, lastPort: FRESH_PORT });
    expect(world.logs.some((line) => line.includes("was occupied; moving"))).toBe(true);
  });

  it("moves the CONNECT surface off its own occupied sticky port independently of the plain listener", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT, lastConnectPort: OCCUPIED_PORT });
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.binds).toEqual([STICKY_PORT]);
    expect(world.connectBinds).toEqual([OCCUPIED_PORT]);
    const state = readFrontDoorState(world.fs, paths.frontdoorStateFile);
    expect(state?.port).toBe(STICKY_PORT);
    expect(state?.connectPort).toBe(FRESH_PORT);
    expect(state?.lastConnectPort).toBe(FRESH_PORT);
  });

  it("a successor generation after a crash rebinds both sticky ports, restoring service for every frozen base URL and HTTPS_PROXY", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT, lastConnectPort: STICKY_CONNECT_PORT, lastDirectPort: STICKY_DIRECT_PORT });
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    // The crashed generation's state still names the ports it served, which is exactly what the successor inherits.
    const successor = makeWorld({ ownPid: SUCCESSOR_PID, fs: world.fs });
    await runFrontDoorSupervisor(IDLE_MINUTES, successor.ports, { tickLimit: 1 });
    expect(successor.binds).toEqual([STICKY_PORT]);
    expect(successor.connectBinds).toEqual([STICKY_CONNECT_PORT]);
    expect(successor.directBinds).toEqual([STICKY_DIRECT_PORT]);
    expect(readFrontDoorState(successor.fs, paths.frontdoorStateFile)).toMatchObject({ supervisorPid: SUCCESSOR_PID, port: STICKY_PORT, connectPort: STICKY_CONNECT_PORT, directPort: STICKY_DIRECT_PORT });
  });

  it("records the failure and clears the start lock when the plain listener cannot start", async () => {
    const world = makeWorld();
    world.failListener = true;
    world.fs.mkdirp(paths.frontdoorDir);
    world.fs.writeFileUtf8(paths.frontdoorLockFile, "{}\n");
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports);
    expect(code).toBe(1);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.lastError).toContain("port chaos");
    expect(world.fs.readFileUtf8(paths.frontdoorLockFile)).toBeUndefined();
  });

  it("records the failure when the CONNECT surface cannot start, closing the listener it had already bound", async () => {
    const world = makeWorld();
    world.failConnect = true;
    world.fs.mkdirp(paths.frontdoorDir);
    world.fs.writeFileUtf8(paths.frontdoorLockFile, "{}\n");
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports);
    expect(code).toBe(1);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.lastError).toContain("connect chaos");
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)?.port).toBeUndefined();
  });

  it("prunes dead launcher sessions and never idles out while one is live", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: DEAD_SESSION, startedAt: 0, token: SESSION_TOKEN });
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(listFrontDoorSessions(world.fs, paths.frontdoorSessionsDir).map((session) => session.pid)).toEqual([LIVE_SESSION]);
    expect(world.closes).toEqual([]);
  });

  it("shuts the door down after the idle window with no live session, keeping the sticky address", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT });
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(code).toBe(0);
    // All three listeners close, the direct one included, and the sticky addresses seed the next generation: the plain listener rebinding its sticky port, the other two starting fresh.
    expect(world.closes.sort((a, b) => a - b)).toEqual([STICKY_PORT, FRESH_PORT, FRESH_PORT].sort((a, b) => a - b));
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toEqual({ lastPort: STICKY_PORT, lastConnectPort: FRESH_PORT, lastDirectPort: FRESH_PORT });
  });

  it("resets the idle clock when a new session arrives inside the window", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT });
    let ticks = 0;
    const halfway = Math.floor(FULL_IDLE_WINDOW_TICKS / 2);
    world.onSleep = () => {
      ticks += 1;
      if (ticks === halfway) {
        world.alive.add(NEW_SESSION);
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: NEW_SESSION, startedAt: world.clock(), token: SESSION_TOKEN });
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
  });
});
