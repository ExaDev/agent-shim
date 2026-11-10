import type { LookupFunction } from "node:net";

/*
 * The functions below contain no `async` or `await`, so a compiler that targets a syntax older than ES2017 (a consumer bundling the library for an old runtime, or a build that instruments for coverage) has no async function to rewrite into a helper from its own scope, which the worker lacks.
 *
 * The door's own upstream dial, as functions that reference nothing but their parameters: the provider probe runs on a worker thread, which cannot load this bundle, so it embeds their source text (`Function.prototype.toString`) and calls them with the worker's own `net` and `dns`. A reference to anything outside a function's own parameters would be undefined in the worker; `doorDial.test.ts` runs each function from its source text alone to keep that true.
 */

/** The part of `dns` the door's name lookup uses. */
export interface DoorLookupIo {
  readonly isIP: (host: string) => number;
  readonly resolve4: (host: string, callback: (error: NodeJS.ErrnoException | null, addresses: readonly string[]) => void) => void;
}

/**
 * The door's lookup for its own upstream dials: an address literal as it is, `localhost` and the names under it as the loopback addresses (RFC 6761) without asking a resolver, and any other name through `dns.resolve4`, which asks the resolver directly and never reads the hosts file, because a transparent-interception deployment points the intercept hosts' names at this machine in /etc/hosts and `getaddrinfo` (Node's default lookup) would send the door's own upstream connections straight back into the intercept port. The first A record is the address dialled.
 */
export function createDoorLookup(io: DoorLookupIo): LookupFunction {
  return (host, options, reply) => {
    // Node asks for one address, `(error, address, family)`, unless `options.all` is set (autoSelectFamily on, no local address), and a callback given the wrong shape fails the dial with ERR_INVALID_IP_ADDRESS, so every answer goes through here.
    const callback = (error: Error | null, addresses: readonly { readonly address: string; readonly family: number }[]): void => {
      const first = addresses[0];
      if (error !== null || options.all === true || first === undefined) {
        reply(error, addresses.slice());
        return;
      }
      reply(null, first.address, first.family);
    };
    // An address literal is not a name to resolve; resolve4 would query DNS for it as a hostname and fail.
    const family = io.isIP(host);
    if (family !== 0) {
      callback(null, [{ address: host, family }]);
      return;
    }
    // RFC 6761 section 6.3: localhost and every name under it is the loopback host, which a resolver is not asked about (and a public one would not know): a provider on `localhost` is reached, where `dns.resolve4` alone would answer ENOTFOUND.
    const lowered = host.toLowerCase().replace(/\.$/, "");
    if (lowered === "localhost" || lowered.endsWith(".localhost")) {
      callback(null, [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]);
      return;
    }
    io.resolve4(host, (error, addresses) => {
      // The error branch first, because a failed resolve hands undefined as the addresses.
      // What the failure of a name means for this lookup, said where the failure is read: the door asks DNS for A records and nothing else, so a name only /etc/hosts or mDNS knows (an alias, a `.local` name) and a host that has only AAAA records are unreachable for the door as they are for the probe, which is no fault of the provider.
      const hint = " (the door resolves names through DNS A records only, never the hosts file or mDNS and not AAAA records: give an IPv4 address for a host DNS does not list)";
      if (error !== null) {
        // Only an absence (the name or its A records are not there) is explained by the hint; a timeout, a refusal or a server failure says nothing about which records exist, so it is reported as it is.
        if (error.code !== "ENOTFOUND" && error.code !== "ENODATA") {
          callback(error, [{ address: "", family: 4 }]);
          return;
        }
        const described = new Error(error.message + hint);
        Object.defineProperty(described, "code", { value: error.code, enumerable: true });
        callback(described, [{ address: "", family: 4 }]);
        return;
      }
      const first = addresses[0];
      if (first === undefined) {
        callback(new Error(`no A record for ${host}` + hint), [{ address: "", family: 4 }]);
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
  /** Whether a failed dial from a reserved source port failed because of that port, so the next port of the rotation is tried: see `sourcePortClassifier`. Injected so the dial reads no platform of its own. */
  readonly isSourcePortUnusable: (error: NodeJS.ErrnoException) => boolean;
}

/** A rotation of reserved source ports: the next one to bind, how many there are, and the inclusive range they come from. */
export interface PortRotation {
  readonly take: () => number;
  readonly count: number;
  readonly start: number;
  readonly end: number;
}

/**
 * The one classification of "this source port cannot be used, move on" that every rotation of reserved source ports shares, for the operating system named by `platform` (a `process.platform` value, passed in so nothing here reads the host). A port another socket holds (`EADDRINUSE`, or the `EADDRNOTAVAIL` a port held at connect time produces) is unusable everywhere. On `win32`, a port inside an excluded range (Hyper-V, WSL2 and Docker Desktop reserve blocks of ports) is refused with `EACCES` at the bind, which is also unusable; on every other platform `EACCES` is a real error and is not retried. Only a failure of the bind counts for the `EACCES` (node names the bind in the error's `syscall`): an `EACCES` from reaching the destination is never a source-port problem, whatever the platform. It references nothing but its parameters, because the probe's worker embeds its source text.
 */
export function sourcePortClassifier(platform: string): (error: NodeJS.ErrnoException) => boolean {
  const held = ["EADDRINUSE", "EADDRNOTAVAIL"];
  const excluded = platform === "win32" ? ["EACCES"] : [];
  return (error) => error.code !== undefined && (held.includes(error.code) || (error.syscall === "bind" && excluded.includes(error.code)));
}

/**
 * One of the door's own upstream dials, settled once its outcome is certain. An address literal is dialled as node's own agents would, from an ephemeral port, since nothing can be resolved or redirected about it. A name is resolved through the door's lookup and bound into the reserved source-port range (the pf exemption an interception deployment loads, keeping a redirected address's traffic from looping into the door's own transparent surface); a reserved port that cannot be used (`io.isSourcePortUnusable`: held by a long-lived sibling, or excluded by the operating system) is retried on the next port of the rotation, one attempt per port, so a fully-unusable range surfaces its last bind error instead of spinning, and a range that is excluded throughout surfaces an `EACCES` naming the range and the command that lists the excluded ranges. Every other failure settles as a bare dial's would.
 */
export function doorDial<S extends DialSocket>(io: DoorDialIo<S>, target: { readonly host: string; readonly port: number }, ports: PortRotation): Promise<DialOutcome<S>> {
  const dialOnce = (options: Parameters<DoorDialIo<S>["connect"]>[0]): Promise<DialOutcome<S>> =>
    new Promise((resolve) => {
      const socket = io.connect(options);
      socket.once("connect", () => {
        resolve({ error: null, socket });
      });
      socket.once("error", (error) => {
        // Node appends the local end of the connection (` - Local (0.0.0.0:48767)`) to a connect error's message once the dial binds a source port, and the port differs on every run, so the reason the probe, `doctor` and the door's answer give would change from one run to the next: it is dropped, and the remote address and the code say what failed.
        const withoutLocalEnd = (message: string): string => message.replace(/ - Local \([^)]*\)/gu, "");
        // A name that resolves to several addresses (`localhost`: 127.0.0.1 and ::1) is dialled by trying each, and when every attempt fails node emits an AggregateError whose own message is empty: its reason is the attempts' reasons, joined, with the code kept, so no report built from `message` ends on "ECONNREFUSED: ".
        const attempts: unknown = Reflect.get(error, "errors");
        if (error.message === "" && Array.isArray(attempts) && attempts.length > 0) {
          const flattened: NodeJS.ErrnoException = new Error(attempts.map((attempt: unknown) => withoutLocalEnd(attempt instanceof Error ? attempt.message : String(attempt))).join("; "));
          flattened.code = error.code;
          flattened.syscall = error.syscall;
          resolve({ error: flattened, socket });
          return;
        }
        if (withoutLocalEnd(error.message) !== error.message) {
          const trimmed: NodeJS.ErrnoException = new Error(withoutLocalEnd(error.message));
          trimmed.code = error.code;
          trimmed.syscall = error.syscall;
          resolve({ error: trimmed, socket });
          return;
        }
        resolve({ error, socket });
      });
    });
  if (io.isIP(target.host) !== 0) {
    return dialOnce({ host: target.host, port: target.port });
  }
  // The rotation advances one full cycle over exactly the range's width of calls, so one attempt per port bounds the retry.
  const attemptFrom = (attempt: number): Promise<DialOutcome<S>> =>
    dialOnce({ host: target.host, port: target.port, localPort: ports.take(), lookup: io.lookup }).then((outcome) => {
      if (outcome.error === null) {
        return outcome;
      }
      if (!io.isSourcePortUnusable(outcome.error)) {
        return outcome;
      }
      if (attempt < ports.count - 1) {
        return attemptFrom(attempt + 1);
      }
      if (outcome.error.code !== "EACCES") {
        return outcome;
      }
      // Every port of the range was refused with EACCES: only an operating system that excludes port ranges does that, so the report names the range and the command that lists what the system excludes.
      const excluded: NodeJS.ErrnoException = new Error(
        `every source port of the door's reserved range (${String(ports.start)} to ${String(ports.end)}) was refused with EACCES, which Windows answers for a port inside an excluded range (Hyper-V, WSL2 and Docker Desktop reserve blocks of ports): list the excluded ranges with \`netsh int ipv4 show excludedportrange protocol=tcp\``,
      );
      excluded.code = "EACCES";
      return { error: excluded, socket: outcome.socket };
    });
  return attemptFrom(0);
}

/** Starts a timer and returns what cancels it: the clock the probe's bound runs on, injected so a test can fire it. */
export type StartTimer = (callback: () => void, ms: number) => () => void;

/** An accept probe's verdict: accepted, or why not. */
export type AcceptVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether the door's dial (`dial`, `doorDial` over the real `net`) reaches `target` within `timeoutMs`. Nothing is written to the socket: it is closed the moment it connects, so the listener sees a connection open and close and no request. A dial still pending when the bound expires fails the probe, and its socket is closed whenever it settles.
 */
export function probeAccept<S extends DialSocket>(dial: () => Promise<DialOutcome<S>>, timeoutMs: number, startTimer: StartTimer): Promise<AcceptVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const cancel = startTimer(() => {
      settled = true;
      resolve({ ok: false, reason: `no connection accepted within ${String(timeoutMs)}ms` });
    }, timeoutMs);
    void dial().then(
      (outcome) => {
        outcome.socket.destroy();
        if (settled) {
          return;
        }
        settled = true;
        cancel();
        resolve(outcome.error === null ? { ok: true } : { ok: false, reason: [outcome.error.code, outcome.error.message].filter((part) => part !== undefined && part !== "").join(": ") || "the connection failed with no reason given" });
      },
      // A dial that throws before it has a socket (a port the system refuses to connect to) rejects: that is the probe's answer, with the reason, not an unhandled rejection in the worker.
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cancel();
        resolve({ ok: false, reason: (error instanceof Error ? error.message : String(error)) || "the dial failed with no reason given" });
      },
    );
  });
}

/** The modules the probe's setup draws on, and the door's dial functions it assembles them with: all passed in, because the probe's worker embeds `runAcceptProbe` as source text and so cannot import them. */
export interface AcceptProbeDeps {
  readonly net: { readonly connect: DoorDialIo<DialSocket>["connect"]; readonly isIP: (host: string) => number };
  readonly dns: { readonly resolve4: DoorLookupIo["resolve4"] };
  readonly createDoorLookup: typeof createDoorLookup;
  readonly doorDial: typeof doorDial;
  readonly probeAccept: typeof probeAccept;
  readonly SourcePortRange: new (start: number, end: number, first?: number) => PortRotation;
  readonly sourcePortClassifier: typeof sourcePortClassifier;
}

/**
 * The accept probe's whole setup, as the worker runs it: the door's lookup over `dns.resolve4` (never the hosts file) and the door's reserved source-port range, handed to the door's own dial. It is the one place the probe's dial is assembled, so a test of it with fake modules pins that the probe dials as the door does.
 */
export function runAcceptProbe(deps: AcceptProbeDeps, data: { readonly host: string; readonly port: number; readonly portStart: number; readonly portEnd: number; readonly portFirst?: number; readonly platform: string; readonly timeoutMs: number }, startTimer: StartTimer): Promise<AcceptVerdict> {
  const lookup = deps.createDoorLookup({ isIP: deps.net.isIP, resolve4: (name, callback) => { deps.dns.resolve4(name, callback); } });
  const io = { connect: (options: Parameters<DoorDialIo<DialSocket>["connect"]>[0]) => deps.net.connect(options), lookup, isIP: deps.net.isIP, isSourcePortUnusable: deps.sourcePortClassifier(data.platform) };
  return deps.probeAccept(() => deps.doorDial(io, { host: data.host, port: data.port }, new deps.SourcePortRange(data.portStart, data.portEnd, data.portFirst)), data.timeoutMs, startTimer);
}
