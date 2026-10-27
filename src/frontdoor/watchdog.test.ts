import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRONTDOOR_PROBE_ATTEMPTS } from "./ensure";
import { PROBE_TIMEOUT_MS } from "./probe";
import { DOOR_AWAIT_PID_ENV, DOOR_RESPAWN_DELAY_ENV, DOOR_RESPAWN_GENERATION_ENV, DOOR_RESPAWN_COOLDOWN_CAP_MS, DOOR_RESPAWN_MAX_GENERATIONS, respawnDelayMs, DOOR_STALL_BOUND_MS, DOOR_WATCHDOG_CHECK_MS, startThreadWatchdog, WATCHDOG_SOURCE, type DoorWatchdog, type MachineLoadReading, type ThreadWatchdogParams } from "./watchdog";

/** The respawn ceiling the tests run at: small so the chain-end case needs no real doors, and one above the middle generation so the stepping case can observe a spawn that is not the last. */
const TEST_RESPAWN_MAX_GENERATION = 3;
/** Generations past the immediate ones that are far enough on for the cooldown to have reached its cap. */
const GENERATIONS_PAST_THE_CAP = 100;
const MS_PER_SECOND = 1000;

/** The cooldown each generation past the immediate ones adds, and its cap: small, so a test that waits for the replacement is not slowed. */
const TEST_COOLDOWN_STEP_MS = 30;
const TEST_COOLDOWN_CAP_MS = 60;

/** The start lock's file name inside each test's own directory. */
const LOCK_NAME = "start.lock";
/** The door log's file name inside each test's own directory. */
const LOG_NAME = "frontdoor.log";

/** The check cadence the thread tests run at: far shorter than the production one so a stall is seen in a few checks. */
const TEST_CHECK_MS = 20;
/** Cadences in the stall bound the thread tests run at, so beating once per cadence is comfortably inside it. */
const CHECKS_IN_TEST_BOUND = 10;
const TEST_BOUND_MS = TEST_CHECK_MS * CHECKS_IN_TEST_BOUND;
/** How many bounds a test waits for a report that should not arrive, and how long the stopped-watchdog test holds the main thread. */
const BOUNDS_TO_WAIT_FOR_SILENCE = 4;
const BOUNDS_TO_BLOCK = 3;
/** The wait for the main thread to pause for the tests that do not read its frames: none, so a stall is reported as soon as it is seen. */
const NO_PAUSE_WAIT_MS = 0;
/** The wait for the test that does read them, and the deadline a sampler is given by the tests that wait for what the sampler itself does (it exits, or it cannot start): a guard against a pause or a sampler that never ends, not an expectation of how long one takes, so a loaded machine cannot make it flaky. Starting a child process is slow enough on a loaded machine to pass any fixed figure, and the watchdog would then report that the sampler did not finish instead of how it ended. The tests of the deadline itself set their own. */
const PAUSE_WAIT_GUARD_MS = 60_000;

/** The processor count of the fixed load readings the thread tests judge by, so the machine running the tests (which may itself be loaded) never decides whether a stall is reported. */
const TEST_CPUS = 4;
/** A machine with no more runnable threads than processors: a silent loop's time counts in full. */
const UNLOADED: MachineLoadReading = { loadAverage: 0, cpus: TEST_CPUS };
/** A machine whose run queue leaves a runnable thread so small a share that the bound's worth of processor time is not reached within the longest any test holds the main thread. */
const STARVED: MachineLoadReading = { loadAverage: TEST_CPUS * (PAUSE_WAIT_GUARD_MS / TEST_BOUND_MS), cpus: TEST_CPUS };
/** A machine loaded enough to stretch the bound, though not so much that a held loop is never judged. */
const LOADED_RUN_QUEUE_PER_CPU = 2;
const LOADED: MachineLoadReading = { loadAverage: TEST_CPUS * LOADED_RUN_QUEUE_PER_CPU, cpus: TEST_CPUS };

/** A gap between two checks just past the two cadences the thread allows before it calls a check late: what a loaded machine makes of the thread's own timer. */
const LATE_CHECK_GAP_MS = 2 * TEST_CHECK_MS + 1;

/** What the thread logs once a silence has outlasted the bound in wall time but not in processor time. */

const WAITING_OUT_STARVATION = "rather than replacing a door the machine did not schedule";

/** Blocks this thread, the way a synchronous call in the door would, in short waits between which it checks `done`, until `done` holds or the guard runs out: the main loop's beat cannot run meanwhile, and the outcome waited for decides how long the hold lasts rather than a guessed duration. */
function holdTheMainThreadUntil(done: () => boolean): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = Date.now() + PAUSE_WAIT_GUARD_MS;
  while (Date.now() < deadline && !done()) {
    Atomics.wait(sleeper, 0, 0, TEST_CHECK_MS);
  }
}

/** The text of `file`, or nothing while it does not exist. */
function textOf(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** The text a respawned child wrote to `file`, once there is any: the child's write creates the file empty before it fills it, so the file existing does not mean its text has arrived. */
async function writtenTextOf(file: string): Promise<string> {
  await vi.waitFor(
    () => {
      expect(textOf(file)).not.toBe("");
    },
    { timeout: PAUSE_WAIT_GUARD_MS },
  );
  return textOf(file);
}

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
  let logFile: string;
  let watchdog: DoorWatchdog | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-watchdog-"));
    stateFile = path.join(directory, "state.json");
    logFile = path.join(directory, LOG_NAME);
    fs.writeFileSync(stateFile, `${JSON.stringify({ supervisorPid: 4242, port: 4100, connectPort: 4200 })}\n`);
  });

  afterEach(() => {
    watchdog?.stop();
    watchdog = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** Starts a watchdog at the test cadence and bound, judging by an unloaded machine unless `extra` says otherwise, and resolves with its report. */
  async function startReporting(extra: Partial<Pick<ThreadWatchdogParams, "pauseWaitMs" | "logFile" | "respawnGeneration" | "respawn" | "nativeSample" | "machineLoad">>): Promise<string> {
    // The executor runs before this function first yields, so `watchdog` is set by the time a caller goes on to hold the main thread.
    return await new Promise<string>((resolve) => {
      watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS, action: "report", respawnGeneration: 0, respawnMaxGeneration: TEST_RESPAWN_MAX_GENERATION, cooldownStepMs: TEST_COOLDOWN_STEP_MS, cooldownCapMs: TEST_COOLDOWN_CAP_MS, startLockFile: path.join(directory, LOCK_NAME), machineLoad: UNLOADED, ...extra, onReport: (message) => {
          resolve(message);
        } });
    });
  }

  it("leaves a loop alone that is free to run, however long the code it serves waits on something else", async () => {
    // Nothing here beats on the watchdog's behalf: this thread only awaits a timer for several bounds, the way the supervisor's tick awaits a `ps` run a loaded machine is slow to finish, and the loop itself runs throughout.
    const report = await Promise.race([
      startReporting({}),
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, TEST_BOUND_MS * BOUNDS_TO_WAIT_FOR_SILENCE);
      }),
    ]);
    expect(report).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("lastError");
  });

  it("acts while the main thread is blocked, which is the case it exists for, recording it in the state file's lastError and keeping the rest of the record", async () => {
    const reported = startReporting({});
    // Only a thread with its own loop can notice while this one is held; the state file is written by that thread before this hold ends.
    holdTheMainThreadUntil(() => textOf(stateFile).includes("lastError"));
    const message = await reported;
    expect(message).toMatch(/event loop did not run/);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toMatchObject({ supervisorPid: 4242, port: 4100, connectPort: 4200, lastError: message });
  });

  it("does nothing once stopped, so a slow orderly retirement is never taken for a stall", async () => {
    const reported: string[] = [];
    void startReporting({}).then((message) => {
      reported.push(message);
    });
    watchdog?.stop();
    // Held for several bounds with nothing able to beat, which a running watchdog would report.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, TEST_BOUND_MS * BOUNDS_TO_BLOCK);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TEST_BOUND_MS);
    });
    expect(reported).toEqual([]);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("lastError");
  });

  describe("on a machine starved of processors", () => {
    it("keeps a door whose loop the machine did not schedule, saying why, and says when the loop ran again", async () => {
      const reported: string[] = [];
      void startReporting({ logFile, machineLoad: STARVED }).then((message) => {
        reported.push(message);
      });
      // Held past the bound in wall time, which an unloaded machine would report, until the thread says it is waiting the starvation out.
      holdTheMainThreadUntil(() => textOf(logFile).includes(WAITING_OUT_STARVATION));
      expect(textOf(logFile)).toMatch(new RegExp(`the front door's event loop has not run for \\d+ms, but the machine's load \\(\\d+\\.\\d across ${String(TEST_CPUS)} cpus\\) left it only \\d+ms of processor time`));
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toMatch(/the front door's event loop ran again after \d+ms; the machine's load had starved it, so the watchdog kept the door/);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(reported).toEqual([]);
      expect(textOf(logFile)).not.toMatch(/did not run for/);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toHaveProperty("lastError");
    });

    it("still ends a loop held for the bound's worth of processor time, once the load has stretched the bound", async () => {
      const reported = startReporting({ logFile, machineLoad: LOADED });
      holdTheMainThreadUntil(() => textOf(logFile).includes("the main thread"));
      const message = await reported;
      const log = textOf(logFile);
      // The wait came first: at this load the bound passed in wall time before the loop had had the bound's worth of processor time.
      expect(log).toContain(WAITING_OUT_STARVATION);
      expect(log.indexOf(WAITING_OUT_STARVATION)).toBeLessThan(log.indexOf("did not run for"));
      const scheduled = /did not run for \d+ms, (\d+)ms of it with a processor to run on/.exec(message);
      expect(Number(scheduled?.[1])).toBeGreaterThanOrEqual(TEST_BOUND_MS);
    });
  });

  describe("on a stall", () => {
    const MARKER = "respawned";

    /** Holds the main thread until the thread has logged where it found it (its last line before it samples and reports), then waits for the report and returns the log. */
    async function stallWith(extra: Partial<Pick<ThreadWatchdogParams, "respawnGeneration" | "respawn" | "nativeSample" | "machineLoad">>): Promise<string> {
      const reported = startReporting({ logFile, ...extra });
      holdTheMainThreadUntil(() => textOf(logFile).includes("the main thread"));
      await reported;
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
      const reported = startReporting({ logFile, pauseWaitMs: PAUSE_WAIT_GUARD_MS });
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      // Holds this thread until the watchdog has logged where it found it, so the test depends on no timing: the pause interrupts the wait, the thread logs the frames and resumes it, and the log then holds the line this loop is waiting for.
      function holdTheLoopHere(): void {
        const deadline = Date.now() + PAUSE_WAIT_GUARD_MS;
        while (Date.now() < deadline && !textOf(logFile).includes("the main thread")) {
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
      await vi.waitFor(
        () => {
          expect(textOf(markerFile)).toBe(`${String(process.pid)} gen 1`);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
    });

    it("steps the generation a replacement is started as", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_GENERATION_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnGeneration: 1, respawn });
      expect(log).toMatch(/started replacement door \d+ of generation 2/);
      await vi.waitFor(
        () => {
          expect(textOf(markerFile)).toBe("2");
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
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

    it("writes a native stack for a main thread that could not be paused, and keeps only the newest few", async () => {
      const samples = path.join(directory, "stall-samples");
      fs.mkdirSync(samples, { recursive: true });
      for (const old of ["1.txt", "2.txt", "3.txt"]) {
        fs.writeFileSync(path.join(samples, old), "older");
        fs.utimesSync(path.join(samples, old), new Date(0), new Date(Number(old.slice(0, 1)) * MS_PER_SECOND));
      }
      const nativeSample = { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'sampled ' + process.argv[2] + 's')", "{file}", "{seconds}"], directory: samples, seconds: 1, overheadMs: PAUSE_WAIT_GUARD_MS, keep: 2 };
      const log = await stallWith({ nativeSample });
      await vi.waitFor(
        () => {
          expect(fs.readFileSync(path.join(samples, `${String(process.pid)}.txt`), "utf8")).toBe("sampled 1s");
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(log).toMatch(/could not be paused/);
      await vi.waitFor(
        () => {
          expect(fs.readdirSync(samples).sort()).toEqual(["3.txt", `${String(process.pid)}.txt`].sort());
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toContain(`native stack of the blocked main thread written to ${path.join(samples, `${String(process.pid)}.txt`)}`);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
    });

    it("says the sampler wrote nothing when it fails, passing on what it said, rather than naming a file that is not there", async () => {
      const samples = path.join(directory, "stall-samples");
      const nativeSample = { command: process.execPath, args: ["-e", "process.stderr.write('cannot examine process'); process.exit(1)"], directory: samples, seconds: 1, overheadMs: PAUSE_WAIT_GUARD_MS, keep: 1 };
      await stallWith({ nativeSample });
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toMatch(/the native sampler exited with status 1 and wrote no native stack: cannot examine process/);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(textOf(logFile)).not.toMatch(/written to/);
      expect(fs.readdirSync(samples)).toEqual([]);
    });

    it("says no stack was written when the sampler is ended at its deadline, and says it once", async () => {
      // A sampler that never finishes on its own, given no sampling time and one check of overhead, so its deadline is that check.
      const nativeSample = { command: process.execPath, args: ["-e", `setTimeout(() => undefined, ${String(PAUSE_WAIT_GUARD_MS)})`], directory: path.join(directory, "stall-samples"), seconds: 0, overheadMs: TEST_CHECK_MS, keep: 1 };
      await stallWith({ nativeSample });
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toMatch(new RegExp(`the native sampler did not finish within ${String(TEST_CHECK_MS)}ms, so no native stack was written`));
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      // The ended sampler's close comes after the deadline's line, and must not add a second account of the same run.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TEST_BOUND_MS);
      });
      expect(textOf(logFile)).not.toMatch(/written to/);
      expect(textOf(logFile).match(/the native sampler/g)).toHaveLength(1);
    });

    it("stretches the sampler's deadline by the share of a processor the machine's load leaves it", async () => {
      const nativeSample = { command: process.execPath, args: ["-e", `setTimeout(() => undefined, ${String(PAUSE_WAIT_GUARD_MS)})`], directory: path.join(directory, "stall-samples"), seconds: 0, overheadMs: TEST_CHECK_MS, keep: 1 };
      await stallWith({ nativeSample, machineLoad: LOADED });
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toMatch(new RegExp(`did not finish within ${String(TEST_CHECK_MS * LOADED_RUN_QUEUE_PER_CPU)}ms`));
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
    });

    it("says so when the native sampler cannot be run, and still ends the stall", async () => {
      const nativeSample = { command: path.join(directory, "no-such-sampler"), args: [], directory: path.join(directory, "stall-samples"), seconds: 1, overheadMs: PAUSE_WAIT_GUARD_MS, keep: 1 };
      const log = await stallWith({ nativeSample });
      await vi.waitFor(
        () => {
          expect(textOf(logFile)).toMatch(/could not sample the main thread natively/);
        },
        { timeout: PAUSE_WAIT_GUARD_MS },
      );
      expect(log).toMatch(/event loop did not run/);
    });

    it("starts a replacement past the immediate generations too, naming the cooldown it waits before binding", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV} + ":" + process.env.${DOOR_RESPAWN_GENERATION_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnGeneration: TEST_RESPAWN_MAX_GENERATION, respawn });
      expect(await writtenTextOf(markerFile)).toBe(`${String(TEST_COOLDOWN_STEP_MS)}:${String(TEST_RESPAWN_MAX_GENERATION + 1)}`);
      expect(log).toMatch(new RegExp(`${String(TEST_COOLDOWN_STEP_MS)}ms cooldown`));
    });

    it("starts the immediate generations with no cooldown", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      await stallWith({ respawnGeneration: 0, respawn });
      expect(await writtenTextOf(markerFile)).toBe("0");
    });

    it("caps the cooldown, so a chain that keeps stalling is retried at a steady pace", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_RESPAWN_DELAY_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      await stallWith({ respawnGeneration: TEST_RESPAWN_MAX_GENERATION + GENERATIONS_PAST_THE_CAP, respawn });
      expect(await writtenTextOf(markerFile)).toBe(String(TEST_COOLDOWN_CAP_MS));
    });
  });
});

describe("the watchdog thread's check on a fake clock", () => {
  let directory: string;

  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-watchdog-clock-"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** Runs the thread's source in this thread, against the fake clock, with a beat counter the test moves; the checks it makes are the ones the real thread makes, at times the test chooses. */
  function startThreadInProcess(logFile: string): Int32Array {
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerData = { shared, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, pauseWaitMs: NO_PAUSE_WAIT_MS, stateFile: path.join(directory, "state.json"), ownPid: process.pid, action: "report", logFile, machineLoad: STARVED };
    const parentPort = { on: () => undefined, postMessage: () => undefined };
    const realRequire = createRequire(import.meta.url);
    const threadRequire = (id: string): unknown => (id === "node:worker_threads" ? { workerData, parentPort } : realRequire(id));
    const run: unknown = vm.runInThisContext(`(function (require) {${WATCHDOG_SOURCE}})`);
    if (typeof run !== "function") {
      throw new Error("the watchdog source did not compile to a function");
    }
    Reflect.apply(run, undefined, [threadRequire]);
    return new Int32Array(shared);
  }

  it("still says the loop ran again when a late check, which saw it silent, came between the wait and the loop's next beat", () => {
    const logFile = path.join(directory, LOG_NAME);
    const counter = startThreadInProcess(logFile);
    vi.advanceTimersByTime(TEST_BOUND_MS + TEST_CHECK_MS);
    expect(textOf(logFile)).toContain(WAITING_OUT_STARVATION);

    // The thread's own timer slips past the cadence while the loop is still silent, then the loop beats.
    vi.setSystemTime(Date.now() + LATE_CHECK_GAP_MS);
    vi.advanceTimersByTime(TEST_CHECK_MS);
    Atomics.add(counter, 0, 1);
    vi.advanceTimersByTime(TEST_CHECK_MS);

    expect(textOf(logFile)).toMatch(/the front door's event loop ran again after \d+ms; the machine's load had starved it, so the watchdog kept the door/);
  });
});
