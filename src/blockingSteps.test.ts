import { afterEach, describe, expect, it } from "vitest";

import { spawnSyncBlocking } from "./blockingSpawn";
import { noteLocalWork, observeBlockingSteps, withBlockingStep } from "./blockingSteps";
import { startProbeWorker, PROBE_WAIT_MARGIN_MS, PROBE_WORKER_START_LIMIT_MS } from "./frontdoor/probe";
import { EventEmitter } from "node:events";

/** Stands in for the probe's worker thread, which a test that runs no probe source does not need. */
class FakeProbeWorker extends EventEmitter {
  public unref(): this {
    return this;
  }
  public async terminate(): Promise<number> {
    return await Promise.resolve(0);
  }
}

const UNBOUNDED_LIMIT_MS = 150;
const HOLD_SECONDS = "30";
const DECLARED_MS = 5_000;

/** What an observer was told, in order: a bound for each begin and "end" for each end. */
function recordingObserver(): { readonly told: (number | "end" | "work")[]; readonly stop: () => void } {
  const told: (number | "end" | "work")[] = [];
  const stop = observeBlockingSteps({
    begin: (ms) => { told.push(ms); },
    end: () => { told.push("end"); },
    localWork: () => { told.push("work"); },
    output: () => undefined,
    unboundedStepLimitMs: UNBOUNDED_LIMIT_MS,
  });
  return { told, stop };
}

let stopObserving: (() => void) | undefined;
afterEach(() => {
  stopObserving?.();
  stopObserving = undefined;
});

describe("withBlockingStep", () => {
  it("announces the declared bound and the end of the step", () => {
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    expect(withBlockingStep(DECLARED_MS, (bound) => bound)).toBe(DECLARED_MS);
    expect(told).toEqual([DECLARED_MS, "end"]);
  });

  it("gives a step that names no bound the observer's limit, and one that names zero too", () => {
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    expect(withBlockingStep(undefined, (bound) => bound)).toBe(UNBOUNDED_LIMIT_MS);
    expect(withBlockingStep(0, (bound) => bound)).toBe(UNBOUNDED_LIMIT_MS);
    expect(told).toEqual([UNBOUNDED_LIMIT_MS, "end", UNBOUNDED_LIMIT_MS, "end"]);
  });

  it("announces the end of a step that throws", () => {
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    expect(() => withBlockingStep(DECLARED_MS, () => { throw new Error("step failed"); })).toThrow("step failed");
    expect(told).toEqual([DECLARED_MS, "end"]);
  });

  it("passes the bound through untouched, and announces nothing, without an observer", () => {
    expect(withBlockingStep(undefined, (bound) => bound)).toBeUndefined();
    expect(withBlockingStep(DECLARED_MS, (bound) => bound)).toBe(DECLARED_MS);
  });
});

describe("noteLocalWork", () => {
  it("tells the observer about each unit of work, and does nothing without one", () => {
    expect(() => { noteLocalWork(); }).not.toThrow();
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    noteLocalWork();
    noteLocalWork();
    expect(told).toEqual(["work", "work"]);
  });
});

describe("a blocking step's limit", () => {
  it("ends a command that names no timeout once an observer is registered, which the same command without one does not", () => {
    const { stop } = recordingObserver();
    stopObserving = stop;
    const result = spawnSyncBlocking("a held command", "sleep", [HOLD_SECONDS], { encoding: "utf8" });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("leaves a command's own timeout as it is and announces it", () => {
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    spawnSyncBlocking("a quick command", "true", [], { encoding: "utf8", timeout: DECLARED_MS });
    expect(told).toEqual([DECLARED_MS, "end"]);
  });

  it("is announced for a wait on a probe worker as the start limit, the probe's bound and the margin", () => {
    const { told, stop } = recordingObserver();
    stopObserving = stop;
    const probeBoundMs = 40;
    const fake = new FakeProbeWorker();
    const probeWorker = startProbeWorker("", {}, probeBoundMs, () => fake);
    fake.emit("error", new Error("worker failed"));
    probeWorker.verdict();
    expect(told).toEqual([PROBE_WORKER_START_LIMIT_MS + probeBoundMs + PROBE_WAIT_MARGIN_MS, "end"]);
  });
});
