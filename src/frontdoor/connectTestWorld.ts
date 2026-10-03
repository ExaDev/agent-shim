import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { expect } from "vitest";

import { connectProxyUrl } from "./capability";
import type { ConnectCapture } from "./capture";
import {
  CONNECT_INTERCEPT_HOST,
  CONNECT_INTERCEPT_HOSTS,
  CONNECT_LIMITS,
  createLeafCache,
  mintLeaf,
  startConnectServer,
  type CaMaterial,
  type ConnectEffects,
  type ConnectLimits,
} from "./connect";
import { realConnectEffects } from "./connectEffects";

/** Enough time for the pure-JS 2048-bit keypairs this file generates in `beforeAll`. */
export const KEYGEN_TIMEOUT_MS = 120_000;

/**
 * How long the fake routed backend holds back the second half of its streamed response. A proxy that buffered the body would deliver both halves in one arrival, so any measured gap at least this large proves the bytes flowed through as they were written.
 */
const STREAM_HOLD_BACK_MS = 300;
/** The gap the client must observe between its first and last body arrivals, comfortably under the hold-back so scheduling noise cannot flip the verdict. */
export const MIN_STREAM_GAP_MS = 150;

/** How long the capture test waits for a finished response's close event, which the capture's end record rides and which can trail the parsed response by a tick. */
export const RESPONSE_CLOSE_SETTLE_MS = 50;

/** The statuses this file asserts on, named so a status literal never reads as a magic number: the healthy answer, the unauthenticated fake upstream's answer, and the proxy's own cannot-serve answer. */
export const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;

/** The byte length of an HTTP head terminator, the framing this file's hand-rolled client parses. */
export const HEAD_TERMINATOR = "\r\n\r\n";

/** A made-up launch capability the round-trip world accepts as live. */
export const TEST_CAPABILITY = "connect-test-capability";

/** The `Proxy-Authorization` header a client derives from a launch's `HTTPS_PROXY` URL, built from the URL the launcher would set so the test exercises the same encoding round trip a real client does. */
export function proxyAuthorizationFor(token: string): string {
  const url = new URL(connectProxyUrl(1, token));
  return `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}


/** A client's view of one HTTP response, framed by content-length so the raw socket can be read by hand. */
export interface RawResponse {
  readonly statusLine: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Resolves on a later turn, keeping promise-shaped helpers honest under the async rules. */
export async function settled<T>(value: T): Promise<T> {
  return await Promise.resolve(value);
}

/** Connects through the proxy the way curl or undici would: CONNECT, then TLS presenting only the given CA as trust. */
export async function connectThroughProxy(port: number, host: string, caPem: string): Promise<tls.TLSSocket> {
  const raw = net.connect(port, "127.0.0.1");
  raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${proxyAuthorizationFor(TEST_CAPABILITY)}\r\n\r\n`);
  const head = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf8");
      if (buffer.includes(HEAD_TERMINATOR)) {
        raw.off("data", onData);
        raw.off("error", onError);
        resolve(buffer);
      }
    }
    function onError(error: Error): void {
      raw.off("data", onData);
      reject(error);
    }
    raw.on("data", onData);
    raw.on("error", onError);
  });
  expect(head).toContain(String(HTTP_OK));
  const secure = tls.connect({ socket: raw, servername: host, ca: caPem, rejectUnauthorized: true });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return secure;
}

/** Sends one request on a TLS session and reads its content-length framed response. */
export async function requestOn(secure: tls.TLSSocket, request: string): Promise<RawResponse> {
  const timed = await requestTimingOn(secure, request);
  return timed.response;
}

/** `requestOn`, also reporting the arrival times of every data event, which is how the streaming test proves bytes flowed before the response completed. */
export async function requestTimingOn(secure: tls.TLSSocket, request: string): Promise<{ readonly response: RawResponse; readonly arrivals: readonly number[] }> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const arrivals: number[] = [];
    secure.write(request);
    function onData(chunk: Buffer): void {
      arrivals.push(Date.now());
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf(HEAD_TERMINATOR);
      if (headerEnd === -1) {
        return;
      }
      const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      const length = headers["content-length"] === undefined ? 0 : Number(headers["content-length"]);
      const total = headerEnd + HEAD_TERMINATOR.length + length;
      if (buffer.length >= total) {
        secure.off("data", onData);
        secure.off("error", onError);
        resolve({ response: { statusLine: lines[0] ?? "", headers, body: buffer.subarray(headerEnd + HEAD_TERMINATOR.length, total).toString("utf8") }, arrivals });
      }
    }
    function onError(error: Error): void {
      secure.off("data", onData);
      reject(error);
    }
    secure.on("data", onData);
    secure.on("error", onError);
  });
}

/**
 * The real-socket world the round-trip tests run against: a CA issued by `x509.ts`, a fake routed backend on plain HTTP (standing in for whatever the pipeline would serve), a fake upstream presenting TLS signed by its own CA, and the real connect surface with only its tunnel target redirected.
 */
export function makeTlsWorld(ca: CaMaterial, upstreamCa: CaMaterial, options: { readonly limits?: Partial<ConnectLimits>; readonly isLiveCapability?: (token: string) => boolean; readonly capture?: ConnectCapture; readonly tapHosts?: readonly string[]; readonly transparent?: { readonly port: number; readonly capability: string } } = {}) {
  /** Every tunnel target the surface dialled, so a refusal can be shown never to have reached one. */
  const dials: { host: string; port: number }[] = [];
  const routedRequests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  const upstreamRequests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  let routedPort = 0;

  const fakeRouted = http.createServer((req, res) => {
    void handleFakeRouted(req, res);
  });
  async function handleFakeRouted(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    // A streamed response: the first byte goes out immediately, the rest only after the hold-back, so a buffering proxy cannot deliver the first byte early.
    const total = `streamed:${body}`;
    res.writeHead(HTTP_OK, { "content-type": "text/plain", "content-length": String(total.length) });
    res.write(total.slice(0, 1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, STREAM_HOLD_BACK_MS);
    });
    res.end(total.slice(1));
  }

  const upstreamLeaf = mintLeaf(upstreamCa, [...CONNECT_INTERCEPT_HOSTS], new Date());
  const fakeUpstream = https.createServer({ key: upstreamLeaf.keyPem, cert: upstreamLeaf.certPem }, (req, res) => {
    upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
    const body = "upstream-says-no";
    res.writeHead(HTTP_UNAUTHORIZED, { "content-type": "text/plain", "content-length": String(body.length) });
    res.end(body);
  });
  // Upgrades reaching the fake upstream are answered as a real websocket server would: the 101 handshake, then a raw echo channel, so a relayed upgrade can be proven end to end.
  const upstreamUpgrades: string[] = [];
  fakeUpstream.on("upgrade", (req, socket) => {
    upstreamUpgrades.push(req.url ?? "?");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.pipe(socket);
  });

  const echoServer = net.createServer((socket) => {
    socket.pipe(socket);
  });

  // A TLS echo server standing in for a tap host's real upstream: it carries the same leaf as the fake HTTP upstream (both intercept hosts' names are in its SANs), so a tap session's upstream half can present the host's name and still be trusted by the test CA.
  const tapEcho = tls.createServer({ key: upstreamLeaf.keyPem, cert: upstreamLeaf.certPem }, (socket) => {
    socket.pipe(socket);
  });

  let echoPort = 0;
  let tapEchoPort = 0;
  /** The ALPN protocol each tap upstream was asked to offer, so a test can assert the client's negotiation was mirrored. */
  const tapAlpnOffered: (string | undefined)[] = [];
  const effects: ConnectEffects = {
    ...realConnectEffects(),
    connectTlsUpstream: async (host, _port, clientAlpn) =>
      await new Promise((resolve, reject) => {
        // The real implementation dials the host's own server over TLS; a test dials a local stand-in presenting the host's name so the certificate matches. The API host's stand-in is the fake HTTP upstream (whose upgrade listener answers the 101 handshake a relayed upgrade needs); a tap host's is the raw TLS echo. The offered ALPN choice is recorded, unused by the dial itself, so tests can assert the mirror.
        tapAlpnOffered.push(clientAlpn);
        const port = host === CONNECT_INTERCEPT_HOST ? portOf(fakeUpstream) : tapEchoPort;
        const socket = tls.connect({ port, host: "127.0.0.1", servername: host, ca: [upstreamCa.certPem], rejectUnauthorized: true });
        socket.once("secureConnect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
    connectTcp: async (host, port) =>
      await new Promise((resolve, reject) => {
        dials.push({ host, port });
        // The real implementation connects to whatever host the CONNECT authority named; a test always tunnels to the local echo server standing in for it.
        const socket = net.connect(echoPort, "127.0.0.1");
        socket.once("connect", () => {
          resolve(socket);
        });
        socket.once("error", reject);
      }),
  };

  return {
    dials,
    upstreamUpgrades,
    tapAlpnOffered,
    routedRequests,
    upstreamRequests,
    async start(): Promise<{ readonly connectPort: number; readonly transparentPort?: number; readonly close: () => Promise<void> }> {
      await listen(fakeRouted);
      await listen(fakeUpstream);
      await listen(echoServer);
      echoPort = portOf(echoServer);
      await listen(tapEcho);
      tapEchoPort = portOf(tapEcho);
      routedPort = portOf(fakeRouted);
      const server = await startConnectServer(
        {
          interceptHosts: [...CONNECT_INTERCEPT_HOSTS],
          tapHosts: options.tapHosts ?? [],
          routedHost: CONNECT_INTERCEPT_HOST,
          serveRouted: (request, response) => {
            routedRequests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers } });
            realConnectEffects().forwardHttp({ host: "127.0.0.1", port: routedPort, tls: false }, request, response);
          },
          leafFor: createLeafCache(ca, () => new Date()),
          upstreamFor: (host) => ({
            host: "127.0.0.1",
            port: portOf(fakeUpstream),
            tls: true,
            // The fake upstream's leaf carries every intercept host's name, so whichever host a session is piped back to, the forwarder's SNI matches a certificate the test CA signed.
            servername: host,
            ca: [upstreamCa.certPem],
            rejectUnauthorized: true,
          }),
          isLiveCapability: options.isLiveCapability ?? ((token) => token === TEST_CAPABILITY),
          ...(options.transparent === undefined
            ? {}
            : {
                transparentPort: options.transparent.port,
                transparentCapability: options.transparent.capability,
              }),
          limits: { ...CONNECT_LIMITS, ...options.limits },
          ...(options.capture === undefined ? {} : { capture: options.capture }),
        },
        effects,
        undefined,
      );
      return { connectPort: server.port, ...(server.transparentPort === undefined ? {} : { transparentPort: server.transparentPort }), close: async () => { await server.close(); } };
    },
    async stop(): Promise<void> {
      await closeServer(fakeRouted);
      await closeServer(fakeUpstream);
      await closeServer(echoServer);
      await closeServer(tapEcho);
    },
  };
}

async function listen(server: http.Server | https.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
}

function portOf(server: http.Server | https.Server | net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return address.port;
}

async function closeServer(server: http.Server | https.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve(undefined);
    });
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      resolve(body);
    });
  });
}

/** One raw client connection to the surface: what it answered (the head, or whatever arrived before it closed) and when it closed. */
export interface RawAttempt {
  readonly socket: net.Socket;
  readonly answer: Promise<string>;
  readonly closed: Promise<void>;
  /** Resolves once the TCP connection is open, so a test can order several attempts as the surface accepts them. */
  readonly connected: Promise<void>;
}

/** Opens a connection to the surface and writes `bytes` (a full or partial CONNECT head) without any of the round-trip helpers' expectations. */
export function rawAttempt(port: number, bytes: string): RawAttempt {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {
    // A refused connection may be reset under the client; the answer and close promises are what the tests read.
  });
  let buffer = "";
  const answer = new Promise<string>((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf(HEAD_TERMINATOR);
      if (end !== -1) {
        resolve(buffer.slice(0, end));
      }
    });
    socket.on("close", () => {
      resolve(buffer);
    });
  });
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve(undefined);
    });
  });
  const connected = new Promise<void>((resolve) => {
    socket.once("connect", () => {
      resolve(undefined);
    });
  });
  socket.write(bytes);
  return { socket, answer, closed, connected };
}

/** A complete CONNECT head for `host`, with whatever extra header lines a case needs. */
export function connectHead(host: string, headerLines: readonly string[]): string {
  return `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${headerLines.map((line) => `${line}\r\n`).join("")}\r\n`;
}

/** How long `settle` waits: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
export const SETTLE_MS = 50;

/** Waits long enough for the surface's side of an already-written event (an accept, a close) to have run: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

/** The head deadline the slow-head cases run with: short enough to reach in a test, long enough above `SETTLE_MS` that a connection opened and settled has not already timed out. */
export const TEST_HEAD_DEADLINE_MS = 300;

/** The revalidation interval the revocation case runs with. */
export const TEST_REVALIDATE_MS = 50;

/** Statuses the authentication and limit cases expect. */
export const HTTP_PROXY_AUTH_REQUIRED = 407;
export const HTTP_REQUEST_TIMEOUT = 408;
export const HTTP_HEADERS_TOO_LARGE = 431;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** Sends one byte through an established tunnel to the echo server and resolves with what came back. */
export async function echoThrough(socket: net.Socket, payload: string): Promise<string> {
  return await new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(payload)) {
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.write(payload);
  });
}
