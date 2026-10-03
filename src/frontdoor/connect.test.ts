import * as net from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConnectCapture, PassthroughObserver } from "./capture";
import { CONNECT_INTERCEPT_HOST, CONNECT_TAP_HOSTS, generateCa, HTTPS_PORT, type CaMaterial } from "./connect";
import {
  connectHead,
  connectThroughProxy,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  KEYGEN_TIMEOUT_MS,
  makeTlsWorld,
  HEAD_TERMINATOR,
  MIN_STREAM_GAP_MS,
  proxyAuthorizationFor,
  rawAttempt,
  requestOn,
  requestTimingOn,
  RESPONSE_CLOSE_SETTLE_MS,
  settled,
  TEST_CAPABILITY,
} from "./connectTestWorld";


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
    "records the connect target and the piped exchange's head, body, response and chunks through the capture",
    async () => {
      const events: { kind: string; [field: string]: unknown }[] = [];
      const capture: ConnectCapture = {
        connect: (target, intercepted) => {
          events.push({ kind: "connect", host: target.host, port: target.port, intercepted });
        },
        upgrade: (request) => {
          events.push({ kind: "upgrade", url: request.url });
        },
        observePassthrough: (request) => {
          events.push({ kind: "request", method: request.method, url: request.url, authorization: request.headers.authorization });
          const observer: PassthroughObserver = {
            onRequestChunk: (chunk) => {
              events.push({ kind: "request-chunk", body: chunk.toString("utf8") });
            },
            onResponse: (status, headers) => {
              events.push({ kind: "response", status, contentType: headers["content-type"] });
            },
            onResponseChunk: (chunk) => {
              events.push({ kind: "response-chunk", body: chunk.toString("utf8") });
            },
            onEnd: () => {
              events.push({ kind: "end" });
            },
          };
          return observer;
        },
      };
      const world = makeTlsWorld(ca, upstreamCa, { capture });
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const pipedRequestBody = '{"grant_type":"code"}';
        const piped = await requestOn(
          secure,
          `POST /api/oauth/token HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nAuthorization: Bearer oauth-token\r\ncontent-type: application/json\r\ncontent-length: ${String(pipedRequestBody.length)}\r\n\r\n${pipedRequestBody}`,
        );
        expect(piped.statusLine).toContain(String(HTTP_UNAUTHORIZED));
        // The response's close event, which drives the capture's end record, can trail the parsed response by a tick.
        await new Promise((resolve) => {
          setTimeout(resolve, RESPONSE_CLOSE_SETTLE_MS);
        });
        expect(events.map((event) => event.kind)).toEqual(["connect", "request", "request-chunk", "response", "response-chunk", "end"]);
        expect(events[0]).toMatchObject({ kind: "connect", host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT, intercepted: true });
        expect(events[1]).toMatchObject({ kind: "request", method: "POST", url: "/api/oauth/token", authorization: "Bearer oauth-token" });
        expect(events[2]).toMatchObject({ kind: "request-chunk", body: '{"grant_type":"code"}' });
        expect(events[3]).toMatchObject({ kind: "response", status: HTTP_UNAUTHORIZED, contentType: "text/plain" });
        expect(events[4]).toMatchObject({ kind: "response-chunk", body: "upstream-says-no" });
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "relays a websocket upgrade on the API host's session byte for byte, carrying the 101 handshake and the frames after it",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const echoed = await new Promise<string>((resolve, reject) => {
          let received = "";
          function onData(chunk: Buffer): void {
            received += chunk.toString("utf8");
            if (received.includes("101 Switching Protocols") && received.includes("upgrade-echo")) {
              secure.off("data", onData);
              secure.off("error", onError);
              resolve(received);
            }
          }
          function onError(error: Error): void {
            secure.off("data", onData);
            reject(error);
          }
          secure.on("data", onData);
          secure.on("error", onError);
          secure.write(`GET /wss/remote HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nupgrade-echo`);
        });
        expect(echoed).toContain("101 Switching Protocols");
        expect(world.upstreamUpgrades).toEqual(["/wss/remote"]);
        expect(world.routedRequests).toEqual([]);
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "terminates platform.claude.com TLS, pipes even its /v1/ paths to that host's upstream, and never hands them to the routed pipeline",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, "platform.claude.com", ca.certPem);
        const piped = await requestOn(secure, `GET /v1/messages HTTP/1.1\r\nHost: platform.claude.com\r\n\r\n`);
        expect(piped.statusLine).toContain(String(HTTP_UNAUTHORIZED));
        expect(world.upstreamRequests.map((seen) => seen.url)).toEqual(["/v1/messages"]);
        expect(world.upstreamRequests[0]?.headers.host).toBe("platform.claude.com");
        expect(world.routedRequests).toEqual([]);
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "pumps a tap host's stream byte for byte to its real host and records both directions, parsing nothing",
    async () => {
      const streams: string[] = [];
      const chunks: { dir: string; text: string }[] = [];
      const capture: ConnectCapture = {
        connect: () => undefined,
        upgrade: () => {
          throw new Error("no upgrade reaches a tap host");
        },
        observePassthrough: () => {
          throw new Error("no HTTP parsing reaches a tap host");
        },
        tapStream: (host) => {
          streams.push(host);
          return {
            onChunk: (dir, chunk) => {
              chunks.push({ dir, text: chunk.toString("utf8") });
            },
            onEnd: () => undefined,
          };
        },
      };
      const world = makeTlsWorld(ca, upstreamCa, { capture, tapHosts: CONNECT_TAP_HOSTS });
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, "platform.claude.com", ca.certPem);
        const echoed = await new Promise<string>((resolve, reject) => {
          function onData(chunk: Buffer): void {
            if (chunk.toString("utf8").includes("tap-payload")) {
              secure.off("data", onData);
              secure.off("error", onError);
              resolve(chunk.toString("utf8"));
            }
          }
          function onError(error: Error): void {
            secure.off("data", onData);
            reject(error);
          }
          secure.on("data", onData);
          secure.on("error", onError);
          secure.write("tap-payload");
        });
        expect(echoed).toContain("tap-payload");
        expect(streams).toEqual(["platform.claude.com"]);
        // The hand-rolled client negotiated no ALPN, so the upstream was asked to offer none: the blind tunnel's exact behaviour.
        expect(world.tapAlpnOffered).toEqual([undefined]);
        expect(chunks).toContainEqual({ dir: "client-to-server", text: "tap-payload" });
        expect(chunks).toContainEqual({ dir: "server-to-client", text: "tap-payload" });
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "captures a platform.claude.com exchange as intercepted, host and all",
    async () => {
      const connects: { host: string; intercepted: boolean }[] = [];
      const requests: string[] = [];
      const capture: ConnectCapture = {
        connect: (target, intercepted) => {
          connects.push({ host: target.host, intercepted });
        },
        upgrade: () => undefined,
        observePassthrough: (request) => {
          requests.push(request.url ?? "?");
          return {
            onRequestChunk: () => undefined,
            onResponse: () => undefined,
            onResponseChunk: () => undefined,
            onEnd: () => undefined,
          };
        },
      };
      const world = makeTlsWorld(ca, upstreamCa, { capture });
      const { connectPort, close } = await world.start();
      try {
        const secure = await connectThroughProxy(connectPort, "platform.claude.com", ca.certPem);
        const piped = await requestOn(secure, `GET /api/oauth/token HTTP/1.1\r\nHost: platform.claude.com\r\n\r\n`);
        expect(piped.statusLine).toContain(String(HTTP_UNAUTHORIZED));
        expect(connects).toContainEqual({ host: "platform.claude.com", intercepted: true });
        expect(requests).toEqual(["/api/oauth/token"]);
        secure.destroy();
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "records a blind-tunnel target as unintercepted, never seeing its bytes",
    async () => {
      const connects: { host: string; port: number; intercepted: boolean }[] = [];
      const capture: ConnectCapture = {
        connect: (target, intercepted) => {
          connects.push({ host: target.host, port: target.port, intercepted });
        },
        upgrade: () => {
          throw new Error("no upgrade reaches a blind tunnel");
        },
        observePassthrough: () => {
          throw new Error("no piped exchange reaches a blind tunnel");
        },
      };
      const world = makeTlsWorld(ca, upstreamCa, { capture });
      const { connectPort, close } = await world.start();
      try {
        const attempt = rawAttempt(connectPort, connectHead("mcp-proxy.anthropic.com", [proxyAuthorizationFor(TEST_CAPABILITY)]));
        expect((await attempt.answer).split("\r\n")[0]).toContain(String(HTTP_OK));
        expect(connects).toEqual([{ host: "mcp-proxy.anthropic.com", port: HTTPS_PORT, intercepted: false }]);
        attempt.socket.destroy();
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
