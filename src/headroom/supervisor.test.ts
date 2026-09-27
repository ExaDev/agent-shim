import { describe, expect, it } from "vitest";

import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import {
  backoffForAttempt,
  HEADROOM_SUPERVISOR_STILL_RUNNING,
  HEADROOM_BACKOFF_BASE_MS,
  HEADROOM_BACKOFF_CAP_MS,
  HEADROOM_POLL_MS,
  HEADROOM_START_RETRY_BUDGET,
  resolveSupervisorConfig,
  runSupervisor,
  versionSatisfies,
  type SupervisorPorts,
} from "./supervisor";
import { hashAllowlist, headroomAllowlist, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const SESSION_PID = 321;
const OWN_PID = 4242;
const TICKS_INSTALL_TEST = 3;
const TICKS_SHORT = 2;
const TICKS_CRASH_RESTART = 6;
const TICKS_DRIFT_TEST = 40;
const TICKS_LONG_SESSION = 100;
const IDLE_ONE_MINUTE = 1;
const IDLE_NEVER_MINUTES = 60;
const DEFERRAL_TICKS = 5;
const FIRST_BACKOFF_ATTEMPT = 1;
const LAST_BACKOFF_ATTEMPT = 5;
const BIG_ATTEMPT = 20;
const ATTEMPT_THREE = 3;
const ATTEMPT_FOUR = 4;
const DRIFT_DONE_PHASE = 3;

/**
 * The fake world `runSupervisor` runs against: a fake filesystem seeded with providers, a clock advanced only by the supervisor's own sleeps, a live-pid set, and controllable readiness, install, and version results. `onSleep` lets a test script the outside world (a provider file appearing, a session ending) between ticks.
 */
function makeWorld(seededProviders: readonly { name: string; baseUrl: string }[] = []) {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  for (const provider of seededProviders) {
    fs.writeFileUtf8(
      `${paths.providersDir}/${provider.name}.json`,
      JSON.stringify({ displayName: provider.name, baseUrl: provider.baseUrl, tokenEnv: "T" }),
    );
  }

  let clock = 0;
  let nextPid = 1000;
  let nextPort = 2000;
  const readyPorts = new Set<number>();
  let autoReady = true;
  let version: string | undefined = "headroom 0.39.1";
  let installOk = true;
  const alive = new Set<number>([process.pid]);
  const spawns: { pid: number; port: number; allowlist: readonly string[] }[] = [];
  const stops: number[] = [];
  const installs: string[] = [];
  const logLines: string[] = [];
  const sleepDelays: number[] = [];
  let onSleep: (() => void) | undefined;

  /** Resolves on a later microtask, the way a real readiness probe awaits I/O; also keeps the promise-shaped fakes honest under the async rules. */
async function settled<T>(value: T): Promise<T> {
  return await Promise.resolve(value);
}

const world = {
    fs,
    alive,
    spawns,
    stops,
    installs,
    logLines,
    sleepDelays,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** When false, spawned proxies never answer /readyz, whatever port they get. */
    set autoReady(value: boolean) {
      autoReady = value;
    },
    set version(value: string | undefined) {
      version = value;
    },
    set installOk(value: boolean) {
      installOk = value;
    },
    kill(pid: number): void {
      alive.delete(pid);
    },
    writeSessionFile(pid: number): void {
      alive.add(pid);
      writeSession(fs, paths.headroomSessionsDir, { pid, startedAt: clock });
    },
    ports: {
      fs,
      paths,
      ownPid: OWN_PID,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
        sleepDelays.push(ms);
        if (onSleep !== undefined) {
          onSleep();
        }
      },
      isProcessAlive: (pid: number) => alive.has(pid),
      freePort: async () => {
        nextPort += 1;
        return await settled(nextPort);
      },
      spawnHeadroom: (port: number, allowlist: readonly string[]) => {
        nextPid += 1;
        alive.add(nextPid);
        spawns.push({ pid: nextPid, port, allowlist: [...allowlist] });
        if (autoReady) {
          readyPorts.add(port);
        }
        return nextPid;
      },
      stopProcess: (pid: number) => {
        alive.delete(pid);
        stops.push(pid);
      },
      ready: async (port: number) => await settled(readyPorts.has(port)),
      install: (spec: string) => {
        installs.push(spec);
        if (installOk) {
          // A successful install puts the binary on PATH, like the real one does.
          version ??= "headroom 0.39.1";
          return { ok: true };
        }
        return { ok: false, error: "uv is not installed or not on PATH (spawn ENOENT)" };
      },
      headroomVersion: () => version,
      log: (line: string) => {
        logLines.push(line);
      },
    } satisfies SupervisorPorts,
  };
  return world;
}

const config = resolveSupervisorConfig({});

describe("resolveSupervisorConfig", () => {
  it("defaults source and idle shutdown from the named constants", () => {
    expect(resolveSupervisorConfig({})).toEqual({
      source: HEADROOM_DEFAULT_SOURCE,
      idleShutdownMinutes: HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES,
    });
    expect(resolveSupervisorConfig({ source: "headroom==0.39.0", idleShutdownMinutes: 5 })).toEqual({
      source: "headroom==0.39.0",
      idleShutdownMinutes: 5,
    });
  });
});

describe("versionSatisfies", () => {
  it("rejects an absent version and accepts any version of an unversioned source", () => {
    expect(versionSatisfies(undefined, HEADROOM_DEFAULT_SOURCE)).toBe(false);
    expect(versionSatisfies("headroom 0.20.0", HEADROOM_DEFAULT_SOURCE)).toBe(true);
  });

  it("checks PEP 440 specifiers against the installed version", () => {
    expect(versionSatisfies("headroom 0.39.1", "headroom>=0.39")).toBe(true);
    expect(versionSatisfies("headroom 0.38.2", "headroom>=0.39")).toBe(false);
    expect(versionSatisfies("headroom 0.39.1", "headroom==0.39.1")).toBe(true);
    expect(versionSatisfies("headroom 0.39.1", "headroom==0.39.0")).toBe(false);
    expect(versionSatisfies("headroom 0.39.1", "headroom<0.40")).toBe(true);
  });

  it("treats an unparseable version or specifier as satisfied rather than reinstalling forever", () => {
    expect(versionSatisfies("garbage", "headroom==also-garbage")).toBe(true);
  });
});

describe("backoffForAttempt", () => {
  it("doubles from the base and caps", () => {
    expect(backoffForAttempt(FIRST_BACKOFF_ATTEMPT)).toBe(HEADROOM_BACKOFF_BASE_MS);
    expect(backoffForAttempt(2)).toBe(HEADROOM_BACKOFF_BASE_MS * 2);
    expect(backoffForAttempt(ATTEMPT_THREE)).toBe(HEADROOM_BACKOFF_BASE_MS * 2 * 2);
    expect(backoffForAttempt(BIG_ATTEMPT)).toBe(HEADROOM_BACKOFF_CAP_MS);
  });
});

describe("runSupervisor", () => {
  it("installs headroom when the binary is missing, then starts it and records ready state", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.version = undefined;

    const code = await runSupervisor(config, world.ports, { tickLimit: TICKS_INSTALL_TEST });

    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.installs).toEqual([HEADROOM_DEFAULT_SOURCE]);
    expect(world.spawns).toHaveLength(1);
    const spawn = world.spawns[0];
    if (spawn === undefined) {
      throw new Error("expected a headroom spawn");
    }
    expect(spawn.allowlist).toEqual([
      "https://api.anthropic.com",
      "https://api.z.ai/api/anthropic",
    ]);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBe(OWN_PID);
    expect(state.headroomPid).toBe(spawn.pid);
    expect(state.port).toBe(spawn.port);
    expect(state.allowlistHash).toBe(hashAllowlist(headroomAllowlist([{ baseUrl: "https://api.z.ai/api/anthropic" }])));
    expect(state.installedSource).toBe(HEADROOM_DEFAULT_SOURCE);
  });

  it("does not install when the installed version already satisfies the configured source", async () => {
    const world = makeWorld();
    await runSupervisor(resolveSupervisorConfig({ source: "headroom>=0.39" }), world.ports, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual([]);
    expect(world.spawns).toHaveLength(1);
  });

  it("exits non-zero and records lastError when installing is impossible (uv absent)", async () => {
    const world = makeWorld();
    world.version = undefined;
    world.installOk = false;

    const code = await runSupervisor(config, world.ports);

    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("could not install headroom");
  });

  it("restarts a daemon that crashed while sessions were live", async () => {
    const world = makeWorld();
    let crashed = false;
    world.onSleep = () => {
      if (!crashed && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        const first = world.spawns[0];
        if (first !== undefined) {
          world.kill(first.pid);
          crashed = true;
        }
      }
    };
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_CRASH_RESTART });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
  });

  it("gives up after the retry budget when the daemon never becomes ready, recording lastError", async () => {
    const world = makeWorld();
    world.autoReady = false;

    const code = await runSupervisor(config, world.ports);

    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(HEADROOM_START_RETRY_BUDGET);
    // The backoff schedule: 500ms, 1000ms, 2000ms, 4000ms, 8000ms between the failed attempts.
    for (const attempt of [FIRST_BACKOFF_ATTEMPT, 2, ATTEMPT_THREE, ATTEMPT_FOUR, LAST_BACKOFF_ATTEMPT]) {
      const expected = backoffForAttempt(attempt);
      expect(world.sleepDelays).toContain(expected);
    }
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(String(state.lastError)).toContain("failed to become ready");
  });

  it("defers a drift restart while a session is live and restarts once the registry empties", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    let phase = 0;
    world.onSleep = () => {
      if (phase === 0 && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        phase = 1;
        return;
      }
      if (phase === 1) {
        // A new provider appears: the allowlist drifts while a session is live.
        world.fs.writeFileUtf8(
          `${paths.providersDir}/m.json`,
          JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", tokenEnv: "T" }),
        );
        phase = 2;
        return;
      }
      if (phase === 2 && world.spawns.length === 1 && world.stops.length === 0) {
        // Give the deferral a few ticks to prove it does not restart under a live session.
        if (world.sleepDelays.filter((delay) => delay === HEADROOM_POLL_MS).length >= DEFERRAL_TICKS) {
          world.alive.delete(SESSION_PID);
          world.fs.removeRecursive(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`);
          phase = DRIFT_DONE_PHASE;
        }
      }
    };

    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_DRIFT_TEST });

    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.spawns).toHaveLength(2);
    const second = world.spawns[1];
    if (second === undefined) {
      throw new Error("expected a restart spawn");
    }
    expect(second.allowlist).toContain("https://api.minimax.io");
    expect(world.stops).toHaveLength(1);
  });

  it("shuts the daemon down after the idle period with an empty registry", async () => {
    const world = makeWorld();
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports);
    expect(code).toBe(0);
    expect(world.stops).toHaveLength(1);
    const state = JSON.parse(world.fs.readFileUtf8(paths.headroomStateFile) ?? "{}") as Record<string, unknown>;
    expect(state.supervisorPid).toBeUndefined();
    expect(state.port).toBeUndefined();
  });

  it("resets the idle clock while a session is live, so a long session never triggers shutdown", async () => {
    const world = makeWorld();
    world.onSleep = () => {
      if (world.spawns.length > 0) {
        world.writeSessionFile(SESSION_PID);
      }
    };
    const code = await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_ONE_MINUTE }, world.ports, { tickLimit: TICKS_LONG_SESSION });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.stops).toHaveLength(0);
  });

  it("prunes registry entries whose launcher pid has died", async () => {
    const world = makeWorld();
    world.writeSessionFile(SESSION_PID);
    world.alive.delete(SESSION_PID);
    await runSupervisor({ source: config.source, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_INSTALL_TEST });
    expect(world.fs.readFileUtf8(`${paths.headroomSessionsDir}/${String(SESSION_PID)}.json`)).toBeUndefined();
  });

  it("reinstalls when the configured source changed since the last install", async () => {
    const world = makeWorld();
    writeHeadroomState(world.fs, paths.headroomStateFile, {
      supervisorPid: 1,
      installedSource: "headroom[proxy] @ git+https://github.com/ExaDev/headroom",
    });
    await runSupervisor(resolveSupervisorConfig({ source: "headroom==0.39.0" }), world.ports, { tickLimit: TICKS_SHORT });
    expect(world.installs).toEqual(["headroom==0.39.0"]);
  });
});
