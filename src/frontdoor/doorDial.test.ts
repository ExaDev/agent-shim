import vm from "node:vm";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeAddressesAcceptSync } from "./probe";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe, type AcceptVerdict, type DialOutcome, type DialSocket, type DoorDialIo } from "./doorDial";
import { SourcePortRange } from "./connectEffects";

/** A bound short enough that a test waiting it out stays quick. */
const SHORT_BOUND_MS = 200;

/** A reserved range of three ports: enough for one held port to be skipped and the next tried. */
const RANGE_START = 1;
const RANGE_END = 3;

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

/** A socket that never connects and records what is done to it: the stand-in for a host that never answers the SYN. */
class SilentSocket extends EventEmitter implements DialSocket {
  writes = 0;
  destroyed = false;

  write(): boolean {
    this.writes += 1;
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

/** A timer the test fires by hand, so the bound is exercised without waiting on any network. */
function manualTimer(): { readonly start: (callback: () => void, ms: number) => () => void; readonly fire: () => void; readonly cancelled: () => boolean; readonly armedMs: () => number | undefined } {
  let pending: (() => void) | undefined;
  let armed: number | undefined;
  let wasCancelled = false;
  return {
    start: (callback, ms) => {
      pending = callback;
      armed = ms;
      return () => {
        pending = undefined;
        wasCancelled = true;
      };
    },
    fire: () => {
      pending?.();
    },
    armedMs: () => armed,
    cancelled: () => wasCancelled,
  };
}

/** What a test of a dial that rejects may take: a rejection nobody answers leaves the verdict unsettled, and the test must fail on that instead of waiting for the suite's hang guard. */
const REJECTION_TEST_BUDGET_MS = 5_000;

describe("probeAccept", () => {
  it("fails a dial that has not connected when its bound expires, writes nothing, and closes the socket when the dial settles late", async () => {
    const socket = new SilentSocket();
    let settle: ((value: { readonly error: null; readonly socket: SilentSocket }) => void) | undefined;
    const timer = manualTimer();
    const verdict = probeAccept<SilentSocket>(
      async () =>
        await new Promise((resolve) => {
          settle = resolve;
        }),
      SHORT_BOUND_MS,
      timer.start,
    );
    expect(timer.armedMs()).toBe(SHORT_BOUND_MS);
    timer.fire();
    expect(await verdict).toEqual({ ok: false, reason: `no connection accepted within ${String(SHORT_BOUND_MS)}ms` });
    settle?.({ error: null, socket });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(socket.destroyed).toBe(true);
    expect(socket.writes).toBe(0);
  });

  it("answers a dial that rejects before it has a socket with the reason, as a verdict, and cancels its timer", async () => {
    const timer = manualTimer();
    const verdict = await probeAccept<SilentSocket>(
      async () => await Promise.reject(new RangeError("Port should be > 0 and < 65536. Received type number (0).")),
      SHORT_BOUND_MS,
      timer.start,
    );
    expect(verdict).toEqual({ ok: false, reason: "Port should be > 0 and < 65536. Received type number (0)." });
    expect(timer.cancelled()).toBe(true);
  }, REJECTION_TEST_BUDGET_MS);

  it("passes a dial that connects within the bound, writes nothing and closes it at once", async () => {
    const socket = new SilentSocket();
    const timer = manualTimer();
    expect(await probeAccept(async () => await Promise.resolve({ error: null, socket }), SHORT_BOUND_MS, timer.start)).toEqual({ ok: true });
    expect(socket.destroyed).toBe(true);
    expect(socket.writes).toBe(0);
  });
});

describe("doorDial", () => {
  it("tries the next reserved port when one is held, and resolves a name through the door's lookup", async () => {
    const tried: { readonly localPort: number | undefined; readonly lookedUp: boolean }[] = [];
    const ports = new SourcePortRange(RANGE_START, RANGE_END);
    const outcome = await doorDial(
      {
        connect: (options) => {
          tried.push({ localPort: options.localPort, lookedUp: options.lookup !== undefined });
          const socket = new SilentSocket();
          queueMicrotask(() => {
            if (tried.length < 2) {
              const held: NodeJS.ErrnoException = new Error("held");
              held.code = "EADDRINUSE";
              socket.emit("error", held);
            } else {
              socket.emit("connect");
            }
          });
          return socket;
        },
        lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
        isIP: net.isIP,
      },
      { host: "provider.example", port: 443 },
      ports,
    );
    expect(outcome.error).toBeNull();
    expect(tried).toEqual([
      { localPort: RANGE_START, lookedUp: true },
      { localPort: RANGE_START + 1, lookedUp: true },
    ]);
  });

  it("dials an address literal from an ephemeral port with no lookup", async () => {
    const tried: { readonly localPort: number | undefined }[] = [];
    await doorDial(
      {
        connect: (options) => {
          tried.push({ localPort: options.localPort });
          const socket = new SilentSocket();
          queueMicrotask(() => {
            socket.emit("connect");
          });
          return socket;
        },
        lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
        isIP: net.isIP,
      },
      { host: "127.0.0.1", port: 9 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    expect(tried).toEqual([{ localPort: undefined }]);
  });
});

describe("the provider probe on its worker thread", () => {
  it("reaches a listener on loopback by the name localhost, which a resolver is never asked about", async () => {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listener has no TCP address");
    }
    expect(probeAddressesAcceptSync([{ host: "localhost", port: address.port, timeoutMs: SHORT_BOUND_MS }])).toEqual([{ ok: true }]);
  });

  it("connects to a loopback listener and sends it nothing", async () => {
    const received: Buffer[] = [];
    let closed = false;
    const server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
      });
      socket.on("close", () => {
        closed = true;
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listener has no TCP address");
    }
    expect(probeAddressesAcceptSync([{ host: "127.0.0.1", port: address.port, timeoutMs: SHORT_BOUND_MS }])).toEqual([{ ok: true }]);
    await new Promise<void>((resolve) => {
      const wait = (): void => {
        if (closed) {
          resolve(undefined);
        } else {
          setImmediate(wait);
        }
      };
      wait();
    });
    expect(Buffer.concat(received).length).toBe(0);
  });
});

describe("evaluating each embedded dial function from its source text alone", () => {
  it("resolves a name through createDoorLookup evaluated in isolation", () => {
    const isolatedCreateLookup = vm.runInNewContext(`(${createDoorLookup.toString()})`, { Error }) as typeof createDoorLookup;
    let resolvedAddresses: readonly { readonly address: string; readonly family: number }[] | undefined;
    const lookup = isolatedCreateLookup({
      isIP: () => 0,
      resolve4: (_host, callback) => {
        callback(null, ["192.0.2.99"]);
      },
    });
    lookup("provider.example", {}, (_err, addresses) => {
      resolvedAddresses = addresses as readonly { readonly address: string; readonly family: number }[];
    });
    expect(resolvedAddresses).toEqual([{ address: "192.0.2.99", family: 4 }]);
  });

  it("answers localhost and the names under it as the loopback addresses without asking a resolver, evaluated in isolation", () => {
    const isolatedCreateLookup = vm.runInNewContext(`(${createDoorLookup.toString()})`, { Error }) as typeof createDoorLookup;
    const asked: string[] = [];
    const lookup = isolatedCreateLookup({
      isIP: () => 0,
      resolve4: (host) => {
        asked.push(host);
      },
    });
    for (const name of ["localhost", "LOCALHOST", "localhost.", "api.localhost", "a.b.Localhost."]) {
      let answered: unknown;
      lookup(name, {}, (_err, addresses) => {
        answered = addresses;
      });
      expect(answered, name).toEqual([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]);
    }
    // A name that only ends in the letters is a different name, and goes to the resolver.
    lookup("notlocalhost", {}, () => undefined);
    lookup("localhost.example", {}, () => undefined);
    expect(asked).toEqual(["notlocalhost", "localhost.example"]);
  });

  it("dials a name through doorDial evaluated in isolation", async () => {
    const isolatedDoorDial = vm.runInNewContext(`(${doorDial.toString()})`, { Promise, Error }) as typeof doorDial;
    const socket = new SilentSocket();
    let dialledOptions: Parameters<DoorDialIo<SilentSocket>["connect"]>[0] | undefined;
    const outcome = await isolatedDoorDial(
      {
        connect: (options) => {
          dialledOptions = options;
          queueMicrotask(() => {
            socket.emit("connect");
          });
          return socket;
        },
        lookup: () => undefined,
        isIP: () => 0,
      },
      { host: "provider.example", port: 8080 },
      { take: () => RANGE_START, count: 1 },
    );
    expect(outcome.error).toBeNull();
    expect(dialledOptions).toMatchObject({
      host: "provider.example",
      port: 8080,
      localPort: RANGE_START,
    });
  });
});

/** A function evaluated from its source text alone in a fresh context, as the probe's worker evaluates it: any reference to something outside the function's own parameters throws a ReferenceError. */
function isolated<F extends { readonly toString: () => string }>(fn: F): F {
  return vm.runInNewContext(`(${fn.toString()})`, { Promise, Error, String }) as F;
}

type DialOptions = Parameters<DoorDialIo<SilentSocket>["connect"]>[0];

/** A `connect` whose sockets answer from a script, recording the options of every dial: each dial takes the next entry, an error code to fail with or `undefined` to connect. */
function scriptedDials(script: readonly (string | undefined)[]): { readonly connect: DoorDialIo<SilentSocket>["connect"]; readonly dialled: readonly DialOptions[] } {
  const dialled: DialOptions[] = [];
  return {
    dialled,
    connect: (options) => {
      const code = script[dialled.length];
      dialled.push(options);
      const socket = new SilentSocket();
      queueMicrotask(() => {
        if (code === undefined) {
          socket.emit("connect");
          return;
        }
        const failure: NodeJS.ErrnoException = new Error(`dial failed with ${code}`);
        failure.code = code;
        socket.emit("error", failure);
      });
      return socket;
    },
  };
}

describe("every branch of the dial evaluated from its source text alone", () => {
  const isolatedDoorDial = isolated(doorDial);
  const lookup = createDoorLookup({ isIP: net.isIP, resolve4: () => undefined });

  async function dial(host: string, script: readonly (string | undefined)[]): Promise<{ readonly outcome: DialOutcome<SilentSocket>; readonly dialled: readonly DialOptions[] }> {
    const dials = scriptedDials(script);
    const outcome = await isolatedDoorDial({ connect: dials.connect, lookup, isIP: net.isIP }, { host, port: 443 }, new SourcePortRange(RANGE_START, RANGE_END));
    return { outcome, dialled: dials.dialled };
  }

  it("settles a refused dial of a name with the refusal, without retrying", async () => {
    const { outcome, dialled } = await dial("provider.example", ["ECONNREFUSED"]);
    expect(outcome.error?.code).toBe("ECONNREFUSED");
    expect(dialled).toHaveLength(1);
  });

  it("retries a name's held source port on the next one, for both codes a held port produces", async () => {
    const { outcome, dialled } = await dial("provider.example", ["EADDRINUSE", "EADDRNOTAVAIL", undefined]);
    expect(outcome.error).toBeNull();
    expect(dialled.map((options) => options.localPort)).toEqual([RANGE_START, RANGE_START + 1, RANGE_START + 2]);
  });

  it("surfaces the last bind error once every port of the range is held", async () => {
    const { outcome, dialled } = await dial("provider.example", ["EADDRINUSE", "EADDRINUSE", "EADDRNOTAVAIL"]);
    expect(outcome.error?.code).toBe("EADDRNOTAVAIL");
    expect(dialled).toHaveLength(RANGE_END - RANGE_START + 1);
  });

  it("dials an address literal once, from an ephemeral port, even when it fails with a held-port code", async () => {
    const { outcome, dialled } = await dial("127.0.0.1", ["EADDRINUSE"]);
    expect(outcome.error?.code).toBe("EADDRINUSE");
    expect(dialled).toEqual([{ host: "127.0.0.1", port: 443 }]);
  });

  describe("probeAccept", () => {
    const isolatedProbeAccept = isolated(probeAccept);

    it("passes a connected dial and closes its socket", async () => {
      const socket = new SilentSocket();
      expect(await isolatedProbeAccept(async () => await Promise.resolve({ error: null, socket }), SHORT_BOUND_MS, manualTimer().start)).toEqual({ ok: true });
      expect(socket.destroyed).toBe(true);
    });

    it("fails a refused dial naming its code and message, and cancels the bound's timer", async () => {
      const socket = new SilentSocket();
      const refusal: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
      refusal.code = "ECONNREFUSED";
      let cancelled = false;
      const verdict = await isolatedProbeAccept(
        async () => await Promise.resolve<DialOutcome<SilentSocket>>({ error: refusal, socket }),
        SHORT_BOUND_MS,
        () => () => {
          cancelled = true;
        },
      );
      expect(verdict).toEqual({ ok: false, reason: "ECONNREFUSED: connect ECONNREFUSED" });
      expect(cancelled).toBe(true);
    });

    it("fails a dial still pending at its bound", async () => {
      const timer = manualTimer();
      const verdict = isolatedProbeAccept(async () => await new Promise<DialOutcome<SilentSocket>>(() => undefined), SHORT_BOUND_MS, timer.start);
      timer.fire();
      expect(await verdict).toEqual({ ok: false, reason: `no connection accepted within ${String(SHORT_BOUND_MS)}ms` });
    });
  });

  describe("runAcceptProbe, assembled from the isolated functions as the worker assembles it", () => {
    const deps = {
      createDoorLookup: isolated(createDoorLookup),
      doorDial: isolatedDoorDial,
      probeAccept: isolated(probeAccept),
      SourcePortRange: isolated(SourcePortRange),
    };
    const isolatedRunAcceptProbe = isolated(runAcceptProbe);

    async function run(host: string, script: readonly (string | undefined)[]): Promise<{ readonly verdict: AcceptVerdict; readonly dialled: readonly DialOptions[] }> {
      const dials = scriptedDials(script);
      const verdict = await isolatedRunAcceptProbe(
        {
          ...deps,
          net: { connect: dials.connect, isIP: net.isIP },
          dns: {
            resolve4: (_name, callback) => {
              callback(null, ["192.0.2.7"]);
            },
          },
        },
        { host, port: 443, portStart: RANGE_START, portEnd: RANGE_END, timeoutMs: SHORT_BOUND_MS },
        manualTimer().start,
      );
      return { verdict, dialled: dials.dialled };
    }

    it("passes a name whose dial connects after a held port, dialling each attempt from the next reserved port through the door's lookup", async () => {
      const { verdict, dialled } = await run("provider.example", ["EADDRINUSE", undefined]);
      expect(verdict).toEqual({ ok: true });
      expect(dialled.map((options) => options.localPort)).toEqual([RANGE_START, RANGE_START + 1]);
      expect(dialled.every((options) => options.lookup !== undefined)).toBe(true);
    });

    it("fails a refused name with the refusal", async () => {
      const { verdict } = await run("provider.example", ["ECONNREFUSED"]);
      expect(verdict.ok ? "" : verdict.reason).toContain("ECONNREFUSED");
    });

    it("passes an address literal dialled directly", async () => {
      const { verdict, dialled } = await run("127.0.0.1", [undefined]);
      expect(verdict).toEqual({ ok: true });
      expect(dialled).toEqual([{ host: "127.0.0.1", port: 443 }]);
    });
  });
});
