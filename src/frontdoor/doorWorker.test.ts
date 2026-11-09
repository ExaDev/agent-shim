import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DOOR_WORKER_WATCHDOG_INTERVAL_MS, DoorWorkerBusyError, DoorWorkerFailedError, createDoorWorkerHost, type DoorWorkerClock, type DoorWorkerSpawn } from "./doorWorker";
import type { DoorWorkerData } from "./doorWorkerProtocol";

/** A worker that runs nothing: the test answers, fails or stalls it by hand. */
class FakeWorker extends EventEmitter {
  public terminations = 0;
  /** Whether the thread has ended: set when `exit` has been emitted. */
  public ended = false;
  /** Holds `terminate` unresolved until `release`: a thread stuck in a blocking call, which a real `terminate` waits for. */
  private releaseTermination: (() => void) | undefined;
  public constructor(public readonly data: DoorWorkerData, private readonly stuck = false) {
    super();
  }
  public async terminate(): Promise<number> {
    this.terminations += 1;
    if (this.stuck) {
      await new Promise<void>((resolve) => {
        this.releaseTermination = resolve;
      });
    }
    // A real worker emits `exit` when it has stopped, then `terminate` resolves.
    this.end();
    return 0;
  }
  /** The thread ends of its own accord, or after being told to. */
  public end(): void {
    if (!this.ended) {
      this.ended = true;
      this.emit("exit", 1);
    }
  }
  /** Lets a stuck thread's termination finish. */
  public release(): void {
    this.releaseTermination?.();
  }
  public answer(value: unknown): void {
    this.emit("message", { kind: "done", value });
  }
  public beat(): void {
    Atomics.add(new Int32Array(this.data.doorWorker.heartbeat), 0, 1);
  }
}

/** A clock the test advances; the watchdog runs when it does. */
function manualClock(): DoorWorkerClock & { readonly advance: (ms: number) => void } {
  let now = 0;
  const callbacks: { readonly callback: () => void; readonly ms: number; active: boolean }[] = [];
  return {
    now: () => now,
    every: (callback, ms) => {
      const entry = { callback, ms, active: true };
      callbacks.push(entry);
      return () => {
        entry.active = false;
      };
    },
    advance: (ms) => {
      const step = Math.min(ms, DOOR_WORKER_WATCHDOG_INTERVAL_MS);
      for (let moved = 0; moved < ms; moved += step) {
        now += step;
        for (const entry of callbacks) {
          if (entry.active) {
            entry.callback();
          }
        }
      }
    },
  };
}

const DEADLINES = { check: 100_000, doctor: 100_000, "refresh-catalogue": 100_000 } as const;
const STALL_MS = 10_000;
const identity = (value: unknown): never => value as never;

/** A host over fake workers, with the ones it started listed in order. */
function hostOver(options: { readonly maxConcurrent?: number; readonly maxQueued?: number; readonly stuck?: boolean } = {}) {
  const started: FakeWorker[] = [];
  const spawn: DoorWorkerSpawn = (_code, data) => {
    const worker = new FakeWorker(data, options.stuck);
    started.push(worker);
    return worker;
  };
  const clock = manualClock();
  const host = createDoorWorkerHost({ code: "code", spawn, clock, stallLimitMs: STALL_MS, deadlineMs: DEADLINES, ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }), ...(options.maxQueued === undefined ? {} : { maxQueued: options.maxQueued }) });
  return { host, started, clock };
}

/** Lets queued promise continuations run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("the door worker host", () => {
  it("starts a worker with the code, the task and its input, and resolves to its answer", async () => {
    const { host, started } = hostOver();
    const result = host.run("doctor", { root: "/r" }, identity);
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]?.data.doorWorker).toMatchObject({ task: "doctor", input: { root: "/r" } });
    started[0]?.answer({ ok: true, findings: [] });
    await expect(result).resolves.toEqual({ ok: true, findings: [] });
    expect(started[0]?.terminations).toBe(1);
  });

  it("gives equal requests in flight one worker and one answer", async () => {
    const { host, started } = hostOver();
    const first = host.run("doctor", { root: "/r" }, identity);
    const second = host.run("doctor", { root: "/r" }, identity);
    await settle();
    expect(started).toHaveLength(1);
    started[0]?.answer({ ok: true, findings: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, findings: [] }, { ok: true, findings: [] }]);
  });

  it("runs at most the bound at once, queues the next, and refuses a task when the queue is full", async () => {
    const { host, started } = hostOver({ maxConcurrent: 1, maxQueued: 1 });
    const first = host.run("doctor", { root: "/a" }, identity);
    const queued = host.run("doctor", { root: "/b" }, identity);
    const refused = host.run("doctor", { root: "/c" }, identity);
    await expect(refused).rejects.toBeInstanceOf(DoorWorkerBusyError);
    await settle();
    expect(started).toHaveLength(1);
    started[0]?.answer("one");
    await first;
    await settle();
    expect(started).toHaveLength(2);
    started[1]?.answer("two");
    await expect(queued).resolves.toBe("two");
  });

  it("terminates a worker that fails, whose error names the task, the error class and a next step, and one that ends with no answer", async () => {
    const { host, started } = hostOver();
    const failed = host.run("check", { root: "/r", path: "/p" }, identity);
    await settle();
    started[0]?.emit("message", { kind: "failed", name: "TypeError", code: "ENOENT" });
    await expect(failed).rejects.toThrow("check failed in its worker: it ended with TypeError (ENOENT); run `agent-shim check` from a shell for the detail");
    const ended = host.run("doctor", { root: "/r" }, identity);
    await settle();
    started[1]?.emit("exit", 1);
    await expect(ended).rejects.toBeInstanceOf(DoorWorkerFailedError);
    expect(started.map((worker) => worker.terminations)).toEqual([1, 1]);
  });

  it("stops a worker whose heartbeat stands still past the stall limit, and keeps one that beats", async () => {
    const { host, started, clock } = hostOver();
    const beating = host.run("doctor", { root: "/a" }, identity);
    const stalling = host.run("doctor", { root: "/b" }, identity);
    await settle();
    for (let elapsed = 0; elapsed < STALL_MS * 2; elapsed += DOOR_WORKER_WATCHDOG_INTERVAL_MS) {
      started[0]?.beat();
      clock.advance(DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    }
    await expect(stalling).rejects.toThrow("stalled");
    expect(started[1]?.terminations).toBe(1);
    expect(started[0]?.terminations).toBe(0);
    started[0]?.answer("ok");
    await expect(beating).resolves.toBe("ok");
  });

  it("stops a worker that outlasts its task's deadline even while it beats", async () => {
    const { host, started, clock } = hostOver();
    const running = host.run("doctor", { root: "/a" }, identity);
    await settle();
    for (let elapsed = 0; elapsed <= DEADLINES.doctor; elapsed += DOOR_WORKER_WATCHDOG_INTERVAL_MS) {
      started[0]?.beat();
      clock.advance(DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    }
    await expect(running).rejects.toThrow("deadline");
    expect(started[0]?.terminations).toBe(1);
  });

  it("ends the worker only when every caller waiting on it has aborted", async () => {
    const { host, started } = hostOver();
    const one = new AbortController();
    const two = new AbortController();
    const first = host.run("doctor", { root: "/r" }, identity, one.signal);
    const second = host.run("doctor", { root: "/r" }, identity, two.signal);
    await settle();
    one.abort();
    await expect(first).rejects.toThrow("cancelled");
    expect(started[0]?.terminations).toBe(0);
    two.abort();
    await expect(second).rejects.toThrow("cancelled");
    await settle();
    expect(started[0]?.terminations).toBe(1);
  });

  it("terminates running workers and refuses queued tasks when the door stops", async () => {
    const { host, started } = hostOver({ maxConcurrent: 1 });
    const running = host.run("doctor", { root: "/a" }, identity);
    const queued = host.run("doctor", { root: "/b" }, identity);
    await settle();
    host.stop();
    await expect(running).rejects.toThrow("ending");
    await expect(queued).rejects.toThrow("ending");
    await expect(host.run("doctor", { root: "/c" }, identity)).rejects.toThrow("ending");
    expect(started[0]?.terminations).toBe(1);
  });

  it("refuses an answer that is not a result", async () => {
    const { host, started } = hostOver();
    const running = host.run("doctor", { root: "/a" }, identity);
    await settle();
    started[0]?.emit("message", "hello");
    await expect(running).rejects.toThrow("something other than a result");
  });

  it("takes a cancelled queued request out of the queue at once, freeing its place, and starts an equal request after the cancel fresh", async () => {
    const { host, started } = hostOver({ maxConcurrent: 1, maxQueued: 1 });
    const running = host.run("doctor", { root: "/a" }, identity);
    const abort = new AbortController();
    const queued = host.run("doctor", { root: "/b" }, identity, abort.signal);
    await settle();
    // The queue is full: a third request is refused.
    await expect(host.run("doctor", { root: "/c" }, identity)).rejects.toBeInstanceOf(DoorWorkerBusyError);
    abort.abort();
    await expect(queued).rejects.toThrow("cancelled");
    // Its place in the queue is free again, in the same turn.
    const third = host.run("doctor", { root: "/c" }, identity);
    // And an equal request after the cancel is a flight of its own.
    const again = host.run("doctor", { root: "/b" }, identity);
    await expect(again).rejects.toBeInstanceOf(DoorWorkerBusyError);
    started[0]?.answer("a");
    await running;
    await settle();
    started[1]?.answer("c");
    await expect(third).resolves.toBe("c");
    expect(started).toHaveLength(2);
    const FLIGHTS_STARTED_BY_NOW = 3;
    const fresh = host.run("doctor", { root: "/b" }, identity);
    await settle();
    expect(started).toHaveLength(started.length);
    expect(started.length).toBe(FLIGHTS_STARTED_BY_NOW);
    started[2]?.answer("b");
    await expect(fresh).resolves.toBe("b");
  });

  it("refuses a request whose signal has already aborted, without starting anything", async () => {
    const { host, started } = hostOver();
    const abort = new AbortController();
    abort.abort();
    await expect(host.run("doctor", { root: "/a" }, identity, abort.signal)).rejects.toThrow("cancelled");
    await settle();
    expect(started).toHaveLength(0);
  });

  it("never spawns a worker for a request made in the turn the door is stopped", async () => {
    const { host, started } = hostOver();
    const running = host.run("doctor", { root: "/a" }, identity);
    host.stop();
    await expect(running).rejects.toThrow("ending");
    await settle();
    expect(started).toHaveLength(0);
  });

  it("never spawns a worker for a queued request that is handed a place after the door is stopped", async () => {
    const { host, started } = hostOver({ maxConcurrent: 1 });
    const running = host.run("doctor", { root: "/a" }, identity);
    const queued = host.run("doctor", { root: "/b" }, identity);
    await settle();
    host.stop();
    await expect(running).rejects.toThrow("ending");
    await expect(queued).rejects.toThrow("ending");
    await settle();
    expect(started).toHaveLength(1);
  });

  it("keeps a place until the thread has ended, so a worker stuck in a blocking call cannot let live threads pass the bound", async () => {
    const { host, started } = hostOver({ maxConcurrent: 1, stuck: true });
    const first = host.run("doctor", { root: "/a" }, identity);
    const second = host.run("doctor", { root: "/b" }, identity);
    await settle();
    started[0]?.answer("a");
    await first;
    await settle();
    // The first thread was told to end but has not: the second request has no place yet.
    expect(started).toHaveLength(1);
    started[0]?.release();
    await settle();
    expect(started).toHaveLength(2);
    started[1]?.answer("b");
    await expect(second).resolves.toBe("b");
  });

  it("terminates a worker once, however many ways its flight ends", async () => {
    const { host, started } = hostOver();
    const abort = new AbortController();
    const running = host.run("doctor", { root: "/a" }, identity, abort.signal);
    await settle();
    abort.abort();
    started[0]?.emit("message", { kind: "done", value: "late" });
    started[0]?.emit("error", new Error("late error"));
    host.stop();
    await expect(running).rejects.toThrow("cancelled");
    await settle();
    expect(started[0]?.terminations).toBe(1);
  });

  it("keeps the bound, the queue and the books through any interleaving of requests, cancels, answers, exits and stops", async () => {
    const MAX = 2;
    const QUEUE = 3;
    const RUNS = 60;
    const OPERATIONS = 40;
    /** The linear congruential generator's parameters (the classic ones), so a seed replays the same interleaving. */
    const LCG_SEED_SCALE = 2_654_435_761;
    const LCG_MULTIPLIER = 1_103_515_245;
    const LCG_INCREMENT = 12_345;
    /** The operations an interleaving draws from (requests twice as likely as the rest), and how many distinct requests it makes (few, so equal requests meet). */
    const OPERATION_KINDS = ["run", "run", "run", "abort", "answer", "end", "stop"] as const;
    const DISTINCT_REQUESTS = 5;
    const STOP_ONE_IN = 4;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      // A small deterministic generator, so a failing seed replays.
      let state = seed * LCG_SEED_SCALE;
      const next = (limit: number): number => {
        state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
        return state % limit;
      };
      const { host, started } = hostOver({ maxConcurrent: MAX, maxQueued: QUEUE, stuck: next(2) === 0 });
      const aborts: AbortController[] = [];
      const outcomes: Promise<unknown>[] = [];
      let stopped = false;
      let spawnedAfterStop = 0;
      for (let step = 0; step < OPERATIONS; step += 1) {
        const before = started.length;
        const operation = OPERATION_KINDS[next(OPERATION_KINDS.length)] ?? "run";
        switch (operation) {
          case "run": {
            const abort = new AbortController();
            aborts.push(abort);
            outcomes.push(host.run("doctor", { root: `/r${String(next(DISTINCT_REQUESTS))}` }, identity, abort.signal).catch(() => undefined));
            break;
          }
          case "abort":
            aborts[next(Math.max(1, aborts.length))]?.abort();
            break;
          case "answer":
            started[next(Math.max(1, started.length))]?.answer("ok");
            break;
          case "end":
            started[next(Math.max(1, started.length))]?.end();
            started[next(Math.max(1, started.length))]?.release();
            break;
          case "stop":
            if (next(STOP_ONE_IN) === 0) {
              host.stop();
              stopped = true;
            }
        }
        await settle();
        if (stopped) {
          spawnedAfterStop += started.length - before;
        }
        const live = started.filter((worker) => !worker.ended).length;
        expect(live, `seed ${String(seed)} step ${String(step)}`).toBeLessThanOrEqual(MAX);
      }
      host.stop();
      for (const worker of started) {
        worker.release();
      }
      await settle();
      await Promise.all(outcomes);
      expect(spawnedAfterStop, `seed ${String(seed)}`).toBe(0);
      expect(started.every((worker) => worker.terminations <= 1), `seed ${String(seed)}`).toBe(true);
      expect(started.every((worker) => worker.ended), `seed ${String(seed)}`).toBe(true);
    }
  });

  it("does not stop a worker when the wall clock jumps forward, since the watchdog reads the monotonic clock", async () => {
    // Real clock, real intervals: only the interval timer is faked, so the watchdog runs when time is advanced here while `performance.now` stands still.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const started: FakeWorker[] = [];
      const spawn: DoorWorkerSpawn = (_code, data) => {
        const worker = new FakeWorker(data);
        started.push(worker);
        return worker;
      };
      const host = createDoorWorkerHost({ code: "code", spawn, stallLimitMs: STALL_MS, deadlineMs: DEADLINES });
      const running = host.run("doctor", { root: "/a" }, identity);
      await vi.advanceTimersByTimeAsync(0);
      const wall = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(wall + DEADLINES.doctor * 2);
      await vi.advanceTimersByTimeAsync(DOOR_WORKER_WATCHDOG_INTERVAL_MS + DOOR_WORKER_WATCHDOG_INTERVAL_MS);
      expect(started[0]?.terminations).toBe(0);
      started[0]?.answer("ok");
      await expect(running).resolves.toBe("ok");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("refuses an unknown task and an input that does not fit, before any worker exists, naming the fields and not the values", async () => {
    const { host, started } = hostOver();
    await expect(host.run("nonexistent" as never, {} as never, identity)).rejects.toThrow("no such task");
    await expect(host.run("check", { root: "/r", path: "", secret: "TOPSECRET" } as never, identity)).rejects.toThrow(/input was refused \(path/u);
    await expect(host.run("check", { root: "/r", path: "", secret: "TOPSECRET" } as never, identity)).rejects.not.toThrow(/TOPSECRET/u);
    await settle();
    expect(started).toHaveLength(0);
  });

  it("names where a worker's answer did not fit the schema, not the value, and ends the message with a next step", async () => {
    const { host, started } = hostOver();
    const running = host.run("doctor", { root: "/a" }, (value) => z.strictObject({ ok: z.boolean() }).parse(value) as never);
    await settle();
    started[0]?.answer({ ok: "TOPSECRET" });
    const failure = await running.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(DoorWorkerFailedError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("its answer was not a valid result (ok)");
    expect(message).toContain("agent-shim doctor");
    expect(message).not.toContain("TOPSECRET");
  });

  it("refuses a failure message that carries anything beyond a class name and a code", async () => {
    const { host, started } = hostOver();
    const running = host.run("doctor", { root: "/a" }, identity);
    await settle();
    started[0]?.emit("message", { kind: "failed", name: "Error", code: "ENOENT", message: "TOPSECRET stderr" });
    await expect(running).rejects.toThrow("something other than a result");
  });
});
