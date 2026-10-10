// The module object itself, not a namespace import: dns.setServers rebinds module.exports' resolve functions, and a namespace import would keep the binding captured at import time, so only a live property read honours a resolver reconfigured later (which is how the regression test's resolver stand-in redirects the door's name dials at loopback).
import dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import * as net from "node:net";
import * as tls from "node:tls";

import { HTTP_STATUS } from "../codex/http";
import { CONNECT_INTERCEPT_HOST, HTTPS_PORT, HTTP_BAD_GATEWAY, forwardableHeaders, type ConnectEffects, type ConnectListenerHandle } from "./connect";
import type { RcDialAnswer, RcEventDial } from "./rcWrites";
import { buildRcMarkReadBody } from "./rcWrites";
import type { RcStreamDial } from "./rcStream";
import { upstreamChunks } from "./server";

/** The exclusive ceiling of the 2xx success class, whose bounds are fixed hundreds (RFC 9110 section 15); named once so a range check never carries a bare literal. */
const SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** Whether a status is a 2xx success. */
function isSuccessful(status: number): boolean {
  return status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_MAX_EXCLUSIVE;
}

/** The real `ConnectEffects` over node's own net, tls, and http. `connectTcp` opens real connections to the CONNECTed host, so tests that want a blind tunnel redirect it. */
/**
 * A DNS lookup for the door's own upstream dials that bypasses the hosts file, because a transparent-interception deployment points the intercept hosts' names at this machine in /etc/hosts: getaddrinfo (Node's default lookup) would send the door's own upstream connections straight back into the intercept port, a loop, while `dns.resolve4` asks the resolver directly and returns the real address. The SNI and Host stay the real name; only the dial address comes from DNS.
 */

/**
 * A range of local source ports the door's own upstream sockets bind, handed out in rotation because node binds one port per socket with no range option. The width is also the dial's retry bound: one attempt per port, so a fully-held range surfaces its last bind error instead of spinning. Injectable so the exhaustion tests hold a private range instead of racing every other worker for the door's real one.
 */
export class SourcePortRange {
  readonly count: number;
  private next: number;

  constructor(
    readonly start: number,
    readonly end: number,
  ) {
    this.count = end - start + 1;
    this.next = start;
  }

  /** The next port in rotation, wrapping from the end back to the start. */
  take(): number {
    const port = this.next;
    this.next = this.next === this.end ? this.start : this.next + 1;
    return port;
  }
}

/**
 * The first port of the door's reserved source range. The range must stay below the operating system's ephemeral range (49152 upward on macOS and per IANA), so nothing else on the machine is ever handed a port the door's rotation may hold.
 */
const DOOR_SOURCE_PORT_START = 47900;

/**
 * How many source ports the door reserves. A closed upstream connection keeps its local port out of use for the TCP TIME_WAIT interval (twice the maximum segment lifetime, 30 s on macOS), so a range sustains about its width divided by that interval in new connections per second; a Remote Control fleet of concurrent sessions each holding a read stream and posting receipts needs far more than a few dozen ports. The range ends at 48899, short of the ephemeral start.
 */
const DOOR_SOURCE_PORT_COUNT = 1000;

/** The last port of the door's reserved source range, inclusive. */
const DOOR_SOURCE_PORT_END = DOOR_SOURCE_PORT_START + DOOR_SOURCE_PORT_COUNT - 1;

/** The pf exemption an interception deployment loads alongside the redirect covers exactly this range: without it, the door's dial to the real address would be redirected straight back into its own transparent surface, an endless loop. */
const DOOR_SOURCE_PORTS = new SourcePortRange(DOOR_SOURCE_PORT_START, DOOR_SOURCE_PORT_END);

/**
 * How long a pooled connection may sit idle before the agent closes it. An idle socket holds a reserved source port, and an intermediary (a NAT, a load balancer) can drop an idle flow without telling either end, so a pooled connection is retired well inside the shortest idle timeout those commonly apply (60 s) instead of being reused dead.
 */
const POOLED_SOCKET_IDLE_MS = 30_000;

/** How many idle connections one agent keeps pooled: enough to serve a session's sequential requests over one connection, while every further idle connection would only hold a port. */
const POOLED_SOCKETS_KEPT_IDLE = 2;

/** The pooling both exempt agents share: without `keepAlive` node's agent opens a fresh connection (and so takes a fresh reserved port) for every request, which is what exhausted the range under per-chunk receipts and per-turn presence calls. */
const POOLING = { keepAlive: true, timeout: POOLED_SOCKET_IDLE_MS, maxFreeSockets: POOLED_SOCKETS_KEPT_IDLE } as const;

const realAddressLookup: LookupFunction = (host, _options, callback) => {
  // An address literal is not a name to resolve; resolve4 would query DNS for it as a hostname and fail. Hand it straight back, so a loopback or otherwise-literal upstream (every test's local fake, and any loopback provider) keeps working under this lookup.
  if (net.isIP(host) !== 0) {
    callback(null, [{ address: host, family: net.isIP(host) }]);
    return;
  }
  dns.resolve4(host, (error, addresses) => {
    // The error branch first, because a failed resolve hands undefined as the addresses: reading the first address before checking would crash on it instead of surfacing the lookup's own failure.
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

/** The default port a plain-HTTP dial lands on when the request names none. */
const HTTP_PORT = 80;

/**
 * The errnos that mean this reserved port cannot serve this dial, so the next port of the range is worth trying: EADDRINUSE is the documented bind conflict, and EADDRNOTAVAIL is the form a port held by a long-lived sibling produces at connect time (the live observation behind the retry). Every other failure is a port-independent problem and surfaces unchanged.
 */
const HELD_PORT_ERRNOS: ReadonlySet<string> = new Set(["EADDRINUSE", "EADDRNOTAVAIL"]);

/** One dial's settled outcome: the socket with no error once its connection is established, or the socket the failure stopped on (dead by then) beside the error. The failed socket rides along because node's agent callback takes both, and ignores the socket whenever an error is set (exactly how node's own proxied https dial reports a failed tunnel). */
type DialOutcome = { readonly error: null; readonly socket: net.Socket } | { readonly error: NodeJS.ErrnoException; readonly socket: net.Socket };

/** Dials once and settles only once the outcome is certain, so a bind-phase failure can be told apart from a connection that is merely still coming up. */
async function dialOnce(connectOptions: net.TcpSocketConnectOpts): Promise<DialOutcome> {
  return await new Promise((resolve) => {
    const socket = net.connect(connectOptions);
    socket.once("connect", () => {
      resolve({ error: null, socket });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ error, socket });
    });
  });
}

/** Where one of the door's own upstream dials is headed: the request's own host and port, with the protocol's default when the request names none. */
function dialTarget(options: http.ClientRequestArgs, defaultPort: number): { readonly host: string; readonly port: number } {
  return { host: typeof options.host === "string" ? options.host : "", port: typeof options.port === "number" ? options.port : defaultPort };
}

/**
 * One of the door's own upstream dials for an address literal, dialled exactly as node's own agents would: no reserved source port, because an OS-chosen ephemeral port cannot be held against the dial, so there is nothing to settle or retry and the socket is returned still connecting, keeping the loopback and literal hot paths at their original shape and cost.
 */
function literalDial(target: { readonly host: string; readonly port: number }): net.Socket {
  return net.connect({ host: target.host, port: target.port });
}

/**
 * One of the door's own upstream dials for a real name: bound into the reserved source-port range and resolved through real DNS (the pf-exemption counterparts, keeping a redirected address's traffic from looping into the door's own transparent surface, which no address literal can name).
 *
 * The dial settles only once its outcome is certain, and a reserved port a long-lived sibling already holds (EADDRINUSE, or the EADDRNOTAVAIL of the live observation) is retried on the next port of the rotation, one attempt per port of the range, so a fully-held range surfaces the last bind error instead of spinning. Every other failure (a refused connection, a TLS fault) settles exactly as a bare dial's would.
 */
async function reservedDial(target: { readonly host: string; readonly port: number }, ports: SourcePortRange): Promise<DialOutcome> {
  // The rotation advances one full cycle over exactly the range's width of calls, so one attempt per port bounds the retry: the last attempt has tried every port once.
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await dialOnce({ host: target.host, port: target.port, localPort: ports.take(), lookup: realAddressLookup });
    if (outcome.error === null) {
      return outcome;
    }
    const held = outcome.error.code !== undefined && HELD_PORT_ERRNOS.has(outcome.error.code);
    // A failure that is not a held port, or a range whose every port has been tried once: this dial's own settled failure is the honest one to hand back.
    if (!held || attempt === ports.count - 1) {
      return outcome;
    }
  }
}

/**
 * The request's own servername (which a forwarding target may set to the real host it stands in for) outranks the dial address: presenting the dial address instead would fail the handshake against a stand-in whose certificate names the real host.
 */
function requestServername(options: http.ClientRequestArgs, fallback: string): string {
  return "servername" in options && typeof options.servername === "string" && options.servername !== "" ? options.servername : fallback;
}

/** The plain-HTTP sibling; http.Agent and https.Agent each carry their protocol, and one cannot serve the other's requests. */
export class ExemptHttpAgent extends http.Agent {
  constructor(private readonly ports: SourcePortRange = DOOR_SOURCE_PORTS) {
    super(POOLING);
  }

  // A reserved-port dial that has to retry cannot produce its socket synchronously, so it settles first and arrives through the callback (node's documented asynchronous createConnection form); a literal dial has nothing to retry and keeps node's own synchronous shape.
  createConnection(options: http.ClientRequestArgs, oncreate?: (error: Error | null, socket: net.Socket) => void): net.Socket | undefined {
    const target = dialTarget(options, HTTP_PORT);
    if (net.isIP(target.host) !== 0) {
      return literalDial(target);
    }
    void reservedDial(target, this.ports).then((outcome) => {
      oncreate?.(outcome.error, outcome.socket);
    });
    return undefined;
  }
}

/** The TLS sibling: the door's keep-alive agent for https upstreams, every real-name socket in the pf-exempt source-port range. */
export class ExemptTlsAgent extends https.Agent {
  constructor(private readonly ports: SourcePortRange = DOOR_SOURCE_PORTS) {
    super(POOLING);
  }

  // The same split as the plain sibling: a literal dial wraps TLS around the socket node's own agent would have returned, a reserved dial settles (retries included) first and arrives through the callback, which is exactly where node's own agent wraps its own dials.
  createConnection(options: http.ClientRequestArgs, oncreate?: (error: Error | null, socket: net.Socket) => void): net.Socket | undefined {
    const target = dialTarget(options, HTTPS_PORT);
    if (net.isIP(target.host) !== 0) {
      return tls.connect({ socket: literalDial(target), servername: requestServername(options, target.host), ...tlsFacts(options) });
    }
    void reservedDial(target, this.ports).then((outcome) => {
      if (outcome.error !== null) {
        oncreate?.(outcome.error, outcome.socket);
        return;
      }
      oncreate?.(null, tls.connect({ socket: outcome.socket, servername: requestServername(options, target.host), ...tlsFacts(options) }));
    });
    return undefined;
  }
}

/**
 * The request's own TLS facts (a forwarding target's servername, its trust anchors for a stand-in upstream, its verification stance): node's own agent consumes them from the options, so this one must too.
 */
function tlsFacts(options: http.ClientRequestArgs): Pick<tls.ConnectionOptions, "ca" | "rejectUnauthorized"> {
  const facts: Pick<tls.ConnectionOptions, "ca" | "rejectUnauthorized"> = {};
  if ("ca" in options && Array.isArray(options.ca)) {
    facts.ca = options.ca;
  }
  if ("rejectUnauthorized" in options && typeof options.rejectUnauthorized === "boolean") {
    facts.rejectUnauthorized = options.rejectUnauthorized;
  }
  return facts;
}

/** Where the Remote Control inject path dials: the API host's own address by default, over TLS with the door's interception-proof agent (real-name DNS resolution and the pf-exempt source-port range), so an injected event cannot be looped back into the door's own transparent surface. A test redirects the dial at a local stand-in presenting the host's name, exactly as the forwarding targets are redirected. */
export interface RcDialTarget {
  readonly host: string;
  readonly port: number;
  /** The SNI name to present; defaults to `host`. */
  readonly servername?: string;
  /** Extra trust anchors for a stand-in's certificate, when it is not system-trusted. */
  readonly ca?: readonly string[];
  /** Overrides certificate verification; production leaves it at the Node default. */
  readonly rejectUnauthorized?: boolean;
}

/**
 * The real `RcEventDial`: one keep-alive TLS agent of the door's own exempt kind, so every injected event rides the same interception-proof dials the door's forwarded traffic does. The dial only ever reads small JSON answers (an event write's result, or an error), never a stream.
 */
export function realRcEventDial(target: RcDialTarget = { host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT }): RcEventDial {
  const agent = new ExemptTlsAgent();
  const post = async (path: string, headers: Readonly<Record<string, string>>, body: string): Promise<RcDialAnswer> =>
    await new Promise<RcDialAnswer>((resolve, reject) => {
      const options: https.RequestOptions = {
        host: target.host,
        port: target.port,
        method: "POST",
        path,
        // The Host header names the host whose API this is, not the address dialled: a redirected test dials a loopback stand-in while still speaking to the API host by name, exactly as the forwarded paths present their SNI.
        headers: { ...headers, host: target.servername ?? target.host, "content-length": String(Buffer.byteLength(body, "utf8")) },
        agent,
      };
      // The request's own TLS facts ride in the options (a stand-in's servername, its trust anchors, its verification stance), exactly as the forwarding target's do.
      options.servername = target.servername ?? target.host;
      if (target.ca !== undefined) {
        options.ca = [...target.ca];
      }
      if (target.rejectUnauthorized !== undefined) {
        options.rejectUnauthorized = target.rejectUnauthorized;
      }
      const request = https.request(options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? HTTP_BAD_GATEWAY, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  return {
    writeEvents: async (sessionId, headers, body) => await post(`/v1/code/sessions/${encodeURIComponent(sessionId)}/events`, headers, body),
    writeTeleportEvents: async (sessionId, headers, body) => await post(`/v1/code/sessions/${encodeURIComponent(sessionId)}/teleport-events`, headers, body),
  };
}

/**
 * The real `RcStreamDial`: the client read stream half's own dials, over the same interception-proof TLS agent the write path uses so the stream cannot be looped back into the door's own transparent surface. The presence call is one small JSON exchange; the stream request is answered chunk by chunk as the host sends them, never buffered, because the whole point of holding it open is to see events as they arrive. A non-2xx stream answer is drained and returned with no chunks (its body is one small error document), and the abort signal tears the request down wherever it is, which is how the door stops an attachment without waiting for the host to speak.
 */
/** An empty byte stream: what a non-2xx stream answer's chunks resolve to, its real body having been drained into the answer's error report. */
const NO_CHUNKS: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
    next: async () => await Promise.resolve({ done: true, value: undefined }),
  }),
};

/**
 * A write dial whose target is resolved at call time rather than construction: the self-hosted Remote Control mode points the door's client half at the door's own transparent surface, whose port is known only once the connect listener has bound, and every other caller keeps the construction-time target (or the default real host when the resolver has nothing yet). The underlying dial is built once per resolved target and reused, so the connection pooling a dial exists for is preserved.
 */
export function lateRcEventDial(resolve: () => RcDialTarget | undefined): RcEventDial {
  let built: { readonly for: RcDialTarget | undefined; readonly dial: RcEventDial } | undefined;
  const dialFor = (): RcEventDial => {
    const target = resolve();
    if (built === undefined || built.for !== target) {
      built = { for: target, dial: realRcEventDial(target) };
    }
    return built.dial;
  };
  return {
    writeEvents: async (sessionId, headers, body) => await dialFor().writeEvents(sessionId, headers, body),
    writeTeleportEvents: async (sessionId, headers, body) => await dialFor().writeTeleportEvents(sessionId, headers, body),
  };
}

/**
 * The stream dial's own late-targeted sibling, for the same reason: the self-hosted mode's attachment stream dials the door's own transparent surface once its port is bound.
 */
export function lateRcStreamDial(resolve: () => RcDialTarget | undefined): RcStreamDial {
  let built: { readonly for: RcDialTarget | undefined; readonly dial: RcStreamDial } | undefined;
  const dialFor = (): RcStreamDial => {
    const target = resolve();
    if (built === undefined || built.for !== target) {
      built = { for: target, dial: realRcStreamDial(target) };
    }
    return built.dial;
  };
  return {
    announcePresence: async (sessionId, headers, clientId, clear) => await dialFor().announcePresence(sessionId, headers, clientId, clear),
    markRead: async (sessionId, headers, eventId) => await dialFor().markRead(sessionId, headers, eventId),
    openStream: async (sessionId, headers, resume, signal) => await dialFor().openStream(sessionId, headers, resume, signal),
  };
}

export function realRcStreamDial(target: RcDialTarget = { host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT }): RcStreamDial {
  const agent = new ExemptTlsAgent();
  const request = async (method: "GET" | "POST", path: string, headers: Readonly<Record<string, string>>, body: string | undefined, signal: AbortSignal): Promise<{ readonly status: number; readonly response: http.IncomingMessage }> =>
    await new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        host: target.host,
        port: target.port,
        method,
        path,
        // The Host header names the host whose API this is, not the address dialled: a redirected test dials a loopback stand-in while still speaking to the API host by name, exactly as the forwarded paths present their SNI.
        headers: { ...headers, host: target.servername ?? target.host, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body, "utf8")) }) },
        agent,
        signal,
      };
      // The request's own TLS facts ride in the options (a stand-in's servername, its trust anchors, its verification stance), exactly as the write dial's do.
      options.servername = target.servername ?? target.host;
      if (target.ca !== undefined) {
        options.ca = [...target.ca];
      }
      if (target.rejectUnauthorized !== undefined) {
        options.rejectUnauthorized = target.rejectUnauthorized;
      }
      const sent = https.request(options, (response) => {
        resolve({ status: response.statusCode ?? HTTP_BAD_GATEWAY, response });
      });
      sent.once("error", reject);
      if (body === undefined) {
        sent.end();
      } else {
        sent.end(body);
      }
    });
  const readAll = async (response: http.IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of upstreamChunks(response)) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  return {
    announcePresence: async (sessionId, headers, clientId, clear) => {
      // The presence body the CLI's own sender posts (verified in the 2.1.289 bundle): the client id and the clear flag, the flag a pulse omits-by-false and a teardown posts true.
      const body = JSON.stringify({ client_id: clientId, clear });
      const { status, response } = await request("POST", `/v1/code/sessions/${encodeURIComponent(sessionId)}/client/presence`, { ...headers, "content-type": "application/json" }, body, new AbortController().signal);
      return { status, body: await readAll(response) };
    },
    markRead: async (sessionId, headers, eventId) => {
      // The receipt body the CLI's own remote-client half posts (`markSessionRead`, verified in the 2.1.289 bundle), built by the one builder so every surface posts the same shape.
      const body = JSON.stringify(buildRcMarkReadBody(eventId));
      const { status, response } = await request("POST", `/v1/code/sessions/${encodeURIComponent(sessionId)}/mark_read`, { ...headers, "content-type": "application/json" }, body, new AbortController().signal);
      return { status, body: await readAll(response) };
    },
    openStream: async (sessionId, headers, resume, signal) => {
      // The protocol's documented resume rule: the query parameter and the header are sent together, naming the sequence number to continue after. An attachment that has seen no events yet sends neither and reads from the stream's own head.
      const path = resume === undefined ? `/v1/code/sessions/${encodeURIComponent(sessionId)}/events/stream` : `/v1/code/sessions/${encodeURIComponent(sessionId)}/events/stream?from_sequence_num=${String(resume.fromSequenceNum)}`;
      const streamHeaders = resume === undefined ? headers : { ...headers, "last-event-id": String(resume.fromSequenceNum) };
      const { status, response } = await request("GET", path, streamHeaders, undefined, signal);
      if (!isSuccessful(status)) {
        // Drained, not kept: a refused answer's body is one small error document, and leaving it unread would hold the socket.
        await readAll(response);
        return { status, chunks: NO_CHUNKS };
      }
      return { status, chunks: response };
    },
  };
}

/** The real effects, dialling upstream from `ports` (the door's own range unless a test injects a private one). */
export function realConnectEffects(ports: SourcePortRange = DOOR_SOURCE_PORTS): ConnectEffects {
  // Keep-alive on both agents so a client reusing its TLS session gets its forwarded requests served over reused upstream connections too, the way a direct connection would, with every socket in the door's pf-exempt source-port range.
  const plainAgent = new ExemptHttpAgent(ports);
  const tlsAgent = new ExemptTlsAgent(ports);

  const listenOnce = async (port: number, onSocket: (socket: net.Socket) => void): Promise<ConnectListenerHandle> =>
    await new Promise((resolve, reject) => {
      const accepted = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        accepted.add(socket);
        socket.on("close", () => {
          accepted.delete(socket);
        });
        onSocket(socket);
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        // A listening TCP server's address is always the object form; the string form is for pipes and unix sockets only.
        const bound = typeof address === "object" && address !== null ? address.port : 0;
        if (bound === 0) {
          reject(new Error("could not bind a loopback port"));
          return;
        }
        resolve({
          port: bound,
          close: async () => {
            await new Promise<void>((closeResolve) => {
              // Stop accepting first (synchronous in the closing flag it sets, so no further connection callback can run and grow `accepted` afterwards), then end everything this listener handed out, which is what lets close's own callback fire.
              server.close(() => {
                closeResolve(undefined);
              });
              for (const socket of accepted) {
                socket.destroy();
              }
            });
          },
        });
      });
    });

  return {
    listenLoopback: async (preferredPort, onSocket) => {
      if (preferredPort !== undefined) {
        try {
          return await listenOnce(preferredPort, onSocket);
        } catch {
          // The sticky port was taken between generations; any free port will do, and the supervisor logs the move.
        }
      }
      return await listenOnce(0, onSocket);
    },
    createTlsAcceptor: (leaf, onSecure, alpnProtocols) => {
      // The context `accept` was last called with, read inside the same synchronous stack as the handshake's connection event, so each session receives exactly its own connection's context with no interleaving.
      let pendingContext = "";
      const server = tls.createServer(
        { key: leaf.keyPem, cert: leaf.certPem, ...(alpnProtocols === undefined ? {} : { ALPNProtocols: [...alpnProtocols] }) },
        (secure) => {
          onSecure(secure, pendingContext);
        },
      );
      // A failed handshake (a client that does not trust the CA, or speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // tls.Server is a net.Server whose connection listener wraps the raw socket in the TLS handshake, and emitting the event by hand is what runs that listener on a socket this process already owns (the CONNECT half of the connection) rather than one the server accepted itself.
        accept: (socket, context) => {
          pendingContext = context;
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
        },
      };
    },
    createSniTlsAcceptor: (hosts, leafFor, onSecure) => {
      // One secure context per served host, built once: `leafFor` is the leaf cache the CONNECT acceptors already minted through, so this only wraps each host's leaf in the form node's SNI selection hands out.
      const contexts = new Map<string, tls.SecureContext>(
        hosts.map((host) => {
          const leaf = leafFor(host);
          return [host, tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })];
        }),
      );
      const server = tls.createServer(
        {
          // No default key or cert exists, so the SNI selection is the only source of credentials: an unserved name fails its handshake here, and a client that sent no SNI at all never reaches the selection and fails for want of any certificate, which is exactly the fail-closed shape this surface wants.
          SNICallback: (servername, callback) => {
            const context = contexts.get(servername);
            callback(context === undefined ? new Error(`the transparent surface serves no host named ${servername}`) : null, context);
          },
        },
        (secure) => {
          // node types the servername `string | false | null` because a client may send none, and a handshake that completed here always did (the SNI selection is the only credential source); anything else still fails closed downstream, where no session carries its name.
          onSecure(secure, typeof secure.servername === "string" ? secure.servername : "");
        },
      );
      // A failed handshake (an unserved name, a client that does not trust the CA, a client that speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // The same hand-off the single-leaf acceptor uses: emitting the connection event runs the TLS server's own connection listener on a socket this process already owns (the redirect half of the connection) rather than one the server accepted itself.
        accept: (socket) => {
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
        },
      };
    },
    createHttpSession: (handler, onUpgrade) => {
      const server = http.createServer(handler);
      server.on("clientError", (_error, socket) => {
        socket.destroy();
      });
      if (onUpgrade !== undefined) {
        // A server with no 'upgrade' listener has Node destroy the connection itself; with one, the handler owns the socket outright, head bytes included, which is what the byte-level relay needs.
        server.on("upgrade", (request, socket, head) => {
          onUpgrade(request, socket, head);
        });
      }
      return {
        serve: (socket) => {
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      };
    },
    connectTlsUpstream: async (host, port, clientAlpn) => {
      // The upstream half of a tap session speaks TLS to the real host, offering exactly the protocol the client negotiated with the tap's front (and nothing when the client negotiated nothing), so the channel's protocol is the client's choice, never ours. The raw socket is dialled by `reservedDial`, so it is bound into the door's reserved source-port range (the pf exemption an interception deployment loads) before TLS wraps it, because tls.connect's own options carry no localPort.
      const dialled = await reservedDial({ host, port }, ports);
      if (dialled.error !== null) {
        throw dialled.error;
      }
      return await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket: dialled.socket, servername: host, ...(clientAlpn === undefined ? {} : { ALPNProtocols: [clientAlpn] }) });
        secure.once("secureConnect", () => {
          resolve(secure);
        });
        secure.once("error", reject);
      });
    },
    connectTcp: async (host, port) =>
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("connect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
    forwardHttp: (target, request, response, observer) => {
      const headers = forwardableHeaders(request.headers);
      const options: https.RequestOptions = {
        host: target.host,
        port: target.port,
        lookup: realAddressLookup,
        method: request.method,
        path: request.url,
        headers,
        agent: target.tls ? tlsAgent : plainAgent,
      };
      if (target.tls) {
        options.servername = target.servername ?? target.host;
        if (target.ca !== undefined) {
          options.ca = [...target.ca];
        }
        if (target.rejectUnauthorized !== undefined) {
          options.rejectUnauthorized = target.rejectUnauthorized;
        }
      }
      const onUpstreamResponse = (upstreamResponse: http.IncomingMessage): void => {
        observer?.onResponse(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, forwardableHeaders(upstreamResponse.headers));
        // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
        response.flushHeaders();
        // Additive listeners, not a tee: the pipe keeps sole control of flow control, and the observer simply sees the same chunk deliveries the client does.
        if (observer !== undefined) {
          upstreamResponse.on("data", (chunk: Buffer) => {
            observer.onResponseChunk(chunk);
          });
        }
        upstreamResponse.pipe(response);
      };
      // Branching rather than selecting the namespace, because a union of the two module objects types `request` as `any` and loses every check on it.
      const upstream = target.tls ? https.request(options, onUpstreamResponse) : http.request(options, onUpstreamResponse);
      upstream.on("error", (error: Error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        const body = `agent-shim headroom: upstream unreachable (${error.message})`;
        response.writeHead(HTTP_BAD_GATEWAY, { "content-type": "text/plain", "content-length": String(body.length) });
        response.end(body);
      });
      if (observer !== undefined) {
        request.on("data", (chunk: Buffer) => {
          observer.onRequestChunk(chunk);
        });
        if (observer.onRequestEnd !== undefined) {
          // Additive, exactly like the chunk listener: the pipe keeps sole control of flow control, and the observer learns the body completed.
          request.on("end", () => {
            observer.onRequestEnd?.();
          });
        }
        response.on("close", () => {
          observer.onEnd();
        });
      }
      request.pipe(upstream);
      request.socket.setNoDelay(true);
      upstream.on("socket", (socket) => {
        socket.setNoDelay(true);
      });
    },
  };
}
