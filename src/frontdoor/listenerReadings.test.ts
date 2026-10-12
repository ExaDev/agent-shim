import { describe, expect, it } from "vitest";

import { readFrontDoorListeners, type FrontDoorListenerProbes } from "./listenerReadings";
import type { ListenerVerdict } from "./probe";
import { formatFrontDoorListeners } from "./status";

const PROVIDER_PORT = 4100;
const CONNECT_PORT = 4200;
const MILLISECONDS_PER_PROBE = 7;

/** Probes that answer from a script and a clock that advances a fixed step per probe, so the readings are deterministic. */
function probes(script: { readonly provider: ListenerVerdict; readonly connect: ListenerVerdict }): FrontDoorListenerProbes & { readonly asked: string[] } {
  let clock = 0;
  const asked: string[] = [];
  return {
    asked,
    authenticateProvider: (port) => {
      asked.push(`provider:${String(port)}`);
      clock += MILLISECONDS_PER_PROBE;
      return script.provider;
    },
    connect: (port) => {
      asked.push(`connect:${String(port)}`);
      clock += MILLISECONDS_PER_PROBE;
      return script.connect;
    },
    now: () => clock,
  };
}

describe("readFrontDoorListeners", () => {
  it("reads both listeners of a live door, provider first, each timed on its own", () => {
    const fake = probes({ provider: { ok: true }, connect: { ok: true } });
    const readings = readFrontDoorListeners({ port: PROVIDER_PORT, connectPort: CONNECT_PORT }, true, fake);
    expect(fake.asked).toEqual([`provider:${String(PROVIDER_PORT)}`, `connect:${String(CONNECT_PORT)}`]);
    expect(readings).toEqual([
      { listener: "provider", port: PROVIDER_PORT, ok: true, elapsedMs: MILLISECONDS_PER_PROBE },
      { listener: "connect", port: CONNECT_PORT, ok: true, elapsedMs: MILLISECONDS_PER_PROBE },
    ]);
  });

  it("carries a failing listener's reason and keeps reading the other", () => {
    const fake = probes({ provider: { ok: false, reason: "no answer within 2000ms" }, connect: { ok: true } });
    const readings = readFrontDoorListeners({ port: PROVIDER_PORT, connectPort: CONNECT_PORT }, true, fake);
    expect(readings[0]).toMatchObject({ listener: "provider", ok: false, reason: "no answer within 2000ms" });
    expect(readings[1]).toMatchObject({ listener: "connect", ok: true });
  });

  it("probes nothing when no supervisor of the door is alive, and skips a port the state does not record", () => {
    const dead = probes({ provider: { ok: true }, connect: { ok: true } });
    expect(readFrontDoorListeners({ port: PROVIDER_PORT, connectPort: CONNECT_PORT }, false, dead)).toEqual([]);
    expect(dead.asked).toEqual([]);
    const half = probes({ provider: { ok: true }, connect: { ok: true } });
    expect(readFrontDoorListeners({ connectPort: CONNECT_PORT }, true, half).map((reading) => reading.listener)).toEqual(["connect"]);
  });
});

describe("formatFrontDoorListeners", () => {
  it("says which listener is not accepting and why", () => {
    const lines = formatFrontDoorListeners([
      { listener: "provider", port: PROVIDER_PORT, ok: true, elapsedMs: MILLISECONDS_PER_PROBE },
      { listener: "connect", port: CONNECT_PORT, ok: false, reason: "no connection accepted within 2000ms", elapsedMs: 2_000 },
    ]);
    expect(lines).toEqual([
      `provider listener: accepting on 127.0.0.1:${String(PROVIDER_PORT)} (probe took ${String(MILLISECONDS_PER_PROBE)} ms)`,
      `connect surface: NOT accepting on 127.0.0.1:${String(CONNECT_PORT)} (no connection accepted within 2000ms)`,
    ]);
  });
});
