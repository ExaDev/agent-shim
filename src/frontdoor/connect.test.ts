import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { beforeAll, describe, expect, it } from "vitest";
import { X509Certificate, createPrivateKey } from "node:crypto";

import { connectProxyUrl, isLiveCapability } from "./capability";
import {
  CONNECT_LIMITS,
  createLeafCache,
  ensureCa,
  forwardableHeaders,
  generateCa,
  ROUTED_PATH_PREFIX,
  HTTPS_PORT,
  isInterceptedHost,
  CONNECT_INTERCEPT_HOST,
  mintLeaf,
  parseConnectTarget,
  realConnectEffects,
  servedByPipeline,
  startConnectServer,
  type CaMaterial,
  type ConnectCertStore,
  type ConnectEffects,
  type ConnectLimits,
  MAX_CONNECT_HEAD_BYTES,
} from "./connect";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { liveSessionTokens, pruneDeadFrontDoorSessions, writeFrontDoorSession } from "./state";

/** Enough time for the pure-JS 2048-bit keypairs this file generates in `beforeAll`. */
const KEYGEN_TIMEOUT_MS = 120_000;

/**
 * How long the fake routed backend holds back the second half of its streamed response. A proxy that buffered the body would deliver both halves in one arrival, so any measured gap at least this large proves the bytes flowed through as they were written.
 */
const STREAM_HOLD_BACK_MS = 300;
/** The gap the client must observe between its first and last body arrivals, comfortably under the hold-back so scheduling noise cannot flip the verdict. */
const MIN_STREAM_GAP_MS = 150;

/** The statuses this file asserts on, named so a status literal never reads as a magic number: the healthy answer, the unauthenticated fake upstream's answer, and the proxy's own cannot-serve answer. */
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;

/** The byte length of an HTTP head terminator, the framing this file's hand-rolled client parses. */
const HEAD_TERMINATOR = "\r\n\r\n";

/** A made-up launch capability the round-trip world accepts as live. */
const TEST_CAPABILITY = "connect-test-capability";

/** The `Proxy-Authorization` header a client derives from a launch's `HTTPS_PROXY` URL, built from the URL the launcher would set so the test exercises the same encoding round trip a real client does. */
function proxyAuthorizationFor(token: string): string {
  const url = new URL(connectProxyUrl(1, token));
  return `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}

describe("CONNECT routing decisions", () => {
  it("parses an authority into a lowercased host and numeric port, defaulting to 443", () => {
    expect(parseConnectTarget("api.anthropic.com:443")).toEqual({ host: "api.anthropic.com", port: 443 });
    expect(parseConnectTarget("Statsig.Anthropic.COM")).toEqual({ host: "statsig.anthropic.com", port: HTTPS_PORT });
    expect(parseConnectTarget("api.anthropic.com:8443")).toEqual({ host: "api.anthropic.com", port: 8443 });
  });

  it("rejects an authority that names no host or an unusable port", () => {
    expect(parseConnectTarget("")).toBeUndefined();
    expect(parseConnectTarget(":443")).toBeUndefined();
    expect(parseConnectTarget("host:not-a-port")).toBeUndefined();
    expect(parseConnectTarget("host:0")).toBeUndefined();
    expect(parseConnectTarget("host:70000")).toBeUndefined();
  });

  it("intercepts exactly the configured host, nothing more", () => {
    expect(isInterceptedHost("api.anthropic.com", CONNECT_INTERCEPT_HOST)).toBe(true);
    expect(isInterceptedHost("statsig.anthropic.com", CONNECT_INTERCEPT_HOST)).toBe(false);
    expect(isInterceptedHost("api.anthropic.com.evil.example", CONNECT_INTERCEPT_HOST)).toBe(false);
  });

  it("routes exactly the paths under /v1/ to the routed handler, query strings included", () => {
    expect(servedByPipeline("/v1/messages")).toBe(true);
    expect(servedByPipeline("/v1/messages?beta=true")).toBe(true);
    expect(servedByPipeline("/v1/messages/count_tokens")).toBe(true);
    expect(servedByPipeline("/v1")).toBe(false);
    expect(servedByPipeline("/api/oauth/token")).toBe(false);
    expect(servedByPipeline(undefined)).toBe(false);
    expect(ROUTED_PATH_PREFIX).toBe("/v1/");
  });

  it("strips hop-by-hop headers and any header the Connection header names, without mutating the input", () => {
    const headers = {
      host: "api.anthropic.com",
      authorization: "Bearer tok",
      connection: "keep-alive, x-drop-me",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "x-drop-me": "gone",
      "x-keep-me": "here",
    };
    const forwarded = forwardableHeaders(headers);
    expect(forwarded).toEqual({ host: "api.anthropic.com", authorization: "Bearer tok", "x-keep-me": "here" });
    expect(headers["x-drop-me"]).toBe("gone");
  });
});

describe("certificate authority", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const ONE_DAY_MS = 86_400_000;
  /** The CA/Browser Forum ceiling on a publicly trusted leaf's lifetime, which Apple platforms also enforce. */
  const MAX_LEAF_LIFETIME_DAYS = 398;

  it("generates a CA whose subject is stable, and signs leaves issued by that CA with the host in their SAN", () => {
    const ca = generateCa(now);
    const again = generateCa(now);
    const caCert = new X509Certificate(ca.certPem);
    expect(caCert.subject).toBe("CN=agent-shim front door CA");
    expect(new X509Certificate(again.certPem).subject).toBe("CN=agent-shim front door CA");
    expect(caCert.ca).toBe(true);
    expect(caCert.verify(caCert.publicKey)).toBe(true);

    const leaf = mintLeaf(ca, [CONNECT_INTERCEPT_HOST], now);
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.issuer).toBe("CN=agent-shim front door CA");
    expect(cert.ca).toBe(false);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.checkHost(CONNECT_INTERCEPT_HOST)).toBe(CONNECT_INTERCEPT_HOST);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(cert.checkPrivateKey(createPrivateKey(leaf.keyPem))).toBe(true);
    expect(caCert.checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(true);
  });

  it("puts an IP name in the SAN as an IP address and a hostname as a DNS name", () => {
    const leaf = new X509Certificate(mintLeaf(generateCa(now), ["127.0.0.1", "localhost", "::1"], now).certPem);
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.checkIP("::1")).toBe("::1");
    expect(leaf.checkHost("localhost")).toBe("localhost");
    expect(leaf.checkHost("127.0.0.1")).toBeUndefined();
    expect(leaf.checkIP("127.0.0.2")).toBeUndefined();
  });

  it("dates a leaf to cover now and to stay inside the 398-day ceiling clients enforce on leaf lifetimes", () => {
    const leaf = new X509Certificate(mintLeaf(generateCa(now), ["a.example"], now).certPem);
    expect(new Date(leaf.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()).toBeLessThanOrEqual(MAX_LEAF_LIFETIME_DAYS * ONE_DAY_MS);
    expect(new Date(leaf.validTo).getTime()).toBeGreaterThan(now.getTime());
  });

  it("issues a leaf under a CA whose key is stored as PKCS#1, the form earlier releases persisted", () => {
    const ca = generateCa(now);
    const pkcs1 = createPrivateKey(ca.keyPem).export({ type: "pkcs1", format: "pem" });
    const leaf = new X509Certificate(mintLeaf({ certPem: ca.certPem, keyPem: pkcs1 }, ["a.example"], now).certPem);
    expect(leaf.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
  });

  it("mints each host's leaf once and reuses it", () => {
    const ca = generateCa(now);
    const leafFor = createLeafCache(ca, () => now);
    expect(leafFor("a.example")).toBe(leafFor("a.example"));
    expect(leafFor("a.example")).not.toBe(leafFor("b.example"));
  });

  it("keeps a stored CA that parses, and regenerates one that is missing or corrupt", () => {
    const good = generateCa(now);
    const writes: CaMaterial[] = [];
    let stored: CaMaterial | undefined;
    const store: ConnectCertStore = {
      loadCa: () => stored,
      writeCa: (ca) => {
        writes.push(ca);
        stored = ca;
      },
    };
    expect(ensureCa(store, () => good)).toBe(good);
    expect(writes).toHaveLength(1);
    // A stored CA is reused, not regenerated: every child's NODE_EXTRA_CA_CERTS points at it.
    expect(ensureCa(store, () => generateCa(now))).toBe(good);
    expect(writes).toHaveLength(1);
    stored = { certPem: "not a certificate", keyPem: good.keyPem };
    expect(ensureCa(store, () => good)).toBe(good);
    expect(writes).toHaveLength(2);
  });
});

/** A client's view of one HTTP response, framed by content-length so the raw socket can be read by hand. */
interface RawResponse {
  readonly statusLine: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Resolves on a later turn, keeping promise-shaped helpers honest under the async rules. */
async function settled<T>(value: T): Promise<T> {
  return await Promise.resolve(value);
}

/** Connects through the proxy the way curl or undici would: CONNECT, then TLS presenting only the given CA as trust. */
async function connectThroughProxy(port: number, host: string, caPem: string): Promise<tls.TLSSocket> {
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
async function requestOn(secure: tls.TLSSocket, request: string): Promise<RawResponse> {
  const timed = await requestTimingOn(secure, request);
  return timed.response;
}

/** `requestOn`, also reporting the arrival times of every data event, which is how the streaming test proves bytes flowed before the response completed. */
async function requestTimingOn(secure: tls.TLSSocket, request: string): Promise<{ readonly response: RawResponse; readonly arrivals: readonly number[] }> {
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
function makeTlsWorld(ca: CaMaterial, upstreamCa: CaMaterial, options: { readonly limits?: Partial<ConnectLimits>; readonly isLiveCapability?: (token: string) => boolean } = {}) {
  /** Every tunnel target the surface dialled, so a refusal can be shown never to have reached one. */
  const dials: { host: string; port: number }[] = [];
  const routedRequests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  const upstreamRequests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  let routedPort = 0;

  const fakeRouted = http.createServer((req, res) => {
    routedRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
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

  const upstreamLeaf = mintLeaf(upstreamCa, [CONNECT_INTERCEPT_HOST], new Date());
  const fakeUpstream = https.createServer({ key: upstreamLeaf.keyPem, cert: upstreamLeaf.certPem }, (req, res) => {
    upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
    const body = "upstream-says-no";
    res.writeHead(HTTP_UNAUTHORIZED, { "content-type": "text/plain", "content-length": String(body.length) });
    res.end(body);
  });

  const echoServer = net.createServer((socket) => {
    socket.pipe(socket);
  });

  let echoPort = 0;
  const effects: ConnectEffects = {
    ...realConnectEffects(),
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
    routedRequests,
    upstreamRequests,
    async start(): Promise<{ readonly connectPort: number; readonly close: () => Promise<void> }> {
      await listen(fakeRouted);
      await listen(fakeUpstream);
      await listen(echoServer);
      echoPort = portOf(echoServer);
      routedPort = portOf(fakeRouted);
      const server = await startConnectServer(
        {
          interceptHost: CONNECT_INTERCEPT_HOST,
          serveRouted: (request, response) => {
            realConnectEffects().forwardHttp({ host: "127.0.0.1", port: routedPort, tls: false }, request, response);
          },
          leafFor: createLeafCache(ca, () => new Date()),
          upstream: {
            host: "127.0.0.1",
            port: portOf(fakeUpstream),
            tls: true,
            servername: CONNECT_INTERCEPT_HOST,
            ca: [upstreamCa.certPem],
            rejectUnauthorized: true,
          },
          isLiveCapability: options.isLiveCapability ?? ((token) => token === TEST_CAPABILITY),
          limits: { ...CONNECT_LIMITS, ...options.limits },
        },
        effects,
        undefined,
      );
      return { connectPort: server.port, close: async () => { await server.close(); } };
    },
    async stop(): Promise<void> {
      await closeServer(fakeRouted);
      await closeServer(fakeUpstream);
      await closeServer(echoServer);
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

describe("MITM proxy over real sockets", () => {
  let ca: CaMaterial;
  let upstreamCa: CaMaterial;

  beforeAll(async () => {
    ca = generateCa(new Date());
    upstreamCa = generateCa(new Date());
    await settled(undefined);
  }, KEYGEN_TIMEOUT_MS);

  it(
    "terminates api.anthropic.com TLS with the CA's leaf and serves /v1/ through the routed handler, streaming the body and passing Authorization through untouched",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const request =
          `POST /v1/messages HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nAuthorization: Bearer oauth-token\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`;
        // Two requests on the one TLS session: the client's connection reuse must work.
        const first = await requestTimingOn(secure, request);
        const second = await requestOn(secure, request.replace("POST /v1/messages", "POST /v1/messages/count_tokens"));
        expect(first.response.statusLine).toContain(String(HTTP_OK));
        expect(first.response.body).toBe("streamed:{}");
        expect(second.body).toBe("streamed:{}");
        expect(world.routedRequests.map((seen) => seen.url)).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
        expect(world.routedRequests[0]?.headers.authorization).toBe("Bearer oauth-token");
        expect(world.routedRequests[0]?.headers.host).toBe(CONNECT_INTERCEPT_HOST);
        expect(world.upstreamRequests).toEqual([]);
        // The response's two halves arrived in separate deliveries with the hold-back between them: the body streamed through the proxy rather than arriving assembled.
        expect(first.arrivals.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...first.arrivals) - Math.min(...first.arrivals)).toBeGreaterThanOrEqual(MIN_STREAM_GAP_MS);
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "pipes non-routed paths on the same terminated session to the real upstream over TLS, never to the routed handler",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const routedSide = await requestOn(secure, "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-length: 2\r\n\r\n{}");
        const upstreamSide = await requestOn(secure, "GET /api/oauth/token HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n");
        expect(routedSide.statusLine).toContain(String(HTTP_OK));
        expect(upstreamSide.statusLine).toContain(String(HTTP_UNAUTHORIZED));
        expect(upstreamSide.body).toBe("upstream-says-no");
        expect(world.routedRequests.map((seen) => seen.url)).toEqual(["/v1/messages"]);
        expect(world.upstreamRequests.map((seen) => seen.url)).toEqual(["/api/oauth/token"]);
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "blind-tunnels every other CONNECT host byte for byte, without terminating its TLS",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const raw = net.connect(connectPort, "127.0.0.1");
        raw.write(`CONNECT mcp-proxy.anthropic.com:443 HTTP/1.1\r\nHost: mcp-proxy.anthropic.com:443\r\n${proxyAuthorizationFor(TEST_CAPABILITY)}\r\n\r\n`);
        const echoed = await new Promise<string>((resolve, reject) => {
          let buffer = "";
          function onData(chunk: Buffer): void {
            buffer += chunk.toString("utf8");
            const headEnd = buffer.indexOf(HEAD_TERMINATOR);
            if (headEnd === -1) {
              return;
            }
            const after = buffer.slice(headEnd + HEAD_TERMINATOR.length);
            if (after.includes("tunnel-payload")) {
              raw.off("data", onData);
              raw.off("error", onError);
              resolve(after);
            }
          }
          function onError(error: Error): void {
            raw.off("data", onData);
            reject(error);
          }
          raw.on("data", onData);
          raw.on("error", onError);
          // Sent before the tunnel target is necessarily connected: the bytes must survive the proxy's connect window and still reach the target in order.
          raw.write("tunnel-payload");
        });
        expect(echoed).toBe("tunnel-payload");
        expect(world.routedRequests).toEqual([]);
        raw.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "releases its port on close, so a replacement generation can bind the same address",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      await close();
      await world.stop();
      const rebound = await new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => {
          resolve(false);
        });
        probe.listen(connectPort, "127.0.0.1", () => {
          probe.close(() => {
            resolve(true);
          });
        });
      });
      expect(rebound).toBe(true);
    },
    KEYGEN_TIMEOUT_MS,
  );
});

/** One raw client connection to the surface: what it answered (the head, or whatever arrived before it closed) and when it closed. */
interface RawAttempt {
  readonly socket: net.Socket;
  readonly answer: Promise<string>;
  readonly closed: Promise<void>;
  /** Resolves once the TCP connection is open, so a test can order several attempts as the surface accepts them. */
  readonly connected: Promise<void>;
}

/** Opens a connection to the surface and writes `bytes` (a full or partial CONNECT head) without any of the round-trip helpers' expectations. */
function rawAttempt(port: number, bytes: string): RawAttempt {
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
function connectHead(host: string, headerLines: readonly string[]): string {
  return `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${headerLines.map((line) => `${line}\r\n`).join("")}\r\n`;
}

/** How long `settle` waits: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
const SETTLE_MS = 50;

/** Waits long enough for the surface's side of an already-written event (an accept, a close) to have run: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

/** The head deadline the slow-head cases run with: short enough to reach in a test, long enough above `SETTLE_MS` that a connection opened and settled has not already timed out. */
const TEST_HEAD_DEADLINE_MS = 300;

/** The revalidation interval the revocation case runs with. */
const TEST_REVALIDATE_MS = 50;

/** Statuses the authentication and limit cases expect. */
const HTTP_PROXY_AUTH_REQUIRED = 407;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_HEADERS_TOO_LARGE = 431;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** Sends one byte through an established tunnel to the echo server and resolves with what came back. */
async function echoThrough(socket: net.Socket, payload: string): Promise<string> {
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

describe("CONNECT authentication and limits over real sockets", () => {
  let ca: CaMaterial;
  let upstreamCa: CaMaterial;

  beforeAll(async () => {
    ca = generateCa(new Date());
    upstreamCa = generateCa(new Date());
    await settled(undefined);
  }, KEYGEN_TIMEOUT_MS);

  it(
    "answers a CONNECT with no, a wrong, a non-Basic or a repeated credential 407 with a Basic challenge, and never dials, intercepts or routes anything for it",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const cases: readonly (readonly string[])[] = [
          [],
          [proxyAuthorizationFor("not-a-live-capability")],
          [`Proxy-Authorization: Bearer ${TEST_CAPABILITY}`],
          [proxyAuthorizationFor(TEST_CAPABILITY), proxyAuthorizationFor(TEST_CAPABILITY)],
          // Basic with no colon at all: a user name and no password.
          [`Proxy-Authorization: Basic ${Buffer.from(TEST_CAPABILITY).toString("base64")}`],
        ];
        for (const host of [CONNECT_INTERCEPT_HOST, "mcp-proxy.anthropic.com"]) {
          for (const headerLines of cases) {
            const attempt = rawAttempt(connectPort, connectHead(host, headerLines));
            const answer = await attempt.answer;
            expect(answer.split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_PROXY_AUTH_REQUIRED)} Proxy Authentication Required`);
            expect(answer).toContain('Proxy-Authenticate: Basic realm="agent-shim front door"');
            await attempt.closed;
          }
        }
        expect(world.dials).toEqual([]);
        expect(world.routedRequests).toEqual([]);
        expect(world.upstreamRequests).toEqual([]);
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "drops a client that has not finished its head by the deadline with 408, never dialling, while an established tunnel outlives the deadline",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { limits: { headDeadlineMs: TEST_HEAD_DEADLINE_MS } });
      const { connectPort, close } = await world.start();
      try {
        const tunnel = rawAttempt(connectPort, connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY)]));
        expect(await tunnel.answer).toContain(String(HTTP_OK));

        const started = Date.now();
        const slow = rawAttempt(connectPort, `CONNECT mcp-proxy.anthropic.com:443 HTTP/1.1\r\n${proxyAuthorizationFor(TEST_CAPABILITY)}\r\n`);
        const answer = await slow.answer;
        await slow.closed;
        expect(answer.split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_REQUEST_TIMEOUT)} Request Timeout`);
        expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_HEAD_DEADLINE_MS - SETTLE_MS);

        // Well past the deadline, the tunnel whose head arrived in time still carries bytes: the deadline is disarmed once the head is in.
        expect(await echoThrough(tunnel.socket, "still-open")).toContain("still-open");
        expect(world.dials).toHaveLength(1);
        tunnel.socket.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "refuses a head larger than the limit with 431 without dialling",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const oversized = rawAttempt(connectPort, connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY), `X-Pad: ${"a".repeat(MAX_CONNECT_HEAD_BYTES)}`]));
        expect((await oversized.answer).split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_HEADERS_TOO_LARGE)} Request Header Fields Too Large`);
        await oversized.closed;
        expect(world.dials).toEqual([]);
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "evicts the oldest half-sent head when the pending cap is reached, so squatters cannot lock out a live launch",
    async () => {
      // The head deadline is set beyond the test's own timeout, so the only thing that can answer a squatter is eviction.
      const world = makeTlsWorld(ca, upstreamCa, { limits: { maxPendingHeads: 2, headDeadlineMs: KEYGEN_TIMEOUT_MS * 2 } });
      const { connectPort, close } = await world.start();
      try {
        const partial = "CONNECT mcp-proxy.anthropic.com:443 HTTP/1.1\r\n";
        const first = rawAttempt(connectPort, partial);
        await first.connected;
        await settle();
        const second = rawAttempt(connectPort, partial);
        await second.connected;
        await settle();
        const third = rawAttempt(connectPort, partial);
        await third.connected;

        expect((await first.answer).split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_REQUEST_TIMEOUT)} Request Timeout`);
        await first.closed;

        // The cap is full of squatters again, yet a launch's connection still gets through: its head evicts the oldest squatter on accept and authenticates at once.
        const launch = rawAttempt(connectPort, connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY)]));
        expect(await launch.answer).toContain(String(HTTP_OK));
        expect((await second.answer).split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_REQUEST_TIMEOUT)} Request Timeout`);
        expect(third.socket.destroyed).toBe(false);
        expect(world.dials).toHaveLength(1);
        launch.socket.destroy();
        third.socket.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "answers an authenticated CONNECT beyond the tunnel cap 503 without dialling, and admits one again once a tunnel closes",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, { limits: { maxTunnels: 1 } });
      const { connectPort, close } = await world.start();
      try {
        const head = connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY)]);
        const first = rawAttempt(connectPort, head);
        expect(await first.answer).toContain(String(HTTP_OK));

        const over = rawAttempt(connectPort, head);
        expect((await over.answer).split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_SERVICE_UNAVAILABLE)} Service Unavailable`);
        await over.closed;
        expect(world.dials).toHaveLength(1);

        first.socket.destroy();
        await first.closed;
        await settle();
        const again = rawAttempt(connectPort, head);
        expect(await again.answer).toContain(String(HTTP_OK));
        expect(world.dials).toHaveLength(2);
        again.socket.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "closes a launch's tunnels once its registry entry is pruned, and refuses its capability 407 afterwards",
    async () => {
      const paths = buildLayoutPaths("/home/testuser/.agent-shim");
      const registry = createFakeFarmFs({});
      const launcherPid = 4242;
      writeFrontDoorSession(registry, paths.frontdoorSessionsDir, { pid: launcherPid, startedAt: 0, token: TEST_CAPABILITY });
      // The production check: constant-time membership in the registry's live tokens, read fresh on every call.
      const world = makeTlsWorld(ca, upstreamCa, {
        limits: { revalidateMs: TEST_REVALIDATE_MS },
        isLiveCapability: (token) => isLiveCapability(token, liveSessionTokens(registry, paths.frontdoorSessionsDir)),
      });
      const { connectPort, close } = await world.start();
      try {
        const head = connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY)]);
        const tunnel = rawAttempt(connectPort, head);
        expect(await tunnel.answer).toContain(String(HTTP_OK));
        expect(await echoThrough(tunnel.socket, "while-live")).toContain("while-live");

        // The launcher dies; the supervisor's next tick prunes it, and the tunnel it opened goes at the next revalidation.
        expect(pruneDeadFrontDoorSessions(registry, paths.frontdoorSessionsDir, () => false)).toEqual([launcherPid]);
        await tunnel.closed;

        const stale = rawAttempt(connectPort, head);
        expect((await stale.answer).split("\r\n")[0]).toBe(`HTTP/1.1 ${String(HTTP_PROXY_AUTH_REQUIRED)} Proxy Authentication Required`);
        expect(world.dials).toHaveLength(1);
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
