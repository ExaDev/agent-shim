import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRONTDOOR_PROBE_ATTEMPTS } from "./ensure";
import { PROBE_TIMEOUT_MS } from "./probe";
import { DOOR_AWAIT_PID_ENV, DOOR_RESPAWN_DELAY_ENV, DOOR_RESPAWN_GENERATION_ENV, DOOR_RESPAWN_COOLDOWN_CAP_MS, DOOR_RESPAWN_MAX_GENERATIONS, respawnDelayMs, DOOR_STALL_BOUND_MS, DOOR_WATCHDOG_CHECK_MS, startThreadWatchdog, type DoorWatchdog, type ThreadWatchdogParams } from "./watchdog";

/** The respawn ceiling the tests run at: small so the chain-end case needs no real doors, and one above the middle generation so the stepping case can observe a spawn that is not the last. */
const TEST_RESPAWN_MAX_GENERATION = 3;
/** Generations past the immediate ones that are far enough on for the cooldown to have reached its cap. */
const GENERATIONS_PAST_THE_CAP = 100;

/** The cooldown each generation past the immediate ones adds, and its cap: small, so a test that waits for the replacement is not slowed. */
const TEST_COOLDOWN_STEP_MS = 30;
const TEST_COOLDOWN_CAP_MS = 60;

/** The start lock's file name inside each test's own directory. */
const LOCK_NAME = "start.lock";

/** The check cadence the thread tests run at: far shorter than the production one so a stall is seen in a few checks. */
const TEST_CHECK_MS = 20;
/** Cadences in the stall bound the thread tests run at, so beating once per cadence is comfortably inside it. */
const CHECKS_IN_TEST_BOUND = 10;
const TEST_BOUND_MS = TEST_CHECK_MS * CHECKS_IN_TEST_BOUND;
/** How many bounds a test waits for a report that should arrive, or for one that should not, and how long the blocked-main-thread test blocks. */
const BOUNDS_TO_WAIT_FOR_REPORT = 10;
const BOUNDS_TO_WAIT_FOR_SILENCE = 4;
const BOUNDS_TO_BLOCK = 3;
/** The wait for the main thread to pause for the tests that do not read its frames: none, so a stall is reported as soon as it is seen. */
const NO_PAUSE_WAIT_MS = 0;
/** The wait for the test that does read them: a guard against a pause that never comes, not an expectation of how long one takes, so a loaded machine cannot make it flaky. */
const PAUSE_WAIT_GUARD_MS = 60_000;

describe("the watchdog's derived constants", () => {
  it("is more patient than a launcher is with a door, so a door a launcher still calls busy is never acted on", () => {
    expect(DOOR_STALL_BOUND_MS).toBeGreaterThan(FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS);
    expect(DOOR_STALL_BOUND_MS).toBe(2 * FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS);
  });

  it("checks several times within its bound, so a stall is noticed within a fraction of it", () => {
    expect(DOOR_STALL_BOUND_MS / DOOR_WATCHDOG_CHECK_MS).toBeGreaterThan(1);
  });
});

describe("respawnDelayMs", () => {
  it("is nothing for the immediate generations and one stall bound more for each generation past them", () => {
    expect(respawnDelayMs(1)).toBe(0);
    expect(respawnDelayMs(DOOR_RESPAWN_MAX_GENERATIONS)).toBe(0);
    expect(respawnDelayMs(DOOR_RESPAWN_MAX_GENERATIONS + 1)).toBe(DOOR_STALL_BOUND_MS);
    expect(respawnDelayMs(DOOR_RESPAWN_MAX_GENERATIONS + 2)).toBe(2 * DOOR_STALL_BOUND_MS);
  });

  it("stops growing at the cap, which is the time the immediate generations together allow", () => {
    expect(respawnDelayMs(DOOR_RESPAWN_MAX_GENERATIONS + GENERATIONS_PAST_THE_CAP)).toBe(DOOR_RESPAWN_COOLDOWN_CAP_MS);
    expect(DOOR_RESPAWN_COOLDOWN_CAP_MS).toBe(DOOR_STALL_BOUND_MS * DOOR_RESPAWN_MAX_GENERATIONS);
  });
});

describe("startThreadWatchdog", () => {
  let directory: string;
  let stateFile: string;
  let watchdog: DoorWatchdog | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-watchdog-"));
    stateFile = path.join(directory, "state.json");
    fs.writeFileSync(stateFile, `${JSON.stringify({ supervisorPid: 4242, port: 4100, connectPort: 4200 })}\n`);
  });

  afterEach(() => {
    watchdog?.stop();
    watchdog = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** Resolves with the report the thread posts, or undefined when none arrives within `waitMs`. */
  async function reportWithin(waitMs: number, beatEveryMs: number | undefined): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      watchdog = startThreadWatchdog({
        stateFile,
        ownPid: process.pid,
        boundMs: TEST_BOUND_MS,
        checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS,
        action: "report",
        respawnGeneration: 0,
        respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME),
        onReport: (message) => {
          if (timer !== undefined) clearInterval(timer);
          resolve(message);
        },
      });
      if (beatEveryMs !== undefined) {
        const beat = watchdog.beat;
        timer = setInterval(beat, beatEveryMs);
      }
      setTimeout(() => {
        if (timer !== undefined) clearInterval(timer);
        resolve(undefined);
      }, waitMs);
    });
  }

  it("reports a main loop that never beats, recording it in the state file's lastError and keeping the rest of the record", async () => {
    const message = await reportWithin(TEST_BOUND_MS * BOUNDS_TO_WAIT_FOR_REPORT, undefined);
    expect(message).toMatch(/event loop did not run/);
    const recorded: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(recorded).toMatchObject({ supervisorPid: 4242, port: 4100, connectPort: 4200, lastError: message });
  });

  it("leaves a loop alone that beats within the bound", async () => {
    expect(await reportWithin(TEST_BOUND_MS * BOUNDS_TO_WAIT_FOR_SILENCE, TEST_CHECK_MS)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("lastError");
  });

  it("acts while the main thread is blocked, which is the case it exists for", async () => {
    const reported = new Promise<string>((resolve) => {
      watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS, action: "report", respawnGeneration: 0, respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME), onReport: (message) => {
          resolve(message);
        } });
    });
    // Blocks this thread, the way a synchronous wait in the door would, for several bounds: only a thread with its own loop can notice.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, TEST_BOUND_MS * BOUNDS_TO_BLOCK);
    // The state file was written by the other thread while this one was blocked, before this line ran.
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toHaveProperty("lastError");
    await expect(reported).resolves.toMatch(/event loop did not run/);
  });

  it("does nothing once stopped, so a slow orderly retirement is never taken for a stall", async () => {
    const reported: string[] = [];
    watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS, action: "report", respawnGeneration: 0, respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME), onReport: (message) => {
        reported.push(message);
      } });
    watchdog.stop();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TEST_BOUND_MS * BOUNDS_TO_BLOCK);
    });
    expect(reported).toEqual([]);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("lastError");
  });

  describe("on a stall", () => {
    const MARKER = "respawned";

    /** Waits for the thread's report, then for the log, which the thread writes before it reports. */
    async function stallWith(extra: { readonly respawnGeneration?: number; readonly respawnMaxGeneration?: number; readonly respawn?: ThreadWatchdogParams["respawn"] }): Promise<string> {
      const logFile = path.join(directory, "frontdoor.log");
      await new Promise<void>((resolve) => {
        watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS, action: "report", logFile, respawnGeneration: 0, respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME), ...extra, onReport: () => {
            resolve();
          } });
      });
      return fs.readFileSync(logFile, "utf8");
    }

    it("writes the stall to the door's log, the one record that outlives the process", async () => {
      const log = await stallWith({});
      expect(log).toMatch(new RegExp(`frontdoor ${String(process.pid)}: the front door's event loop did not run`));
    });

    it("records the machine's load, so a stall the machine caused is told apart from the door's own", async () => {
      const log = await stallWith({});
      expect(log).toMatch(/machine load at the stall: \d+\.\d \(1m\), \d+\.\d \(5m\), \d+\.\d \(15m\) across \d+ cpus/);
    });

    it("says the main thread could not be paused when the wait is over before it was, rather than naming a frame", async () => {
      const log = await stallWith({});
      expect(log).toMatch(/the main thread could not be paused within 0ms/);
    });

    it("names the function a blocked main thread was held in", async () => {
      const logFile = path.join(directory, "frontdoor.log");
      const reported = new Promise<void>((resolve) => {
        watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: PAUSE_WAIT_GUARD_MS, action: "report", logFile, respawnGeneration: 0, respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME), onReport: () => {
            resolve();
          } });
      });
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      // Holds this thread until the watchdog has logged where it found it, so the test depends on no timing: the pause interrupts the wait, the thread logs the frames and resumes it, and the log then holds the line this loop is waiting for.
      function holdTheLoopHere(): void {
        const deadline = Date.now() + PAUSE_WAIT_GUARD_MS;
        while (Date.now() < deadline && !(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").includes("the main thread")) {
          Atomics.wait(sleeper, 0, 0, TEST_CHECK_MS);
        }
      }
      holdTheLoopHere();
      await reported;
      expect(fs.readFileSync(logFile, "utf8")).toMatch(/the main thread was in .*holdTheLoopHere/);
    });

    it("starts a replacement naming the stalled pid and the next generation, however young the stalled door was", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_AWAIT_PID_ENV} + " gen " + process.env.${DOOR_RESPAWN_GENERATION_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawn });
      expect(log).toMatch(/started replacement door \d+ of generation 1/);
      await vi.waitFor(() => {
        expect(fs.readFileSync(markerFile, "utf8")).toBe(`${String(process.pid)} gen 1`);
      });
    });

    it("steps the generation a replacement is started as", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_GENERATION_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnGeneration: 1, respawn });
      expect(log).toMatch(/started replacement door \d+ of generation 2/);
      await vi.waitFor(() => {
        expect(fs.readFileSync(markerFile, "utf8")).toBe("2");
      });
    });

    /** The pid the start lock currently names. */
    const lockHolder = (): unknown => {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, LOCK_NAME), "utf8"));
      return typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined;
    };
    /** A replacement that stays alive for the length of the assertions, so the lock it holds names a live process. */
    const lingeringRespawn = { command: process.execPath, args: ["-e", "setTimeout(() => undefined, 5000)"], env: { PATH: process.env.PATH ?? "" } };

    it("takes the start lock naming the replacement, so a launch that finds the stalled door dead waits for it instead of starting a second door", async () => {
      const log = await stallWith({ respawn: lingeringRespawn });
      const started = /started replacement door (\d+)/.exec(log);
      expect(started).not.toBeNull();
      expect(lockHolder()).toBe(Number(started?.[1]));
    });

    it("starts no replacement while a live process holds the start lock, since a door is already being started and a second would race it for the sticky ports", async () => {
      fs.writeFileSync(path.join(directory, LOCK_NAME), `${JSON.stringify({ pid: process.pid, at: 0 })}\n`);
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "x")`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawn });
      expect(log).toMatch(new RegExp(`process ${String(process.pid)} holds the start lock`));
      expect(fs.existsSync(markerFile)).toBe(false);
      expect(lockHolder()).toBe(process.pid);
    });

    it("clears the start lock of a holder that has died and starts the replacement, which the launcher's ensure would also treat as litter", async () => {
      const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
      fs.writeFileSync(path.join(directory, LOCK_NAME), `${JSON.stringify({ pid: dead, at: 0 })}\n`);
      const log = await stallWith({ respawn: lingeringRespawn });
      const started = /started replacement door (\d+)/.exec(log);
      expect(started).not.toBeNull();
      expect(lockHolder()).toBe(Number(started?.[1]));
      expect(lockHolder()).not.toBe(dead);
    });

    it("starts a replacement past the immediate generations too, naming the cooldown it waits before binding", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV} + ":" + process.env.${DOOR_RESPAWN_GENERATION_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnGeneration: TEST_RESPAWN_MAX_GENERATION, respawn });
      await vi.waitFor(
        () => {
        expect(fs.existsSync(markerFile)).toBe(true);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(fs.readFileSync(markerFile, "utf8")).toBe(`${String(TEST_COOLDOWN_STEP_MS)}:${String(TEST_RESPAWN_MAX_GENERATION + 1)}`);
      expect(log).toMatch(new RegExp(`${String(TEST_COOLDOWN_STEP_MS)}ms cooldown`));
    });

    it("starts the immediate generations with no cooldown", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      await stallWith({ respawnGeneration: 0, respawn });
      await vi.waitFor(
        () => {
        expect(fs.existsSync(markerFile)).toBe(true);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(fs.readFileSync(markerFile, "utf8")).toBe("0");
    });

    it("caps the cooldown, so a chain that keeps stalling is retried at a steady pace", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      await stallWith({ respawnGeneration: TEST_RESPAWN_MAX_GENERATION + GENERATIONS_PAST_THE_CAP, respawn });
      await vi.waitFor(
        () => {
        expect(fs.existsSync(markerFile)).toBe(true);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(fs.readFileSync(markerFile, "utf8")).toBe(String(TEST_COOLDOWN_CAP_MS));
    });
  });
});
