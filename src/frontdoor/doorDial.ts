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
  /** Why a failed dial from a reserved source port failed because of that port, so the next port of the rotation is tried, or undefined when it failed for any other reason: see `sourcePortClassifier`. Injected so the dial reads no platform of its own. */
  readonly sourcePortFailure: (error: NodeJS.ErrnoException) => SourcePortFailure | undefined;
}

/** Why a source port could not be used: another socket holds it (`held`, which passes as that socket closes), or the operating system refuses to bind it at all (`excluded`, which holds until the system's configuration changes). */
export type SourcePortFailure = "held" | "excluded";

/** A rotation of reserved source ports: the next one to bind, how many there are, the inclusive range they come from, and a memory of the ports the system refuses to bind, which `take` then skips. */
export interface PortRotation {
  readonly take: () => number;
  readonly exclude: (port: number) => void;
  readonly count: number;
  readonly start: number;
  readonly end: number;
}

/**
 * The one classification of "this source port cannot be used, move on" that every rotation of reserved source ports shares, for the operating system named by `platform` (a `process.platform` value, passed in so nothing here reads the host). It answers `held` for a port another socket holds (`EADDRINUSE`, or the `EADDRNOTAVAIL` a port held at connect time produces) on every platform; `excluded` for `EACCES` at the bind on `win32` only, where a port inside an excluded range (Hyper-V, WSL2 and Docker Desktop reserve blocks of ports) is refused that way; and undefined for everything else, so on every other platform `EACCES` at a bind is a real error. A destination's `EACCES` is never a source-port problem on any platform: node names the failing syscall, and only `bind` counts.
 *
 * A name that resolves to several addresses is dialled by trying each, and node then rejects with an `AggregateError` whose own code and syscall say nothing reliable (its `errors` hold each attempt's). Such an error is judged by its attempts: it is a source-port failure when ANY attempt was one, because a different source port can let that address succeed (a v4-only listener reached by `localhost` answers the `::1` attempt with a refusal and the `127.0.0.1` attempt fails on a held source port, and moving on is right); it is not when every attempt failed for another reason, where no source port would have helped. One `excluded` attempt makes the whole `excluded`. The retry stays bounded by the rotation's width.
 *
 * It references nothing but its parameters, because the probe's worker embeds its source text.
 */
export function sourcePortClassifier(platform: string): (error: NodeJS.ErrnoException) => SourcePortFailure | undefined {
  const classify = (error: NodeJS.ErrnoException): SourcePortFailure | undefined => {
    const attempts: unknown = Reflect.get(error, "errors");
    if (Array.isArray(attempts) && attempts.length > 0) {
      const kinds = attempts.map((attempt: unknown) => (attempt instanceof Error ? classify(attempt) : undefined));
      return kinds.includes("excluded") ? "excluded" : kinds.includes("held") ? "held" : undefined;
    }
    if (error.code === "EADDRINUSE" || error.code === "EADDRNOTAVAIL") {
      return "held";
    }
    return platform === "win32" && error.code === "EACCES" && error.syscall === "bind" ? "excluded" : undefined;
  };
  return classify;
}

/**
 * One of the door's own upstream dials, settled once its outcome is certain. An address literal is dialled as node's own agents would, from an ephemeral port, since nothing can be resolved or redirected about it. A name is resolved through the door's lookup and bound into the reserved source-port range (the pf exemption an interception deployment loads, keeping a redirected address's traffic from looping into the door's own transparent surface); a reserved port that cannot be used (`io.sourcePortFailure`: held by a long-lived sibling, or excluded by the operating system) is retried on the next port of the rotation, one attempt per port, so a fully-unusable range surfaces its last bind error instead of spinning, and a range the system refused to bind surfaces an error naming the range and the command that lists the excluded ranges. A port the system refuses is remembered by the rotation (`exclude`) and skipped by later dials. Every other failure settles as a bare dial's would.
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
          Object.defineProperty(flattened, "errors", { value: attempts });
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
  // The rotation advances one full cycle over exactly the range's width of calls, so one attempt per port bounds the retry. `refused` counts the attempts the system refused to bind (excluded ports), so a final report says what happened to the range and not what happened to its last port.
  const attemptFrom = (attempt: number, refused: number): Promise<DialOutcome<S>> => {
    const port = ports.take();
    return dialOnce({ host: target.host, port: target.port, localPort: port, lookup: io.lookup }).then((outcome) => {
      if (outcome.error === null) {
        return outcome;
      }
      const failure = io.sourcePortFailure(outcome.error);
      if (failure === undefined) {
        return outcome;
      }
      if (failure === "excluded") {
        ports.exclude(port);
      }
      const refusedSoFar = failure === "excluded" ? refused + 1 : refused;
      if (attempt < ports.count - 1) {
        return attemptFrom(attempt + 1, refusedSoFar);
      }
      if (refusedSoFar === 0) {
        return outcome;
      }
      // Windows is the only platform that answers a bind with an excluded-range refusal, so the report names what it excludes and the command that lists it, and says whether the range was refused throughout or only in part.
      const scope = refusedSoFar === ports.count ? "every source port" : `${String(refusedSoFar)} of its ${String(ports.count)} source ports (the rest were held by other sockets)`;
      const refusal: NodeJS.ErrnoException = new Error(
        `${scope} of the door's reserved range (${String(ports.start)} to ${String(ports.end)}) could not be bound: Windows refuses a port inside an excluded range with EACCES (Hyper-V, WSL2 and Docker Desktop reserve blocks of ports). List the excluded ranges with \`netsh int ipv4 show excludedportrange protocol=tcp\``,
      );
      refusal.code = refusedSoFar === ports.count ? "EACCES" : outcome.error.code;
      return { error: refusal, socket: outcome.socket };
    });
  };
  return attemptFrom(0, 0);
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
  const io = { connect: (options: Parameters<DoorDialIo<DialSocket>["connect"]>[0]) => deps.net.connect(options), lookup, isIP: deps.net.isIP, sourcePortFailure: deps.sourcePortClassifier(data.platform) };
  return deps.probeAccept(() => deps.doorDial(io, { host: data.host, port: data.port }, new deps.SourcePortRange(data.portStart, data.portEnd, data.portFirst)), data.timeoutMs, startTimer);
}
