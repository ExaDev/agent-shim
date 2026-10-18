import { Worker } from "node:worker_threads";

import { FRONTDOOR_PROBE_ATTEMPTS } from "./ensure";
import { PROBE_TIMEOUT_MS } from "./probe";

/**
 * How long the door's main loop may go without a beat before the watchdog ends the process: twice the longest a launcher waits on a door before it calls it unresponsive (its probes, in turn, each bounded by the probe's deadline). A launcher that still counts a door as merely busy has therefore never been acted on by the door's own watchdog, and a loop that is slow but serving beats long before this.
 */
export const DOOR_STALL_BOUND_MS = 2 * FRONTDOOR_PROBE_ATTEMPTS * PROBE_TIMEOUT_MS;

/** The environment variable naming the pid a respawned door waits to see gone before it binds, so the sticky ports are free when it asks for them. */
export const DOOR_AWAIT_PID_ENV = "AGENT_SHIM_FRONTDOOR_AWAIT_PID";

/**
 * The environment variable naming how many doors the watchdog's respawns have gone through before this one: a door started by `frontdoor restart` or a launch carries nothing here and counts as generation 0, and each watchdog respawn adds one. A door reads it once at startup and passes the number to its own watchdog, which refuses to respawn past `DOOR_RESPAWN_MAX_GENERATIONS`.
 */
export const DOOR_RESPAWN_GENERATION_ENV = "AGENT_SHIM_FRONTDOOR_RESPAWN_GENERATION";

/**
 * The highest replacement generation the watchdog will start. Every stall gets a replacement as long as a further generation is left, because a young door killed by a stall the machine caused (observed in production: an overloaded host stalling the loop before the door had served a minute) left every live session with connection refused until some later launch happened to start a door. What must not happen is an endless chain of doors each killed at once, so after this many consecutive replacements the chain stops and the next launch's ensure takes over: each link already costs at least one stall bound, so a stall that has recurred this many times with no door serving in between is the machine's, and respawning faster than a launch cannot fix it.
 */
export const DOOR_RESPAWN_MAX_GENERATIONS = 3;

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
type StallAction = "kill-process" | "report";

/**
 * The watchdog thread: its own event loop, which a blocked main loop cannot stall. It compares a shared beat counter against its previous reading on a fixed cadence, and when the counter has not moved for `boundMs` it records the stall in the state file (the existing `lastError` field, so no reader of the file sees a new key) and in the door's log (the next generation's first state write replaces `lastError`, and a SIGKILL runs no handler, so the log line is the only record that outlives the replacement), logs the machine's load and where the main thread was (see `describeMainThread`, so a stall that was the door's own code is told apart from one the machine caused), starts a replacement door (as long as this door's own generation has not reached the respawn ceiling, so a stall that recurs through consecutive doors ends the chain rather than looping) and ends the process. A thread that was itself descheduled for longer than its cadence (the machine was suspended or starved) restarts its clock instead of judging, since the main loop stalled by the same pause is not a hung one.
 */
const WATCHDOG_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const inspector = require("node:inspector");
const { shared, boundMs, checkEveryMs, pauseWaitMs, stateFile, ownPid, action, logFile, respawn, respawnGeneration, respawnMaxGeneration, awaitPidEnv, respawnGenerationEnv } = workerData;
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
const log = (line) => {
  if (logFile === undefined) return;
  try {
    fs.appendFileSync(logFile, new Date().toISOString() + " frontdoor " + String(ownPid) + ": " + line + "\\n");
  } catch (error) {
    // Nowhere left to report a failed log write to; the process still has to end.
  }
};
// Enough of the stack to read the caller chain from the timer or socket callback down to the call that held the loop.
const STACK_FRAMES_LOGGED = 12;
// Asks the main thread where it is, through the inspector: a pause request interrupts JavaScript that is running (a loop, or a synchronous call that can be interrupted), so the top frames name what held the loop. A main thread that cannot be paused within the wait is not at such a point (it is idle in the event loop, which means it was not scheduled, or blocked inside a native call), and the answer says so rather than guessing. \`resume\` lets a thread that is not about to be killed run on again.
const describeMainThread = (waitMs, resume) => new Promise((resolve) => {
  let session;
  let settled = false;
  const finish = (text) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try {
      session.disconnect();
    } catch (error) {
      // Never connected; there is nothing to release.
    }
    resolve(text);
  };
  const timeout = setTimeout(() => finish("the main thread could not be paused within " + String(waitMs) + "ms, so it was idle in the event loop or blocked inside a native call"), waitMs);
  try {
    session = new inspector.Session();
    session.connectToMainThread();
    session.on("Debugger.paused", (event) => {
      if (settled) return;
      const frames = event.params.callFrames.slice(0, STACK_FRAMES_LOGGED).map((frame) => (frame.functionName === "" ? "(anonymous)" : frame.functionName) + " " + frame.url + ":" + String(frame.location.lineNumber + 1));
      const text = "the main thread was in " + frames.join(" <- ");
      if (resume) {
        session.post("Debugger.resume", () => finish(text));
      } else {
        finish(text);
      }
    });
    session.post("Debugger.enable", () => {
      // The wait may have run out while the main thread was too stalled to answer the enable; the session is gone then.
      if (!settled) session.post("Debugger.pause");
    });
  } catch (error) {
    finish("the main thread could not be inspected: " + (error instanceof Error ? error.message : String(error)));
  }
});
const spawnReplacement = () => {
  if (respawn === undefined || logFile === undefined) return;
  if (respawnGeneration >= respawnMaxGeneration) {
    log("not starting another replacement: this door was replacement generation " + String(respawnGeneration) + " of " + String(respawnMaxGeneration) + ", so the stall has recurred through consecutive doors and the machine, not the door, is the one refusing to serve; leaving the next launch's ensure to start one");
    return;
  }
  try {
    const out = fs.openSync(logFile, "a");
    const child = require("node:child_process").spawn(respawn.command, respawn.args, { detached: true, stdio: ["ignore", out, out], env: Object.assign({}, respawn.env, { [awaitPidEnv]: String(ownPid), [respawnGenerationEnv]: String(respawnGeneration + 1) }) });
    child.unref();
    fs.closeSync(out);
    log("started replacement door " + String(child.pid) + " of generation " + String(respawnGeneration + 1) + ", which binds once this process is gone");
  } catch (error) {
    log("could not start a replacement door: " + (error instanceof Error ? error.message : String(error)));
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
    stopped = true;
    clearInterval(timer);
    record(message);
    log(message);
    const [oneMinute, fiveMinutes, fifteenMinutes] = os.loadavg();
    log("machine load at the stall: " + oneMinute.toFixed(1) + " (1m), " + fiveMinutes.toFixed(1) + " (5m), " + fifteenMinutes.toFixed(1) + " (15m) across " + String(os.cpus().length) + " cpus");
    spawnReplacement();
    describeMainThread(pauseWaitMs, action !== "kill-process").then((where) => {
      log(where);
      if (action === "kill-process") {
        process.kill(ownPid, "SIGKILL");
      } else {
        parentPort.postMessage({ stalled: true, message });
      }
    });
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
  /** How long the thread waits for the main thread to pause so its frames can be logged before it ends the process anyway (`DOOR_WATCHDOG_CHECK_MS` in production, the same cadence that bounds how late a stall is noticed). */
  readonly pauseWaitMs: number;
  readonly action: StallAction;
  /** The door's log file, which the thread appends the stall to before ending the process. Omitted by a host with no log of its own. */
  readonly logFile?: string;
  /** How many watchdog respawns produced this door (`0` for a door no watchdog started), from `DOOR_RESPAWN_GENERATION_ENV` in production. */
  readonly respawnGeneration: number;
  /** The highest replacement generation this door's watchdog may start (`DOOR_RESPAWN_MAX_GENERATIONS` in production). */
  readonly respawnMaxGeneration: number;
  /** How to start a replacement door on a stall: the invocation and environment of a door, to which the thread adds `DOOR_AWAIT_PID_ENV` and `DOOR_RESPAWN_GENERATION_ENV`. Omitted by a host that does not respawn. */
  readonly respawn?: { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
  /** Called on the main thread with the recorded message when `action` is `report` and the stall was seen. */
  readonly onReport?: (message: string) => void;
}

/** Starts the watchdog thread and returns the supervisor's two handles on it. The thread never keeps the process alive: it is unref'd, and `stop` ends it. */
export function startThreadWatchdog(params: Readonly<ThreadWatchdogParams>): DoorWatchdog {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(shared);
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { shared, boundMs: params.boundMs, checkEveryMs: params.checkEveryMs, pauseWaitMs: params.pauseWaitMs, stateFile: params.stateFile, ownPid: params.ownPid, action: params.action, logFile: params.logFile, respawn: params.respawn, respawnGeneration: params.respawnGeneration, respawnMaxGeneration: params.respawnMaxGeneration, awaitPidEnv: DOOR_AWAIT_PID_ENV, respawnGenerationEnv: DOOR_RESPAWN_GENERATION_ENV },
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
