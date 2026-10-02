import { X509Certificate, createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";

import { issueCaCertificate, issueLeafCertificate } from "./x509";
import { CONNECT_PROXY_REALM, capabilityFromProxyAuthorization } from "./capability";
import { FRONTDOOR_POLL_MS } from "./supervisor";

/**
 * The front door's CONNECT surface, so an OAuth session can have claude-use's routing AND Claude Code's Remote Control at once: Remote Control refuses any `ANTHROPIC_BASE_URL` other than the real API, but happily honours `HTTPS_PROXY`, so OAuth launches route at the proxy layer instead.
 *
 * Nothing is tunnelled or intercepted for a client that has not authenticated: every CONNECT request must present a live launch's capability as its proxy credential (`Proxy-Authorization: Basic`, which clients derive from the credential in the `HTTPS_PROXY` URL the launcher sets), or it is answered 407 before any target is dialled, so the port is no open proxy for other local processes. Pending and authenticated connections are bounded by `ConnectLimits`.
 *
 * Every authenticated CONNECT target is blind-tunnelled byte for byte EXCEPT the intercept host (Claude Code's own API), whose TLS this surface terminates with a leaf certificate signed by a locally generated CA. On the terminated session, the paths the front door routes (`/v1/`) are handed to the same ordered pipeline the provider listener serves (the client's Authorization header passes through untouched), and every other path is piped by this surface to the real upstream over TLS, so Remote Control's streaming, OAuth refreshes, and unknown endpoints bypass the pipeline entirely.
 */

/** The one CONNECT host whose TLS gets terminated: Claude Code's own API, the upstream every OAuth session is really talking to. */
export const CONNECT_INTERCEPT_HOST = "api.anthropic.com";

/** Paths under this prefix are what the routed pipeline serves; everything else on the terminated session goes to the real upstream. */
export const ROUTED_PATH_PREFIX = "/v1/";

/** The port HTTPS is served on, both the default when a CONNECT authority names none and the port non-headroom paths are piped to on the real upstream. */
export const HTTPS_PORT = 443;

/** The highest TCP port an authority can name; anything above it is malformed, not a port. */
const MAX_PORT = 65535;

/** What the forwarding effect answers with when the upstream is unreachable. */
const HTTP_BAD_GATEWAY = 502;

/** The file mode of the CA private key: readable and writable by its owner, invisible to everyone else. */
const CA_KEY_FILE_MODE = 0o600;

/** A CONNECT request line carries exactly three tokens: method, authority, protocol. */
const CONNECT_LINE_TOKENS = 3;

/** The terminator of an HTTP request head, the framing the CONNECT parser splits on. */
const HEAD_TERMINATOR = "\r\n\r\n";

/** Largest CONNECT request head accepted before the connection is refused: a real head is a request line and a few short headers (Host, the proxy credential, a User-Agent), so anything this size is a confused or hostile client. 8 KiB is also the per-header-line limit common HTTP servers apply by default (nginx's `large_client_header_buffers` buffer, Apache's `LimitRequestFieldSize` of 8190 bytes), so no client is built to need a longer line, and a CONNECT head is a few such lines at most. */
export const MAX_CONNECT_HEAD_BYTES = 8192;

/** The response line every CONNECT proxy sends before the tunnel starts; the body is empty by definition. */
const CONNECT_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** The status lines the surface refuses a connection with, each closing it once written. */
const REFUSAL = {
  badRequest: "400 Bad Request",
  proxyAuthenticationRequired: "407 Proxy Authentication Required",
  requestTimeout: "408 Request Timeout",
  headTooLarge: "431 Request Header Fields Too Large",
  serviceUnavailable: "503 Service Unavailable",
} as const;

/**
 * The surface's connection deadlines and caps. Production passes `CONNECT_LIMITS`; tests pass small values so a deadline or a cap is reached in milliseconds.
 *
 * A connection is pending from accept until its CONNECT head has arrived, and authenticated once that head presented a live launch's capability. Pending connections are bounded twice, by `headDeadlineMs` and by `maxPendingHeads` (reaching the cap evicts the oldest pending connection rather than refusing the newest, so a squatter holding open half-sent heads cannot lock live launches out: a real client's head arrives in its first segment and is authenticated long before that many newer connections could push it out). Authenticated connections are bounded by `maxTunnels` and revoked when their launch ends; they have no idle timeout (see `CONNECT_LIMITS`).
 */
export interface ConnectLimits {
  /** How long a connection may take to deliver its whole CONNECT head before it is answered 408 and closed. */
  readonly headDeadlineMs: number;
  /** How many connections may be waiting for their head at once; one more evicts the oldest. */
  readonly maxPendingHeads: number;
  /** How many authenticated connections (blind tunnels and terminated sessions together) may be open at once; one more is answered 503 and closed. */
  readonly maxTunnels: number;
  /** How often every authenticated connection's capability is re-checked, closing the connections of any launch that has since ended. */
  readonly revalidateMs: number;
}

/**
 * The production limits, each derived from what the surface's real clients do.
 *
 * `headDeadlineMs`: every client checked (Claude Code, curl, Node's own proxy support, Python's urllib) sends its whole CONNECT head, credential included, the moment the TCP connection opens, without waiting for anything from the proxy, so on loopback the head arrives within milliseconds. The deadline only has to outlast a door process stalled by a loaded machine, and ten seconds is three orders of magnitude above any such stall while still ending a slowloris connection quickly.
 *
 * `maxPendingHeads`: since a real head arrives in the first segment, the pending set at any instant holds only connections opened in the same instant. The largest real burst is a package manager or similar running inside a session, which opens its parallel downloads through HTTPS_PROXY at once; 64 covers the defaults of npm (`maxsockets` 15) and pnpm (`network-concurrency` 16) several times over, and eviction means even a larger burst only costs a retry, never a lockout.
 *
 * `maxTunnels`: each authenticated connection holds two descriptors (the client's and the upstream's). Node raises its soft descriptor limit to the hard limit at start, and 4096 is the smallest hard limit common Linux distributions ship (macOS's is far higher), so 1024 tunnels keep the surface to half of it, leaving the provider and direct listeners room to serve rather than all three failing with EMFILE. It is still many times what concurrent sessions hold: each keeps a handful of tunnels plus whatever bursts its tools make.
 *
 * `revalidateMs`: the supervisor prunes dead launches from the registry once per `FRONTDOOR_POLL_MS`, so re-checking more often than that could never find anything newly dead.
 *
 * There is deliberately no idle timeout on an authenticated connection: Remote Control and other long-lived streams can sit silent for as long as the far end chooses between events, at an interval the surface cannot know, so any idle timeout would cut legitimate sessions. Authenticated connections are bounded instead by who can open them (only a live launch's process tree holds the capability), by `maxTunnels`, and by revocation: a launch that ends loses every connection it opened at the next revalidation.
 */
export const CONNECT_LIMITS: ConnectLimits = {
  headDeadlineMs: 10_000,
  maxPendingHeads: 64,
  maxTunnels: 1024,
  revalidateMs: FRONTDOOR_POLL_MS,
};

/** CA validity: ten years, because the CA lives on one machine and a shorter life buys nothing but a first-start keygen every time it lapses. */
const CA_VALIDITY_DAYS = 3650;
/** Leaf validity: 397 days, the longest a public CA may issue, as a conventional bound for a certificate nothing re-reads once minted. */
const LEAF_VALIDITY_DAYS = 397;

/** The CA's fixed subject: stable across regenerations so anything that pinned the old subject fails loudly rather than trusting a silently renamed authority. */
const CA_SUBJECT_COMMON_NAME = "claude-use front door CA";

/** Milliseconds per day, so the validity windows above read as the days they are. */
const MS_PER_DAY = 86_400_000;

/** One parsed CONNECT authority, the host lowercased and the port defaulted. */
export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

/** Parses a CONNECT authority (`host:port`, or a bare `host` meaning 443), or undefined when it names no host or a non-numeric port. */
export function parseConnectTarget(authority: string): ConnectTarget | undefined {
  const colon = authority.lastIndexOf(":");
  if (colon === -1) {
    const host = authority.trim().toLowerCase();
    return host === "" ? undefined : { host, port: HTTPS_PORT };
  }
  const host = authority.slice(0, colon).trim().toLowerCase();
  const port = Number.parseInt(authority.slice(colon + 1), 10);
  if (host === "" || !Number.isInteger(port) || port <= 0 || port > MAX_PORT) {
    return undefined;
  }
  return { host, port };
}

/** Whether a CONNECT target's host (port already stripped) is the one whose TLS this proxy terminates. */
export function isInterceptedHost(host: string, interceptHost: string): boolean {
  return host === interceptHost;
}

/** Whether a request path on the terminated session is one the routed pipeline serves. The query string stays part of the path: `/v1/messages?beta=true` is still the pipeline's. */
export function servedByPipeline(path: string | undefined): boolean {
  return path?.startsWith(ROUTED_PATH_PREFIX) === true;
}

/** The end-to-end transport re-frames both messages, so every header named here is regenerated rather than forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers a forwarded HTTP message keeps: everything except the hop-by-hop set, which belongs to whichever connection carried it and must not leak onto the next one. The `Connection` header's own value can name further hop-by-hop headers (RFC 9110 section 7.6.1), so those go too. Returns a fresh object; the input is the live parser's map and is never mutated.
 */
export function forwardableHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const connectionTokens = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
  const result: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

/** A CA certificate and its private key, both as PEM. */
export interface CaMaterial {
  readonly certPem: string;
  readonly keyPem: string;
}

/** A TLS leaf certificate and its private key, both as PEM. */
export interface LeafCert {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Generates the local CA: one RSA keypair, self-signed, CA-only by basicConstraints and keyUsage, with a random serial. Built on `node:crypto` alone (see `x509.ts`), no openssl, so the same code works on every platform claude-use ships to. */
export function generateCa(now: Readonly<Date>): CaMaterial {
  return issueCaCertificate(CA_SUBJECT_COMMON_NAME, new Date(now.getTime() - MS_PER_DAY), new Date(now.getTime() + CA_VALIDITY_DAYS * MS_PER_DAY));
}

/** The names the front door's provider listener answers to: the loopback address every provider session's base URL names, plus the loopback hostname for a client that spells it that way. */
export const LOOPBACK_LEAF_NAMES: readonly string[] = ["127.0.0.1", "localhost"];

/**
 * Mints a TLS leaf signed by the CA: its own RSA keypair, server-auth usage only, the first name as the subject's common name and every name in the SAN. A name that parses as an IP address goes in as an IP SAN, because TLS clients match an IP host only against IP SANs, never against a DNS SAN spelling the same digits.
 */
export function mintLeaf(ca: CaMaterial, names: readonly string[], now: Readonly<Date>): LeafCert {
  return issueLeafCertificate(ca, names, new Date(now.getTime() - MS_PER_DAY), new Date(now.getTime() + LEAF_VALIDITY_DAYS * MS_PER_DAY));
}

/** Mints each host's leaf once from the CA and reuses it, because generating a 2048-bit RSA keypair costs noticeable time and nothing about the certificate changes between sessions. */
export function createLeafCache(ca: CaMaterial, now: () => Date): (host: string) => LeafCert {
  const cache = new Map<string, LeafCert>();
  return (host: string): LeafCert => {
    const existing = cache.get(host);
    if (existing !== undefined) {
      return existing;
    }
    const minted = mintLeaf(ca, [host], now());
    cache.set(host, minted);
    return minted;
  };
}

/**
 * Persistence for the CA: generated once on the machine's first headroom start and reused forever after, because regenerating it would invalidate every child's `NODE_EXTRA_CA_CERTS` pointing at the old file. The real implementation writes the key with mode 0600; injected fakes keep it in memory.
 */
export interface ConnectCertStore {
  /** The persisted CA, or undefined when none exists yet (or only half of it does: a cert without its key can sign nothing, so it counts as absent). */
  readonly loadCa: () => CaMaterial | undefined;
  /** Persists both halves of the CA, the key unreadable to other users. */
  readonly writeCa: (ca: CaMaterial) => void;
}

/**
 * Loads the persisted CA, generating and persisting one when no usable CA exists. A stored pair that `node:crypto` cannot parse is treated as absent and replaced: a truncated write is the one failure mode a regeneration can actually repair, and every child that trusted the old file needs a new `NODE_EXTRA_CA_CERTS` anyway once its CA stops parsing.
 */
export function ensureCa(store: ConnectCertStore, generate: () => CaMaterial): CaMaterial {
  const existing = store.loadCa();
  if (existing !== undefined && caParses(existing)) {
    return existing;
  }
  const ca = generate();
  store.writeCa(ca);
  return ca;
}

/** Whether both PEMs parse as certificate and private key: the minimum a leaf-minting round trip needs from the pair. */
function caParses(ca: CaMaterial): boolean {
  try {
    new X509Certificate(ca.certPem);
    createPrivateKey(ca.keyPem);
    return true;
  } catch {
    return false;
  }
}

/** Where one forwarded request goes, and how: the connect surface's own forwards go to the real upstream over TLS, while a local hop over plain HTTP is what tests redirect to. */
interface ConnectForwardTarget {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /** The SNI name to present; defaults to `host`. Separated so a test can connect to a local fake while presenting the production hostname. */
  readonly servername?: string;
  /** Extra trust anchors for the target's certificate, when it is not system-trusted (a test's local fake upstream). */
  readonly ca?: readonly string[];
  /** Overrides certificate verification; production leaves it at the Node default (verify against system trust or `ca`). */
  readonly rejectUnauthorized?: boolean;
}

/** Handles one parsed HTTP request on a terminated TLS session. */
type ConnectRequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** A bound loopback listener and how to stop it. */
interface ConnectListenerHandle {
  readonly port: number;
  /** Stops accepting, ends every live connection, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/** Presents one leaf's server-side TLS on CONNECTed sockets. */
interface TlsAcceptor {
  /** Starts the TLS handshake on a socket that has just received its CONNECT response. */
  readonly accept: (socket: net.Socket) => void;
  /** Drops every session this acceptor is terminating. */
  readonly close: () => void;
}

/** Parses HTTP over terminated sockets and serves each request through the handler, keep-alive included. */
interface HttpParserSession {
  readonly serve: (socket: net.Socket) => void;
  readonly close: () => void;
}

/**
 * Every effect the MITM proxy performs, injected so the routing decisions and lifecycle run against fakes in unit tests (the SupervisorPorts pattern): TCP listening, TLS termination, HTTP parsing, plain TCP tunnels, and request forwarding. The real implementation is `realConnectEffects`; the TLS round-trip test uses it with redirected targets.
 */
export interface ConnectEffects {
  /** Binds a loopback TCP listener; `preferredPort` is tried first and any free port used when it is taken (bind, do not probe: check-then-bind races). Resolves with the bound port and a close handle. */
  readonly listenLoopback: (preferredPort: number | undefined, onSocket: (socket: net.Socket) => void) => Promise<ConnectListenerHandle>;
  /** Builds the TLS terminator for one leaf, handing each successfully handshaked session to `onSecure`. */
  readonly createTlsAcceptor: (leaf: LeafCert, onSecure: (secure: net.Socket) => void) => TlsAcceptor;
  /** Builds the HTTP parser bound to one request handler. */
  readonly createHttpSession: (handler: ConnectRequestHandler) => HttpParserSession;
  /** Opens a raw TCP connection for a blind tunnel. */
  readonly connectTcp: (host: string, port: number) => Promise<net.Socket>;
  /** Streams one request to `target` and the response back, never buffering a body. */
  readonly forwardHttp: (target: ConnectForwardTarget, request: IncomingMessage, response: ServerResponse) => void;
}

/** Everything the connect surface needs to route, resolved before it starts. */
export interface ConnectServerConfig {
  /** The CONNECT host whose TLS gets terminated. */
  readonly interceptHost: string;
  /**
   * Serves one routed path (`/v1/...`) from the terminated session: the same ordered pipeline the provider listener hands requests to, so an OAuth session and a provider session run identical identification, middleware and routing.
   */
  readonly serveRouted: ConnectRequestHandler;
  /** The leaf to terminate `interceptHost` with, minted and cached per host. */
  readonly leafFor: (host: string) => LeafCert;
  /** Where non-routed paths on the terminated session are piped: the real upstream over TLS. */
  readonly upstream: ConnectForwardTarget;
  /** Whether a capability presented as a CONNECT request's proxy credential belongs to a live launch: the same constant-time check against the same registry the routed pipeline's admission makes, read fresh on every call because launches come and go. */
  readonly isLiveCapability: (token: string) => boolean;
  /** The connection deadlines and caps; production passes `CONNECT_LIMITS`. */
  readonly limits: ConnectLimits;
}

/** A running connect surface. */
export interface ConnectServerHandle {
  readonly port: number;
  /** Stops the listener, drops every live tunnel and terminated session, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/**
 * Starts the connect surface: binds the listener, mints the intercept host's leaf, and wires the per-connection routing. Resolves once the listener is bound.
 *
 * The connection flow: read the CONNECT head within the deadline (never more of the stream than that, so an early ClientHello glued to the head is pushed back with `unshift` and still seen by whatever consumes the socket next), authenticate it, then either blind-tunnel the target or terminate its TLS and parse HTTP on the session. Every network effect flows through `effects`; nothing here touches the network or filesystem itself.
 */
export async function startConnectServer(config: ConnectServerConfig, effects: ConnectEffects, preferredPort: number | undefined): Promise<ConnectServerHandle> {
  const handler: ConnectRequestHandler = (request, response) => {
    if (servedByPipeline(request.url)) {
      config.serveRouted(request, response);
      return;
    }
    effects.forwardHttp(config.upstream, request, response);
  };

  const httpSession = effects.createHttpSession(handler);
  const tlsAcceptor = effects.createTlsAcceptor(config.leafFor(config.interceptHost), (secure) => {
    httpSession.serve(secure);
  });
  const ledger = createConnectionLedger(config.limits, config.isLiveCapability);

  // The listener owns teardown of everything it accepted: destroying the raw CONNECT socket ends both the blind tunnels and the TLS sessions layered on top of them.
  const listener = await effects.listenLoopback(preferredPort, (socket) => {
    handleConnect(socket, { config, effects, tlsAcceptor, ledger });
  });

  return {
    port: listener.port,
    close: async () => {
      ledger.close();
      await listener.close();
      tlsAcceptor.close();
      httpSession.close();
    },
  };
}

/** Everything one connection's handling needs from the running surface. */
interface ConnectionContext {
  readonly config: ConnectServerConfig;
  readonly effects: ConnectEffects;
  readonly tlsAcceptor: TlsAcceptor;
  readonly ledger: ConnectionLedger;
}

/** The surface's accounting of its connections, enforcing `ConnectLimits`. */
interface ConnectionLedger {
  /** Records a freshly accepted connection as pending and arms its head deadline, evicting the oldest pending connection first when the pending cap is reached. */
  readonly accept: (socket: net.Socket) => void;
  /** Marks a connection's head as received: it leaves the pending set and its deadline is disarmed. */
  readonly headReceived: (socket: net.Socket) => void;
  /** Records an authenticated connection under the capability it presented. False, with nothing recorded, when the tunnel cap is already reached. */
  readonly establish: (socket: net.Socket, capability: string) => boolean;
  /** Stops the revalidation timer and disarms every deadline; the listener's own close destroys the sockets. */
  readonly close: () => void;
}

function createConnectionLedger(limits: ConnectLimits, isLiveCapability: (token: string) => boolean): ConnectionLedger {
  /** Connections still waiting for their head, oldest first (a Map iterates in insertion order), each with its deadline timer. */
  const pending = new Map<net.Socket, NodeJS.Timeout>();
  /** Authenticated connections grouped by the capability they presented, so a revalidation checks each launch once however many connections it holds. */
  const authenticated = new Map<string, Set<net.Socket>>();
  let tunnels = 0;

  const leavePending = (socket: net.Socket): void => {
    const deadline = pending.get(socket);
    if (deadline !== undefined) {
      clearTimeout(deadline);
      pending.delete(socket);
    }
  };

  const revalidation = setInterval(() => {
    for (const [capability, sockets] of authenticated) {
      if (!isLiveCapability(capability)) {
        // The launch that held this capability has ended: everything it opened goes with it. Each socket's close handler removes it from the ledger.
        for (const socket of sockets) {
          socket.destroy();
        }
      }
    }
  }, limits.revalidateMs);
  // The timer only matters while the listener serves, and the listener alone decides that: it must never be what keeps the door's process alive.
  revalidation.unref();

  return {
    accept: (socket) => {
      const [oldest] = pending.keys();
      if (pending.size >= limits.maxPendingHeads && oldest !== undefined) {
        leavePending(oldest);
        refuse(oldest, REFUSAL.requestTimeout);
      }
      pending.set(
        socket,
        setTimeout(() => {
          leavePending(socket);
          refuse(socket, REFUSAL.requestTimeout);
        }, limits.headDeadlineMs),
      );
      socket.once("close", () => {
        leavePending(socket);
      });
    },
    headReceived: leavePending,
    establish: (socket, capability) => {
      if (tunnels >= limits.maxTunnels) {
        return false;
      }
      tunnels += 1;
      const sockets = authenticated.get(capability) ?? new Set<net.Socket>();
      sockets.add(socket);
      authenticated.set(capability, sockets);
      socket.once("close", () => {
        tunnels -= 1;
        sockets.delete(socket);
        if (sockets.size === 0 && authenticated.get(capability) === sockets) {
          authenticated.delete(capability);
        }
      });
      return true;
    },
    close: () => {
      clearInterval(revalidation);
      for (const deadline of pending.values()) {
        clearTimeout(deadline);
      }
      pending.clear();
    },
  };
}

/**
 * Answers a connection with a bodiless status and closes it once the answer is written. The head parser is detached first, so nothing that arrives afterwards can be read as a CONNECT head and routed on a connection already refused.
 */
function refuse(socket: net.Socket, status: string, headers: readonly string[] = []): void {
  socket.removeAllListeners("data");
  socket.pause();
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.end(`HTTP/1.1 ${status}\r\n${headers.map((header) => `${header}\r\n`).join("")}content-length: 0\r\nconnection: close\r\n\r\n`, () => {
    socket.destroy();
  });
}

/** Reads one CONNECT head off the socket within the deadline and routes the connection: blind tunnel, or TLS termination into the acceptor. */
function handleConnect(socket: net.Socket, context: ConnectionContext): void {
  socket.on("error", () => {
    socket.destroy();
  });
  context.ledger.accept(socket);
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const headEnd = buffer.indexOf(HEAD_TERMINATOR);
    // A head is too large whether or not its terminator has arrived: one oversized segment can carry both.
    if (headEnd === -1 ? buffer.length > MAX_CONNECT_HEAD_BYTES : headEnd > MAX_CONNECT_HEAD_BYTES) {
      context.ledger.headReceived(socket);
      refuse(socket, REFUSAL.headTooLarge);
      return;
    }
    if (headEnd === -1) {
      return;
    }
    socket.removeListener("data", onData);
    // Detaching a 'data' listener does NOT return the socket to paused mode, and a still-flowing socket with no listener discards everything that arrives next, which would eat the ClientHello before the TLS layer attaches. Pausing explicitly is what keeps the following bytes buffered for the next consumer.
    socket.pause();
    context.ledger.headReceived(socket);
    const head = buffer.subarray(0, headEnd).toString("utf8");
    // Whatever followed the head in the buffer (an early TLS ClientHello, typically) belongs to the next consumer, so it goes back to the front of the socket's buffer; the listener comes off before routing so the next consumer, not this parser, drains what follows.
    socket.unshift(buffer.subarray(headEnd + HEAD_TERMINATOR.length));
    routeConnect(socket, head, context);
  };
  socket.on("data", onData);
}

/** The value of the one `Proxy-Authorization` header in a CONNECT head, or undefined when there is none or more than one (a repeated credential is malformed, and the surface refuses rather than guessing which copy counts). */
function proxyAuthorizationOf(head: string): string | undefined {
  const values = head
    .split("\r\n")
    .slice(1)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0 && line.slice(0, colon).trim().toLowerCase() === "proxy-authorization" ? [line.slice(colon + 1)] : [];
    });
  const [value] = values;
  return values.length === 1 ? value : undefined;
}

/**
 * Applies the decision for one received CONNECT head: authenticate it, then route it. Authentication comes before anything else the head says is acted on, so a client without a live capability learns nothing and causes nothing: no target is parsed for it, dialled or intercepted, and its only answer is 407 with the challenge naming the scheme the surface accepts.
 */
function routeConnect(socket: net.Socket, head: string, context: ConnectionContext): void {
  const { config, effects, tlsAcceptor, ledger } = context;
  const credential = proxyAuthorizationOf(head);
  const capability = credential === undefined ? undefined : capabilityFromProxyAuthorization(credential);
  if (capability === undefined || !config.isLiveCapability(capability)) {
    refuse(socket, REFUSAL.proxyAuthenticationRequired, [`Proxy-Authenticate: Basic realm="${CONNECT_PROXY_REALM}"`]);
    return;
  }
  const requestLine = head.split("\r\n", 1)[0] ?? "";
  const parts = requestLine.split(" ");
  const authority = parts.length === CONNECT_LINE_TOKENS && parts[0]?.toUpperCase() === "CONNECT" ? (parts[1] ?? "") : undefined;
  const target = authority === undefined ? undefined : parseConnectTarget(authority);
  if (target === undefined) {
    refuse(socket, REFUSAL.badRequest);
    return;
  }
  if (!ledger.establish(socket, capability)) {
    refuse(socket, REFUSAL.serviceUnavailable);
    return;
  }
  socket.write(CONNECT_ESTABLISHED);
  if (isInterceptedHost(target.host, config.interceptHost)) {
    tlsAcceptor.accept(socket);
    return;
  }
  void blindTunnel(socket, target, effects);
}

/** Pipes a CONNECTed socket byte for byte to its target: this proxy never looks inside another host's TLS. */
async function blindTunnel(socket: net.Socket, target: ConnectTarget, effects: ConnectEffects): Promise<void> {
  let upstream: net.Socket;
  try {
    upstream = await effects.connectTcp(target.host, target.port);
  } catch {
    // Nothing to tunnel to: the only honest response is to drop the connection the client asked to open.
    socket.destroy();
    return;
  }
  if (socket.destroyed) {
    // The client went away (or its launch was revoked) while the target was being dialled; the close handlers below were not yet attached to see it, so the fresh upstream would otherwise outlive it.
    upstream.destroy();
    return;
  }
  socket.pipe(upstream);
  upstream.pipe(socket);
  const drop = (): void => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", drop);
  upstream.on("error", drop);
  socket.on("close", () => {
    upstream.destroy();
  });
  upstream.on("close", () => {
    socket.destroy();
  });
}

/** The real `ConnectEffects` over node's own net, tls, and http. `connectTcp` opens real connections to the CONNECTed host, so tests that want a blind tunnel redirect it. */
export function realConnectEffects(): ConnectEffects {
  // Keep-alive on both agents so a client reusing its TLS session gets its forwarded requests served over reused upstream connections too, the way a direct connection would.
  const plainAgent = new http.Agent({ keepAlive: true });
  const tlsAgent = new https.Agent({ keepAlive: true });

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
    createTlsAcceptor: (leaf, onSecure) => {
      const server = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (secure) => {
        onSecure(secure);
      });
      // A failed handshake (a client that does not trust the CA, or speaks no TLS) surfaces here; the only honest response is to drop the connection.
      server.on("clientError", (_error: Error, socket: net.Socket) => {
        socket.destroy();
      });
      return {
        // tls.Server is a net.Server whose connection listener wraps the raw socket in the TLS handshake, and emitting the event by hand is what runs that listener on a socket this process already owns (the CONNECT half of the connection) rather than one the server accepted itself.
        accept: (socket) => {
          server.emit("connection", socket);
        },
        close: () => {
          server.close();
        },
      };
    },
    createHttpSession: (handler) => {
      const server = http.createServer(handler);
      server.on("clientError", (_error, socket) => {
        socket.destroy();
      });
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
    connectTcp: async (host, port) =>
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("connect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
    forwardHttp: (target, request, response) => {
      const headers = forwardableHeaders(request.headers);
      const options: https.RequestOptions = {
        host: target.host,
        port: target.port,
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
        response.writeHead(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, forwardableHeaders(upstreamResponse.headers));
        // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
        response.flushHeaders();
        upstreamResponse.pipe(response);
      };
      // Branching rather than selecting the namespace, because a union of the two module objects types `request` as `any` and loses every check on it.
      const upstream = target.tls ? https.request(options, onUpstreamResponse) : http.request(options, onUpstreamResponse);
      upstream.on("error", (error: Error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        const body = `claude-use headroom: upstream unreachable (${error.message})`;
        response.writeHead(HTTP_BAD_GATEWAY, { "content-type": "text/plain", "content-length": String(body.length) });
        response.end(body);
      });
      request.pipe(upstream);
      request.socket.setNoDelay(true);
      upstream.on("socket", (socket) => {
        socket.setNoDelay(true);
      });
    },
  };
}

/** Whether an fs error is "the file is not there", the only failure a missing CA read treats as absence. */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The real `ConnectCertStore` on the filesystem: `ca.pem` world-readable (it is public material), `ca.key` mode 0600 exactly, chmod'ed after the write because a create's mode bits pass through the process umask. */
export function realConnectCertStore(paths: { readonly frontdoorCaDir: string; readonly frontdoorCaCertFile: string; readonly frontdoorCaKeyFile: string }): ConnectCertStore {
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  };
  return {
    loadCa: () => {
      const certPem = read(paths.frontdoorCaCertFile);
      const keyPem = read(paths.frontdoorCaKeyFile);
      return certPem === undefined || keyPem === undefined ? undefined : { certPem, keyPem };
    },
    writeCa: (ca) => {
      fs.mkdirSync(paths.frontdoorCaDir, { recursive: true });
      fs.writeFileSync(paths.frontdoorCaCertFile, ca.certPem, "utf8");
      fs.writeFileSync(paths.frontdoorCaKeyFile, ca.keyPem, { encoding: "utf8", mode: CA_KEY_FILE_MODE });
      fs.chmodSync(paths.frontdoorCaKeyFile, CA_KEY_FILE_MODE);
    },
  };
}
