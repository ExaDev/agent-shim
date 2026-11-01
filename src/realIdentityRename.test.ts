import { afterEach, describe, expect, it } from "vitest";

import { realSignals } from "./realIdentityRename";

/** How long the synchronous work, during which the signal is pending, lasts. */
const BUSY_MS = 20;

describe("the real signal port", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("delivers a signal sent to this process during synchronous work by the time one turn has passed, and no longer once stopped", async () => {
    const received: NodeJS.Signals[] = [];
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
    stop = realSignals.onInterrupt((signal) => {
      received.push(signal);
    });
    const busyUntil = Date.now() + BUSY_MS;
    process.kill(process.pid, "SIGTERM");
    while (Date.now() < busyUntil) {
      // Synchronous work, as a rename's steps are, during which the signal is pending.
    }
    await realSignals.turn();
    expect(received).toEqual(["SIGTERM"]);
    process.kill(process.pid, "SIGINT");
    await realSignals.turn();
    expect(received).toEqual(["SIGTERM", "SIGINT"]);
    stop();
    stop = undefined;
    expect({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }).toEqual(listeners);
  });
});
