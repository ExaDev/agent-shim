import { afterEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "./credential";
import type { RunPort } from "./launcher/ports";
import { buildLayoutPaths } from "./paths";
import { realRunPort } from "./realPorts";
import { realIdentityRenamePorts, realSignals } from "./realIdentityRename";

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
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM"), SIGHUP: process.listenerCount("SIGHUP") };
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
    process.kill(process.pid, "SIGHUP");
    await realSignals.turn();
    expect(received).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    stop();
    stop = undefined;
    expect({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM"), SIGHUP: process.listenerCount("SIGHUP") }).toEqual(listeners);
  });
});

describe("realIdentityRenamePorts", () => {
  it("asks the attribute-only Keychain lookups under the bound a credential command has, and leaves the runner that may wait on a person unbounded", () => {
    const bounded: RunPort = { run: () => ({ status: 0, stdout: "", stderr: "" }) };
    const within = vi.fn<(timeoutMs: number) => RunPort>(() => bounded);
    const ports = realIdentityRenamePorts(buildLayoutPaths("/state"), within);
    expect(within).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(ports.lookupRun).toBe(bounded);
    expect(ports.run).toBe(realRunPort);
  });
});
