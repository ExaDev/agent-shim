import { X509Certificate, createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type * as net from "node:net";
import type { Duplex } from "node:stream";

import { issueCaCertificate, issueLeafCertificate } from "./x509";
import type { ConnectCapture, PassthroughObserver } from "./capture";
import { pumpTapSession } from "./tap";
import { CONNECT_PROXY_REALM, capabilityFromProxyAuthorization } from "./capability";
import { AUTH_HEADER } from "./route";
import { FRONTDOOR_POLL_MS } from "./supervisor";

/**
 * The front door's CONNECT surface, so an OAuth session can have agent-shim's routing AND Claude Code's Remote Control at once: Remote Control refuses any `ANTHROPIC_BASE_URL` other than the real API, but happily honours `HTTPS_PROXY`, so OAuth launches route at the proxy layer instead.
 *
 * Nothing is tunnelled or intercepted for a client that has not authenticated: every CONNECT request must present a live launch's capability as its proxy credential (`Proxy-Authorization: Basic`, which clients derive from the credential in the `HTTPS_PROXY` URL the launcher sets), or it is answered 407 before any target is dialled, so the port is no open proxy for other local processes. Pending and authenticated connections are bounded by `ConnectLimits`.
 *
 * Every authenticated CONNECT target is blind-tunnelled byte for byte EXCEPT the intercept hosts (Claude Code's own API and the claude.ai control plane), whose TLS this surface terminates with leaf certificates signed by a locally generated CA. On the API host's terminated session, the paths the front door routes (`/v1/`) are handed to the same ordered pipeline the provider listener serves (the client's Authorization header passes through untouched), and every other path there, and every path on the control plane's session, is piped by this surface to that session's own real upstream over TLS, so Remote Control's streaming, OAuth refreshes, and unknown endpoints bypass the pipeline entirely. When a `capture` is configured, those piped exchanges and every CONNECT target are recorded through it (see `./capture.ts`); the forwarding itself is identical either way.
 */

/** The API host: Claude Code's own upstream, the one host whose `/v1/` paths the routed pipeline serves. */
export const CONNECT_INTERCEPT_HOST = "api.anthropic.com";

/**
 * Every CONNECT host whose TLS this surface terminates, each with its own leaf and its own HTTP parser: the API host above, and `platform.claude.com`, the claude.ai control plane where Remote Control's long-lived channel and its handshake live. Terminating the second one is what makes a Remote Control login rejection observable at all: its bytes cross this surface either way, and blind-tunnelling them hides exactly the exchange that failed. Only the API host's `/v1/` paths ever reach the routed pipeline; everything else on either session is piped to that session's own real upstream, so the pipeline's identification and authorisation are never asked to serve another host's traffic.
 */
export const CONNECT_INTERCEPT_HOSTS: readonly string[] = [CONNECT_INTERCEPT_HOST, "platform.claude.com"];

/**
 * The intercept hosts the surface never parses as HTTP: terminated with ALPN for HTTP/2 and HTTP/1.1 both offered, pumped byte for byte to the real host over TLS (offering upstream only the protocol the client negotiated), and teed into the capture's stream tap when capturing is on. The claude.ai control plane's channel mixes an HTTP/1.1-shaped request with binary HTTP/2 frames, so parsing it as either protocol would destroy or distort it; tapping preserves the channel exactly as a blind tunnel served it while making its bytes observable.
 */
export const CONNECT_TAP_HOSTS: readonly string[] = ["platform.claude.com"];

/** Paths under this prefix are what the routed pipeline serves; everything else on the terminated session goes to the real upstream. */
export const ROUTED_PATH_PREFIX = "/v1/";

/** The port HTTPS is served on, both the default when a CONNECT authority names none and the port non-headroom paths are piped to on the real upstream. */
export const HTTPS_PORT = 443;

/** The highest TCP port an authority can name; anything above it is malformed, not a port. */
const MAX_PORT = 65535;

/** What the forwarding effect answers with when the upstream is unreachable. */
export const HTTP_BAD_GATEWAY = 502;

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
const CA_SUBJECT_COMMON_NAME = "agent-shim front door CA";

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

/** Whether a CONNECT target's host (port already stripped) is one whose TLS this proxy terminates. */
export function isInterceptedHost(host: string, interceptHosts: readonly string[]): boolean {
  return interceptHosts.includes(host);
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

/** Generates the local CA: one RSA keypair, self-signed, CA-only by basicConstraints and keyUsage, with a random serial. Built on `node:crypto` alone (see `x509.ts`), no openssl, so the same code works on every platform agent-shim ships to. */
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
 * Persistence for the CA: generated once on the machine's first front-door start and reused forever after, because regenerating it would invalidate every child's `NODE_EXTRA_CA_CERTS` pointing at the old file. The real implementation writes the key with mode 0600; injected fakes keep it in memory.
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
export interface ConnectListenerHandle {
  readonly port: number;
  /** Stops accepting, ends every live connection, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/** Presents one leaf's server-side TLS on CONNECTed sockets. */
interface TlsAcceptor {
  /** Starts the TLS handshake on a socket that has just received its CONNECT response, carrying `context` to the handshake's completion untouched: whatever the caller knows about this connection (its tunnel's capability) reaches `onSecure` without the acceptor interpreting it. */
  readonly accept: (socket: net.Socket, context: string) => void;
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
  /** Builds the TLS terminator for one leaf, handing each successfully handshaked session to `onSecure` together with the context its `accept` call carried. `alpnProtocols`, when given, is advertised during the handshake, which is how a tap host's session can offer HTTP/2 the way its real server does. */
  readonly createTlsAcceptor: (leaf: LeafCert, onSecure: (secure: net.Socket, context: string) => void, alpnProtocols?: readonly string[]) => TlsAcceptor;
  /** Opens a TLS connection to a real host, presenting its name as SNI, for a tap session's upstream half. `clientAlpn`, when given, is the protocol the client negotiated with the surface and the only one offered upstream, so the tap never changes the channel's protocol. */
  readonly connectTlsUpstream: (host: string, port: number, clientAlpn: string | undefined) => Promise<net.Socket>;
  /** Builds the HTTP parser bound to one request handler. `onUpgrade`, when given, owns every HTTP upgrade request arriving on a terminated session, socket and already-read bytes included; a session without one lets Node destroy the upgrade, its own no-listener behaviour. */
  readonly createHttpSession: (handler: ConnectRequestHandler, onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => HttpParserSession;
  /** Opens a raw TCP connection for a blind tunnel. */
  readonly connectTcp: (host: string, port: number) => Promise<net.Socket>;
  /** Streams one request to `target` and the response back, never buffering a body. When `observer` is given, the forwarding drives it with additive listeners (request and response chunks arrive to both the pipe and the observer) so capturing never changes the forwarding's own flow control. */
  readonly forwardHttp: (target: ConnectForwardTarget, request: IncomingMessage, response: ServerResponse, observer?: PassthroughObserver) => void;
}

/** Everything the connect surface needs to route, resolved before it starts. */
export interface ConnectServerConfig {
  /** The CONNECT hosts whose TLS get terminated, each with its own leaf, its own HTTP parser and its own upstream. */
  readonly interceptHosts: readonly string[];
  /**
   * The one intercept host whose `/v1/` paths `serveRouted` handles: the API host, whose pipeline identification, authorisation and headroom hop are about Anthropic sessions and no other host's traffic.
   */
  readonly routedHost: string;
  /**
   * Serves one routed path (`/v1/...`) from the terminated session: the same ordered pipeline the provider listener hands requests to, so an OAuth session and a provider session run identical identification, middleware and routing.
   */
  readonly serveRouted: ConnectRequestHandler;
  /** The leaf to terminate each intercept host with, minted and cached per host. */
  readonly leafFor: (host: string) => LeafCert;
  /** Where non-routed paths on one host's terminated session are piped: that host's own real upstream over TLS. */
  readonly upstreamFor: (host: string) => ConnectForwardTarget;
  /** Whether a capability presented as a CONNECT request's proxy credential belongs to a live launch: the same constant-time check against the same registry the routed pipeline's admission makes, read fresh on every call because launches come and go. */
  readonly isLiveCapability: (token: string) => boolean;
  /**
   * Binds a second listener that serves the intercept hosts' sessions to connections arriving pre-established, with no CONNECT handshake to authenticate: what an operating-system redirect (a pf rule sending the real hosts' address to this port) delivers. Only the API host's session is reachable this way, never a tap host's, because a redirect can name only addresses and the control plane shares the API host's address today; if that ever splits, the transparent listener must not follow it blindly. There is no capability to check on this surface: the connection carried no proxy credential, so every request rides the pipeline anonymously, admitted the way a tunnel's own header-less requests are (by nothing, which is exactly what they present), and the surface exists solely for clients that ignore proxies and would otherwise be invisible to the door entirely.
   */
  readonly transparentPort?: number;
  /**
   * The capability the transparent surface's sessions carry: a real, registered token minted by the door for its own pid, so header-less traffic that arrives by redirect is admitted and attributed like any launch's instead of being refused for a credential it cannot possibly present. Absent along with `transparentPort`.
   */
  readonly transparentCapability?: string;
  /** The intercept hosts that are never HTTP-parsed: terminated, tapped at the byte level, and pumped to their real host. */
  readonly tapHosts: readonly string[];
  /** The connection deadlines and caps; production passes `CONNECT_LIMITS`. */
  readonly limits: ConnectLimits;
  /** The diagnostic tap, when capturing is enabled; absent means nothing is recorded. */
  readonly capture?: ConnectCapture;
}

/** A running connect surface. */
export interface ConnectServerHandle {
  readonly port: number;
  /** The transparent listener's port, when one was requested: what an operating-system redirect should point at. */
  readonly transparentPort?: number;
  /** Stops the listener, drops every live tunnel and terminated session, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/** The ALPN protocols a tap host's TLS offers: HTTP/2 first, because that is what its real server negotiates and what the channel has proved to be, with HTTP/1.1 still allowed so a client that speaks it is served rather than refused. */
const TAP_ALPN_PROTOCOLS: readonly string[] = ["h2", "http/1.1"];

/**
 * Starts the connect surface: binds the listener, mints the intercept host's leaf, and wires the per-connection routing. Resolves once the listener is bound.
 *
 * The connection flow: read the CONNECT head within the deadline (never more of the stream than that, so an early ClientHello glued to the head is pushed back with `unshift` and still seen by whatever consumes the socket next), authenticate it, then either blind-tunnel the target or terminate its TLS and parse HTTP on the session. Every network effect flows through `effects`; nothing here touches the network or filesystem itself.
 */
export async function startConnectServer(config: ConnectServerConfig, effects: ConnectEffects, preferredPort: number | undefined): Promise<ConnectServerHandle> {
  // The capability each terminated session's tunnel authenticated with, keyed by the TLS session the acceptor handed over. A request riding that session is admitted by this token when its own headers carry none: the pipeline's per-request admission exists for listeners with no transport auth (a loopback process spending a session's credentials through the provider listener), while a CONNECT surface session already authenticated at the tunnel, and a client inside the child that never sees the launcher's headers (Claude Code's Remote Control bridge is exactly this, and its requests were refused with a 401 Claude Code misreports as a rejected login) has nothing else to present.
  const tunnelTokens = new WeakMap<net.Socket, string>();
  // One HTTP parser per intercept host, so each handler knows by closure which host's session it serves and therefore which upstream a non-routed path is piped to. No socket-to-host bookkeeping to get wrong: the only path into a session's handler is that host's acceptor.
  // An upgrade request is relayed, never parsed: the client wants a 101 and a raw byte channel after it (Remote Control's websocket to the API host is exactly this), which no request/response forwarding can carry. The relay splices the client's TLS session to a fresh TLS connection to the session's real host, byte for byte, using the same pump a tap host uses; the capture records the upgrade's head, and the frames after it flow unrecorded.
  const onUpgrade = (host: string) => (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    config.capture?.upgrade(request);
    if (head.length > 0) {
      // Paused first, exactly as the CONNECT head parser does: an unshift on a still-flowing socket hands its bytes to listeners that no longer exist, losing them before the relay's pipe attaches.
      socket.pause();
      socket.unshift(head);
    }
    // The parser consumed the request's own head, so the relay reconstructs it verbatim (method, target, and every header exactly as sent, case and order included via rawHeaders) for the upstream to parse; everything after it is spliced raw.
    const headText = `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1\r\n${request.rawHeaders.reduce((accumulated, value, index) => (index % 2 === 0 ? `${accumulated}${value}: ` : `${accumulated}${value}\r\n`), "")}\r\n`;
    // The relayed websocket is teed like a tap host's stream when capturing is on: the door never parses the frames, but the capture records them both directions so the channel's protocol can be decoded offline (see `wsFrames.ts`).
    pumpTapSession(socket, async (clientAlpn) => await effects.connectTlsUpstream(host, HTTPS_PORT, clientAlpn), config.capture?.tapStream?.(host), Buffer.from(headText, "utf8"));
  };
  const sessions = config.interceptHosts.map((host) => {
    if (config.tapHosts.includes(host)) {
      const tlsAcceptor = effects.createTlsAcceptor(
        config.leafFor(host),
        (secure) => {
          pumpTapSession(secure, async (clientAlpn) => await effects.connectTlsUpstream(host, HTTPS_PORT, clientAlpn), config.capture?.tapStream?.(host));
        },
        TAP_ALPN_PROTOCOLS,
      );
      return { host, tlsAcceptor };
    }

    const handler: ConnectRequestHandler = (request, response) => {
      if (host === config.routedHost && servedByPipeline(request.url)) {
        const tunnelToken = tunnelTokens.get(request.socket);
        if (tunnelToken !== undefined && request.headers[AUTH_HEADER] === undefined) {
          request.headers[AUTH_HEADER] = tunnelToken;
        }
        config.serveRouted(request, response);
        return;
      }
      effects.forwardHttp(config.upstreamFor(host), request, response, config.capture?.observePassthrough(request));
    };
    const httpSession = effects.createHttpSession(handler, onUpgrade(host));
    const tlsAcceptor = effects.createTlsAcceptor(config.leafFor(host), (secure, context) => {
      tunnelTokens.set(secure, context);
      httpSession.serve(secure);
    });
    return { host, httpSession, tlsAcceptor };
  });
  const ledger = createConnectionLedger(config.limits, config.isLiveCapability);

  // The listener owns teardown of everything it accepted: destroying the raw CONNECT socket ends both the blind tunnels and the TLS sessions layered on top of them.
  const listener = await effects.listenLoopback(preferredPort, (socket) => {
    handleConnect(socket, { config, effects, sessions, ledger });
  });

  const apiSession = sessions.find((session) => session.host === config.routedHost);
  const transparent =
    config.transparentPort === undefined || apiSession === undefined
      ? undefined
      : await effects.listenLoopback(config.transparentPort, (socket) => {
          // A redirected connection is the intercept host's session the moment it arrives: no head to parse, no credential to read, straight into the API host's TLS acceptor, whose session then handles routing, piped forwarding and relayed upgrades exactly as a CONNECT-tunnelled one does.
          apiSession.tlsAcceptor.accept(socket, config.transparentCapability ?? "");
        });

  return {
    port: listener.port,
    ...(transparent === undefined ? {} : { transparentPort: transparent.port }),
    close: async () => {
      ledger.close();
      await listener.close();
      await transparent?.close();
      for (const { httpSession, tlsAcceptor } of sessions) {
        tlsAcceptor.close();
        httpSession?.close();
      }
    },
  };
}

/** One intercept host's terminated-session machinery: an HTTP-parsed session (the API host), or a byte-tapped pump (a tap host) with no HTTP session at all. */
interface InterceptSession {
  readonly host: string;
  readonly tlsAcceptor: TlsAcceptor;
  readonly httpSession?: HttpParserSession;
}

/** Everything one connection's handling needs from the running surface. */
interface ConnectionContext {
  readonly config: ConnectServerConfig;
  readonly effects: ConnectEffects;
  readonly sessions: readonly InterceptSession[];
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
  const { config, effects, sessions, ledger } = context;
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
  const session = sessions.find((entry) => entry.host === target.host);
  config.capture?.connect(target, session !== undefined);
  socket.write(CONNECT_ESTABLISHED);
  if (session !== undefined) {
    session.tlsAcceptor.accept(socket, capability);
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
