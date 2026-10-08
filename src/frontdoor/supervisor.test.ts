import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { DOOR_HEALTH_EVENT_SOURCE, LAUNCH_EVENT_SOURCE, type DoorEvent } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import { createDoorHealthPublisher } from "./doorHealthEvents";
import { createLaunchEventPublisher } from "./launchEvents";
import { FRONT_DOOR_PROTOCOL, listFrontDoorSessions, readFrontDoorState, removeFrontDoorSession, writeFrontDoorSession, writeFrontDoorState } from "./state";
import { FRONTDOOR_POLL_MS, FRONTDOOR_SUPERVISOR_STILL_RUNNING, runFrontDoorSupervisor, watchedInstallEntry, type FrontDoorSupervisorPorts, type OwnExecutableStat } from "./supervisor";

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
/** The installed binary as the door starts serving it: every field differs in the replacement, the way a rename-install's new inode does. */
const INSTALLED_BINARY: OwnExecutableStat = { dev: 1, ino: 10, size: 4096, mtimeMs: 0 };
const REPLACED_BINARY: OwnExecutableStat = { dev: 1, ino: 11, size: 4097, mtimeMs: 1 };

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
  /** Every stop in the order it happened, so a test can prove what the shutdown sequence closes before what. */
  const stopOrder: string[] = [];
  let hubCloses = 0;
  const logs: string[] = [];
  let failListener = false;
  let failConnect = false;
  let failDirect = false;
  let onSleep: (() => void) | undefined;
  // The executable identity the door serves as, present by default so the existing idle behaviour runs with a matching stat (the no-drift case), replaceable or removable mid-run through the world's setter the way `agent-shim update`'s rename-install replaces the file between ticks.
  let ownExecutableStat: OwnExecutableStat | undefined = INSTALLED_BINARY;
  // The door's event backbone and its launch lifecycle publisher, the same pairing the real ports wire: the tick's registry facts go in through the port below and come out as source-tagged events a test subscribes for.
  const doorEvents = createDoorEventHub();
  const launchEvents = createLaunchEventPublisher(doorEvents, () => clock);
  /** How many ticks ran the expiring-quota check, so the tick's calling of it is itself observable. */
  let quotaChecks = 0;

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
    statOwnExecutable: () => ownExecutableStat,
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
          stopOrder.push("provider");
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
          stopOrder.push("connect");
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
          stopOrder.push("direct");
          await Promise.resolve();
        },
      });
    },
    closeRcStreamHub: () => {
      hubCloses += 1;
      stopOrder.push("hub");
    },
    observeLaunchRegistry: launchEvents.observe,
    // The door health publisher and the expiring-quota checker, the same pairing the real ports wire: the publisher over the same backbone the launch events ride, and the checker a recorder the tick calls.
    doorHealth: createDoorHealthPublisher(doorEvents, () => clock, ownPid),
    checkQuotaExpiry: () => {
      quotaChecks += 1;
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
    stopOrder,
    hubCloses: () => hubCloses,
    doorEvents,
    quotaChecks: () => quotaChecks,
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
    /** Replaces or removes the installed binary's identity; setting it mid-run (from `onSleep`) models the update's rename landing between ticks. */
    set ownExecutable(value: OwnExecutableStat | undefined) {
      ownExecutableStat = value;
    },
    directBinds,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
  };
}

describe("watchedInstallEntry", () => {
  it("watches the resolved entry itself when it is already named agent-shim", () => {
    expect(watchedInstallEntry("/home/testuser/.local/bin/agent-shim")).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/agent-shim.exe")).toBe("/home/testuser/.local/bin/agent-shim.exe");
  });

  it("watches the agent-shim sibling when the door was spawned through another entry, the way the claude hardlink and the legacy claude-use symlink are", () => {
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude")).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude-use")).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude.exe")).toBe("/home/testuser/.local/bin/agent-shim.exe");
  });
});

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
    // A startup failure exits this process too, so the hub's close happens once there as well: nothing was ever attached, but the exit path is the same one the idle shutdown takes.
    expect(world.hubCloses()).toBe(1);
    expect(world.stopOrder).toEqual(["hub"]);
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
    // The already-bound listener closes first and the hub's close follows it, the same after-the-listeners position the idle shutdown gives it.
    expect(world.hubCloses()).toBe(1);
    expect(world.stopOrder).toEqual(["provider", "hub"]);
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

  it("turns the door over at the first empty registry once the installed binary changed, without waiting out the idle window", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT });
    // The replacement lands between the first and second tick, the way a rename-install does.
    world.onSleep = () => {
      world.ownExecutable = REPLACED_BINARY;
    };
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(code).toBe(0);
    // The exit happened on the drift, long before the idle window: one tick's poll has passed, not a minute of them.
    expect(world.clock()).toBe(FRONTDOOR_POLL_MS);
    expect(world.logs.some((line) => line.includes("the installed binary changed"))).toBe(true);
    // The turnover is the same graceful shutdown the idle exit is: every listener closed, the hub closed after them, the sticky address kept for the successor.
    expect(world.stopOrder).toEqual(["direct", "connect", "provider", "hub"]);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toEqual({ lastPort: STICKY_PORT, lastConnectPort: FRESH_PORT, lastDirectPort: FRESH_PORT });
  });

  it("keeps serving a replaced binary while a session is live", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    world.onSleep = () => {
      world.ownExecutable = REPLACED_BINARY;
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
    expect(world.hubCloses()).toBe(0);
  });

  it("publishes the binary turnover on the backbone before the exit, and no idle shutdown beside it", async () => {
    const world = makeWorld();
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    world.onSleep = () => {
      world.ownExecutable = REPLACED_BINARY;
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    detach();
    // The turnover is observed at the second tick, the first one to see the replaced stat.
    expect(received).toEqual([
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 1, payload: { kind: "generation", pid: OWN_PID, providerPort: FRESH_PORT, connectPort: FRESH_PORT, directPort: FRESH_PORT, observedAt: 0 } },
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 2, payload: { kind: "binaryTurnover", pid: OWN_PID, observedAt: FRONTDOOR_POLL_MS } },
    ]);
  });

  it("leaves an executable that cannot be statted at startup on the idle behaviour alone, without flapping", async () => {
    const world = makeWorld();
    world.ownExecutable = undefined;
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(code).toBe(0);
    expect(world.clock()).toBe(IDLE_MINUTES * MS_PER_MINUTE);
  });

  it("does not turn over while the executable is briefly unstatable mid-run, the removal window a remove-then-link install leaves", async () => {
    const world = makeWorld();
    world.onSleep = () => {
      world.ownExecutable = undefined;
    };
    // Within the idle window, with the stat gone but the door otherwise serving: still running, the same no-flap rule.
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: SLACK_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
  });

  it("turns the door over at the first empty registry tick after a session that was live at the replacement ends, not after fresh idle minutes", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    // The replacement and the launcher's death land together between the first and second tick: the tick's prune then empties the registry in the same pass that first sees the replaced stat.
    world.onSleep = () => {
      world.ownExecutable = REPLACED_BINARY;
      world.alive.delete(LIVE_SESSION);
    };
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(code).toBe(0);
    // One poll interval: the turnover fired on the first tick with an empty registry, not after the idle window restarted.
    expect(world.clock()).toBe(FRONTDOOR_POLL_MS);
    expect(world.logs.some((line) => line.includes("the installed binary changed"))).toBe(true);
  });

  it("treats a stat returning to the exact captured identity after an absent window as unchanged, not replaced", async () => {
    const world = makeWorld();
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === 1) {
        world.ownExecutable = undefined;
      } else if (sleeps === 2) {
        world.ownExecutable = INSTALLED_BINARY;
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: SLACK_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
  });

  it("closes the Remote Control stream hub once, after every listener is down and before the exit, so the final cursor save is deterministic", async () => {
    const world = makeWorld();
    const code = await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(code).toBe(0);
    // The hub's close is the last stop of the serving machinery and happens exactly once: every listener is already down (nothing can settle an observed exchange and re-attach a stream the close had just ended), and the exit follows it.
    expect(world.stopOrder).toEqual(["direct", "connect", "provider", "hub"]);
    expect(world.hubCloses()).toBe(1);
  });

  it("never closes the Remote Control stream hub while the door is still serving", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.hubCloses()).toBe(0);
    expect(world.stopOrder).toEqual([]);
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

  it("publishes the launch lifecycle on the event backbone as the registry changes between ticks, and nothing for the baseline a generation inherits", async () => {
    const world = makeWorld();
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([LAUNCH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    // The clock instants the driven changes are observed at, one sleep apart: the world's clock only moves when the supervisor sleeps, so each is the tick's own reading.
    const endedAtMs = FRONTDOOR_POLL_MS + FRONTDOOR_POLL_MS;
    const prunedAtMs = endedAtMs + FRONTDOOR_POLL_MS;
    // A session the registry already holds when the door starts: this generation never observed its registration, so the baseline observation publishes nothing rather than claiming a moment it did not see.
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    let ticks = 0;
    const registerNewSessionOn = 1;
    const endNewSessionOn = 2;
    const killLiveSessionOn = 3;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === registerNewSessionOn) {
        world.alive.add(NEW_SESSION);
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: NEW_SESSION, startedAt: world.clock(), token: SESSION_TOKEN });
      }
      if (ticks === endNewSessionOn) {
        removeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, NEW_SESSION);
      }
      if (ticks === killLiveSessionOn) {
        world.alive.delete(LIVE_SESSION);
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: SLACK_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    detach();
    expect(received).toEqual([
      { source: "launch", sequence: 1, payload: { kind: "registered", pid: NEW_SESSION, startedAt: FRONTDOOR_POLL_MS, observedAt: FRONTDOOR_POLL_MS } },
      { source: "launch", sequence: 2, payload: { kind: "ended", pid: NEW_SESSION, startedAt: FRONTDOOR_POLL_MS, observedAt: endedAtMs } },
      { source: "launch", sequence: 3, payload: { kind: "pruned", pid: LIVE_SESSION, startedAt: 0, observedAt: prunedAtMs } },
    ]);
  });

  it("publishes the door's own health on the backbone: the generation once serving, and the idle shutdown before the exit", async () => {
    const world = makeWorld();
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    // The idle exit's clock reading: the window is one minute, the clock advances one tick per second, and the shutdown is observed at the first tick at or past the window.
    const shutdownAtMs = IDLE_MINUTES * MS_PER_MINUTE;
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    detach();
    expect(received).toEqual([
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 1, payload: { kind: "generation", pid: OWN_PID, providerPort: FRESH_PORT, connectPort: FRESH_PORT, directPort: FRESH_PORT, observedAt: 0 } },
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 2, payload: { kind: "idleShutdown", pid: OWN_PID, observedAt: shutdownAtMs } },
    ]);
  });

  it("publishes the listener failure that ends a generation, naming which listener and why", async () => {
    const world = makeWorld();
    world.failConnect = true;
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(1);
    detach();
    // No generation event: the door never fully served.
    expect(received).toEqual([{ source: DOOR_HEALTH_EVENT_SOURCE, sequence: 1, payload: { kind: "listenerFailed", pid: OWN_PID, listener: "connect", message: "connect chaos", observedAt: 0 } }]);
  });

  it("runs the expiring-quota check on every tick", async () => {
    const world = makeWorld();
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: SLACK_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.quotaChecks()).toBe(SLACK_TICKS);
  });
});
