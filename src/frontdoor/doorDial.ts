import type { LookupFunction } from "node:net";

/*
 * The door's own upstream dial, as functions that reference nothing but their parameters: the provider probe runs on a worker thread, which cannot load this bundle, so it embeds their source text (`Function.prototype.toString`) and calls them with the worker's own `net` and `dns`. A reference to anything outside a function's own parameters would be undefined in the worker; `doorDial.test.ts` runs each function from its source text alone to keep that true.
 */

/** The part of `dns` the door's name lookup uses. */
export interface DoorLookupIo {
  readonly isIP: (host: string) => number;
  readonly resolve4: (host: string, callback: (error: NodeJS.ErrnoException | null, addresses: readonly string[]) => void) => void;
}

/**
 * The door's lookup for its own upstream dials: an address literal as it is, and a name through `dns.resolve4`, which asks the resolver directly and never reads the hosts file, because a transparent-interception deployment points the intercept hosts' names at this machine in /etc/hosts and `getaddrinfo` (Node's default lookup) would send the door's own upstream connections straight back into the intercept port. The first A record is the address dialled.
 */
export function createDoorLookup(io: DoorLookupIo): LookupFunction {
  return (host, _options, callback) => {
    // An address literal is not a name to resolve; resolve4 would query DNS for it as a hostname and fail.
    const family = io.isIP(host);
    if (family !== 0) {
      callback(null, [{ address: host, family }]);
      return;
    }
    io.resolve4(host, (error, addresses) => {
      // The error branch first, because a failed resolve hands undefined as the addresses.
      if (error !== null) {
        callback(error, [{ address: "", family: 4 }]);
        return;
      }
      const first = addresses[0];
      if (first === undefined) {
        callback(new Error(`no A record for ${host}`), [{ address: "", family: 4 }]);
        return;
      }
      callback(null, [{ address: first, family: 4 }]);
    });
  };
}

/** What a dialled socket must offer the dial: its lifecycle events, and closing it. */
export interface DialSocket {
  readonly once: ((event: "connect", listener: () => void) => unknown) & ((event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown);
  readonly destroy: () => unknown;
}

/** One dial's settled outcome: the socket with no error once its connection is established, or the socket the failure stopped on (dead by then) beside the error. The failed socket rides along because node's agent callback takes both, and ignores the socket whenever an error is set. */
export type DialOutcome<S extends DialSocket> = { readonly error: null; readonly socket: S } | { readonly error: NodeJS.ErrnoException; readonly socket: S };

/** What the dial needs: a connect, the door's lookup, and how to tell an address literal from a name. */
export interface DoorDialIo<S extends DialSocket> {
  readonly connect: (options: { readonly host: string; readonly port: number; readonly localPort?: number; readonly lookup?: LookupFunction }) => S;
  readonly lookup: LookupFunction;
  readonly isIP: (host: string) => number;
}

/** A rotation of reserved source ports: the next one to bind, and how many there are. */
export interface PortRotation {
  readonly take: () => number;
  readonly count: number;
}

/**
 * One of the door's own upstream dials, settled once its outcome is certain. An address literal is dialled as node's own agents would, from an ephemeral port, since nothing can be resolved or redirected about it. A name is resolved through the door's lookup and bound into the reserved source-port range (the pf exemption an interception deployment loads, keeping a redirected address's traffic from looping into the door's own transparent surface); a reserved port a long-lived sibling already holds (EADDRINUSE, or the EADDRNOTAVAIL a port held at connect time produces) is retried on the next port of the rotation, one attempt per port, so a fully-held range surfaces the last bind error instead of spinning. Every other failure settles as a bare dial's would.
 */
export async function doorDial<S extends DialSocket>(io: DoorDialIo<S>, target: { readonly host: string; readonly port: number }, ports: PortRotation): Promise<DialOutcome<S>> {
  const dialOnce = async (options: Parameters<DoorDialIo<S>["connect"]>[0]): Promise<DialOutcome<S>> =>
    await new Promise((resolve) => {
      const socket = io.connect(options);
      socket.once("connect", () => {
        resolve({ error: null, socket });
      });
      socket.once("error", (error) => {
        resolve({ error, socket });
      });
    });
  if (io.isIP(target.host) !== 0) {
    return await dialOnce({ host: target.host, port: target.port });
  }
  // The rotation advances one full cycle over exactly the range's width of calls, so one attempt per port bounds the retry.
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await dialOnce({ host: target.host, port: target.port, localPort: ports.take(), lookup: io.lookup });
    if (outcome.error === null) {
      return outcome;
    }
    const held = outcome.error.code === "EADDRINUSE" || outcome.error.code === "EADDRNOTAVAIL";
    if (!held || attempt === ports.count - 1) {
      return outcome;
    }
  }
}

/** Starts a timer and returns what cancels it: the clock the probe's bound runs on, injected so a test can fire it. */
export type StartTimer = (callback: () => void, ms: number) => () => void;

/** An accept probe's verdict: accepted, or why not. */
export type AcceptVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether the door's dial (`dial`, `doorDial` over the real `net`) reaches `target` within `timeoutMs`. Nothing is written to the socket: it is closed the moment it connects, so the listener sees a connection open and close and no request. A dial still pending when the bound expires fails the probe, and its socket is closed whenever it settles.
 */
export async function probeAccept<S extends DialSocket>(dial: () => Promise<DialOutcome<S>>, timeoutMs: number, startTimer: StartTimer): Promise<AcceptVerdict> {
  return await new Promise((resolve) => {
    let settled = false;
    const cancel = startTimer(() => {
      settled = true;
      resolve({ ok: false, reason: `no connection accepted within ${String(timeoutMs)}ms` });
    }, timeoutMs);
    void dial().then((outcome) => {
      outcome.socket.destroy();
      if (settled) {
        return;
      }
      settled = true;
      cancel();
      resolve(outcome.error === null ? { ok: true } : { ok: false, reason: `${outcome.error.code === undefined ? "" : `${outcome.error.code}: `}${outcome.error.message}` });
    });
  });
}
