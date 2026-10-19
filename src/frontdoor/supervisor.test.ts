import { describe, expect, it } from "vitest";

import { DOOR_HEALTH_EVENT_SOURCE, LAUNCH_EVENT_SOURCE, type DoorEvent } from "./eventSchemas";
import { FRONT_DOOR_PROTOCOL, listFrontDoorDirectRecords, listFrontDoorSessions, readFrontDoorState, removeFrontDoorSession, writeFrontDoorSession, writeFrontDoorState } from "./state";
import { awaitPidExit, FRONTDOOR_POLL_MS, FRONTDOOR_SUPERVISOR_STILL_RUNNING, runFrontDoorSupervisor, watchedInstallEntry } from "./supervisor";
import { DEAD_SESSION, FRESH_PORT, FULL_IDLE_WINDOW_TICKS, IDLE_MINUTES, INSTALLED_BINARY, LIVE_SESSION, MS_PER_MINUTE, NEW_SESSION, OCCUPIED_PORT, OWN_PID, REPLACED_BINARY, SESSION_TOKEN, SLACK_TICKS, STICKY_CONNECT_PORT, STICKY_DIRECT_PORT, STICKY_PORT, SUCCESSOR_PID, SUCCESSOR_STATE, makeWorld, paths } from "./supervisorTestWorld";

/** The existence check that always answers yes: the sibling rule applies wherever the candidate path would be. */
const SIBLING_EXISTS = (): boolean => true;

describe("awaitPidExit", () => {
  const PREDECESSOR_PID = 4242;
  /** Long enough that a fixed bound on the wait, of any size the door could have chosen, would have elapsed first. */
  const SLOW_TEARDOWN_POLLS = 1_000;

  /** A clock the fake sleep advances, so the wait is exercised without real time. */
  function fakeClock(runningUntil: number) {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        await Promise.resolve();
      },
      isRunning: () => now < runningUntil,
    };
  }

  it("returns as soon as the pid is gone, so the replacement binds the freed sticky ports", async () => {
    const clock = fakeClock(FRONTDOOR_POLL_MS);
    const waited = await awaitPidExit(PREDECESSOR_PID, clock);
    expect(waited).toBeGreaterThanOrEqual(FRONTDOOR_POLL_MS);
    expect(clock.now()).toBe(waited);
    expect(clock.isRunning()).toBe(false);
  });

  it("keeps waiting for a predecessor that is slow to be torn down, rather than binding other ports while it holds the sticky ones", async () => {
    const runningUntil = SLOW_TEARDOWN_POLLS * FRONTDOOR_POLL_MS;
    const clock = fakeClock(runningUntil);
    const waited = await awaitPidExit(PREDECESSOR_PID, clock);
    expect(waited).toBeGreaterThanOrEqual(runningUntil);
  });

  it("returns at once when the pid is already gone", async () => {
    expect(await awaitPidExit(PREDECESSOR_PID, fakeClock(0))).toBe(0);
  });
});

describe("watchedInstallEntry", () => {
  it("watches the resolved entry itself when it is already named agent-shim", () => {
    expect(watchedInstallEntry("/home/testuser/.local/bin/agent-shim", SIBLING_EXISTS)).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/agent-shim.exe", SIBLING_EXISTS)).toBe("/home/testuser/.local/bin/agent-shim.exe");
  });

  it("watches the agent-shim sibling when the door was spawned through another entry and one exists, the way the claude hardlink and the legacy claude-use symlink are", () => {
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude", SIBLING_EXISTS)).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude-use", SIBLING_EXISTS)).toBe("/home/testuser/.local/bin/agent-shim");
    expect(watchedInstallEntry("/home/testuser/.local/bin/claude.exe", SIBLING_EXISTS)).toBe("/home/testuser/.local/bin/agent-shim.exe");
  });

  it("falls back to the own path when no sibling exists, the npm bundle's own layout, where dist/cli.cjs is itself the file an update replaces", () => {
    expect(watchedInstallEntry("/n/lib/node_modules/agent-shim/dist/cli.cjs", () => false)).toBe("/n/lib/node_modules/agent-shim/dist/cli.cjs");
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

  it("records its own direct port under its pid while serving, and removes the record on an idle shutdown and on a superseded drain", async () => {
    const serving = makeWorld();
    writeFrontDoorState(serving.fs, paths.frontdoorStateFile, { lastDirectPort: STICKY_DIRECT_PORT });
    await runFrontDoorSupervisor(IDLE_MINUTES, serving.ports, { tickLimit: 1 });
    expect(listFrontDoorDirectRecords(serving.fs, paths.frontdoorDirectRecordsDir)).toEqual([{ pid: OWN_PID, directPort: STICKY_DIRECT_PORT }]);

    const idle = makeWorld();
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, idle.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(0);
    expect(listFrontDoorDirectRecords(idle.fs, paths.frontdoorDirectRecordsDir)).toEqual([]);

    const drained = makeWorld();
    drained.onSleep = () => {
      drained.alive.add(SUCCESSOR_PID);
      writeFrontDoorState(drained.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, drained.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(0);
    expect(listFrontDoorDirectRecords(drained.fs, paths.frontdoorDirectRecordsDir)).toEqual([]);
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

  it("starts the watchdog once the listeners are bound, beats it every tick, and stops it before the first listener closes", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { lastPort: STICKY_PORT });
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS });
    expect(world.timeline[0]).toBe("watchdog-start");
    expect(world.timeline.filter((entry) => entry === "watchdog-start")).toHaveLength(1);
    expect(world.timeline.filter((entry) => entry === "beat").length).toBeGreaterThan(0);
    const stopAt = world.timeline.indexOf("watchdog-stop");
    expect(stopAt).toBeGreaterThan(world.timeline.lastIndexOf("beat"));
    expect(stopAt).toBeLessThan(world.timeline.indexOf("direct"));
    expect(world.timeline.filter((entry) => entry === "watchdog-stop")).toHaveLength(1);
  });

  it("never starts the watchdog for a door whose listener failed to bind", async () => {
    const world = makeWorld();
    world.failListener = true;
    await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: 1 });
    expect(world.timeline).not.toContain("watchdog-start");
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

  it("turns over a replacement that lands during the door's own startup, at the second tick rather than under the ensuring launch", async () => {
    const world = makeWorld();
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    // The replacement lands between the identity baseline and the listeners being up, the window a post-bind baseline would wrongly capture as the new normal.
    world.onListenerStart = () => {
      world.ownExecutable = REPLACED_BINARY;
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    detach();
    // The turnover is observed at the second tick's clock (one poll interval), not at tick one: the first tick's grace is what lets the ensuring launch's session record land before the door may retire.
    expect(world.clock()).toBe(FRONTDOOR_POLL_MS);
    expect(received).toEqual([
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 1, payload: { kind: "generation", pid: OWN_PID, providerPort: FRESH_PORT, connectPort: FRESH_PORT, directPort: FRESH_PORT, observedAt: 0 } },
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 2, payload: { kind: "binaryTurnover", pid: OWN_PID, observedAt: FRONTDOOR_POLL_MS } },
    ]);
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

  it("stops taking sessions once another live supervisor owns the state file, and exits when the sessions it served have ended, leaving the owner's record untouched", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    let ticks = 0;
    const takeOverOn = 1;
    const registerWithOwnerOn = 3;
    const endServedSessionOn = 4;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === takeOverOn) {
        world.alive.add(SUCCESSOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
      }
      if (ticks === registerWithOwnerOn) {
        // A launch made against the new owner: it lives on past the end of this test, and must not keep the superseded door serving.
        world.alive.add(NEW_SESSION);
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: NEW_SESSION, startedAt: world.clock(), token: SESSION_TOKEN });
      }
      if (ticks === endServedSessionOn) {
        world.alive.delete(LIVE_SESSION);
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(0);
    // The exit came on the first tick after the served session ended, not after an idle window, and with the owner's launch still live.
    expect(world.clock()).toBe(endServedSessionOn * FRONTDOOR_POLL_MS);
    expect(world.stopOrder).toEqual(["direct", "connect", "provider", "hub"]);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toEqual(SUCCESSOR_STATE);
    expect(listFrontDoorSessions(world.fs, paths.frontdoorSessionsDir).map((session) => session.pid)).toEqual([NEW_SESSION]);
    expect(world.logs.some((line) => line.includes(`supervisor ${String(SUCCESSOR_PID)} now owns the front door`))).toBe(true);
  });

  it("does not wait for a launch that recorded the owner as the door it was sent to, even one registered before the takeover", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    world.alive.add(NEW_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN, supervisorPid: OWN_PID });
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: NEW_SESSION, startedAt: 0, token: SESSION_TOKEN, supervisorPid: SUCCESSOR_PID });
    let ticks = 0;
    const takeOverOn = 1;
    const endServedSessionOn = 3;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === takeOverOn) {
        world.alive.add(SUCCESSOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
      }
      if (ticks === endServedSessionOn) {
        world.alive.delete(LIVE_SESSION);
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(0);
    expect(world.clock()).toBe(endServedSessionOn * FRONTDOOR_POLL_MS);
    expect(world.stopOrder).toEqual(["direct", "connect", "provider", "hub"]);
  });

  it("counts a launch that registers in the tick after the takeover as its own, since that launch may have read the state before the owner replaced it", async () => {
    const world = makeWorld();
    let ticks = 0;
    const takeOverOn = 1;
    const lateRegistrationOn = 2;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === takeOverOn) {
        world.alive.add(SUCCESSOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
      }
      if (ticks === lateRegistrationOn) {
        world.alive.add(LIVE_SESSION);
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: world.clock(), token: SESSION_TOKEN });
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
    expect(world.hubCloses()).toBe(0);
  });

  it("exits a superseded door with no sessions of its own at once, ignoring the door-minted sessions keyed by its own pid and the owner's", async () => {
    const world = makeWorld();
    world.onSleep = () => {
      if (!world.alive.has(SUCCESSOR_PID)) {
        world.alive.add(SUCCESSOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
        // Each door's transparent surface registers a session under the door's own pid, which lives exactly as long as that door: counting either would keep the superseded door serving for as long as one of the two doors runs.
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: OWN_PID, startedAt: 0, token: SESSION_TOKEN });
        writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: SUCCESSOR_PID, startedAt: world.clock(), token: SESSION_TOKEN });
      }
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(0);
    // Noticed at the second tick, drained at the third: the grace tick after the notice, and no idle window.
    const drainedAtMs = FRONTDOOR_POLL_MS + FRONTDOOR_POLL_MS;
    expect(world.clock()).toBe(drainedAtMs);
    expect(readFrontDoorState(world.fs, paths.frontdoorStateFile)).toEqual(SUCCESSOR_STATE);
  });

  it("publishes the supersession when it is noticed and the drained exit before it happens", async () => {
    const world = makeWorld();
    const received: DoorEvent[] = [];
    const detach = world.doorEvents.subscribe([DOOR_HEALTH_EVENT_SOURCE], (event) => {
      received.push(event);
    });
    world.onSleep = () => {
      world.alive.add(SUCCESSOR_PID);
      writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports)).toBe(0);
    detach();
    const drainedAtMs = FRONTDOOR_POLL_MS + FRONTDOOR_POLL_MS;
    expect(received).toEqual([
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 1, payload: { kind: "generation", pid: OWN_PID, providerPort: FRESH_PORT, connectPort: FRESH_PORT, directPort: FRESH_PORT, observedAt: 0 } },
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 2, payload: { kind: "superseded", pid: OWN_PID, ownerPid: SUCCESSOR_PID, observedAt: FRONTDOOR_POLL_MS } },
      { source: DOOR_HEALTH_EVENT_SOURCE, sequence: 3, payload: { kind: "drained", pid: OWN_PID, observedAt: drainedAtMs } },
    ]);
  });

  it("keeps serving as the owner when the state file names a supervisor that is no longer running", async () => {
    const world = makeWorld();
    world.alive.add(LIVE_SESSION);
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    world.onSleep = () => {
      // A record naming a dead supervisor is claimable, the same rule the headroom supervisor applies: nothing serves at its addresses, so it supersedes nobody.
      writeFrontDoorState(world.fs, paths.frontdoorStateFile, SUCCESSOR_STATE);
    };
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: FULL_IDLE_WINDOW_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.closes).toEqual([]);
    expect(world.logs.some((line) => line.includes("now owns the front door"))).toBe(false);
  });

  it("runs the expiring-quota check on every tick", async () => {
    const world = makeWorld();
    expect(await runFrontDoorSupervisor(IDLE_MINUTES, world.ports, { tickLimit: SLACK_TICKS })).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(world.quotaChecks()).toBe(SLACK_TICKS);
  });
});
