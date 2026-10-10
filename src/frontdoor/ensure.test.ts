import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { ensureFrontDoor, FrontDoorStartError, restartFrontDoor } from "./ensure";
import type { ListenerVerdict } from "./probe";
import { FRONT_DOOR_PROTOCOL, writeFrontDoorSession, writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SUPERVISOR_PID = 500;
/** A stand-in capability: front-door registry records carry one per launch. */
const SESSION_TOKEN = "test-capability";
const OTHER_LAUNCHER_PID = 777;
const LAUNCHER_PID = 42;
const PORT = 4100;
const CONNECT_PORT = 4200;
/** A supervisor pid that is dead in every test that names it, distinct from the live fake's SUPERVISOR_PID. */
const DEAD_SUPERVISOR_PID = 999;
/** Polls before a lazily-written ready state appears, so the waiting path is exercised rather than the first-poll hit. */
const SLEEPS_BEFORE_READY = 2;
/** A launcher pid holding a start lock in the dead-holder test, distinct from every live fake. */
const DEAD_LOCK_HOLDER = 12345;
/** A port held by something that cannot present agent-shim's certificate. */
const HOSTILE_PORT = 4666;
/** The pid and port a replacement supervisor comes up on after the recorded one was distrusted. */
const REPLACEMENT_PID = 501;
const REPLACEMENT_PORT = 4101;
/** The bring-up timeout the implementation documents, asserted so the waiting path really ran its course. */
const START_TIMEOUT_MS = 30_000;

/**
 * The fake world `ensureFrontDoor` runs against: a fake filesystem, a clock that only advances when the code sleeps, a live-pid set, and a `spawnSupervisor` that records itself and can simulate the freshly spawned supervisor writing a ready state (immediately, or lazily on a later poll via `onSleep`).
 */
function makeWorld(options: { readonly spawnWritesReadyState?: boolean; readonly spawnedPid?: number; readonly spawnedPort?: number } = {}) {
  const fs = createFakeFarmFs({});
  let clock = 0;
  let onSleep: (() => void) | undefined;
  const alive = new Set<number>([SUPERVISOR_PID, process.pid, OTHER_LAUNCHER_PID]);
  const spawns: number[] = [];
  const stops: number[] = [];
  /** Ports whose listener authenticates; every other port fails the probe, the way a listener without a leaf from agent-shim's CA does. */
  const authentic = new Set<number>([PORT]);
  const probed: number[] = [];
  const spawnedPid = options.spawnedPid ?? SUPERVISOR_PID;
  const spawnedPort = options.spawnedPort ?? PORT;

  const world = {
    fs,
    alive,
    spawns,
    stops,
    authentic,
    probed,
    clock: () => clock,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** The state a serving supervisor records; `protocol` is the current one unless a test names another, with `null` meaning the field is absent, as in state written before it existed. */
    writeReadyState(port = PORT, pid = SUPERVISOR_PID, protocol: number | null = FRONT_DOOR_PROTOCOL): void {
      writeFrontDoorState(fs, paths.frontdoorStateFile, {
        ...(protocol === null ? {} : { protocol }),
        supervisorPid: pid,
        port,
        lastPort: port,
        connectPort: CONNECT_PORT,
        lastConnectPort: CONNECT_PORT,
      });
    },
    /** What the recorded session file for a launcher holds, so a test can read the launch's token back. */
    sessionToken(pid: number): string | undefined {
      const raw = fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(pid)}.json`);
      if (raw === undefined) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && "token" in parsed ? String((parsed as { readonly token: unknown }).token) : undefined;
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
        spawns.push(spawnedPid);
        alive.add(spawnedPid);
        if (options.spawnWritesReadyState !== false) {
          world.writeReadyState(spawnedPort, spawnedPid);
        }
        return spawnedPid;
      },
      stopSupervisor: (pid: number) => {
        stops.push(pid);
        alive.delete(pid);
      },
      verifyListener: (port: number): ListenerVerdict => {
        probed.push(port);
        return authentic.has(port) ? { ok: true } : { ok: false, reason: "SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain" };
      },
    },
  };
  return world;
}

describe("ensureFrontDoor", () => {
  it("spawns the supervisor when nothing is serving and waits for its ready state, then registers the session", () => {
    const world = makeWorld();
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(ensured.port).toBe(PORT);
    expect(ensured.connectPort).toBe(CONNECT_PORT);
    expect(ensured.token).toMatch(/^[0-9a-f-]{36}$/);
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
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(ensured.port).toBe(PORT);
    expect(ensured.connectPort).toBe(CONNECT_PORT);
    expect(ensured.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_READY);
  });

  it("joins an already-serving front door without spawning anything", () => {
    const world = makeWorld();
    world.writeReadyState();
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(ensured.port).toBe(PORT);
    expect(ensured.connectPort).toBe(CONNECT_PORT);
    expect(ensured.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
    expect(world.spawns).toHaveLength(0);
  });

  it("replaces a door from before the protocol field, stopping it only after its listener authenticated, and the replacement comes up on the same port", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: PORT });
    world.writeReadyState(PORT, SUPERVISOR_PID, null);
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.stops).toEqual([SUPERVISOR_PID]);
    expect(world.spawns).toEqual([REPLACEMENT_PID]);
    expect(world.probed[0]).toBe(PORT);
    expect(ensured.port).toBe(PORT);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
  });

  it("replaces a door whose recorded protocol is lower than the launcher's", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID });
    world.writeReadyState(PORT, SUPERVISOR_PID, FRONT_DOOR_PROTOCOL - 1);
    ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.stops).toEqual([SUPERVISOR_PID]);
    expect(world.spawns).toEqual([REPLACEMENT_PID]);
  });

  it("replaces a door of the current protocol when asked to, once, and the replacement comes up on the same port", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: PORT });
    world.writeReadyState(PORT, SUPERVISOR_PID, FRONT_DOOR_PROTOCOL);
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports, replace: true });
    expect(world.stops).toEqual([SUPERVISOR_PID]);
    expect(world.spawns).toEqual([REPLACEMENT_PID]);
    expect(ensured.port).toBe(PORT);
  });

  it("does not stop a door whose listener did not authenticate even when asked to replace it", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: REPLACEMENT_PORT });
    world.authentic.add(REPLACEMENT_PORT);
    world.writeReadyState(HOSTILE_PORT, SUPERVISOR_PID, FRONT_DOOR_PROTOCOL);
    ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports, replace: true });
    expect(world.stops).toEqual([]);
  });

  it("joins a door of the same or a newer protocol without stopping it, so an older launcher never downgrades a newer door", () => {
    for (const protocol of [FRONT_DOOR_PROTOCOL, FRONT_DOOR_PROTOCOL + 1]) {
      const world = makeWorld();
      world.writeReadyState(PORT, SUPERVISOR_PID, protocol);
      ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
      expect(world.stops).toEqual([]);
      expect(world.spawns).toEqual([]);
    }
  });

  it("never stops a process whose listener did not authenticate, however old its recorded protocol", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: REPLACEMENT_PORT });
    world.authentic.add(REPLACEMENT_PORT);
    world.writeReadyState(HOSTILE_PORT, SUPERVISOR_PID, null);
    ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.stops).toEqual([]);
  });

  it("fails loudly when an older door does not exit when asked", () => {
    const world = makeWorld();
    world.writeReadyState(PORT, SUPERVISOR_PID, null);
    world.ports.stopSupervisor = (pid: number) => {
      world.stops.push(pid);
    };
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(/asked to be replaced and did not exit/);
  });

  it("spawns a replacement supervisor when the recorded one is dead, the crash-recovery path every frozen base URL depends on", () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: DEAD_SUPERVISOR_PID, port: PORT, lastPort: PORT, connectPort: CONNECT_PORT, lastConnectPort: CONNECT_PORT });
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(ensured.port).toBe(PORT);
    expect(ensured.connectPort).toBe(CONNECT_PORT);
    expect(ensured.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
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
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(ensured.port).toBe(PORT);
    expect(ensured.connectPort).toBe(CONNECT_PORT);
    expect(ensured.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
    expect(world.spawns).toHaveLength(0);

    // A dead holder's lock is litter, not a wait: the next ensure clears it and spawns.
    const litterWorld = makeWorld({ spawnWritesReadyState: false });
    litterWorld.fs.mkdirp(paths.frontdoorDir);
    litterWorld.fs.writeFileExclusive(paths.frontdoorLockFile, `${JSON.stringify({ pid: DEAD_LOCK_HOLDER, at: 0 })}\n`);
    litterWorld.alive.delete(DEAD_LOCK_HOLDER);
    litterWorld.onSleep = () => {
      litterWorld.writeReadyState();
    };
    expect(ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: litterWorld.ports }).port).toBe(PORT);
    expect(litterWorld.spawns).toHaveLength(1);
  });

  it("refuses immediately when a live supervisor has recorded a fatal error", () => {
    const world = makeWorld();
    // The fatal state replaces a ready one: a live supervisor that is not serving and has recorded why.
    world.writeReadyState();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR_PID, lastPort: PORT, lastConnectPort: CONNECT_PORT, lastError: "gave up" });
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(FrontDoorStartError);
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow("gave up");
    // The command line's error reporter adds the `agent-shim:` prefix, so the message must not carry its own.
    expect(() => ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports })).toThrow(/^the front door reported a fatal error/);
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
    writeFrontDoorSession(world.fs, paths.frontdoorSessionsDir, { pid: OTHER_LAUNCHER_PID, startedAt: 0, token: SESSION_TOKEN });
    ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(LAUNCHER_PID)}.json`)).toBeDefined();
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(OTHER_LAUNCHER_PID)}.json`)).toBeDefined();
  });

  it("authenticates the listener before registering anything, and never probes with the launch's capability", () => {
    const world = makeWorld();
    world.writeReadyState();
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.probed).toEqual([PORT]);
    expect(ensured.port).toBe(PORT);
  });

  it("refuses a listener whose certificate does not validate when the supervisor it spawned serves it: no session, no port, the reason and the log named", () => {
    const world = makeWorld({ spawnedPort: HOSTILE_PORT });
    let thrown: unknown;
    try {
      ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrontDoorStartError);
    expect(String(thrown)).toContain(`127.0.0.1:${String(HOSTILE_PORT)}`);
    expect(String(thrown)).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(String(thrown)).toContain(paths.frontdoorLogPath);
    expect(world.fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${String(LAUNCHER_PID)}.json`)).toBeUndefined();
  });

  it("distrusts a recorded live pid whose listener fails authentication and brings up a verified replacement instead", () => {
    // A reused pid (or a hostile process) holds the state's port: the pid is alive, but nothing on that port presents agent-shim's certificate.
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: REPLACEMENT_PORT });
    world.authentic.delete(PORT);
    world.authentic.add(REPLACEMENT_PORT);
    world.writeReadyState(PORT, SUPERVISOR_PID);
    const ensured = ensureFrontDoor({ paths, launcherPid: LAUNCHER_PID, ports: world.ports });
    expect(world.spawns).toEqual([REPLACEMENT_PID]);
    expect(ensured.port).toBe(REPLACEMENT_PORT);
    expect(world.probed).toEqual([PORT, REPLACEMENT_PORT]);
    expect(world.sessionToken(LAUNCHER_PID)).toBe(ensured.token);
  });

  it("restarts a serving door in place: the old one is stopped, the replacement serves the same port, and the restart leaves no registry entry of its own", () => {
    const world = makeWorld({ spawnedPid: REPLACEMENT_PID, spawnedPort: PORT });
    world.writeReadyState(PORT, SUPERVISOR_PID, FRONT_DOOR_PROTOCOL);
    const result = restartFrontDoor({ paths, pid: LAUNCHER_PID, ports: world.ports });
    expect(result).toEqual({ action: "restarted", previousPid: SUPERVISOR_PID, pid: REPLACEMENT_PID });
    expect(world.stops).toEqual([SUPERVISOR_PID]);
    expect(world.sessionToken(LAUNCHER_PID)).toBeUndefined();
  });

  it("starts nothing when no door is serving", () => {
    const world = makeWorld();
    expect(restartFrontDoor({ paths, pid: LAUNCHER_PID, ports: world.ports })).toEqual({ action: "not-running" });
    expect(world.spawns).toEqual([]);
    expect(world.stops).toEqual([]);
  });
});
