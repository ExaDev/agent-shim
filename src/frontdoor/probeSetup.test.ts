import { describe, expect, it } from "vitest";

import { SourcePortRange } from "./connectEffects";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe, type AcceptProbeDeps, type DialSocket } from "./doorDial";
import { probeAddressesAcceptSync, type ProbeWorkers } from "./probe";

const RANGE_START = 47_900;
const RANGE_END = 47_902;
const PROBE_BOUND_MS = 50;
const PORT = 8000;
/** What `net.isIP` answers for an IPv4 literal and for a name. */
const IPV4 = 4;
const NOT_AN_ADDRESS = 0;
/** The address the fake resolver answers every name with. */
const RESOLVED_ADDRESS = "192.0.2.7";

/** A socket that connects as soon as it is asked to, and records that it was closed. */
class ConnectingSocket implements DialSocket {
  destroyed = false;
  private readonly listeners = new Map<string, () => void>();

  once(event: "connect" | "error", listener: (() => void) | ((error: NodeJS.ErrnoException) => void)): this {
    this.listeners.set(event, listener as () => void);
    if (event === "connect") {
      queueMicrotask(() => {
        this.listeners.get("connect")?.();
      });
    }
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

/** Fake `net` and `dns` modules that record how the probe dials: each connect's options, and each name the resolver was asked for. */
function fakeModules(): { readonly deps: AcceptProbeDeps; readonly connects: Parameters<AcceptProbeDeps["net"]["connect"]>[0][]; readonly resolved: string[] } {
  const connects: Parameters<AcceptProbeDeps["net"]["connect"]>[0][] = [];
  const resolved: string[] = [];
  return {
    connects,
    resolved,
    deps: {
      net: {
        connect: (options) => {
          connects.push(options);
          // The door's lookup is part of the dial: a connect that names one resolves through it, as node would.
          options.lookup?.(options.host, {}, () => undefined);
          return new ConnectingSocket();
        },
        isIP: (host) => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? IPV4 : NOT_AN_ADDRESS),
      },
      dns: {
        resolve4: (host, callback) => {
          resolved.push(host);
          callback(null, [RESOLVED_ADDRESS]);
        },
      },
      createDoorLookup,
      doorDial,
      probeAccept,
      SourcePortRange,
    },
  };
}

const noTimer = (): (() => void) => () => undefined;

describe("the provider probe's setup", () => {
  it("resolves a name through the door's resolver, never the hosts file", async () => {
    const { deps, resolved } = fakeModules();
    const verdict = await runAcceptProbe(deps, { host: "provider.example", port: PORT, portStart: RANGE_START, portEnd: RANGE_END, timeoutMs: PROBE_BOUND_MS }, noTimer);
    expect(verdict).toEqual({ ok: true });
    expect(resolved).toEqual(["provider.example"]);
  });

  it("dials a name from the first port of the door's reserved range", async () => {
    const { deps, connects } = fakeModules();
    await runAcceptProbe(deps, { host: "provider.example", port: PORT, portStart: RANGE_START, portEnd: RANGE_END, timeoutMs: PROBE_BOUND_MS }, noTimer);
    expect(connects).toHaveLength(1);
    expect(connects[0]?.localPort).toBe(RANGE_START);
    expect(connects[0]?.port).toBe(PORT);
  });

  it("dials an address literal as it is, with no lookup", async () => {
    const { deps, connects, resolved } = fakeModules();
    await runAcceptProbe(deps, { host: RESOLVED_ADDRESS, port: PORT, portStart: RANGE_START, portEnd: RANGE_END, timeoutMs: PROBE_BOUND_MS }, noTimer);
    expect(resolved).toEqual([]);
    expect(connects[0]?.lookup).toBeUndefined();
  });
});

/** Workers that record the order of starts and verdict waits, answering each target with the verdict its port names. */
function recordingWorkers(): { readonly workers: ProbeWorkers; readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    workers: {
      start: (_source, data) => {
        const name = String(data.port);
        events.push(`start ${name}`);
        return {
          verdict: () => {
            events.push(`wait ${name}`);
            return { ok: false, reason: `verdict for ${name}` };
          },
        };
      },
    },
  };
}

describe("a batch of provider probes", () => {
  const TARGETS = [
    { host: "a.example", port: 1, timeoutMs: PROBE_BOUND_MS },
    { host: "b.example", port: 2, timeoutMs: PROBE_BOUND_MS },
    { host: "c.example", port: 3, timeoutMs: PROBE_BOUND_MS },
  ];

  it("starts every probe before it waits on any, so their dials are in flight together", () => {
    const { workers, events } = recordingWorkers();
    probeAddressesAcceptSync(TARGETS, workers);
    const firstWait = events.findIndex((event) => event.startsWith("wait"));
    expect(events.slice(0, firstWait)).toEqual(["start 1", "start 2", "start 3"]);
    expect(events.slice(firstWait).every((event) => event.startsWith("wait"))).toBe(true);
  });

  it("answers in the order the targets were given", () => {
    const { workers } = recordingWorkers();
    expect(probeAddressesAcceptSync(TARGETS, workers)).toEqual([
      { ok: false, reason: "verdict for 1" },
      { ok: false, reason: "verdict for 2" },
      { ok: false, reason: "verdict for 3" },
    ]);
  });
});
