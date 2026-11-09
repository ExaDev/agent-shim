import * as net from "node:net";
import { describe, expect, it } from "vitest";

import { CONNECT_LIMITS, startConnectServer } from "./connect";
import { realConnectEffects } from "./connectEffects";
import { TEST_CAPABILITY, proxyAuthorizationFor, rawAttempt } from "./connectTestWorld";

/** Binds an echo server on the IPv6 loopback, or resolves undefined where this machine has no `::1` to bind. */
async function echoOnLoopbackV6(): Promise<net.Server | undefined> {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  return await new Promise<net.Server | undefined>((resolve) => {
    server.once("error", () => {
      resolve(undefined);
    });
    server.listen(0, "::1", () => {
      resolve(server);
    });
  });
}

/** A CONNECT head naming `authority` exactly as given, which `connectHead` cannot do since it appends its own port. */
function headFor(authority: string): string {
  return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyAuthorizationFor(TEST_CAPABILITY)}\r\n\r\n`;
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return address.port;
}

describe("a CONNECT to an IPv6 literal through the front door", () => {
  async function startDoor() {
    return await startConnectServer(
      {
        interceptHosts: [],
        tapHosts: [],
        routedHost: "unused.invalid",
        serveRouted: () => undefined,
        leafFor: () => {
          throw new Error("no host is intercepted, so no leaf is minted");
        },
        upstreamFor: () => {
          throw new Error("no host is intercepted, so no upstream is chosen");
        },
        isLiveCapability: (token) => token === TEST_CAPABILITY,
        limits: CONNECT_LIMITS,
      },
      realConnectEffects(),
      { preferredPort: undefined },
    );
  }

  it("reaches a listener on ::1 with the brackets taken off the dial", async (ctx) => {
    const echo = await echoOnLoopbackV6();
    if (echo === undefined) {
      ctx.skip();
      return;
    }
    const door = await startDoor();
    try {
      const attempt = rawAttempt(door.port, headFor(`[::1]:${String(portOf(echo))}`));
      expect(await attempt.answer).toContain("200 Connection Established");
      const echoed = new Promise<string>((resolve) => {
        attempt.socket.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("utf8"));
        });
      });
      attempt.socket.write("ping");
      expect(await echoed).toBe("ping");
      attempt.socket.destroy();
    } finally {
      await door.close();
      await new Promise<void>((resolve) => {
        echo.close(() => {
          resolve(undefined);
        });
      });
    }
  });

  it.each(["[::1", "[::1]x", "[]:443", "::1", "host:65536", "user@host:443"])("answers 400 to the malformed authority %j before dialling anything", async (authority) => {
    const door = await startDoor();
    try {
      const attempt = rawAttempt(door.port, headFor(authority));
      const answer = await attempt.answer;
      expect(answer).toContain("400 Bad Request");
      expect(answer.toLowerCase()).toContain("x-agent-shim-refusal: ");
      await attempt.closed;
    } finally {
      await door.close();
    }
  });
});
