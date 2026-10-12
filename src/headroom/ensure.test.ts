import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { ensureHeadroom, HeadroomStartError } from "./ensure";
import { earlierReleaseAllowlistHash } from "./earlierRelease";
import { hashAllowlist, readAllProviders, writeAllowlistFile, writeHeadroomState, writeSession } from "./state";
import { launchRequiredUpstreams } from "./supervisor";
import { writeFrontDoorState } from "../frontdoor/state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SUPERVISOR_PID = 500;
const OTHER_LAUNCHER_PID = 777;
const SLEEPS_BEFORE_RECOVERY = 3;
const SLEEPS_BEFORE_OTHER_SUPERVENDOR_READY = 2;
const HEADROOM_PID = 501;
const SOCKET_PATH = "/home/testuser/.agent-shim/headroom/run/7.sock";
/** A supervisor pid that is dead in every test that names it, distinct from the live fake's SUPERVISOR_PID. */
const DEAD_SUPERVISOR_PID = 999;

/**
 * The fake world `ensureHeadroom` runs against: a fake filesystem, a clock that only advances when the code sleeps, a live-pid set, and a `spawnSupervisor` that records itself and can simulate the freshly spawned supervisor writing a ready state (immediately, or lazily on a later poll via `onSleep`).
 */
function makeWorld(options: { readonly spawnWritesReadyState?: boolean } = {}) {
  const fs = createFakeFarmFs({});
  let clock = 0;
  let onSleep: (() => void) | undefined;
  const alive = new Set<number>([SUPERVISOR_PID, HEADROOM_PID, process.pid]);
  const zombies = new Set<number>();
  const spawns: number[] = [];
  /** Every pid whose command line the gate asked for. */
  const commandLineReads: number[] = [];
  // The daemon's command line as `ps` reports it: this release's supervisor starts it reading an allowlist file.
  let daemonCommandLine: string | undefined = `python -m headroom.cli proxy --uds ${SOCKET_PATH} --allowed-base-urls-file /home/testuser/.agent-shim/headroom/allowlist.txt --no-rate-limit`;

  const world = {
    fs,
    alive,
    zombies,
    spawns,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    commandLineReads,
    set daemonCommandLine(value: string | undefined) {
      daemonCommandLine = value;
    },
    writeReadyState(socketPath = SOCKET_PATH, allowlistHash?: string): void {
      writeHeadroomState(fs, paths.headroomStateFile, {
        supervisorPid: SUPERVISOR_PID,
        headroomPid: HEADROOM_PID,
        socketPath,
        version: "headroom 0.39.1",
        ...(allowlistHash === undefined ? {} : { allowlistHash }),
      });
    },
    ports: {
      fs,
      isRunning: (pid: number) => alive.has(pid) && !zombies.has(pid),
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        if (onSleep !== undefined) {
          onSleep();
        }
      },
      daemonCommandLine: (pid: number) => {
        commandLineReads.push(pid);
        return daemonCommandLine;
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

describe("ensureHeadroom", () => {
  it("starts a supervisor when nothing is running and waits for its ready state, then registers the session", () => {
    const world = makeWorld();
    const result = ensureHeadroom({ paths, launcherPid: 42, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/42.json`)).toBeDefined();
  });

  it("reuses an already-healthy daemon without spawning anything", () => {
    const world = makeWorld();
    world.writeReadyState();
    const result = ensureHeadroom({ paths, launcherPid: 43, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(0);
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/43.json`)).toBeDefined();
  });

  it("joins a live previous-release supervisor recorded under the legacy state name, migrating nothing", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomLegacyStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
      version: "headroom 0.39.1",
    });
    const result = ensureHeadroom({ paths, launcherPid: 45, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(0);
    expect(world.fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeDefined();
    expect(world.fs.readFileUtf8(paths.headroomStateFile)).toBeUndefined();
  });

  it("registers the session against the supervisor whose daemon socket it returns, so only that supervisor counts it as live", () => {
    const world = makeWorld();
    world.writeReadyState();
    ensureHeadroom({ paths, launcherPid: 44, ports: world.ports });
    const entry = JSON.parse(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/44.json`) ?? "{}") as Record<string, unknown>;
    expect(entry.supervisorPid).toBe(SUPERVISOR_PID);
  });

  it("spawns a replacement supervisor when the recorded one is dead", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: DEAD_SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
    });
    const result = ensureHeadroom({ paths, launcherPid: 44, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("spawns a replacement supervisor when the recorded one is an unreaped zombie that signal 0 still reports alive", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: DEAD_SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
    });
    // The supervisor died without being reaped: it still "exists" in the table, but nothing is running there.
    world.alive.add(DEAD_SUPERVISOR_PID);
    world.zombies.add(DEAD_SUPERVISOR_PID);
    const result = ensureHeadroom({ paths, launcherPid: 51, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("keeps waiting while a live supervisor has not yet recorded a serving socket, and returns once it has", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    // The supervisor half arrives first; the daemon's socket arrives partway through the wait.
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
    });
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 52, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_RECOVERY);
  });

  it("keeps waiting while a live supervisor restarts a dead daemon, and returns once it is back", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: DEAD_SUPERVISOR_PID,
      socketPath: SOCKET_PATH,
    });
    // The supervisor brings the daemon back partway through the wait.
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 45, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBeGreaterThanOrEqual(SLEEPS_BEFORE_RECOVERY);
  });

  it("does not spawn while another live launcher holds the start lock, and waits for that launcher's supervisor", () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.headroomDir);
    world.fs.writeFileUtf8(paths.headroomLockFile, JSON.stringify({ pid: OTHER_LAUNCHER_PID, at: 0 }));
    world.alive.add(OTHER_LAUNCHER_PID);
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_OTHER_SUPERVENDOR_READY) {
        world.writeReadyState();
      }
    };
    const result = ensureHeadroom({ paths, launcherPid: 46, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(0);
  });

  it("takes over a start lock whose holder is dead", () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.headroomDir);
    world.fs.writeFileUtf8(paths.headroomLockFile, JSON.stringify({ pid: OTHER_LAUNCHER_PID, at: 0 }));
    // 777 deliberately not in the alive set.
    const result = ensureHeadroom({ paths, launcherPid: 47, ports: world.ports });
    expect(result).toEqual({ socketPath: SOCKET_PATH });
    expect(world.spawns).toHaveLength(1);
  });

  it("refuses immediately when a live supervisor has recorded a fatal lastError", () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: SUPERVISOR_PID,
      lastError: "headroom failed to become ready 5 times in a row",
    });
    expect(() => ensureHeadroom({ paths, launcherPid: 48, ports: world.ports })).toThrow(HeadroomStartError);
    expect(world.spawns).toHaveLength(0);
  });

  it("times out loudly, naming the daemon log path, when nothing ever becomes ready", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    let error: unknown;
    try {
      ensureHeadroom({ paths, launcherPid: 49, ports: world.ports });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HeadroomStartError);
    expect((error as HeadroomStartError).message).toContain(paths.headroomLogPath);
    expect(world.spawns).toHaveLength(1);
  });

  it("does not re-register a session that already exists; writeSession is idempotent per pid", () => {
    const world = makeWorld();
    world.writeReadyState();
    writeSession(world.fs, paths.headroomSessionsDir, { pid: 50, startedAt: 123, supervisorPid: SUPERVISOR_PID });
    ensureHeadroom({ paths, launcherPid: 50, ports: world.ports });
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/50.json`)).toBeDefined();
  });
});

describe("ensureHeadroom allowlist gate", () => {
  /** What the daemon admits before the front door moves, and what this launch needs after it has: the door's direct origin. */
  const OLD = ["http://127.0.0.1:50123"];
  const CURRENT_DOOR_PORT = 50999;
  const CURRENT = [`http://127.0.0.1:${String(CURRENT_DOOR_PORT)}`];
  /** The launch under test; each test has its own world, so one pid serves them all. */
  const GATED_LAUNCHER_PID = 61;
  const required = (): readonly string[] => CURRENT;
  const sessionFile = (pid: number): string => `${paths.headroomSessionsDir}/${String(pid)}.json`;
  const EARLIER_RELEASE_DAEMON = `python -m headroom.cli proxy --uds ${SOCKET_PATH} --no-rate-limit`;
  /** The supervisor's tick: the allowlist file holding `entries`, and the hash of those entries recorded as served. */
  const serve = (world: ReturnType<typeof makeWorld>, entries: readonly string[]): void => {
    writeAllowlistFile(world.fs, paths.headroomAllowlistFile, entries);
    world.writeReadyState(SOCKET_PATH, hashAllowlist(entries));
  };

  it("registers a provider launch at once when the daemon serves the upstreams the launch needs", () => {
    const world = makeWorld();
    serve(world, CURRENT);
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toEqual({ socketPath: SOCKET_PATH });
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
  });

  it("registers a provider launch when the daemon serves more than it needs, such as a superseded door's origin", () => {
    const world = makeWorld();
    serve(world, [...CURRENT, ...OLD].sort());
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toEqual({ socketPath: SOCKET_PATH });
  });

  it("does not register while the file already lists the upstreams but the supervisor has not recorded it as served", () => {
    const world = makeWorld();
    serve(world, OLD);
    writeAllowlistFile(world.fs, paths.headroomAllowlistFile, CURRENT);
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toThrow(HeadroomStartError);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
  });

  it("does not hold a launch that needs only Claude Code's own API to the allowlist, since every daemon admits it", () => {
    const world = makeWorld();
    serve(world, OLD);
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports })).toEqual({ socketPath: SOCKET_PATH });
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
  });

  it("waits, registering nothing, while the daemon serves an older allowlist, even with live sessions on it, and registers once the supervisor records the new one", () => {
    const world = makeWorld();
    serve(world, OLD);
    world.alive.add(OTHER_LAUNCHER_PID);
    writeSession(world.fs, paths.headroomSessionsDir, { pid: OTHER_LAUNCHER_PID, startedAt: 0, supervisorPid: SUPERVISOR_PID });
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        serve(world, CURRENT);
      }
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBe(SLEEPS_BEFORE_RECOVERY);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeDefined();
    expect(world.fs.readFileUtf8(sessionFile(OTHER_LAUNCHER_PID))).toBeDefined();
  });

  it("fails at once, without waiting out the timeout, when the daemon was started by an earlier release without an allowlist file", () => {
    const world = makeWorld();
    world.writeReadyState(SOCKET_PATH, hashAllowlist(OLD));
    world.daemonCommandLine = EARLIER_RELEASE_DAEMON;
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
    };
    const attempt = (): unknown => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required });
    expect(attempt).toThrow(HeadroomStartError);
    expect(attempt).toThrow(`the running headroom daemon (pid ${String(HEADROOM_PID)}) was started by an earlier release with an allowlist fixed at start; it restarts once its sessions end`);
    expect(sleeps).toBe(0);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
  });

  it("joins an earlier release's daemon whose recorded hash is that release's hash for the providers and door on disk now", () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: CURRENT_DOOR_PORT });
    world.fs.mkdirp(paths.providersDir);
    world.fs.writeFileUtf8(`${paths.providersDir}/z.json`, JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } }));
    const providers = readAllProviders(world.fs, paths.providersDir).map((entry) => entry.provider);
    world.writeReadyState(SOCKET_PATH, earlierReleaseAllowlistHash(providers, CURRENT[0]));
    world.daemonCommandLine = EARLIER_RELEASE_DAEMON;
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: () => launchRequiredUpstreams(world.fs, paths) })).toEqual({ socketPath: SOCKET_PATH });
  });


  it("reads the daemon's command line once per wait, since a running daemon's arguments cannot change", () => {
    const world = makeWorld();
    serve(world, OLD);
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        serve(world, CURRENT);
      }
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toEqual({ socketPath: SOCKET_PATH });
    expect(sleeps).toBe(SLEEPS_BEFORE_RECOVERY);
    expect(world.commandLineReads).toEqual([HEADROOM_PID]);
  });

  it("names an unreadable daemon command line as the cause when the wait times out, not the allowlist file", () => {
    const world = makeWorld();
    serve(world, OLD);
    world.daemonCommandLine = undefined;
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toThrow(
      `could not read the command line of the headroom daemon (pid ${String(HEADROOM_PID)}), so whether it reads an allowlist file is unknown`,
    );
  });

  it("names a daemon pid now running something else as the cause, and never judges it an earlier release", () => {
    const world = makeWorld();
    serve(world, OLD);
    world.daemonCommandLine = "/usr/bin/vim notes.md";
    expect(() => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required })).toThrow(
      `the headroom daemon pid ${String(HEADROOM_PID)} the state records is no longer a headroom proxy on its socket`,
    );
  });

  it("re-reads the required upstreams on every poll, so a front door that moves while the launch waits is followed", () => {
    const world = makeWorld();
    serve(world, OLD);
    let needed = CURRENT;
    world.onSleep = () => {
      needed = OLD;
    };
    expect(ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: () => needed })).toEqual({ socketPath: SOCKET_PATH });
  });

  it("times out loudly, naming the allowlist file and the supervisor log, when the supervisor never serves the upstreams the launch needs", () => {
    const world = makeWorld();
    serve(world, OLD);
    const attempt = (): unknown => ensureHeadroom({ paths, launcherPid: GATED_LAUNCHER_PID, ports: world.ports, requiredUpstreams: required });
    expect(attempt).toThrow(HeadroomStartError);
    expect(attempt).toThrow(`the headroom supervisor has not written an allowlist admitting this launch's upstreams to ${paths.headroomAllowlistFile}`);
    expect(attempt).toThrow(`Supervisor and daemon log: ${paths.headroomLogPath}`);
    expect(world.fs.readFileUtf8(sessionFile(GATED_LAUNCHER_PID))).toBeUndefined();
  });
});

describe("ensureHeadroom after a supervisor failed", () => {
  const FAILURE = "could not write the headroom allowlist file: EACCES";

  it("stops attributing the wait to the allowlist once the daemon is gone, and names the recorded lastError on timeout", () => {
    const world = makeWorld({ spawnWritesReadyState: false });
    world.writeReadyState(SOCKET_PATH, "hash-of-an-older-allowlist");
    let sleeps = 0;
    world.onSleep = () => {
      sleeps += 1;
      if (sleeps === SLEEPS_BEFORE_RECOVERY) {
        // The supervisor failed and exited, taking its daemon with it, and left only its error behind.
        world.alive.delete(SUPERVISOR_PID);
        world.alive.delete(HEADROOM_PID);
        writeHeadroomState(world.fs, paths.headroomStateFile, { lastError: FAILURE });
      }
    };
    const attempt = (): unknown => ensureHeadroom({ paths, launcherPid: 80, ports: world.ports, requiredUpstreams: () => ["https://upstream.example"] });
    expect(attempt).toThrow(`(last error: ${FAILURE})`);
    expect(attempt).toThrow(/^the headroom daemon did not become ready/);
  });

  it("spawns a fresh supervisor over a record holding only a dead supervisor's lastError", () => {
    for (const record of [{ lastError: FAILURE }, { supervisorPid: DEAD_SUPERVISOR_PID, lastError: FAILURE }]) {
      const world = makeWorld();
      writeHeadroomState(world.fs, paths.headroomStateFile, record);
      expect(ensureHeadroom({ paths, launcherPid: 82, ports: world.ports })).toEqual({ socketPath: SOCKET_PATH });
      expect(world.spawns).toHaveLength(1);
    }
  });
});

describe("ensureHeadroom error messages", () => {
  it("leave the `agent-shim:` prefix to the command line's error reporter, so it is not printed twice", () => {
    const world = makeWorld();
    world.writeReadyState();
    writeHeadroomState(world.fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, lastError: "boom" });
    expect(() => ensureHeadroom({ paths, launcherPid: 70, ports: world.ports })).toThrow(/^the headroom daemon reported a fatal error/);
  });
});
