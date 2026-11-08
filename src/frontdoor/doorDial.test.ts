import { EventEmitter } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeAddressAcceptSync } from "./probe";
import { createDoorLookup, doorDial, probeAccept, type DialSocket } from "./doorDial";
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
function manualTimer(): { readonly start: (callback: () => void, ms: number) => () => void; readonly fire: () => void; readonly armedMs: () => number | undefined } {
  let pending: (() => void) | undefined;
  let armed: number | undefined;
  return {
    start: (callback, ms) => {
      pending = callback;
      armed = ms;
      return () => {
        pending = undefined;
      };
    },
    fire: () => {
      pending?.();
    },
    armedMs: () => armed,
  };
}

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
    expect(probeAddressAcceptSync("127.0.0.1", address.port, SHORT_BOUND_MS)).toEqual({ ok: true });
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
