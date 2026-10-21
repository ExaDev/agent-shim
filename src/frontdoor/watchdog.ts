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

/** The environment variable naming how long a respawned door waits, after the stalled door has released the sticky ports, before it binds: the cooldown the watchdog gives a chain of replacements that keeps stalling. Read once at startup, like the generation. */
export const DOOR_RESPAWN_DELAY_ENV = "AGENT_SHIM_FRONTDOOR_RESPAWN_DELAY_MS";

/**
 * The highest replacement generation the watchdog starts at once. Every stall gets a replacement, because a young door killed by a stall the machine caused (observed in production: an overloaded host stalling the loop before the door had served a minute) left every live session with connection refused until some later launch happened to start a door. What must not happen is an endless chain of doors each killed at once, so a replacement past this generation waits a growing cooldown before it binds (see `respawnDelayMs`): the chain never ends with no door and nobody to start one, and it never spins faster than the machine can serve.
 */
export const DOOR_RESPAWN_MAX_GENERATIONS = 3;

/** The longest cooldown a replacement waits: the time the immediate generations together allow a stalled door, so a chain that keeps stalling is retried at that pace and no slower. */
export const DOOR_RESPAWN_COOLDOWN_CAP_MS = DOOR_STALL_BOUND_MS * DOOR_RESPAWN_MAX_GENERATIONS;

/**
 * How long a replacement of `generation` waits before it binds: nothing up to `DOOR_RESPAWN_MAX_GENERATIONS`, then one stall bound more for each generation past it, up to `DOOR_RESPAWN_COOLDOWN_CAP_MS`. The step is the stall bound because that is how long a door that cannot serve takes to be noticed, so a cooldown shorter than it would let the next door stall before the machine had any quiet.
 */
export function respawnDelayMs(generation: number): number {
  return Math.min(Math.max(0, generation - DOOR_RESPAWN_MAX_GENERATIONS) * DOOR_STALL_BOUND_MS, DOOR_RESPAWN_COOLDOWN_CAP_MS);
}

/** How many times the thread looks at the beat counter within one probe deadline, so a stall is noticed within a small fraction of the bound. */
const CHECKS_PER_PROBE_DEADLINE = 2;

/** How often the watchdog thread looks at the beat counter. */
export const DOOR_WATCHDOG_CHECK_MS = PROBE_TIMEOUT_MS / CHECKS_PER_PROBE_DEADLINE;

/** What the supervisor holds: a stop for when it begins to retire. The beat that tells the watchdog the main event loop ran comes from the watchdog's own timer on that loop (see `startThreadWatchdog`), not from the supervisor's tick, so nothing a tick awaits (a `ps` run a loaded machine is slow to finish) is taken for a loop that did not run. */
export interface DoorWatchdog {
  /** Ends the watchdog before the door begins an orderly retirement, so a slow close is never taken for a stall. Idempotent. */
  readonly stop: () => void;
}

/** A fixed reading of the machine's load in place of the real one (`os.loadavg()` and `os.cpus()`), for a host whose judgement must not depend on the machine it runs on: the tests, which would otherwise see a loaded machine's starvation as a reason not to report. */
export interface MachineLoadReading {
  readonly loadAverage: number;
  readonly cpus: number;
}

/** What the thread does when the counter has not moved for the bound: end the process (production) or only report to its parent (tests, which must not kill the test run). */
type StallAction = "kill-process" | "report";

/**
 * The watchdog thread: its own event loop, which a blocked main loop cannot stall. It compares a shared beat counter (moved by a timer on the main loop) against its previous reading on a fixed cadence, and counts the time the counter stays still at the share of a processor the machine's load leaves a runnable thread (all of one while the one-minute load average is within the processor count, the processor count over the load average beyond it): a main loop the machine did not schedule has not had the time to run, and replacing the door would only drop every in-flight request into a door just as starved. When that counted time reaches `boundMs` it records the stall in the state file (the existing `lastError` field, so no reader of the file sees a new key) and in the door's log (the next generation's first state write replaces `lastError`, and a SIGKILL runs no handler, so the log line is the only record that outlives the replacement), logs the machine's load and where the main thread was (see `describeMainThread`, so a stall that was the door's own code is told apart from one the machine caused), starts a replacement door (as long as this door's own generation has not reached the respawn ceiling, so a stall that recurs through consecutive doors ends the chain rather than looping) and ends the process. A thread that was itself descheduled for longer than its cadence (the machine was suspended or starved) restarts its clock instead of judging, since the main loop stalled by the same pause is not a hung one.
 */
const WATCHDOG_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const inspector = require("node:inspector");
const { shared, boundMs, checkEveryMs, pauseWaitMs, stateFile, ownPid, action, logFile, respawn, respawnGeneration, respawnMaxGeneration, cooldownStepMs, cooldownCapMs, startLockFile, awaitPidEnv, respawnGenerationEnv, delayEnv, nativeSample, machineLoad } = workerData;
const counter = new Int32Array(shared);
let lastValue = Atomics.load(counter, 0);
let lastChangeAt = Date.now();
let lastCheckAt = Date.now();
// The processor time the machine's load left the main thread since the counter last moved: what the bound is judged against.
let scheduledMs = 0;
// Set once a silence has outlasted the bound in wall time while the counted time has not, so the wait is logged once and its end is logged too.
let waitingOutStarvation = false;
let stopped = false;
const readLoad = () => machineLoad === undefined ? { loadAverage: os.loadavg()[0], cpus: os.cpus().length } : machineLoad;
const processorShare = (reading) => reading.loadAverage <= reading.cpus ? 1 : reading.cpus / reading.loadAverage;
const describeLoad = (reading) => reading.loadAverage.toFixed(1) + " across " + String(reading.cpus) + " cpus";
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
const MS_PER_SECOND = 1000;
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
// Whether a process is alive: signal 0 only tests, and EPERM means it exists under another user.
const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
// The pid holding the start lock when that holder is alive, which means a door is already being started and another must not be: the launcher's ensure and this respawn are the two things that start a door, and the lock is the one protocol that keeps them from starting two. A dead holder's lock is litter and is cleared, exactly as the launcher's ensure clears it.
const liveLockHolder = () => {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(startLockFile, "utf8")).pid;
  } catch (error) {
    return undefined;
  }
  if (typeof holder === "number" && isRunning(holder)) return holder;
  fs.rmSync(startLockFile, { force: true });
  return undefined;
};
// Creates the lock naming the replacement as its holder, atomically (the wx flag), so the launcher's ensure sees a live holder while the replacement boots and waits for it instead of starting a door of its own; the replacement removes the lock once it is serving, as every door does.
const claimStartLock = (holder) => {
  try {
    fs.writeFileSync(startLockFile, JSON.stringify({ pid: holder, at: Date.now() }) + "\\n", { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
};
const spawnReplacement = () => {
  if (respawn === undefined || logFile === undefined) return;
  const nextGeneration = respawnGeneration + 1;
  const cooldownMs = Math.min(Math.max(0, nextGeneration - respawnMaxGeneration) * cooldownStepMs, cooldownCapMs);
  const startingBy = liveLockHolder();
  if (startingBy !== undefined) {
    log("not starting a replacement: process " + String(startingBy) + " holds the start lock, so a door is already being started and a second one would race it for the sticky ports");
    return;
  }
  try {
    const out = fs.openSync(logFile, "a");
    const child = require("node:child_process").spawn(respawn.command, respawn.args, { detached: true, stdio: ["ignore", out, out], env: Object.assign({}, respawn.env, { [awaitPidEnv]: String(ownPid), [respawnGenerationEnv]: String(nextGeneration), [delayEnv]: String(cooldownMs) }) });
    child.unref();
    fs.closeSync(out);
    if (!claimStartLock(child.pid)) {
      // A launcher took the lock between the check and the spawn, so its door is the one that is starting: this one must not also bind.
      process.kill(child.pid, "SIGKILL");
      log("withdrew replacement door " + String(child.pid) + ": a launcher took the start lock first and its door is the one starting");
      return;
    }
    log("started replacement door " + String(child.pid) + " of generation " + String(nextGeneration) + ", which binds once this process is gone" + (cooldownMs > 0 ? " and a " + String(cooldownMs) + "ms cooldown has passed, since the stall has recurred through " + String(respawnMaxGeneration) + " consecutive replacements" : ""));
  } catch (error) {
    log("could not start a replacement door: " + (error instanceof Error ? error.message : String(error)));
  }
};
// Captures where a main thread that could not be paused is held natively, with the platform's own sampler, so a stall the inspector cannot name still leaves a stack to read. The wait is the sampling time plus the sampler's start-up and symbolication, stretched by the processor share the machine's load leaves it, and the capture never delays the process ending beyond that. The sampler writes its report only once it has finished, so one ended at the deadline, or one that failed, leaves no file, and the log says which rather than naming a file that is not there.
const takeNativeSample = () => new Promise((resolve) => {
  if (nativeSample === undefined) { resolve(); return; }
  try {
    fs.mkdirSync(nativeSample.directory, { recursive: true });
    const file = require("node:path").join(nativeSample.directory, String(ownPid) + ".txt");
    const args = nativeSample.args.map((arg) => arg.replace("{pid}", String(ownPid)).replace("{seconds}", String(nativeSample.seconds)).replace("{file}", file));
    const child = require("node:child_process").spawn(nativeSample.command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const settle = (line) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      log(line);
      resolve();
    };
    const deadlineMs = Math.ceil((nativeSample.seconds * MS_PER_SECOND + nativeSample.overheadMs) / processorShare(readLoad()));
    const giveUp = setTimeout(() => { child.kill(); settle("the native sampler did not finish within " + String(deadlineMs) + "ms, so no native stack was written"); }, deadlineMs);
    child.once("error", (error) => { settle("could not sample the main thread natively: " + error.message); });
    child.once("close", (code, signal) => {
      if (code !== 0 || !fs.existsSync(file)) {
        const detail = stderr.trim();
        settle("the native sampler " + (signal === null ? "exited with status " + String(code) : "was ended by " + signal) + " and wrote no native stack" + (detail === "" ? "" : ": " + detail));
        return;
      }
      const kept = fs.readdirSync(nativeSample.directory).filter((name) => name.endsWith(".txt")).map((name) => ({ name, at: fs.statSync(require("node:path").join(nativeSample.directory, name)).mtimeMs })).sort((a, b) => b.at - a.at);
      for (const old of kept.slice(nativeSample.keep)) fs.rmSync(require("node:path").join(nativeSample.directory, old.name), { force: true });
      settle("native stack of the blocked main thread written to " + file);
    });
  } catch (error) {
    log("could not sample the main thread natively: " + (error instanceof Error ? error.message : String(error)));
    resolve();
  }
});
const timer = setInterval(() => {
  if (stopped) return;
  const now = Date.now();
  const sinceLastCheck = now - lastCheckAt;
  lastCheckAt = now;
  const value = Atomics.load(counter, 0);
  if (value !== lastValue || sinceLastCheck > checkEveryMs * 2) {
    if (waitingOutStarvation && value !== lastValue) log("the front door's event loop ran again after " + String(now - lastChangeAt) + "ms; the machine's load had starved it, so the watchdog kept the door");
    waitingOutStarvation = false;
    lastValue = value;
    lastChangeAt = now;
    scheduledMs = 0;
    return;
  }
  const reading = readLoad();
  scheduledMs += sinceLastCheck * processorShare(reading);
  const silentMs = now - lastChangeAt;
  if (scheduledMs < boundMs) {
    if (silentMs >= boundMs && !waitingOutStarvation) {
      waitingOutStarvation = true;
      log("the front door's event loop has not run for " + String(silentMs) + "ms, but the machine's load (" + describeLoad(reading) + ") left it only " + String(Math.round(scheduledMs)) + "ms of processor time, so the watchdog waits until it has had " + String(boundMs) + "ms rather than replacing a door the machine did not schedule");
    }
    return;
  }
  const message = "the front door's event loop did not run for " + String(silentMs) + "ms, " + String(Math.round(scheduledMs)) + "ms of it with a processor to run on; its watchdog ended the process so the next launch starts a fresh door on the same ports";
  stopped = true;
  clearInterval(timer);
  record(message);
  log(message);
  const [oneMinute, fiveMinutes, fifteenMinutes] = os.loadavg();
  log("machine load at the stall: " + oneMinute.toFixed(1) + " (1m), " + fiveMinutes.toFixed(1) + " (5m), " + fifteenMinutes.toFixed(1) + " (15m) across " + String(os.cpus().length) + " cpus");
  spawnReplacement();
  describeMainThread(pauseWaitMs, action !== "kill-process").then(async (where) => {
    log(where);
    if (where.startsWith("the main thread could not be paused")) await takeNativeSample();
    if (action === "kill-process") {
      process.kill(ownPid, "SIGKILL");
    } else {
      parentPort.postMessage({ stalled: true, message });
    }
  });
}, checkEveryMs);
parentPort.on("message", (message) => {
  if (message === "stop") {
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  }
});
`;

/** What `startThreadWatchdog` needs: where the state file is, which process to end, and the two derived time constants (parameters so a test can use small ones). `checkEveryMs` is also the cadence of the main loop's beat. */
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
  /** The highest replacement generation this door's watchdog starts with no cooldown (`DOOR_RESPAWN_MAX_GENERATIONS` in production); each generation past it waits `cooldownStepMs` longer, up to `cooldownCapMs`. */
  readonly respawnMaxGeneration: number;
  /** How much longer each generation past `respawnMaxGeneration` waits before it binds (`DOOR_STALL_BOUND_MS` in production). */
  readonly cooldownStepMs: number;
  /** The longest cooldown (`DOOR_RESPAWN_COOLDOWN_CAP_MS` in production). */
  readonly cooldownCapMs: number;
  /** The start lock a launcher's ensure takes before it spawns a door and the door removes once it is serving: the respawn takes the same lock, naming the replacement as holder, so a launch that finds the stalled door's pid dead waits for the replacement instead of starting a second door that would find the sticky ports held and move off them. */
  readonly startLockFile: string;
  /** How to start a replacement door on a stall: the invocation and environment of a door, to which the thread adds `DOOR_AWAIT_PID_ENV` and `DOOR_RESPAWN_GENERATION_ENV`. Omitted by a host that does not respawn. */
  readonly respawn?: { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
  /**
   * How to capture the native stack of a main thread the inspector could not pause (it was blocked inside a native call, which no JavaScript frame names): a command run with `{pid}`, `{seconds}` and `{file}` replaced in its arguments, its output written to `directory` as `<pid>.txt`, keeping the newest `keep` files. It is given `seconds` plus `overheadMs` (one probe deadline, `PROBE_TIMEOUT_MS`, in production: the time a launcher allows the door itself to answer, spent here on the sampler's start-up and symbolication), stretched by the processor share the machine's load leaves it, before it is ended with nothing written. Omitted where the platform has no such tool (production sets it on macOS only).
   */
  readonly nativeSample?: { readonly command: string; readonly args: readonly string[]; readonly directory: string; readonly seconds: number; readonly overheadMs: number; readonly keep: number };
  /** A fixed load reading in place of the machine's own; omitted in production, where the thread reads the machine each check. */
  readonly machineLoad?: MachineLoadReading;
  /** Called on the main thread with the recorded message when `action` is `report` and the stall was seen. */
  readonly onReport?: (message: string) => void;
}

/** Starts the watchdog thread and the main loop's beat, and returns the supervisor's handle on them. The beat is a timer on the calling thread's event loop, so it moves exactly when that loop runs, whatever the code the loop serves is waiting on. Neither keeps the process alive: both are unref'd, and `stop` ends both. */
export function startThreadWatchdog(params: Readonly<ThreadWatchdogParams>): DoorWatchdog {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(shared);
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { shared, boundMs: params.boundMs, checkEveryMs: params.checkEveryMs, pauseWaitMs: params.pauseWaitMs, stateFile: params.stateFile, ownPid: params.ownPid, action: params.action, logFile: params.logFile, respawn: params.respawn, respawnGeneration: params.respawnGeneration, respawnMaxGeneration: params.respawnMaxGeneration, cooldownStepMs: params.cooldownStepMs, cooldownCapMs: params.cooldownCapMs, startLockFile: params.startLockFile, awaitPidEnv: DOOR_AWAIT_PID_ENV, respawnGenerationEnv: DOOR_RESPAWN_GENERATION_ENV, delayEnv: DOOR_RESPAWN_DELAY_ENV, nativeSample: params.nativeSample, machineLoad: params.machineLoad },
  });
  worker.unref();
  const beat = setInterval(() => {
    Atomics.add(counter, 0, 1);
  }, params.checkEveryMs);
  beat.unref();
  worker.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "message" in message && typeof message.message === "string") {
      params.onReport?.(message.message);
    }
  });
  let stopped = false;
  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(beat);
      worker.postMessage("stop");
      void worker.terminate();
    },
  };
}
