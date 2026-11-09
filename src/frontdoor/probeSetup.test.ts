import { describe, expect, it, vi } from "vitest";

import { DOOR_SOURCE_PORT_COUNT, DOOR_SOURCE_PORT_END, DOOR_SOURCE_PORT_START, SourcePortRange } from "./connectEffects";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe, type AcceptProbeDeps, type DialSocket } from "./doorDial";
import { MAX_CONCURRENT_PROBES, probeAddressesAcceptSync, startAddressProbes, probeListenerAcceptSync, type ProbeWorkers } from "./probe";

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

  it("dials a name from the port its rotation is told to start at, wrapping at the end of the range", async () => {
    const { deps, connects } = fakeModules();
    await runAcceptProbe(deps, { host: "provider.example", port: PORT, portStart: RANGE_START, portEnd: RANGE_END, portFirst: RANGE_START + 2, timeoutMs: PROBE_BOUND_MS }, noTimer);
    expect(connects[0]?.localPort).toBe(RANGE_START + 2);
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
          cancel: () => undefined,
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

  it("hands each worker the door's reserved source-port range", () => {
    const startedData: Readonly<Record<string, unknown>>[] = [];
    const workers: ProbeWorkers = {
      start: (_source, data) => {
        startedData.push(data);
        return { verdict: () => ({ ok: true }), cancel: () => undefined };
      },
    };
    probeAddressesAcceptSync(TARGETS, workers);
    expect(startedData).toHaveLength(TARGETS.length);
    for (const [index, data] of startedData.entries()) {
      expect(data).toMatchObject({
        host: TARGETS[index]?.host,
        port: TARGETS[index]?.port,
        portStart: DOOR_SOURCE_PORT_START,
        portEnd: DOOR_SOURCE_PORT_END,
      });
    }
  });
});

describe("a batch of provider probes at the size of a large configuration", () => {
  const OTHER_BASE = 40;
  /** How many probes at a time the documentation states. */
  const DOCUMENTED_CONCURRENT_PROBES = 10;
  /** What a process id is multiplied by to place its first batch (see `probe.ts`). */
  const PORT_BASE_SPREAD = 389;
  /** The share of the reserved range, as its reciprocal, that probes may hold between them. */
  const PROBE_SHARE_DENOMINATOR = 100;
  const FIRST = 100;
  const SECOND = 200;
  const THIRD = 400;
  const sizes = [FIRST, SECOND, THIRD] as const;

  /** Workers that hold the source port their rotation hands them, as a dial holds it while it connects, until their verdict is read; a rotation that meets a held port takes the next, as the door's dial does. Records how many workers were alive at once, how many bind attempts were made and what was started. */
  function holdingWorkers(attemptLimit: number): { readonly workers: ProbeWorkers; readonly peak: () => number; readonly attempts: () => number; readonly started: () => number } {
    const held = new Set<number>();
    let alive = 0;
    let peakAlive = 0;
    let bindAttempts = 0;
    let startedCount = 0;
    return {
      peak: () => peakAlive,
      attempts: () => bindAttempts,
      started: () => startedCount,
      workers: {
        start: (_source, data) => {
          startedCount += 1;
          const ports = new SourcePortRange(Number(data.portStart), Number(data.portEnd), Number(data.portFirst));
          let port = ports.take();
          bindAttempts += 1;
          while (held.has(port)) {
            // A walk past held ports is what the batch must not make: it fails as soon as the attempts exceed the one-for-each-worker the spread guarantees, not after the whole batch has run.
            if (bindAttempts >= attemptLimit) {
              throw new Error(`a worker walked past a held port after ${String(bindAttempts)} bind attempts, more than the ${String(attemptLimit)} the batch is allowed`);
            }
            port = ports.take();
            bindAttempts += 1;
          }
          held.add(port);
          alive += 1;
          peakAlive = Math.max(peakAlive, alive);
          return {
            verdict: () => {
              held.delete(port);
              alive -= 1;
              return { ok: true };
            },
            cancel: () => undefined,
          };
        },
      },
    };
  }

  const distinctTargets = (count: number) => Array.from({ length: count }, (_, index) => ({ host: `p${String(index)}.example`, port: PORT, timeoutMs: PROBE_BOUND_MS }));

  it("runs no more workers at once than the bound, however many providers there are", () => {
    for (const size of sizes) {
      const run = holdingWorkers(size);
      probeAddressesAcceptSync(distinctTargets(size), run.workers);
      expect(run.peak(), `size ${String(size)}`).toBeLessThanOrEqual(MAX_CONCURRENT_PROBES);
      expect(run.started()).toBe(size);
    }
  });

  it("makes one bind attempt for each provider, as each worker's rotation starts apart", () => {
    const counts = sizes.map((size) => {
      const run = holdingWorkers(size);
      probeAddressesAcceptSync(distinctTargets(size), run.workers);
      return run.attempts();
    });
    // Each worker found its port at the first attempt, since no two started on the same one: the attempts are the targets, not their square.
    expect(counts).toEqual([...sizes]);
  });

  it("starts every worker at its own port with more targets than half the range (a stride of one), wrapping the range", () => {
    const LARGE = DOOR_SOURCE_PORT_COUNT + DOOR_SOURCE_PORT_COUNT / 2;
    const run = holdingWorkers(LARGE);
    probeAddressesAcceptSync(distinctTargets(LARGE), run.workers);
    expect(run.attempts()).toBe(LARGE);
  });

  it("settles the workers already running, and reports the one that could not start, when a later worker cannot be created", () => {
    const settled: string[] = [];
    const FAILING_START = 3;
    const TARGET_COUNT = 4;
    let started = 0;
    const workers: ProbeWorkers = {
      start: (_source, data) => {
        started += 1;
        if (started === FAILING_START) {
          throw new Error("ERR_WORKER_INIT_FAILED");
        }
        const host = String(data.host);
        return { verdict: () => { settled.push(host); return { ok: true }; }, cancel: () => undefined };
      },
    };
    const verdicts = probeAddressesAcceptSync(distinctTargets(TARGET_COUNT), workers, 0);
    expect(settled).toEqual(["p0.example", "p1.example", "p3.example"]);
    expect(verdicts.map((verdict) => verdict.ok)).toEqual([true, true, false, true]);
    expect(verdicts[2]).toMatchObject({ reason: expect.stringContaining("ERR_WORKER_INIT_FAILED") as unknown });
  });

  it("starts the batches of different base offsets apart, so batches running together do not begin at one port", () => {
    const firsts: number[] = [];
    const workers: ProbeWorkers = { start: (_source, data) => { firsts.push(Number(data.portFirst)); return { verdict: () => ({ ok: true }), cancel: () => undefined }; } };
    probeAddressesAcceptSync(distinctTargets(1), workers, 0);
    probeAddressesAcceptSync(distinctTargets(1), workers, OTHER_BASE);
    expect(firsts).toEqual([DOOR_SOURCE_PORT_START, DOOR_SOURCE_PORT_START + OTHER_BASE]);
  });

  it("spreads a batch's workers over the range by the stride, one every range-width over the targets", () => {
    const firsts: number[] = [];
    const workers: ProbeWorkers = { start: (_source, data) => { firsts.push(Number(data.portFirst)); return { verdict: () => ({ ok: true }), cancel: () => undefined }; } };
    const TARGETS = 100;
    probeAddressesAcceptSync(distinctTargets(TARGETS), workers, 0);
    const stride = DOOR_SOURCE_PORT_COUNT / TARGETS;
    expect(firsts).toEqual(Array.from({ length: TARGETS }, (_, index) => DOOR_SOURCE_PORT_START + index * stride));
  });

  it("places a fresh process's first batch at its id times the spread, so processes with successive ids start apart", async () => {
    vi.resetModules();
    const fresh = await import("./probe");
    const firsts: number[] = [];
    const workers: ProbeWorkers = { start: (_source, data) => { firsts.push(Number(data.portFirst)); return { verdict: () => ({ ok: true }), cancel: () => undefined }; } };
    fresh.probeAddressesAcceptSync(distinctTargets(1), workers);
    expect(firsts).toEqual([DOOR_SOURCE_PORT_START + ((process.pid * PORT_BASE_SPREAD) % DOOR_SOURCE_PORT_COUNT)]);
  });

  it("holds a batch's concurrent probes to the share of the range it names", () => {
    expect(MAX_CONCURRENT_PROBES).toBe(DOOR_SOURCE_PORT_COUNT / PROBE_SHARE_DENOMINATOR);
    // The documentation (`docs/configuration-model.md`, `docs/architecture.md`) says ten; a change of the share changes that text with this.
    expect(MAX_CONCURRENT_PROBES).toBe(DOCUMENTED_CONCURRENT_PROBES);
  });

  it("probes a host, port and bound once however many providers name them, and gives each provider the verdict", () => {
    const run = holdingWorkers(2);
    const same = Array.from({ length: THIRD }, () => ({ host: "shared.example", port: PORT, timeoutMs: PROBE_BOUND_MS }));
    const other = { host: "shared.example", port: PORT, timeoutMs: PROBE_BOUND_MS * 2 };
    const verdicts = probeAddressesAcceptSync([...same, other], run.workers);
    expect(run.started()).toBe(2);
    expect(verdicts).toHaveLength(THIRD + 1);
  });

  it("starts every probe without waiting for any, waits only in settle, and cancels the workers still running", () => {
    const events: string[] = [];
    const workers: ProbeWorkers = {
      start: (_source, data) => {
        const host = String(data.host);
        events.push(`start ${host}`);
        return {
          verdict: () => {
            events.push(`wait ${host}`);
            return { ok: true };
          },
          cancel: () => {
            events.push(`cancel ${host}`);
          },
        };
      },
    };
    const targets = [
      { host: "a.example", port: PORT, timeoutMs: PROBE_BOUND_MS },
      { host: "b.example", port: PORT, timeoutMs: PROBE_BOUND_MS },
    ];
    const settled = startAddressProbes(targets, workers);
    expect(events).toEqual(["start a.example", "start b.example"]);
    expect(settled.settle()).toEqual([{ ok: true }, { ok: true }]);
    expect(events.slice(2)).toEqual(["wait a.example", "wait b.example"]);
    events.length = 0;
    const abandoned = startAddressProbes(targets, workers);
    abandoned.cancel();
    expect(events).toEqual(["start a.example", "start b.example", "cancel a.example", "cancel b.example"]);
  });

  it("gives two targets that differ only in their bound each their own bound and verdict", () => {
    const SHORT_BOUND_MS = 500;
    const LONG_BOUND_MS = 30_000;
    // The verdict names the bound its worker was given, so a probe shared between the two would show the same bound twice.
    const workers: ProbeWorkers = {
      start: (_source, _data, timeoutMs) => ({ verdict: () => ({ ok: false, reason: `bound ${String(timeoutMs)}` }), cancel: () => undefined }),
    };
    const verdicts = probeAddressesAcceptSync(
      [
        { host: "same.example", port: PORT, timeoutMs: SHORT_BOUND_MS },
        { host: "same.example", port: PORT, timeoutMs: LONG_BOUND_MS },
        { host: "same.example", port: PORT, timeoutMs: SHORT_BOUND_MS },
      ],
      workers,
    );
    expect(verdicts).toEqual([
      { ok: false, reason: `bound ${String(SHORT_BOUND_MS)}` },
      { ok: false, reason: `bound ${String(LONG_BOUND_MS)}` },
      { ok: false, reason: `bound ${String(SHORT_BOUND_MS)}` },
    ]);
  });
});

describe("probeListenerAcceptSync", () => {
  it("passes the listener target and the door's reserved source-port range to its worker", () => {
    let startedData: Readonly<Record<string, unknown>> | undefined;
    const workers: ProbeWorkers = {
      start: (_source, data) => {
        startedData = data;
        return { verdict: () => ({ ok: true }), cancel: () => undefined };
      },
    };
    expect(probeListenerAcceptSync(PORT, PROBE_BOUND_MS, workers)).toEqual({ ok: true });
    expect(startedData).toEqual({
      host: "127.0.0.1",
      port: PORT,
      portStart: DOOR_SOURCE_PORT_START,
      portEnd: DOOR_SOURCE_PORT_END,
    });
  });
});
