import { X509Certificate, createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type * as net from "node:net";
import type { Duplex } from "node:stream";

import { parseDialAuthority } from "../baseUrlDial";
import { issueCaCertificate, issueLeafCertificate } from "./x509";
import type { ConnectCapture, PassthroughObserver } from "./capture";
import { pumpTapSession } from "./tap";
import { CONNECT_PROXY_REALM, capabilityFromProxyAuthorization } from "./capability";
import type { ListenSource } from "./handover";
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

/** The response header naming why a CONNECT authority was refused, so a client sees the problem and not only a bare 400. The reason is fixed text, never the client's own bytes. */
const REFUSAL_HEADER = "x-agent-shim-refusal";

/** The status lines the surface refuses a connection with, each closing it once written. */
const REFUSAL = {
  badRequest: "400 Bad Request",
  forbidden: "403 Forbidden",
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

/** Parses a CONNECT authority (`host`, `host:port`, `[v6]` or `[v6]:port`; a bare host means 443) through the rule every dial target takes (`parseDialAuthority`), or undefined when it cannot be dialled. The refusal's reason is `parseDialAuthority(authority, HTTPS_PORT)`'s own result. */
export function parseConnectTarget(authority: string): ConnectTarget | undefined {
  const parsed = parseDialAuthority(authority, HTTPS_PORT);
  return "refusal" in parsed ? undefined : parsed;
}

/** Whether a CONNECT target's host (port already stripped) is one whose TLS this proxy terminates. */
export function isInterceptedHost(host: string, interceptHosts: readonly string[]): boolean {
  return interceptHosts.includes(host);
}

/** The origin every request target is resolved against: only its path and query are ever read back, so any fixed origin serves. */
const TARGET_BASE = "http://127.0.0.1";

/**
 * One request target in the single form every decision on a terminated session reads: the path the WHATWG URL parser resolves (dot segments, percent-encoded dots, backslashes and an absolute-form target all collapse to the path a real host would serve) with the query kept. An origin-form target is parsed as the path it is, so a leading `//` stays part of the path rather than becoming an authority. The surface rewrites each request's target to this before anything decides on it, so the routing choice, the local surface and the upstream all see one path and no two parsers can disagree about a request. Undefined for a target the parser cannot read, which Node's own HTTP parser accepts (an absolute-form target with an out-of-range port, for one), and for a path the deciders' own readers (which resolve a target against a base) would read as a different one, such as a leading `//`: such a request is refused rather than decided on a path someone else would read differently.
 */
export function canonicalRequestTarget(target: string | undefined): string | undefined {
  const raw = target ?? "/";
  const absolute = raw.startsWith("/") ? `${TARGET_BASE}${raw}` : undefined;
  if (absolute === undefined ? !URL.canParse(raw, TARGET_BASE) : !URL.canParse(absolute)) {
    return undefined;
  }
  const parsed = absolute === undefined ? new URL(raw, TARGET_BASE) : new URL(absolute);
  const canonical = `${parsed.pathname}${parsed.search}`;
  return new URL(canonical, TARGET_BASE).pathname === parsed.pathname ? canonical : undefined;
}

/** Answers one request on a terminated session with an empty body and the given status, closing the session: what the surface sends for a request it will neither decide on nor forward. */
function answerAndClose(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-length": "0", connection: "close" });
  response.end();
}

/** Whether a request path on the terminated session is one the routed pipeline serves. The query string stays part of the path: `/v1/messages?beta=true` is still the pipeline's. Callers pass a target already in `canonicalRequestTarget` form. */
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
  /** The listening socket itself, which a planned replacement hands to the successor door (see `./handover.ts`). */
  readonly listening: net.Server;
  /** Stops accepting and releases the port at once, leaving every connection already accepted open: a successor can bind the same port while they finish. */
  readonly stopAccepting: () => void;
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

/** Presents every served host's leaf on one handshake, selected by the SNI name the client sent: the transparent surface's terminator, answering each redirected connection as the host it named. */
interface SniTlsAcceptor {
  /** Starts the TLS handshake on a redirected socket; a handshake that completes for a served host hands its secure session to the acceptor's `onSecure` with that host's name. */
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
  /** Binds a loopback TCP listener, or adopts the one `source` inherits from the door being replaced; a bound one tries the preferred port first and uses any free port when it is taken (bind, do not probe: check-then-bind races). Resolves with the bound port and a close handle. */
  readonly listenLoopback: (source: ListenSource, onSocket: (socket: net.Socket) => void) => Promise<ConnectListenerHandle>;
  /** Builds the TLS terminator for one leaf, handing each successfully handshaked session to `onSecure` together with the context its `accept` call carried. `alpnProtocols`, when given, is advertised during the handshake, which is how a tap host's session can offer HTTP/2 the way its real server does. */
  readonly createTlsAcceptor: (leaf: LeafCert, onSecure: (secure: net.Socket, context: string) => void, alpnProtocols?: readonly string[]) => TlsAcceptor;
  /** Builds the transparent surface's TLS terminator: one handshake whose SNI name selects which served host's leaf answers it, so a connection redirected from any of the hosts sharing the redirected address is terminated as the host it named. A name the surface does not serve is answered with no certificate at all (a client that sends no SNI never reaches the selection and finds no default certificate either), because the only leaf that could answer such a name is another host's, which the client's own hostname check would reject anyway. No ALPN is offered: node's TLS server negotiates ALPN from the listener's own options and ignores protocols named on an SNI-selected secure context, and the API host's terminated session is parsed as HTTP/1.1, which a negotiated `h2` would strand. */
  readonly createSniTlsAcceptor: (hosts: readonly string[], leafFor: (host: string) => LeafCert, onSecure: (secure: net.Socket, host: string) => void) => SniTlsAcceptor;
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
   * Binds a second listener that terminates redirected connections per host, with no CONNECT handshake to authenticate: what an operating-system redirect (a pf rule sending the real hosts' address to this port) delivers, pre-established. A redirect names addresses, and several real hosts share the API host's, so the client's TLS SNI name is what says which host arrived: each intercept host is served with its own leaf and its own session exactly as a CONNECT-tunnelled connection to that host is (the API host's `/v1/` rides the routed pipeline, a tap host's stream is pumped to its real host), and a name outside the intercept set, or a connection presenting none, is refused with no certificate at all, because the only leaf that could answer it is another host's. There is no capability to check on this surface: the connection carried no proxy credential, so every request rides the pipeline anonymously, admitted the way a tunnel's own header-less requests are (by nothing, which is exactly what they present), and the surface exists solely for clients that ignore proxies and would otherwise be invisible to the door entirely.
   */
  readonly transparentPort?: number;
  /**
   * The capability the transparent surface's sessions carry: a real, registered token minted by the door for its own pid, so header-less traffic that arrives by redirect is admitted and attributed like any launch's instead of being refused for a credential it cannot possibly present. Absent along with `transparentPort`.
   */
  readonly transparentCapability?: string;
  /** The intercept hosts that are never HTTP-parsed: terminated, tapped at the byte level, and pumped to their real host. */
  readonly tapHosts: readonly string[];
  /**
   * The door's local answer surface, consulted before routing or piping on every parsed host's session, and given the parsing of the tap hosts it names: absent (the default, and every door that has not asked for the self-hosted Remote Control mode) nothing about the surface's behaviour changes.
   */
  readonly localSurface?: ConnectLocalSurface;
  /** The connection deadlines and caps; production passes `CONNECT_LIMITS`. */
  readonly limits: ConnectLimits;
  /** The diagnostic tap, when capturing is enabled; absent means nothing is recorded. */
  readonly capture?: ConnectCapture;
  /** Where the surface writes one line per request it failed to serve; absent, such a failure is answered and not logged. */
  readonly log?: (line: string) => void;
}

/** A running connect surface. */
export interface ConnectServerHandle {
  readonly port: number;
  /** The CONNECT listener's listening socket, which a planned replacement hands to the successor door (see `./handover.ts`). The transparent listener is not handed over: it exists only when the door's own environment asks for it, which a successor decides for itself. */
  readonly listening: net.Server;
  /** The transparent listener's port, when one was requested: what an operating-system redirect should point at. */
  readonly transparentPort?: number;
  /** How many authenticated connections (blind tunnels and terminated sessions together) are open now: what closing this surface, or exiting its process, drops. */
  readonly openTunnels: () => number;
  /**
   * Retires the surface without cutting off the tunnels it carries: the port is released at once so a successor can bind it, the terminated sessions (which carry this door's own routing state) are ended so their clients reconnect to the successor, and the blind tunnels, which are byte pumps to hosts the door never looks into, keep running until they end by themselves or their launch ends. A connection the listener accepted before it stopped but whose head has not arrived yet is still answered: its blind tunnel runs like any other, its terminated session serves one request and ends, and one whose head never comes is refused at its deadline. Resolves when the last connection has closed, with the surface fully closed.
   */
  readonly drain: () => Promise<void>;
  /** Stops the listener, drops every live tunnel and terminated session, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/**
 * A surface the connect layer consults before it routes or pipes anything: the door's self-hosted Remote Control answers (see `rcSelfHost.ts`). Which sessions it owns is decided once per terminated session, before the session is chosen and never from a request's headers: a CONNECT tunnel by the launch whose capability it presented (`ownsLaunch`), and a redirected connection, which carries no capability, by the process holding its other end (`ownsPeer`), failing closed when that process cannot be read. An owned session is served by a session set that parses every intercept host as HTTP (the tap hosts included, since the surface answers their traffic itself and the tap protects only traffic that is forwarded): its requests go to `serve` first, its upgrades and blind tunnels are refused, and nothing it sends reaches a real host except what the routed pipeline serves. Every other session is served by the ordinary set, exactly as with no surface at all, tap hosts tapped. Absent, every request keeps exactly the behaviour it has today.
 */
export interface ConnectLocalSurface {
  /** Serves one request of a session the surface owns (the connect surface consults it for no other); resolves false when the request is for the routed pipeline, so routing continues unchanged. */
  readonly serve: (host: string, request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  /** Whether the launch whose capability a CONNECT tunnel presented is one this surface owns: its requests are served by `serve`, its upgrades refused and its blind tunnels refused, whatever any request presents. */
  readonly ownsLaunch: (capability: string) => boolean;
  /** Whether a redirected connection whose client end is on local port `port` is one this surface owns: attributed by the process holding that end, since a redirect carries no launch capability. Resolves true when the connection cannot be attributed at all, so an unattributable session fails closed. */
  readonly ownsPeer: (port: number) => Promise<boolean>;
  /** What the surface's ownership decisions currently rest on (for the self-hosted mode, the identity the credential is minted into): when it changes, every decision made under the old value is stale. */
  readonly mintGeneration: () => string;
}

/** The statuses the surface answers one request on a terminated session with when it neither serves nor forwards it. */
const REQUEST_STATUS = {
  badRequest: 400,
  internalServerError: 500,
} as const;

/** The whole answer to an upgrade the local surface claims: a 404 that closes the connection, since no upgrade it claims has anything on this machine to talk to. */
const REFUSED_UPGRADE_RESPONSE = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/** The ALPN protocols a tap host's TLS offers: HTTP/2 first, because that is what its real server negotiates and what the channel has proved to be, with HTTP/1.1 still allowed so a client that speaks it is served rather than refused. */
const TAP_ALPN_PROTOCOLS: readonly string[] = ["h2", "http/1.1"];

/**
 * Starts the connect surface: binds the listener, mints the intercept host's leaf, and wires the per-connection routing. Resolves once the listener is bound.
 *
 * The connection flow: read the CONNECT head within the deadline (never more of the stream than that, so an early ClientHello glued to the head is pushed back with `unshift` and still seen by whatever consumes the socket next), authenticate it, then either blind-tunnel the target or terminate its TLS and parse HTTP on the session. Every network effect flows through `effects`; nothing here touches the network or filesystem itself.
 */
export async function startConnectServer(config: ConnectServerConfig, effects: ConnectEffects, source: ListenSource): Promise<ConnectServerHandle> {
  // The capability each terminated session's tunnel authenticated with, keyed by the TLS session the acceptor handed over. A request riding that session is admitted by this token when its own headers carry none: the pipeline's per-request admission exists for listeners with no transport auth (a loopback process spending a session's credentials through the provider listener), while a CONNECT surface session already authenticated at the tunnel, and a client inside the child that never sees the launcher's headers (Claude Code's Remote Control bridge is exactly this, and its requests were refused with a 401 Claude Code misreports as a rejected login) has nothing else to present.
  const tunnelTokens = new WeakMap<net.Socket, string>();
  // Which launches the local surface owns can change while sessions are open (a mint names another identity, or names one for the first time): every decision rests on the generation it was made under, so when the generation moves, every authenticated connection and redirected session is ended and its client's reconnection is decided afresh. Checked before every decision and on the ledger's revalidation tick, so a quiet session is not left decided under a mint that no longer holds.
  let generation = config.localSurface?.mintGeneration();
  const redirectedSessions = new Set<net.Socket>();
  const ledger = createConnectionLedger(config.limits, config.isLiveCapability, () => {
    checkGeneration();
  });
  function checkGeneration(): void {
    const surface = config.localSurface;
    if (surface === undefined) {
      return;
    }
    const current = surface.mintGeneration();
    if (current === generation) {
      return;
    }
    config.log?.("connect: the self-hosted mint changed, so every intercepted session and tunnel is ended and decided again on reconnection");
    generation = current;
    ledger.endAuthenticated();
    for (const secure of redirectedSessions) {
      secure.destroy();
    }
  }
  /** The deadline of each terminated session a retiring surface took on, disarmed by its first request (see `serveSecure`). */
  const lateSessionDeadlines = new WeakMap<net.Socket, NodeJS.Timeout>();
  // Whether each terminated session is the local surface's: decided before the session is chosen (from the CONNECT tunnel's launch, or a redirected connection's peer process) and recorded by the session set that serves it, so every request and upgrade on it is decided the same way.
  const owned = new WeakMap<net.Socket, boolean>();
  const ownedBySurface = (secure: net.Socket): boolean => owned.get(secure) === true;
  // One HTTP parser per intercept host, so each handler knows by closure which host's session it serves and therefore which upstream a non-routed path is piped to. No socket-to-host bookkeeping to get wrong: the only path into a session's handler is that host's acceptor.
  // An upgrade request is relayed, never parsed: the client wants a 101 and a raw byte channel after it (Remote Control's websocket to the API host is exactly this), which no request/response forwarding can carry. The relay splices the client's TLS session to a fresh TLS connection to the session's real host, byte for byte, using the same pump a tap host uses; the capture records the upgrade's head, and the frames after it flow unrecorded.
  const onUpgrade = (host: string) => (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    config.capture?.upgrade(request);
    if (ownedBySurface(request.socket)) {
      // The local surface serves no upgrade, so an owned session's is refused here, before any upstream is dialled: relaying it would carry the session to the real host whatever it presents.
      socket.end(REFUSED_UPGRADE_RESPONSE);
      return;
    }
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
  // Two session sets: the one every session not the local surface's is served by (each tap host byte-tapped, exactly as with no surface), and, when a surface is configured, the one its sessions are served by (every host parsed, since the surface answers them itself). A session is handed to one set or the other once its ownership is known, before its TLS is terminated on a CONNECT tunnel.
  const sessionsFor = (ownedSet: boolean): readonly InterceptSession[] => config.interceptHosts.map((host) => {
    if (config.tapHosts.includes(host) && !ownedSet) {
      const serveSecure = (secure: net.Socket): void => {
        pumpTapSession(secure, async (clientAlpn) => await effects.connectTlsUpstream(host, HTTPS_PORT, clientAlpn), config.capture?.tapStream?.(host));
      };
      const tlsAcceptor = effects.createTlsAcceptor(config.leafFor(host), serveSecure, TAP_ALPN_PROTOCOLS);
      return { host, serveSecure, tlsAcceptor };
    }

    // The local surface is consulted first and awaited, because serving a path it owns means the whole response has been written by the time it resolves; a miss falls through to routing or piping unchanged. The parser's handler shape returns void, so the awaited body runs as its own helper.
    const handleHostRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      checkGeneration();
      if (request.socket.destroyed) {
        return;
      }
      const target = canonicalRequestTarget(request.url);
      if (target === undefined) {
        request.resume();
        answerAndClose(response, REQUEST_STATUS.badRequest);
        return;
      }
      request.url = target;
      if (ledger.retiring()) {
        // A session the retiring surface took on serves this one request and then ends, so its client's next request opens a connection the successor takes.
        clearTimeout(lateSessionDeadlines.get(request.socket));
        response.once("close", () => {
          request.socket.end();
        });
      }
      if (config.localSurface !== undefined && ownedBySurface(request.socket) && (await config.localSurface.serve(host, request, response))) {
        return;
      }
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
    // The handler is the last place a failure in serving one request can be caught: the door is one process carrying every session's tunnels, so a failure answers this request 500 and nothing else.
    const handler: ConnectRequestHandler = (request, response) => {
      handleHostRequest(request, response).catch((error: unknown) => {
        config.log?.(`connect: serving ${request.method ?? "?"} on ${host} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        request.resume();
        answerAndClose(response, REQUEST_STATUS.internalServerError);
      });
    };
    const httpSession = effects.createHttpSession(handler, onUpgrade(host));
    const serveSecure = (secure: net.Socket, capability: string): void => {
      tunnelTokens.set(secure, capability);
      owned.set(secure, ownedSet);
      if (ledger.retiring()) {
        // A session that reached a retiring surface was accepted before the listener stopped: it is served one request (see `handleHostRequest`), and one that makes none within the time a CONNECT head is given is ended, so it cannot hold the retirement open.
        const deadline = setTimeout(() => {
          secure.destroy();
        }, config.limits.headDeadlineMs);
        deadline.unref();
        lateSessionDeadlines.set(secure, deadline);
      }
      httpSession.serve(secure);
    };
    const tlsAcceptor = effects.createTlsAcceptor(config.leafFor(host), serveSecure);
    return { host, serveSecure, httpSession, tlsAcceptor };
  });
  const sessions = sessionsFor(false);
  const ownedSessions = config.localSurface === undefined ? undefined : sessionsFor(true);
  // The listener owns teardown of everything it accepted: destroying the raw CONNECT socket ends both the blind tunnels and the TLS sessions layered on top of them.
  const listener = await effects.listenLoopback(source, (socket) => {
    handleConnect(socket, { config, effects, sessions, ownedSessions, ledger, checkGeneration });
  });

  const apiSession = sessions.find((session) => session.host === config.routedHost);
  const sessionByHost = new Map(sessions.map((session) => [session.host, session]));
  const ownedSessionByHost = new Map((ownedSessions ?? []).map((session) => [session.host, session]));
  // The transparent surface's terminator: one handshake whose SNI name selects the leaf, because a redirect sends every host sharing the API host's address here and each must be terminated as the host it named, never with the API host's certificate.
  const serveRedirected = (secure: net.Socket, host: string, isOwned: boolean): void => {
    redirectedSessions.add(secure);
    secure.once("close", () => {
      redirectedSessions.delete(secure);
    });
    const session = (isOwned ? ownedSessionByHost : sessionByHost).get(host);
    if (session === undefined) {
      // The acceptor fails the handshake of every name it was not given, and it was given exactly the intercept hosts these sessions cover, so reaching here means the acceptor itself misrouted; dropping the session is the fail-closed answer.
      secure.destroy();
      return;
    }
    session.serveSecure(secure, config.transparentCapability ?? "");
  };
  // A redirected connection names no launch, so with a local surface configured it is attributed by the process holding its other end (`ownsPeer`) before a session set is chosen. Nothing reads the TLS session meanwhile (no data listener is attached until the session serves it), so whatever the client sends waits in the socket's buffer; with no surface the session is served at once, exactly as before. An attribution that fails is the surface's, failing closed.
  const sniAcceptor = effects.createSniTlsAcceptor(config.interceptHosts, config.leafFor, (secure, host) => {
    const surface = config.localSurface;
    if (surface === undefined) {
      serveRedirected(secure, host, false);
      return;
    }
    checkGeneration();
    surface.ownsPeer(secure.remotePort ?? 0).then(
      (isOwned) => {
        serveRedirected(secure, host, isOwned);
      },
      (error: unknown) => {
        config.log?.(`connect: attributing a redirected ${host} connection failed, so it is served as the local surface's: ${error instanceof Error ? error.message : String(error)}`);
        serveRedirected(secure, host, true);
      },
    );
  });
  const transparent =
    config.transparentPort === undefined || apiSession === undefined
      ? undefined
      : await effects.listenLoopback({ preferredPort: config.transparentPort }, (socket) => {
          // A redirected connection is the session of whatever host its TLS SNI names, the moment it arrives: no head to parse, no credential to read, straight into the SNI acceptor, and the session then handles routing, piped forwarding and relayed upgrades exactly as a CONNECT-tunnelled one does.
          sniAcceptor.accept(socket);
        });

  /** Tears the whole surface down: timers, listeners (which end whatever they still hold) and the TLS machinery. */
  const closeSurface = async (): Promise<void> => {
    ledger.close();
    await listener.close();
    await transparent?.close();
    sniAcceptor.close();
    for (const { httpSession, tlsAcceptor } of [...sessions, ...(ownedSessions ?? [])]) {
      tlsAcceptor.close();
      httpSession?.close();
    }
  };

  return {
    port: listener.port,
    listening: listener.listening,
    ...(transparent === undefined ? {} : { transparentPort: transparent.port }),
    openTunnels: ledger.openTunnels,
    drain: async () => {
      listener.stopAccepting();
      // The transparent surface's connections are terminated sessions that never enter the ledger, so closing it is what ends them.
      await transparent?.close();
      await ledger.retire();
      await closeSurface();
    },
    close: closeSurface,
  };
}

/** One intercept host's terminated-session machinery: an HTTP-parsed session (the API host), or a byte-tapped pump (a tap host) with no HTTP session at all. */
interface InterceptSession {
  readonly host: string;
  /** Serves one TLS-terminated session of this host, whichever surface terminated it: the shared body of the CONNECT acceptor's and the transparent acceptor's completion handling, carrying the capability the connection authenticated by (a launch's for a CONNECT tunnel, the transparent capability for a redirect). */
  readonly serveSecure: (secure: net.Socket, capability: string) => void;
  readonly tlsAcceptor: TlsAcceptor;
  readonly httpSession?: HttpParserSession;
}

/** Everything one connection's handling needs from the running surface. */
interface ConnectionContext {
  readonly config: ConnectServerConfig;
  readonly effects: ConnectEffects;
  readonly sessions: readonly InterceptSession[];
  /** The session set the local surface's sessions are served by, when a surface is configured. */
  readonly ownedSessions: readonly InterceptSession[] | undefined;
  /** Ends every decision made under a mint generation that no longer holds; called before a CONNECT is decided. */
  readonly checkGeneration: () => void;
  readonly ledger: ConnectionLedger;
}

/** The surface's accounting of its connections, enforcing `ConnectLimits`. */
interface ConnectionLedger {
  /** Records a freshly accepted connection as pending and arms its head deadline, evicting the oldest pending connection first when the pending cap is reached. */
  readonly accept: (socket: net.Socket) => void;
  /** Marks a connection's head as received: it leaves the pending set and its deadline is disarmed. */
  readonly headReceived: (socket: net.Socket) => void;
  /** Records an authenticated connection under the capability it presented, and whether it is a blind tunnel or a terminated session. False, with nothing recorded, when the tunnel cap is already reached. */
  readonly establish: (socket: net.Socket, capability: string, kind: ConnectionKind) => boolean;
  /** Ends every authenticated connection, blind tunnels and terminated sessions alike: what a change in which launches the local surface owns calls, so each is reopened and decided afresh. */
  readonly endAuthenticated: () => void;
  /** How many authenticated connections are open. */
  readonly openTunnels: () => number;
  /**
   * Ends every authenticated connection that is not a blind tunnel and resolves once every connection the surface accepted has closed. A connection still waiting for its head is not ended: the listener accepted it before it stopped, so its client is owed an answer, and it is served as it would have been (a blind tunnel runs to its end, a terminated session serves one request; see `retiring`) or refused at its head deadline. The revalidation timer keeps running, so a launch that ends still takes its tunnels with it.
   */
  readonly retire: () => Promise<void>;
  /** Whether `retire` has begun: a terminated session established from then on serves one request and ends. */
  readonly retiring: () => boolean;
  /** Stops the revalidation timer and disarms every deadline; the listener's own close destroys the sockets. */
  readonly close: () => void;
}

/** What an authenticated connection carries: `blind` is a byte pump to a host the door never looks into, `terminated` is a TLS session this surface ends and routes, which holds the door's own state. */
type ConnectionKind = "blind" | "terminated";

function createConnectionLedger(limits: ConnectLimits, isLiveCapability: (token: string) => boolean, onRevalidate: () => void = () => undefined): ConnectionLedger {
  /** Connections still waiting for their head, oldest first (a Map iterates in insertion order), each with its deadline timer. */
  const pending = new Map<net.Socket, NodeJS.Timeout>();
  /** Authenticated connections grouped by the capability they presented, so a revalidation checks each launch once however many connections it holds. */
  const authenticated = new Map<string, Set<net.Socket>>();
  let tunnels = 0;
  /** The authenticated connections that are blind tunnels, which a retirement lets run to their end. */
  const blind = new Set<net.Socket>();
  /** Every connection accepted and not yet closed, whatever its stage: what a retirement waits on. */
  const live = new Set<net.Socket>();
  let retiring = false;
  /** Resolves a retirement waiting on the last connection. */
  let onNoConnections: (() => void) | undefined;

  const leavePending = (socket: net.Socket): void => {
    const deadline = pending.get(socket);
    if (deadline !== undefined) {
      clearTimeout(deadline);
      pending.delete(socket);
    }
  };

  const revalidation = setInterval(() => {
    onRevalidate();
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
    endAuthenticated: () => {
      for (const sockets of authenticated.values()) {
        for (const socket of sockets) {
          socket.destroy();
        }
      }
    },
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
      live.add(socket);
      socket.once("close", () => {
        leavePending(socket);
        live.delete(socket);
        if (live.size === 0) {
          onNoConnections?.();
        }
      });
    },
    headReceived: leavePending,
    openTunnels: () => tunnels,
    retire: async () => {
      retiring = true;
      for (const sockets of authenticated.values()) {
        for (const socket of sockets) {
          if (!blind.has(socket)) {
            socket.destroy();
          }
        }
      }
      if (live.size > 0) {
        await new Promise<void>((resolve) => {
          onNoConnections = resolve;
        });
      }
    },
    retiring: () => retiring,
    establish: (socket, capability, kind) => {
      if (tunnels >= limits.maxTunnels) {
        return false;
      }
      tunnels += 1;
      if (kind === "blind") {
        blind.add(socket);
      }
      const sockets = authenticated.get(capability) ?? new Set<net.Socket>();
      sockets.add(socket);
      authenticated.set(capability, sockets);
      socket.once("close", () => {
        tunnels -= 1;
        blind.delete(socket);
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
/** The `x-agent-shim-refusal` value a refused self-hosted tunnel carries, so a client or a test can tell the mode's refusal from any other 403. */
export const SELF_HOSTED_TUNNEL_REFUSAL = "self-hosted-remote-control";

/** Refuses a CONNECT with a plain-text body saying why and a header naming the rule that refused it, for a refusal the client (or a person reading its debug log) should be able to attribute. */
function refuseWithReason(socket: net.Socket, status: string, rule: string, reason: string): void {
  socket.removeAllListeners("data");
  socket.pause();
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.end(`HTTP/1.1 ${status}\r\nx-agent-shim-refusal: ${rule}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${String(Buffer.byteLength(reason))}\r\nconnection: close\r\n\r\n${reason}`, () => {
    socket.destroy();
  });
}

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
  const { config, effects, sessions, ownedSessions, ledger } = context;
  const credential = proxyAuthorizationOf(head);
  const capability = credential === undefined ? undefined : capabilityFromProxyAuthorization(credential);
  if (capability === undefined || !config.isLiveCapability(capability)) {
    refuse(socket, REFUSAL.proxyAuthenticationRequired, [`Proxy-Authenticate: Basic realm="${CONNECT_PROXY_REALM}"`]);
    return;
  }
  const requestLine = head.split("\r\n", 1)[0] ?? "";
  const parts = requestLine.split(" ");
  const authority = parts.length === CONNECT_LINE_TOKENS && parts[0]?.toUpperCase() === "CONNECT" ? (parts[1] ?? "") : undefined;
  const target = authority === undefined ? undefined : parseDialAuthority(authority, HTTPS_PORT);
  if (target === undefined || "refusal" in target) {
    refuse(socket, REFUSAL.badRequest, target === undefined ? [] : [`${REFUSAL_HEADER}: ${target.refusal}`]);
    return;
  }
  // The tunnel's launch decides, once and before its TLS is terminated, which session set serves it and whether a blind tunnel is refused.
  context.checkGeneration();
  const isOwned = config.localSurface?.ownsLaunch(capability) === true;
  const session = (isOwned && ownedSessions !== undefined ? ownedSessions : sessions).find((entry) => entry.host === target.host);
  if (session === undefined && isOwned) {
    config.capture?.refusedTunnel(target);
    refuseWithReason(socket, REFUSAL.forbidden, SELF_HOSTED_TUNNEL_REFUSAL, `the front door's self-hosted Remote Control mode does not tunnel to ${target.host}: a self-hosted session reaches no host the door does not serve itself`);
    return;
  }
  if (!ledger.establish(socket, capability, session === undefined ? "blind" : "terminated")) {
    refuse(socket, REFUSAL.serviceUnavailable);
    return;
  }
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
