import { Worker } from "node:worker_threads";

import { FRONTDOOR_PROBE_ATTEMPTS } from "./ensure";
import { PROBE_TIMEOUT_MS } from "./probe";

/**
 * How long the door's main loop may go without a beat before the watchdog ends the process: twice the longest a launcher waits on a door before it calls it unresponsive (its probes, in turn, each bounded by the probe's deadline). A launcher that still counts a door as merely busy has therefore never been acted on by the door's own watchdog, and a loop that is slow but serving beats long before this.
 */
export const DOOR_STALL_BOUND_MS = 2 * FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS;

/** How many times the thread looks at the beat counter within one probe deadline, so a stall is noticed within a small fraction of the bound. */
const CHECKS_PER_PROBE_DEADLINE = 2;

/** How often the watchdog thread looks at the beat counter. */
export const DOOR_WATCHDOG_CHECK_MS = PROBE_TIMEOUT_MS / CHECKS_PER_PROBE_DEADLINE;

/** What the supervisor holds: a beat from each tick of its main loop, and a stop when it begins to retire. */
export interface DoorWatchdog {
  /** Records that the main event loop ran. Called from the supervisor's tick, which only runs while the loop serves. */
  readonly beat: () => void;
  /** Ends the watchdog before the door begins an orderly retirement, so a slow close is never taken for a stall. Idempotent. */
  readonly stop: () => void;
}

/** What the thread does when the counter has not moved for the bound: end the process (production) or only report to its parent (tests, which must not kill the test run). */
export type StallAction = "kill-process" | "report";

/**
 * The watchdog thread: its own event loop, which a blocked main loop cannot stall. It compares a shared beat counter against its previous reading on a fixed cadence, and when the counter has not moved for `boundMs` it records the stall in the state file (the existing `lastError` field, so no reader of the file sees a new key) and ends the process. A thread that was itself descheduled for longer than its cadence (the machine was suspended or starved) restarts its clock instead of judging, since the main loop stalled by the same pause is not a hung one.
 */
const WATCHDOG_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { shared, boundMs, checkEveryMs, stateFile, ownPid, action } = workerData;
const counter = new Int32Array(shared);
let lastValue = Atomics.load(counter, 0);
let lastChangeAt = Date.now();
let lastCheckAt = Date.now();
let stopped = false;
const record = (message) => {
  try {
    const existing = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const next = Object.assign({}, existing, { lastError: message });
    const temporary = stateFile + "." + String(ownPid) + ".watchdog";
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\\n", { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } catch (error) {
    // The state file is a courtesy to whoever looks next; the process still has to end.
  }
};
const timer = setInterval(() => {
  if (stopped) return;
  const now = Date.now();
  const sinceLastCheck = now - lastCheckAt;
  lastCheckAt = now;
  const value = Atomics.load(counter, 0);
  if (value !== lastValue || sinceLastCheck > checkEveryMs * 2) {
    lastValue = value;
    lastChangeAt = now;
    return;
  }
  if (now - lastChangeAt >= boundMs) {
    const message = "the front door's event loop did not run for " + String(now - lastChangeAt) + "ms; its watchdog ended the process so the next launch starts a fresh door on the same ports";
    record(message);
    stopped = true;
    clearInterval(timer);
    if (action === "kill-process") {
      process.kill(ownPid, "SIGKILL");
    } else {
      parentPort.postMessage({ stalled: true, message });
    }
  }
}, checkEveryMs);
parentPort.on("message", (message) => {
  if (message === "stop") {
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  }
});
`;

/** What `startThreadWatchdog` needs: where the state file is, which process to end, and the two derived time constants (parameters so a test can use small ones). */
export interface ThreadWatchdogParams {
  readonly stateFile: string;
  readonly ownPid: number;
  readonly boundMs: number;
  readonly checkEveryMs: number;
  readonly action: StallAction;
  /** Called on the main thread with the recorded message when `action` is `report` and the stall was seen. */
  readonly onReport?: (message: string) => void;
}

/** Starts the watchdog thread and returns the supervisor's two handles on it. The thread never keeps the process alive: it is unref'd, and `stop` ends it. */
export function startThreadWatchdog(params: Readonly<ThreadWatchdogParams>): DoorWatchdog {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(shared);
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { shared, boundMs: params.boundMs, checkEveryMs: params.checkEveryMs, stateFile: params.stateFile, ownPid: params.ownPid, action: params.action },
  });
  worker.unref();
  worker.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "message" in message && typeof message.message === "string") {
      params.onReport?.(message.message);
    }
  });
  let stopped = false;
  return {
    beat: () => {
      Atomics.add(counter, 0, 1);
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      worker.postMessage("stop");
      void worker.terminate();
    },
  };
}
