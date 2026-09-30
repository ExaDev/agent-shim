import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { CODEX_KEEP_ALIVE_CEILING_MS, createUpstreamAgent, createUpstreamFetch } from "./agent";
import { HTTP_STATUS } from "./http";

const POLL_MS = 10;
/** What the stand-in backend advertises: ten minutes, far beyond the ceiling. */
const SERVER_KEEP_ALIVE_MS = 600_000;
const CLOSE_TIMEOUT_MS = 2000;

/** Every loopback server a test starts, closed afterwards. */
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

// The keep-alive ceiling tests below moved verbatim from the codex listener's own test file when that listener was replaced by the front door: they pin the upstream agent's behaviour, not any listener's.
describe("upstream keep-alive ceiling", () => {
  /**
   * A server that advertises a far longer keep-alive than the ceiling and never closes an idle socket itself, standing in for a backend whose hint outlives the real socket: the 2026-08-27 wedge happened because the client trusted that hint.
   */
  async function hintingServer(): Promise<{ readonly port: number; readonly openSockets: () => number }> {
    let open = 0;
    const server = http.createServer((_request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "Content-Type": "text/plain", "Keep-Alive": "timeout=600" });
      response.end("ok");
    });
    server.keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
    server.on("connection", (socket) => {
      open += 1;
      socket.on("close", () => {
        open -= 1;
      });
    });
    const port = await listen(server);
    return { port, openSockets: () => open };
  }

  const TEN_SECONDS_MS = 10_000;
  const TEST_CEILING_MS = 150;
  const BEYOND_CEILING_MS = 600;

  async function requestOnce(agent: Agent, port: number): Promise<void> {
    const fetch = createUpstreamFetch(agent);
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { method: "POST", headers: {}, body: "", signal: new AbortController().signal });
    expect(await response.text()).toBe("ok");
  }

  it("is ten seconds", () => {
    expect(CODEX_KEEP_ALIVE_CEILING_MS).toBe(TEN_SECONDS_MS);
  });

  it("closes an idle pooled socket at the ceiling even though the server's hint says to keep it", async () => {
    const { port, openSockets } = await hintingServer();
    const agent = createUpstreamAgent(TEST_CEILING_MS);
    await requestOnce(agent, port);
    expect(openSockets()).toBe(1);
    await waitFor(() => openSockets() === 0, CLOSE_TIMEOUT_MS);
    expect(openSockets()).toBe(0);
    await agent.close();
  });

  it("would keep the socket open on undici's defaults, which is the failure the ceiling prevents", async () => {
    const { port, openSockets } = await hintingServer();
    const agent = new Agent();
    await requestOnce(agent, port);
    await new Promise((resolve) => {
      setTimeout(resolve, BEYOND_CEILING_MS);
    });
    expect(openSockets()).toBe(1);
    await agent.destroy();
  });
});
