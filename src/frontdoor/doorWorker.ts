import fs from "node:fs";
import { getAsset, isSea } from "node:sea";
import { Worker } from "node:worker_threads";

import { DOOR_WORKER_CODE_ASSET } from "../../scripts/bundle-options.mts";
import { CliError } from "../cliError";
import { CATALOGUE_REFRESH_TIMEOUT_MS } from "../providerCatalogue";
import { isDoorWorkerMessage, type DoorWorkerData, type DoorWorkerTaskName, type DoorWorkerTasks } from "./doorWorkerProtocol";

/**
 * The front door runs the work that blocks its thread (a report's synchronous probes, a catalogue refresh's credential commands) in a worker thread of its own process, never in its event loop and never in a child process.
 *
 * The worker evaluates the code text the door read when it started (`readDoorWorkerCode`), so an upgrade in place changes nothing about a running door until it restarts: a worker created from a path read again would run the new build beside the old door. It is given one task by name and its input by structured clone, answers once, and ends. Nothing authenticates it by environment variable, descriptor or parent process, because it shares the door's process.
 */

/**
 * The code text a door worker evaluates, read once by the door when it starts: the embedded asset of a single-executable build, otherwise the command line bundle at `bundlePath`. The text is held in memory, so removing or replacing the file afterwards changes nothing.
 */
function readDoorWorkerCode(bundlePath: string): string {
  return isSea() ? getAsset(DOOR_WORKER_CODE_ASSET, "utf8") : fs.readFileSync(bundlePath, "utf8");
}

/** The longest a check or doctor report runs in a worker: five minutes, the longest a person or a tool waits on one. */
const DOOR_REPORT_DEADLINE_MS = 300_000;

/** How many worker threads the door runs at once, each a whole isolate with the bundle loaded in it. */
const MAX_CONCURRENT_DOOR_WORKERS = 2;

/** How many tasks may wait for a worker beyond those running; a task past it is refused at once. */
const MAX_QUEUED_DOOR_WORKER_TASKS = 8;

/** The old-generation heap a door worker may grow to, in megabytes: a report of a very large configuration ends in a worker error and not in the door's memory. */
const DOOR_WORKER_MAX_OLD_GENERATION_MB = 512;

/** The longest a report or a catalogue refresh runs in a worker in all, whatever its heartbeat says: a report of a configuration with many providers probes each one's connect bound, and a catalogue refresh is bounded by its own timeout. */
const DOOR_WORKER_DEADLINES: Readonly<Record<DoorWorkerTaskName, number>> = {
  check: DOOR_REPORT_DEADLINE_MS,
  doctor: DOOR_REPORT_DEADLINE_MS,
  "refresh-catalogue": CATALOGUE_REFRESH_TIMEOUT_MS,
};

/** How often the watchdog looks at each running worker. */
export const DOOR_WORKER_WATCHDOG_INTERVAL_MS = 1_000;

/** The longest a single blocking step of a report runs without telling the heartbeat anything: the longest synchronous command timeout any report step uses (a Codex version check), doubled for a loaded machine. A report whose heartbeat does not move for this long is stalled. */
const DOOR_WORKER_STALL_LIMIT_MS = 60_000;

/** The input the host takes for a task, as `DoorWorkerTasks` declares it. */
type InputOf<T extends DoorWorkerTaskName> = DoorWorkerTasks[T]["input"];
/** The output a task answers with. */
type OutputOf<T extends DoorWorkerTaskName> = DoorWorkerTasks[T]["output"];

/** Raised when a task cannot be run: the door's workers are all busy and its queue is full. */
export class DoorWorkerBusyError extends CliError {
  constructor(task: DoorWorkerTaskName) {
    super(`the front door is busy with other work; ${task} was not started, try again shortly`);
    this.name = "DoorWorkerBusyError";
  }
}

/** Raised when a task's worker ended without an answer, or was stopped by the watchdog, the caller or the door. */
export class DoorWorkerFailedError extends CliError {
  constructor(task: DoorWorkerTaskName, reason: string) {
    super(`${task} failed in its worker: ${reason}`);
    this.name = "DoorWorkerFailedError";
  }
}

/** The part of a worker thread the host uses, so a test can stand a fake in. */
interface DoorWorkerHandle {
  readonly on: ((event: "message", listener: (value: unknown) => void) => unknown) & ((event: "error", listener: (error: Error) => void) => unknown) & ((event: "exit", listener: (code: number) => void) => unknown);
  readonly terminate: () => Promise<number>;
}

/** Starts a worker thread evaluating `code` with `workerData`; the real one is `node:worker_threads`. */
export type DoorWorkerSpawn = (code: string, workerData: DoorWorkerData) => DoorWorkerHandle;

const spawnRealDoorWorker: DoorWorkerSpawn = (code, workerData) =>
  new Worker(code, { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb: DOOR_WORKER_MAX_OLD_GENERATION_MB } });

/** The clock the watchdog runs on, injected so a test drives it. The real one is monotonic (`performance.now`), so a wall clock step cannot fire a deadline or a stall limit early. */
export interface DoorWorkerClock {
  readonly now: () => number;
  /** Calls `callback` every `ms` until the returned function is called. */
  readonly every: (callback: () => void, ms: number) => () => void;
}

const realClock: DoorWorkerClock = {
  now: () => performance.now(),
  every: (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  },
};

/** What the host takes: the code its workers run, and the seams a test replaces. */
export interface DoorWorkerHostOptions {
  readonly code: string;
  readonly spawn?: DoorWorkerSpawn;
  readonly clock?: DoorWorkerClock;
  /** How long a worker's heartbeat may stand still before the watchdog stops it. */
  readonly stallLimitMs?: number;
  /** The longest a task of each kind may run in all, whatever its heartbeat says. */
  readonly deadlineMs: Readonly<Record<DoorWorkerTaskName, number>>;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
}

/** Runs the door's worker tasks. */
export interface DoorWorkerHost {
  /**
   * Runs `task` with `input` in a worker and resolves to its output as `parse` reads it (a schema's parse, so a worker's answer is validated at the boundary, not trusted). A request equal to one in flight shares its worker and its answer. When `signal` aborts, this caller's promise rejects, and the worker is terminated once no caller is left waiting on it. Rejects with `DoorWorkerBusyError` when every worker is busy and the queue is full, and with `DoorWorkerFailedError` when the worker fails, stalls, outlasts its deadline or is stopped.
   */
  readonly run: <T extends DoorWorkerTaskName>(task: T, input: InputOf<T>, parse: (value: unknown) => OutputOf<T>, signal?: AbortSignal) => Promise<OutputOf<T>>;
  /** Terminates every running worker and refuses the queued tasks: the door is ending. */
  readonly stop: () => void;
}

/** Where a flight is in its life: waiting for a place, holding one (a worker is starting or running), or over. */
type FlightState = "queued" | "running" | "ended";

/** One task in flight or waiting: its callers share it. */
interface Flight {
  readonly key: string;
  readonly task: DoorWorkerTaskName;
  readonly input: unknown;
  readonly outcome: { readonly promise: Promise<unknown>; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void };
  callers: number;
  state: FlightState;
  /** Ends the flight with `reason` for every caller and stops its worker, if it has one. */
  cancel: (reason: string) => void;
}

/** A promise with its settlers, for the flights. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  return { promise, resolve, reject };
}

/** Creates the host the door runs its worker tasks through. */
export function createDoorWorkerHost(options: Readonly<DoorWorkerHostOptions>): DoorWorkerHost {
  const spawn = options.spawn ?? spawnRealDoorWorker;
  const clock = options.clock ?? realClock;
  const stallLimitMs = options.stallLimitMs ?? DOOR_WORKER_STALL_LIMIT_MS;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_DOOR_WORKERS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED_DOOR_WORKER_TASKS;
  /** The flights not yet over, by request: an equal request joins one of these. */
  const inFlight = new Map<string, Flight>();
  /** The flights waiting for a place, oldest first. */
  const queue: Flight[] = [];
  /** The places in use: one for each live thread, from the moment its flight is given the place until the thread has ended (`terminate` settled or its `exit` seen), so a worker stuck in a blocking call keeps its place and the live threads never exceed `maxConcurrent`. */
  let places = 0;
  let stopped = false;

  /** Takes the flight out of the books, whatever state it is in; true when it was not already over. */
  const close = (flight: Flight): boolean => {
    if (flight.state === "ended") {
      return false;
    }
    if (flight.state === "queued") {
      const at = queue.indexOf(flight);
      if (at !== -1) {
        queue.splice(at, 1);
      }
    }
    flight.state = "ended";
    // A request equal to this one that came after it ended has started a flight of its own under the same key.
    if (inFlight.get(flight.key) === flight) {
      inFlight.delete(flight.key);
    }
    return true;
  };

  /** Starts the worker of a flight that holds a place; assigned below, since starting a worker and handing out places call each other. */
  const starter: { launch: (flight: Flight) => void } = { launch: () => undefined };

  /** Hands free places to the flights waiting for them. */
  const drain = (): void => {
    while (places < maxConcurrent) {
      const next = queue.shift();
      if (next === undefined) {
        return;
      }
      places += 1;
      next.state = "running";
      starter.launch(next);
    }
  };

  /** Gives the place its flight held back, once the thread that held it has ended. */
  const releasePlace = (): void => {
    places -= 1;
    drain();
  };

  /** Starts the worker of a flight that holds a place, with its watchdog; the place goes back when the thread has ended. */
  const launch = (flight: Flight): void => {
    if (stopped || flight.state === "ended") {
      // Nothing was spawned: the door is ending, or the flight was cancelled between being given the place and this turn.
      close(flight);
      flight.outcome.reject(new DoorWorkerFailedError(flight.task, stopped ? "the front door is ending" : "it was cancelled"));
      releasePlace();
      return;
    }
    const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const beats = new Int32Array(heartbeat);
    const startedAt = clock.now();
    let lastBeat = Atomics.load(beats, 0);
    let lastBeatAt = startedAt;
    const worker = spawn(options.code, { doorWorker: { task: flight.task, input: flight.input, heartbeat } });
    let stopWatchdog: () => void = () => undefined;
    let threadEnded = false;
    let terminating = false;
    const threadHasEnded = (): void => {
      if (!threadEnded) {
        threadEnded = true;
        releasePlace();
      }
    };
    /** Ends the thread, once: the place is released when `terminate` settles or the thread's `exit` arrives, whichever is first. */
    const terminate = (): void => {
      stopWatchdog();
      if (terminating) {
        return;
      }
      terminating = true;
      worker.terminate().then(threadHasEnded, threadHasEnded);
    };
    const finish = (apply: () => void): void => {
      if (close(flight)) {
        apply();
      }
      terminate();
    };
    flight.cancel = (reason) => {
      finish(() => {
        flight.outcome.reject(new DoorWorkerFailedError(flight.task, reason));
      });
    };
    stopWatchdog = clock.every(() => {
      const now = clock.now();
      const beat = Atomics.load(beats, 0);
      if (beat !== lastBeat) {
        lastBeat = beat;
        lastBeatAt = now;
      }
      if (now - startedAt > options.deadlineMs[flight.task]) {
        flight.cancel("it outlasted its deadline");
      } else if (now - lastBeatAt > stallLimitMs) {
        flight.cancel("it stalled: nothing in it moved");
      }
    }, DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    worker.on("message", (value) => {
      if (!isDoorWorkerMessage(value)) {
        flight.cancel("it answered with something other than a result");
        return;
      }
      finish(() => {
        if (value.kind === "done") {
          flight.outcome.resolve(value.value);
        } else {
          flight.outcome.reject(new DoorWorkerFailedError(flight.task, `${value.name}: ${value.message}`));
        }
      });
    });
    worker.on("error", (error) => {
      flight.cancel(error.message);
    });
    worker.on("exit", (code) => {
      flight.cancel(`it ended with code ${String(code)} without an answer`);
      threadHasEnded();
    });
  };

  starter.launch = launch;

  /** Creates the flight for a request and gives it a place, or queues it, or refuses it when the queue is full. */
  const begin = (key: string, task: DoorWorkerTaskName, input: unknown): Flight => {
    if (stopped) {
      throw new DoorWorkerFailedError(task, "the front door is ending");
    }
    const flight: Flight = {
      key,
      task,
      input,
      outcome: deferred<unknown>(),
      callers: 0,
      state: "queued",
      cancel: (reason) => {
        // Before it has a worker: it leaves the books at once, freeing its place in the queue.
        if (close(flight)) {
          flight.outcome.reject(new DoorWorkerFailedError(task, reason));
        }
      },
    };
    if (places < maxConcurrent && queue.length === 0) {
      places += 1;
      flight.state = "running";
      // The worker starts a turn later, so a door told to stop in the turn it was asked never spawns one.
      queueMicrotask(() => {
        launch(flight);
      });
    } else if (queue.length >= maxQueued) {
      throw new DoorWorkerBusyError(task);
    } else {
      queue.push(flight);
    }
    inFlight.set(key, flight);
    // The outcome of a flight nobody is waiting on any more is not an unhandled rejection.
    flight.outcome.promise.catch(() => undefined);
    return flight;
  };

  return {
    run: async <T extends DoorWorkerTaskName>(task: T, input: InputOf<T>, parse: (value: unknown) => OutputOf<T>, signal?: AbortSignal): Promise<OutputOf<T>> => {
      if (signal?.aborted === true) {
        throw new DoorWorkerFailedError(task, "it was cancelled");
      }
      const key = JSON.stringify([task, input]);
      const flight = inFlight.get(key) ?? begin(key, task, input);
      flight.callers += 1;
      const released = deferred<never>();
      released.promise.catch(() => undefined);
      const onAbort = (): void => {
        flight.callers -= 1;
        if (flight.callers === 0) {
          flight.cancel("it was cancelled");
        }
        released.reject(new DoorWorkerFailedError(task, "it was cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return parse(await Promise.race([flight.outcome.promise, released.promise]));
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    stop: () => {
      stopped = true;
      for (const flight of [...inFlight.values()]) {
        flight.cancel("the front door is ending");
      }
    },
  };
}

/** The host a real front door runs its worker tasks through: the code text is read now, once, from the embedded asset or the bundle at `bundlePath`, and every task has its deadline. */
export function createRealDoorWorkerHost(bundlePath: string): DoorWorkerHost {
  return createDoorWorkerHost({ code: readDoorWorkerCode(bundlePath), deadlineMs: DOOR_WORKER_DEADLINES });
}
