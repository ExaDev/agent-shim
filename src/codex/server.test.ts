import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { CODEX_KEEP_ALIVE_CEILING_MS, createUpstreamAgent, createUpstreamFetch } from "./agent";
import { HTTP_STATUS } from "./http";
import type { RouteRequest, RouteResponse } from "./route";
import { createCodexServer } from "./server";

const POLL_MS = 10;
const ABORT_TIMEOUT_MS = 2000;
const SETTLE_MS = 20;
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
          resolve();
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

describe("createCodexServer", () => {
  it("aborts the route's signal when the client disconnects mid-stream", async () => {
    let seen: AbortSignal | undefined;
    const route = async (request: RouteRequest): Promise<RouteResponse> => {
      seen = request.signal;
      async function* body(): AsyncGenerator<string> {
        yield "event: message_start\ndata: {}\n\n";
        // The upstream keeps generating until the signal says the client has gone.
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
      return await Promise.resolve({ status: HTTP_STATUS.ok, headers: { "Content-Type": "text/event-stream" }, body: body() });
    };
    const port = await listen(createCodexServer(route, () => undefined));
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/providers/codex/v1/messages" });
    request.end("{}");
    await new Promise<void>((resolve) => {
      request.on("response", (response) => {
        response.once("data", () => {
          resolve();
        });
      });
    });
    expect(seen?.aborted).toBe(false);
    request.destroy();
    await waitFor(() => seen?.aborted === true, ABORT_TIMEOUT_MS);
    expect(seen?.aborted).toBe(true);
  });

  it("does not abort a response that finished normally", async () => {
    let seen: AbortSignal | undefined;
    const route = async (request: RouteRequest): Promise<RouteResponse> => {
      seen = request.signal;
      return await Promise.resolve({ status: HTTP_STATUS.ok, headers: { "Content-Type": "application/json" }, body: '{"ok":true}' });
    };
    const port = await listen(createCodexServer(route, () => undefined));
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(await response.text()).toBe('{"ok":true}');
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    expect(seen?.aborted).toBe(false);
  });

  it("answers a route failure with an Anthropic-shaped 500 and logs it", async () => {
    const logs: string[] = [];
    const port = await listen(
      createCodexServer(
        async () => await Promise.reject(new Error("route exploded")),
        (line) => {
          logs.push(line);
        },
      ),
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/x`, { method: "POST", body: "{}" });
    expect(response.status).toBe(HTTP_STATUS.internalServerError);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(logs.some((line) => line.includes("route exploded"))).toBe(true);
  });
});

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
