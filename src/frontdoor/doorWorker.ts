import fs from "node:fs";
import { getAsset, isSea } from "node:sea";
import { Worker } from "node:worker_threads";

import { DOOR_WORKER_CODE_ASSET } from "../../scripts/bundle-options.mts";
import { CliError } from "../cliError";
import { isDoorWorkerMessage, type DoorWorkerData, type DoorWorkerTaskName, type DoorWorkerTasks } from "./doorWorkerProtocol";

/**
 * The front door runs the work that blocks its thread (a report's synchronous probes, a catalogue refresh's credential commands) in a worker thread of its own process, never in its event loop and never in a child process.
 *
 * The worker evaluates the code text the door read when it started (`readDoorWorkerCode`), so an upgrade in place changes nothing about a running door until it restarts: a worker created from a path read again would run the new build beside the old door. It is given one task by name and its input by structured clone, answers once, and ends. Nothing authenticates it by environment variable, descriptor or parent process, because it shares the door's process.
 */

/**
 * The code text a door worker evaluates, read once by the door when it starts: the embedded asset of a single-executable build, otherwise the command line bundle at `bundlePath`. The text is held in memory, so removing or replacing the file afterwards changes nothing.
 */
export function readDoorWorkerCode(bundlePath: string): string {
  return isSea() ? getAsset(DOOR_WORKER_CODE_ASSET, "utf8") : fs.readFileSync(bundlePath, "utf8");
}

/** How many worker threads the door runs at once, each a whole isolate with the bundle loaded in it. */
export const MAX_CONCURRENT_DOOR_WORKERS = 2;

/** How many tasks may wait for a worker beyond those running; a task past it is refused at once. */
export const MAX_QUEUED_DOOR_WORKER_TASKS = 8;

/** The old-generation heap a door worker may grow to, in megabytes: a report of a very large configuration ends in a worker error and not in the door's memory. */
export const DOOR_WORKER_MAX_OLD_GENERATION_MB = 512;

/** How often the watchdog looks at each running worker. */
export const DOOR_WORKER_WATCHDOG_INTERVAL_MS = 1_000;

/** The longest a single blocking step of a report runs without telling the heartbeat anything: the longest synchronous command timeout any report step uses (a Codex version check), doubled for a loaded machine. A report whose heartbeat does not move for this long is stalled. */
export const DOOR_WORKER_STALL_LIMIT_MS = 60_000;

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
export interface DoorWorkerHandle {
  readonly on: ((event: "message", listener: (value: unknown) => void) => unknown) & ((event: "error", listener: (error: Error) => void) => unknown) & ((event: "exit", listener: (code: number) => void) => unknown);
  readonly terminate: () => Promise<number>;
}

/** Starts a worker thread evaluating `code` with `workerData`; the real one is `node:worker_threads`. */
export type DoorWorkerSpawn = (code: string, workerData: DoorWorkerData) => DoorWorkerHandle;

const spawnRealDoorWorker: DoorWorkerSpawn = (code, workerData) =>
  new Worker(code, { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb: DOOR_WORKER_MAX_OLD_GENERATION_MB } });

/** The clock the watchdog runs on, injected so a test drives it. */
export interface DoorWorkerClock {
  readonly now: () => number;
  /** Calls `callback` every `ms` until the returned function is called. */
  readonly every: (callback: () => void, ms: number) => () => void;
}

const realClock: DoorWorkerClock = {
  now: () => Date.now(),
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

/** One task in flight or waiting: its callers share it. */
interface Flight {
  readonly task: DoorWorkerTaskName;
  readonly input: unknown;
  callers: number;
  readonly promise: Promise<unknown>;
  readonly cancel: (reason: string) => void;
}

/** A promise with its settlers, for the gate and the flights. */
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
  const inFlight = new Map<string, Flight>();
  const waiting: { readonly start: () => void; readonly refuse: (reason: string) => void }[] = [];
  const running = new Set<{ readonly cancel: (reason: string) => void }>();
  /** The places taken in the gate: a task holds one from the moment it is admitted until its worker has ended, so two tasks asked in the same turn cannot both pass a full gate. */
  let placesTaken = 0;
  let stopped = false;

  /** Runs one worker to its answer, with its watchdog; releases its place in the gate when it ends. */
  const execute = async (flight: { readonly task: DoorWorkerTaskName; readonly input: unknown }, register: (cancel: (reason: string) => void) => void): Promise<unknown> => {
    const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const beats = new Int32Array(heartbeat);
    const outcome = deferred<unknown>();
    const startedAt = clock.now();
    let lastBeat = Atomics.load(beats, 0);
    let lastBeatAt = startedAt;
    const worker = spawn(options.code, { doorWorker: { task: flight.task, input: flight.input, heartbeat } });
    const entry: { cancel: (reason: string) => void } = { cancel: () => undefined };
    let stopWatchdog: () => void = () => undefined;
    const settle = (apply: () => void): void => {
      stopWatchdog();
      running.delete(entry);
      void worker.terminate();
      apply();
    };
    entry.cancel = (reason) => {
      settle(() => {
        outcome.reject(new DoorWorkerFailedError(flight.task, reason));
      });
    };
    running.add(entry);
    register(entry.cancel);
    stopWatchdog = clock.every(() => {
      const now = clock.now();
      const beat = Atomics.load(beats, 0);
      if (beat !== lastBeat) {
        lastBeat = beat;
        lastBeatAt = now;
      }
      if (now - startedAt > options.deadlineMs[flight.task]) {
        entry.cancel("it outlasted its deadline");
      } else if (now - lastBeatAt > stallLimitMs) {
        entry.cancel("it stalled: nothing in it moved");
      }
    }, DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    worker.on("message", (value) => {
      if (!isDoorWorkerMessage(value)) {
        entry.cancel("it answered with something other than a result");
        return;
      }
      settle(() => {
        if (value.kind === "done") {
          outcome.resolve(value.value);
        } else {
          outcome.reject(new DoorWorkerFailedError(flight.task, `${value.name}: ${value.message}`));
        }
      });
    });
    worker.on("error", (error) => {
      entry.cancel(error.message);
    });
    worker.on("exit", (code) => {
      entry.cancel(`it ended with code ${String(code)} without an answer`);
    });
    return await outcome.promise;
  };

  /** Waits for a place among the running workers, or is refused. */
  const admit = async (task: DoorWorkerTaskName): Promise<void> => {
    if (stopped) {
      throw new DoorWorkerFailedError(task, "the front door is ending");
    }
    if (placesTaken < maxConcurrent && waiting.length === 0) {
      placesTaken += 1;
      return;
    }
    if (waiting.length >= maxQueued) {
      throw new DoorWorkerBusyError(task);
    }
    const place = deferred<undefined>();
    waiting.push({ start: () => { place.resolve(undefined); }, refuse: (reason) => { place.reject(new DoorWorkerFailedError(task, reason)); } });
    await place.promise;
  };

  /** Starts the next waiting task, if a place is free. */
  const drain = (): void => {
    placesTaken -= 1;
    while (placesTaken < maxConcurrent) {
      const next = waiting.shift();
      if (next === undefined) {
        return;
      }
      placesTaken += 1;
      next.start();
    }
  };

  const start = (task: DoorWorkerTaskName, input: unknown): Flight => {
    let cancelWorker: ((reason: string) => void) | undefined;
    let cancelledBeforeStart: string | undefined;
    const promise = (async () => {
      await admit(task);
      try {
        if (cancelledBeforeStart !== undefined) {
          throw new DoorWorkerFailedError(task, cancelledBeforeStart);
        }
        return await execute({ task, input }, (cancel) => {
          cancelWorker = cancel;
        });
      } finally {
        drain();
      }
    })();
    return {
      task,
      input,
      callers: 0,
      promise,
      cancel: (reason) => {
        if (cancelWorker === undefined) {
          cancelledBeforeStart = reason;
        } else {
          cancelWorker(reason);
        }
      },
    };
  };

  return {
    run: async <T extends DoorWorkerTaskName>(task: T, input: InputOf<T>, parse: (value: unknown) => OutputOf<T>, signal?: AbortSignal): Promise<OutputOf<T>> => {
      const key = JSON.stringify([task, input]);
      let flight = inFlight.get(key);
      if (flight === undefined) {
        const created = start(task, input);
        flight = created;
        inFlight.set(key, created);
        void created.promise.then(
          () => { inFlight.delete(key); },
          () => { inFlight.delete(key); },
        );
      }
      const shared = flight;
      shared.callers += 1;
      const released = deferred<never>();
      const onAbort = (): void => {
        shared.callers -= 1;
        if (shared.callers === 0) {
          shared.cancel("it was cancelled");
        }
        released.reject(new DoorWorkerFailedError(task, "it was cancelled"));
      };
      if (signal?.aborted === true) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
      try {
        return parse(await Promise.race([shared.promise, released.promise]));
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    stop: () => {
      stopped = true;
      for (const refuse of waiting.splice(0)) {
        refuse.refuse("the front door is ending");
      }
      for (const entry of [...running]) {
        entry.cancel("the front door is ending");
      }
    },
  };
}
