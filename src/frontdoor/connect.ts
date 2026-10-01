import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import forge from "node-forge";

/**
 * The front door's CONNECT surface, so an OAuth session can have claude-use's routing AND Claude Code's Remote Control at once: Remote Control refuses any `ANTHROPIC_BASE_URL` other than the real API, but happily honours `HTTPS_PROXY`, so OAuth launches route at the proxy layer instead.
 *
 * Every CONNECT target is blind-tunnelled byte for byte EXCEPT the intercept host (Claude Code's own API), whose TLS this surface terminates with a leaf certificate signed by a locally generated CA. On the terminated session, the paths the front door routes (`/v1/`) are handed to the same ordered pipeline the provider listener serves (the client's Authorization header passes through untouched), and every other path is piped by this surface to the real upstream over TLS, so Remote Control's streaming, OAuth refreshes, and unknown endpoints bypass the pipeline entirely.
 */

/** The one CONNECT host whose TLS gets terminated: Claude Code's own API, the upstream every OAuth session is really talking to. */
export const CONNECT_INTERCEPT_HOST = "api.anthropic.com";

/** Paths under this prefix are what the routed pipeline serves; everything else on the terminated session goes to the real upstream. */
export const ROUTED_PATH_PREFIX = "/v1/";

/** The port HTTPS is served on, both the default when a CONNECT authority names none and the port non-headroom paths are piped to on the real upstream. */
export const HTTPS_PORT = 443;

/** The highest TCP port an authority can name; anything above it is malformed, not a port. */
const MAX_PORT = 65535;

/** Bytes of randomness in a certificate serial number: 128 bits, more than any collision a single machine's CA will ever mint. */
const SERIAL_NUMBER_BYTES = 16;

/** What the forwarding effect answers with when the upstream is unreachable. */
const HTTP_BAD_GATEWAY = 502;

/** The file mode of the CA private key: readable and writable by its owner, invisible to everyone else. */
const CA_KEY_FILE_MODE = 0o600;

/** A CONNECT request line carries exactly three tokens: method, authority, protocol. */
const CONNECT_LINE_TOKENS = 3;

/** The terminator of an HTTP request head, the framing the CONNECT parser splits on. */
const HEAD_TERMINATOR = "\r\n\r\n";

/** Largest CONNECT request head accepted before the connection is refused: a real head is one short line, so anything this size is a confused or hostile client. */
const MAX_CONNECT_HEAD_BYTES = 8192;

/** The response line every CONNECT proxy sends before the tunnel starts; the body is empty by definition. */
const CONNECT_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

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

/** Generates the local CA: one RSA keypair, self-signed, CA-only by basicConstraints and keyUsage, with a random serial. Pure node-forge, no openssl, so the same code works on every platform claude-use ships to. */
export function generateCa(now: Readonly<Date>): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(SERIAL_NUMBER_BYTES));
  cert.validity.notBefore = new Date(now.getTime() - MS_PER_DAY);
  cert.validity.notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * MS_PER_DAY);
  const subject = [{ name: "commonName", value: CA_SUBJECT_COMMON_NAME }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** The names the front door's provider listener answers to: the loopback address every provider session's base URL names, plus the loopback hostname for a client that spells it that way. */
export const LOOPBACK_LEAF_NAMES: readonly string[] = ["127.0.0.1", "localhost"];

/** node-forge's subjectAltName type codes (RFC 5280's GeneralName tags): 2 is a DNS name, 7 an IP address. */
const SAN_TYPE_DNS = 2;
const SAN_TYPE_IP = 7;

/**
 * Mints a TLS leaf signed by the CA: its own RSA keypair, server-auth usage only, the first name as the subject's common name and every name in the SAN. A name that parses as an IP address goes in as an IP SAN, because TLS clients match an IP host only against IP SANs, never against a DNS SAN spelling the same digits.
 */
export function mintLeaf(ca: CaMaterial, names: readonly string[], now: Readonly<Date>): LeafCert {
  const [commonName] = names;
  if (commonName === undefined) {
    throw new Error("a leaf certificate needs at least one name");
  }
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(SERIAL_NUMBER_BYTES));
  cert.validity.notBefore = new Date(now.getTime() - MS_PER_DAY);
  cert.validity.notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * MS_PER_DAY);
  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: names.map((name) => (net.isIP(name) === 0 ? { type: SAN_TYPE_DNS, value: name } : { type: SAN_TYPE_IP, ip: name })) },
    { name: "subjectKeyIdentifier" },
    { name: "authorityKeyIdentifier", keyLocatorFields: [] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** Mints each host's leaf once from the CA and reuses it, because a 2048-bit keypair in pure JS costs seconds and nothing about the certificate changes between sessions. */
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
 * Loads the persisted CA, generating and persisting one when no usable CA exists. A stored pair that node-forge cannot parse is treated as absent and replaced: a truncated write is the one failure mode a regeneration can actually repair, and every child that trusted the old file needs a new `NODE_EXTRA_CA_CERTS` anyway once its CA stops parsing.
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
    forge.pki.certificateFromPem(ca.certPem);
    forge.pki.privateKeyFromPem(ca.keyPem);
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
 * The connection flow: read the CONNECT head (never more of the stream than that, so an early ClientHello glued to the head is pushed back with `unshift` and still seen by whatever consumes the socket next), then either blind-tunnel the target or terminate its TLS and parse HTTP on the session. Every effect flows through `effects`; nothing here touches the network or filesystem itself.
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

  // The listener owns teardown of everything it accepted: destroying the raw CONNECT socket ends both the blind tunnels and the TLS sessions layered on top of them.
  const listener = await effects.listenLoopback(preferredPort, (socket) => {
    handleConnect(socket, config, effects, tlsAcceptor);
  });

  return {
    port: listener.port,
    close: async () => {
      await listener.close();
      tlsAcceptor.close();
      httpSession.close();
    },
  };
}

/** Reads one CONNECT head off the socket and routes the connection: blind tunnel, or TLS termination into the acceptor. */
function handleConnect(socket: net.Socket, config: ConnectServerConfig, effects: ConnectEffects, tlsAcceptor: TlsAcceptor): void {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const headEnd = buffer.indexOf(HEAD_TERMINATOR);
    if (headEnd === -1) {
      if (buffer.length > MAX_CONNECT_HEAD_BYTES) {
        socket.removeListener("data", onData);
        socket.pause();
        socket.destroy();
      }
      return;
    }
    socket.removeListener("data", onData);
    // Detaching a 'data' listener does NOT return the socket to paused mode, and a still-flowing socket with no listener discards everything that arrives next, which would eat the ClientHello before the TLS layer attaches. Pausing explicitly is what keeps the following bytes buffered for the next consumer.
    socket.pause();
    const head = buffer.subarray(0, headEnd).toString("utf8");
    // Whatever followed the head in the buffer (an early TLS ClientHello, typically) belongs to the next consumer, so it goes back to the front of the socket's buffer; the listener comes off before routing so the next consumer, not this parser, drains what follows.
    socket.unshift(buffer.subarray(headEnd + HEAD_TERMINATOR.length));
    routeConnect(socket, head, config, effects, tlsAcceptor);
  };
  socket.on("data", onData);
  socket.on("error", () => {
    socket.destroy();
  });
}

/** Applies the routing decision for one parsed CONNECT head. */
function routeConnect(socket: net.Socket, head: string, config: ConnectServerConfig, effects: ConnectEffects, tlsAcceptor: TlsAcceptor): void {
  const requestLine = head.split("\r\n", 1)[0] ?? "";
  const parts = requestLine.split(" ");
  const authority = parts.length === CONNECT_LINE_TOKENS && parts[0]?.toUpperCase() === "CONNECT" ? (parts[1] ?? "") : undefined;
  const target = authority === undefined ? undefined : parseConnectTarget(authority);
  if (target === undefined) {
    socket.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
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
