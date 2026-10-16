import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRONTDOOR_PROBE_ATTEMPTS } from "./ensure";
import { PROBE_TIMEOUT_MS } from "./probe";
import { DOOR_AWAIT_PID_ENV, DOOR_STALL_BOUND_MS, DOOR_WATCHDOG_CHECK_MS, startThreadWatchdog, type DoorWatchdog, type ThreadWatchdogParams } from "./watchdog";

/** The check cadence the thread tests run at: far shorter than the production one so a stall is seen in a few checks. */
const TEST_CHECK_MS = 20;
/** Cadences in the stall bound the thread tests run at, so beating once per cadence is comfortably inside it. */
const CHECKS_IN_TEST_BOUND = 10;
const TEST_BOUND_MS = TEST_CHECK_MS * CHECKS_IN_TEST_BOUND;
/** How many bounds a test waits for a report that should arrive, or for one that should not, and how long the blocked-main-thread test blocks. */
const BOUNDS_TO_WAIT_FOR_REPORT = 10;
const BOUNDS_TO_WAIT_FOR_SILENCE = 4;
const BOUNDS_TO_BLOCK = 3;

describe("the watchdog's derived constants", () => {
  it("is more patient than a launcher is with a door, so a door a launcher still calls busy is never acted on", () => {
    expect(DOOR_STALL_BOUND_MS).toBeGreaterThan(FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS);
    expect(DOOR_STALL_BOUND_MS).toBe(2 * FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS);
  });

  it("checks several times within its bound, so a stall is noticed within a fraction of it", () => {
    expect(DOOR_STALL_BOUND_MS / DOOR_WATCHDOG_CHECK_MS).toBeGreaterThan(1);
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
        checkEveryMs: TEST_CHECK_MS,
        action: "report",
        respawnAfterServingMs: 0,
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
      watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, action: "report", respawnAfterServingMs: 0, onReport: (message) => {
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
    watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, action: "report", respawnAfterServingMs: 0, onReport: (message) => {
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

    /** Waits for the thread's report, then for the log to hold `needle`, which the thread writes before it reports. */
    async function stallWith(extra: { readonly respawnAfterServingMs: number; readonly respawn?: ThreadWatchdogParams["respawn"] }): Promise<string> {
      const logFile = path.join(directory, "frontdoor.log");
      await new Promise<void>((resolve) => {
        watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, action: "report", logFile, ...extra, onReport: () => {
            resolve();
          } });
      });
      return fs.readFileSync(logFile, "utf8");
    }

    it("writes the stall to the door's log, the one record that outlives the process", async () => {
      const log = await stallWith({ respawnAfterServingMs: 0 });
      expect(log).toMatch(new RegExp(`frontdoor ${String(process.pid)}: the front door's event loop did not run`));
    });

    it("records the machine's load, so a stall the machine caused is told apart from the door's own", async () => {
      const log = await stallWith({ respawnAfterServingMs: 0 });
      expect(log).toMatch(/machine load at the stall: \d+\.\d \(1m\), \d+\.\d \(5m\), \d+\.\d \(15m\) across \d+ cpus/);
    });

    it("says a main thread idle in its event loop could not be paused, rather than naming a frame", async () => {
      const log = await stallWith({ respawnAfterServingMs: 0 });
      expect(log).toMatch(/the main thread could not be paused within \d+ms/);
    });

    it("names the function a blocked main thread was held in", async () => {
      const logFile = path.join(directory, "frontdoor.log");
      const reported = new Promise<void>((resolve) => {
        watchdog = startThreadWatchdog({ stateFile, ownPid: process.pid, boundMs: TEST_BOUND_MS, checkEveryMs: TEST_CHECK_MS, action: "report", logFile, respawnAfterServingMs: 0, onReport: () => {
            resolve();
          } });
      });
      function holdTheLoopHere(): void {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, TEST_BOUND_MS * BOUNDS_TO_BLOCK);
      }
      holdTheLoopHere();
      await reported;
      expect(fs.readFileSync(logFile, "utf8")).toMatch(/the main thread was in .*holdTheLoopHere/);
    });

    it("starts a replacement naming the stalled pid when the door had served long enough", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.${DOOR_AWAIT_PID_ENV})`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnAfterServingMs: 0, respawn });
      expect(log).toMatch(/started replacement door \d+/);
      await vi.waitFor(() => {
        expect(fs.readFileSync(markerFile, "utf8")).toBe(String(process.pid));
      });
    });

    it("leaves the next launch to start one when the door stalled before it had served long enough", async () => {
      const markerFile = path.join(directory, MARKER);
      const respawn = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "x")`], env: { PATH: process.env.PATH ?? "" } };
      const log = await stallWith({ respawnAfterServingMs: Number.MAX_SAFE_INTEGER, respawn });
      expect(log).toMatch(/less than the \d+ms it must have served to be replaced/);
      expect(fs.existsSync(markerFile)).toBe(false);
    });
  });
});
