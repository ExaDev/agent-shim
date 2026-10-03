import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { admitLaunchToken } from "../test-helpers";
import { createPassthroughRoute } from "./passthrough";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, IDENTITY_HEADER } from "./route";

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

/** What the fake upstream saw of one request. */
interface UpstreamSeen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A fake Anthropic-shaped upstream that records each request and answers with a fixed JSON body. */
async function fakeUpstream(): Promise<{ readonly port: number; readonly seen: () => readonly UpstreamSeen[] }> {
  const requests: UpstreamSeen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body });
      // A hop-by-hop header named by Connection: the door must regenerate framing on the client's connection, never copy it (Node also emits its own keep-alive hints, so a Connection-named token is the precise probe).
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json", connection: "x-hop-probe", "x-hop-probe": "must-not-cross" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await listen(server);
  return { port, seen: () => requests };
}

/** Starts a door serving exactly one pass-through route at the given target. */
async function startDoor(target: { readonly baseUrl: string; readonly stripPrefix: string | undefined; readonly headroomUpstream: string | undefined }): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const route = createPassthroughRoute("http:z", target);
  const server = createFrontDoorServer(
    async (request) => {
      await serveRouted(request, {
        resolveRoute: async () => await Promise.resolve({ ok: true, route }),
        responseObservers: [],
        admit: admitLaunchToken("launch-token-for-tests"),
        now: () => 0,
        log: () => undefined,
      });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
}

describe("the pass-through route", () => {
  it("forwards to the upstream with the provider prefix stripped, the query kept, the host replaced and the body intact", async () => {
    const upstream = await fakeUpstream();
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(upstream.port)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages?beta=true`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok", [IDENTITY_HEADER]: "work", [AUTH_HEADER]: "launch-token-for-tests" },
        body: '{"model":"claude-sonnet-4-5"}',
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(await response.json()).toMatchObject({ ok: true });
      const seen = upstream.seen()[0];
      expect(seen?.url).toBe("/v1/messages?beta=true");
      expect(seen?.headers.authorization).toBe("Bearer tok");
      expect(seen?.body).toBe('{"model":"claude-sonnet-4-5"}');
      // The upstream must hear its own host, never the door's loopback address the client named.
      expect(seen?.headers.host).toBe(`127.0.0.1:${String(upstream.port)}`);
      expect(seen?.headers[IDENTITY_HEADER]).toBeUndefined();
      expect(seen?.headers[HEADROOM_FLAG_HEADER]).toBeUndefined();
      // And the client must not receive the upstream's connection-scoped header, which describes a connection it is not on.
      expect(response.headers.get("x-hop-probe")).toBeNull();
    } finally {
      await door.close();
    }
  });

  it("addresses the request under the upstream's base path, so a provider whose base URL has a path is reached", async () => {
    const upstream = await fakeUpstream();
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(upstream.port)}/api/anthropic/`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      await fetch(`${door.url}/providers/z/v1/messages?beta=true`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok", [IDENTITY_HEADER]: "work", [AUTH_HEADER]: "launch-token-for-tests" },
        body: "{}",
      });
      expect(upstream.seen()[0]?.url).toBe("/api/anthropic/v1/messages?beta=true");
    } finally {
      await door.close();
    }
  });

  it("answers an unreachable upstream as an Anthropic-shaped 502 rather than hanging", async () => {
    // A port nothing listens on: bind and release one to be sure it is genuinely closed.
    const probe = http.createServer();
    const deadPort = await listen(probe);
    await new Promise<void>((resolve) => {
      probe.closeAllConnections();
      probe.close(() => {
        resolve(undefined);
      });
    });
    servers.splice(servers.indexOf(probe), 1);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(deadPort)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    } finally {
      await door.close();
    }
  });
});
