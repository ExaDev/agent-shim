import { beforeAll, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { isLiveCapability } from "./capability";
import { CONNECT_INTERCEPT_HOST, generateCa, MAX_CONNECT_HEAD_BYTES, type CaMaterial } from "./connect";
import { liveSessionTokens, pruneDeadFrontDoorSessions, writeFrontDoorSession } from "./state";
import {
  connectHead,
  echoThrough,
  HTTP_HEADERS_TOO_LARGE,
  HTTP_OK,
  HTTP_PROXY_AUTH_REQUIRED,
  HTTP_REQUEST_TIMEOUT,
  HTTP_SERVICE_UNAVAILABLE,
  KEYGEN_TIMEOUT_MS,
  makeTlsWorld,
  proxyAuthorizationFor,
  rawAttempt,
  SETTLE_MS,
  settle,
  TEST_CAPABILITY,
  TEST_HEAD_DEADLINE_MS,
  TEST_REVALIDATE_MS,
} from "./connectTestWorld";

describe("CONNECT authentication and limits over real sockets", () => {
  let ca: CaMaterial;
  let upstreamCa: CaMaterial;

  beforeAll(async () => {
    ca = generateCa(new Date());
    upstreamCa = generateCa(new Date());
    await settle();
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
