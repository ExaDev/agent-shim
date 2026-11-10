import vm from "node:vm";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeAddressesAcceptSync } from "./probe";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe, sourcePortClassifier, type AcceptVerdict, type DialOutcome, type DialSocket, type DoorDialIo } from "./doorDial";
import { SourcePortRange } from "./connectEffects";

/** A bound short enough that a test waiting it out stays quick. */
const SHORT_BOUND_MS = 200;

/** The bound a test gives a probe that dials a real loopback listener and must be accepted. It applies once the probe's worker has started, a healthy accept takes a few milliseconds, and a loaded machine can delay the connect by far more than `SHORT_BOUND_MS`, so it is far above a healthy accept and the test asserts the outcome, not a time. */
const REAL_LISTENER_BOUND_MS = 5_000;

/** A reserved range of three ports: enough for one held port to be skipped and the next tried. */
const RANGE_START = 1;
const RANGE_END = 3;

/**
 * A source-port range a real dial can bind on every platform: above the privileged ports (a dial that binds one is refused with EACCES on Linux for an unprivileged user) and below both the Linux and the macOS ephemeral ranges, so nothing the operating system hands out can hold one. It is also clear of the door's own reserved range (`DOOR_SOURCE_PORT_START` and its width), which the probe workers of other tests draw from. `RANGE_START` and `RANGE_END` belong to fake sockets, which bind nothing.
 */
const BINDABLE_RANGE_START = 31_990;
const BINDABLE_RANGE_END = 31_999;

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

  it("never answers with an empty reason when a dial rejects with nothing to say", async () => {
    const verdict = await probeAccept<SilentSocket>(async () => await Promise.reject(new Error("")), SHORT_BOUND_MS, manualTimer().start);
    expect(verdict).toEqual({ ok: false, reason: "the dial failed with no reason given" });
  });

  it("flattens the AggregateError node emits when every address of a name refuses, so the reason names each attempt", async () => {
    class Refused extends Error {
      public readonly code = "ECONNREFUSED";
    }
    class Aggregate extends Error {
      public readonly code = "ECONNREFUSED";
      public readonly errors = [new Refused("connect ECONNREFUSED 127.0.0.1:1"), new Refused("connect ECONNREFUSED ::1:1")];
      constructor() {
        super("");
      }
    }
    const verdict = await probeAccept(
      async () =>
        await doorDial(
          {
            connect: () => {
              const socket = new SilentSocket();
              queueMicrotask(() => {
                socket.emit("error", new Aggregate());
              });
              return socket;
            },
            lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
            isIP: () => 0,
            isSourcePortUnusable: unusableOn("linux"),
          },
          { host: "localhost", port: 1 },
          new SourcePortRange(RANGE_START, RANGE_END),
        ),
      SHORT_BOUND_MS,
      manualTimer().start,
    );
    expect(verdict).toEqual({ ok: false, reason: "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1; connect ECONNREFUSED ::1:1" });
  });

  it("leaves the local end of the connection out of a failure's reason, so the reason is the same on every run", async () => {
    class Refused extends Error {
      public readonly code = "ECONNREFUSED";
    }
    class Aggregate extends Error {
      public readonly code = "ECONNREFUSED";
      public readonly errors: Refused[];
      constructor(localPort: number) {
        super("");
        this.errors = [new Refused(`connect ECONNREFUSED 127.0.0.1:1 - Local (0.0.0.0:${String(localPort)})`), new Refused(`connect ECONNREFUSED ::1:1 - Local (:::${String(localPort)})`)];
      }
    }
    const reasonFor = async (failure: Error): Promise<string> => {
      const verdict = await probeAccept(
        async () =>
          await doorDial(
            {
              connect: () => {
                const socket = new SilentSocket();
                queueMicrotask(() => {
                  socket.emit("error", failure);
                });
                return socket;
              },
              lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
              isIP: () => 0,
              isSourcePortUnusable: unusableOn("linux"),
            },
            { host: "localhost", port: 1 },
            new SourcePortRange(RANGE_START, RANGE_END),
          ),
        SHORT_BOUND_MS,
        manualTimer().start,
      );
      return verdict.ok ? "" : verdict.reason;
    };
    const FIRST_LOCAL_PORT = 48_767;
    const SECOND_LOCAL_PORT = 51_203;
    const first = await reasonFor(new Aggregate(FIRST_LOCAL_PORT));
    expect(first).toBe("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1; connect ECONNREFUSED ::1:1");
    expect(await reasonFor(new Aggregate(SECOND_LOCAL_PORT))).toBe(first);
    const single = new Refused(`connect ECONNREFUSED 127.0.0.1:1 - Local (0.0.0.0:${String(FIRST_LOCAL_PORT)})`);
    expect(await reasonFor(single)).toBe("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1");
  });

  class CodedError extends Error {
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  it("never gives an empty reason: a code with no message is the code, and neither is a plain statement", async () => {
    const timer = manualTimer();
    const bare = new SilentSocket();
    const noMessage = await probeAccept<SilentSocket>(async () => await Promise.resolve({ error: new CodedError("", "EHOSTUNREACH"), socket: bare }), SHORT_BOUND_MS, timer.start);
    expect(noMessage).toEqual({ ok: false, reason: "EHOSTUNREACH" });
    const nothing = await probeAccept<SilentSocket>(async () => await Promise.resolve({ error: new Error(""), socket: bare }), SHORT_BOUND_MS, timer.start);
    expect(nothing).toEqual({ ok: false, reason: "the connection failed with no reason given" });
  });

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
        isSourcePortUnusable: unusableOn("linux"),
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
        isSourcePortUnusable: unusableOn("linux"),
      },
      { host: "127.0.0.1", port: 9 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    expect(tried).toEqual([{ localPort: undefined }]);
  });
});

describe("the door's lookup answers in the shape node asks for", () => {
  const lookup = createDoorLookup({ isIP: net.isIP, resolve4: (_host, callback) => { callback(null, ["192.0.2.7"]); } });

  /** What the lookup hands its callback for `host`, with `all` as the dial would ask. */
  function answered(host: string, all: boolean): readonly unknown[] {
    let handed: readonly unknown[] = [];
    lookup(host, { all }, (...args: readonly unknown[]) => {
      handed = args;
    });
    return handed;
  }

  it("answers an array when all addresses are asked for, and one address and its family when one is", () => {
    for (const host of ["localhost", "sub.localhost", "spark.example", "10.0.0.5"]) {
      const [error, many] = answered(host, true);
      expect(error, host).toBeNull();
      expect(Array.isArray(many), host).toBe(true);
      const [singleError, address, family] = answered(host, false);
      expect(singleError, host).toBeNull();
      expect(typeof address, host).toBe("string");
      expect(net.isIP(String(address)), host).toBe(family);
    }
  });

  it("lets a real dial reach a listener by name with node's automatic address-family selection off, which asks for one address", async () => {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("listener has no TCP address");
    }
    const before = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      const outcome = await doorDial(
        { connect: (options) => net.connect(options), lookup, isIP: net.isIP, isSourcePortUnusable: unusableOn("linux") },
        { host: "localhost", port: address.port },
        new SourcePortRange(BINDABLE_RANGE_START, BINDABLE_RANGE_END),
      );
      outcome.socket.destroy();
      expect(outcome.error).toBeNull();
    } finally {
      net.setDefaultAutoSelectFamily(before);
    }
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
    expect(probeAddressesAcceptSync([{ host: "localhost", port: address.port, timeoutMs: REAL_LISTENER_BOUND_MS }])).toEqual([{ ok: true }]);
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
    expect(probeAddressesAcceptSync([{ host: "127.0.0.1", port: address.port, timeoutMs: REAL_LISTENER_BOUND_MS }])).toEqual([{ ok: true }]);
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
    lookup("provider.example", { all: true }, (_err, addresses) => {
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
      lookup(name, { all: true }, (_err, addresses) => {
        answered = addresses;
      });
      expect(answered, name).toEqual([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]);
    }
    // A name that only ends in the letters is a different name, and goes to the resolver.
    const lookalikes = ["notlocalhost", "localhost.example", "localhost.evil.com", "evil-localhost", "foolocalhost"];
    for (const lookalike of lookalikes) {
      lookup(lookalike, {}, () => undefined);
    }
    expect(asked).toEqual(lookalikes);
  });

  it("says the door resolves through DNS A records only when a name does not resolve, keeping the error's code, evaluated in isolation", () => {
    const isolatedCreateLookup = vm.runInNewContext(`(${createDoorLookup.toString()})`, { Error, Object }) as typeof createDoorLookup;
    const failures: NodeJS.ErrnoException[] = [];
    class NotFound extends Error {
      public readonly code = "ENOTFOUND";
    }
    const notFound = new NotFound("queryA ENOTFOUND spark.local");
    const answers: readonly (readonly string[] | Error)[] = [notFound, []];
    for (const answer of answers) {
      const lookup = isolatedCreateLookup({
        isIP: () => 0,
        resolve4: (_host, callback) => {
          if (answer instanceof Error) {
            callback(answer, []);
          } else {
            callback(null, answer);
          }
        },
      });
      lookup("spark.local", {}, (error) => {
        if (error !== null) {
          failures.push(error);
        }
      });
    }
    expect(failures.map((failure) => failure.message)).toEqual([
      expect.stringMatching(/^queryA ENOTFOUND spark\.local \(the door resolves names through DNS A records only, never the hosts file or mDNS and not AAAA records/u) as unknown,
      expect.stringMatching(/^no A record for spark\.local \(the door resolves names through DNS A records only/u) as unknown,
    ]);
    expect(failures[0]?.code).toBe("ENOTFOUND");
  });

  it("gives the A-records hint only to a name that is absent, never to a resolver failure", () => {
    const isolatedCreateLookup = vm.runInNewContext(`(${createDoorLookup.toString()})`, { Error, Object }) as typeof createDoorLookup;
    const outcomes = new Map<string, { readonly message: string; readonly code: string | undefined }>();
    for (const code of ["ENOTFOUND", "ENODATA", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"]) {
      const failure: NodeJS.ErrnoException = new Error(`queryA ${code} spark.example`);
      failure.code = code;
      const lookup = isolatedCreateLookup({ isIP: () => 0, resolve4: (_host, callback) => { callback(failure, []); } });
      lookup("spark.example", {}, (error) => {
        if (error !== null) {
          outcomes.set(code, { message: error.message, code: error.code });
        }
      });
    }
    const hinted = [...outcomes].filter(([, outcome]) => outcome.message.includes("DNS A records only")).map(([code]) => code);
    expect(hinted).toEqual(["ENOTFOUND", "ENODATA"]);
    expect([...outcomes].map(([code, outcome]) => [code, outcome.code])).toEqual([...outcomes.keys()].map((code) => [code, code]));
    expect(outcomes.get("ETIMEOUT")?.message).toBe("queryA ETIMEOUT spark.example");
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
        isSourcePortUnusable: unusableOn("linux"),
      },
      { host: "provider.example", port: 8080 },
      { take: () => RANGE_START, count: 1, start: RANGE_START, end: RANGE_START },
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

/** The classification the dial is given for `platform`, as the door builds it from `process.platform`. */
function unusableOn(platform: string): DoorDialIo<SilentSocket>["isSourcePortUnusable"] {
  return sourcePortClassifier(platform);
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
        // `CODE@syscall` names the syscall node reports the failure from (`bind` for a source port that cannot be bound, `connect` for the destination), as node does.
        const [errno, syscall] = code.split("@");
        const failure: NodeJS.ErrnoException = new Error(`dial failed with ${errno ?? code}`);
        failure.code = errno ?? code;
        if (syscall !== undefined) {
          failure.syscall = syscall;
        }
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
    const outcome = await isolatedDoorDial({ connect: dials.connect, lookup, isIP: net.isIP, isSourcePortUnusable: isolated(sourcePortClassifier)("linux") }, { host, port: 443 }, new SourcePortRange(RANGE_START, RANGE_END));
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
      sourcePortClassifier: isolated(sourcePortClassifier),
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
        { host, port: 443, portStart: RANGE_START, portEnd: RANGE_END, platform: "linux", timeoutMs: SHORT_BOUND_MS },
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

describe("which source-port failures move the rotation on", () => {
  const BIND_REFUSED = "EACCES@bind";
  const RANGE_WIDTH = RANGE_END - RANGE_START + 1;

  /** Dials a name over a scripted `connect` for `platform`, returning the outcome and every source port tried. */
  async function dialOn(platform: string, script: readonly (string | undefined)[]): Promise<{ readonly outcome: DialOutcome<SilentSocket>; readonly ports: readonly (number | undefined)[] }> {
    const dials = scriptedDials(script);
    const outcome = await doorDial(
      { connect: dials.connect, lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }), isIP: net.isIP, isSourcePortUnusable: unusableOn(platform) },
      { host: "provider.example", port: 443 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    return { outcome, ports: dials.dialled.map((options) => options.localPort) };
  }

  it.each([
    ["win32", "EADDRINUSE@bind", true],
    ["win32", "EADDRNOTAVAIL@connect", true],
    ["win32", "EACCES@bind", true],
    ["win32", "EACCES@connect", false],
    ["win32", "EACCES", false],
    ["win32", "ECONNREFUSED@connect", false],
    ["linux", "EADDRINUSE@bind", true],
    ["linux", "EADDRNOTAVAIL@connect", true],
    ["linux", "EACCES@bind", false],
    ["darwin", "EACCES@bind", false],
    ["darwin", "EACCES@connect", false],
    ["freebsd", "EACCES@bind", false],
  ] as const)("on %s a %s failure of a source port is %s", (platform, failure, unusable) => {
    const [code, syscall] = failure.split("@");
    const error: NodeJS.ErrnoException = new Error(failure);
    error.code = code;
    if (syscall !== undefined) {
      error.syscall = syscall;
    }
    expect(sourcePortClassifier(platform)(error)).toBe(unusable);
  });

  it("moves past a port Windows excludes (EACCES at the bind) and connects from the next one", async () => {
    const { outcome, ports } = await dialOn("win32", [BIND_REFUSED, BIND_REFUSED, undefined]);
    expect(outcome.error).toBeNull();
    expect(ports).toEqual([RANGE_START, RANGE_START + 1, RANGE_START + 2]);
  });

  it("fails a bind refused with EACCES at once on a platform that excludes no ranges, since there it is a real error", async () => {
    for (const platform of ["linux", "darwin"]) {
      const { outcome, ports } = await dialOn(platform, [BIND_REFUSED, undefined]);
      expect(outcome.error?.code, platform).toBe("EACCES");
      expect(ports, platform).toHaveLength(1);
    }
  });

  it("never treats a destination's EACCES as a source-port problem, on Windows or anywhere", async () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      const { outcome, ports } = await dialOn(platform, ["EACCES@connect", undefined]);
      expect(outcome.error?.code, platform).toBe("EACCES");
      expect(ports, platform).toHaveLength(1);
    }
  });

  it("stops after one attempt per port when Windows excludes the whole range, and names the range and the command that lists the excluded ranges", async () => {
    const { outcome, ports } = await dialOn("win32", Array.from({ length: RANGE_WIDTH * 2 }, () => BIND_REFUSED));
    expect(ports).toHaveLength(RANGE_WIDTH);
    expect(outcome.error?.code).toBe("EACCES");
    expect(outcome.error?.message).toContain(`${String(RANGE_START)} to ${String(RANGE_END)}`);
    expect(outcome.error?.message).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
  });

  it("stops after one attempt per port when every port is held, surfacing the last bind error as before", async () => {
    const { outcome, ports } = await dialOn("linux", Array.from({ length: RANGE_WIDTH * 2 }, () => "EADDRINUSE@bind"));
    expect(ports).toHaveLength(RANGE_WIDTH);
    expect(outcome.error?.code).toBe("EADDRINUSE");
  });

  it("keeps the failing syscall through the trimming of node's local-end suffix", async () => {
    let handed: NodeJS.ErrnoException | undefined;
    const outcome = await doorDial(
      {
        connect: () => {
          const socket = new SilentSocket();
          queueMicrotask(() => {
            const failure: NodeJS.ErrnoException = new Error("bind EACCES 0.0.0.0:48000 - Local (0.0.0.0:48000)");
            failure.code = "EACCES";
            failure.syscall = "bind";
            socket.emit("error", failure);
          });
          return socket;
        },
        lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
        isIP: net.isIP,
        isSourcePortUnusable: (error) => {
          handed = error;
          return false;
        },
      },
      { host: "provider.example", port: 443 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    expect(outcome.error?.message).not.toContain("Local");
    expect(handed?.syscall).toBe("bind");
  });

  it("classifies the same from its source text alone, as the probe's worker runs it", () => {
    const isolatedClassifier = isolated(sourcePortClassifier);
    const bind: NodeJS.ErrnoException = new Error("bind");
    bind.code = "EACCES";
    bind.syscall = "bind";
    expect(isolatedClassifier("win32")(bind)).toBe(true);
    expect(isolatedClassifier("linux")(bind)).toBe(false);
  });
});
