import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { DOOR_WORKER_WATCHDOG_INTERVAL_MS, DoorWorkerBusyError, DoorWorkerFailedError, createDoorWorkerHost, type DoorWorkerClock, type DoorWorkerSpawn } from "./doorWorker";
import type { DoorWorkerData } from "./doorWorkerProtocol";

/** A worker that runs nothing: the test answers, fails or stalls it by hand. */
class FakeWorker extends EventEmitter {
  public terminations = 0;
  public constructor(public readonly data: DoorWorkerData) {
    super();
  }
  public async terminate(): Promise<number> {
    this.terminations += 1;
    return await Promise.resolve(0);
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
function hostOver(options: { readonly maxConcurrent?: number; readonly maxQueued?: number } = {}) {
  const started: FakeWorker[] = [];
  const spawn: DoorWorkerSpawn = (_code, data) => {
    const worker = new FakeWorker(data);
    started.push(worker);
    return worker;
  };
  const clock = manualClock();
  const host = createDoorWorkerHost({ code: "code", spawn, clock, stallLimitMs: STALL_MS, deadlineMs: DEADLINES, ...options });
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

  it("terminates a worker that fails, whose error names the task and the reason, and one that ends with no answer", async () => {
    const { host, started } = hostOver();
    const failed = host.run("check", { root: "/r", path: "/p" }, identity);
    await settle();
    started[0]?.emit("message", { kind: "failed", name: "Error", message: "no such directory" });
    await expect(failed).rejects.toThrow("check failed in its worker: Error: no such directory");
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
});
