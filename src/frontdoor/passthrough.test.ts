import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { admitLaunchToken, followsLaunchFlag } from "../test-helpers";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { armConnectDeadline, createPassthroughRoute, type PassthroughTarget } from "./passthrough";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, IDENTITY_HEADER } from "./route";

const servers: http.Server[] = [];

/** A connect bound short enough that a test waiting it out stays quick, and far above what a loopback connect takes, so a reachable loopback upstream never trips it. */
const SHORT_CONNECT_BOUND_MS = 200;

/** The connect bound of the test that a reachable upstream must NOT trip: a loaded machine can delay even a loopback connect past `SHORT_CONNECT_BOUND_MS`, so this is far above a healthy connect, and the upstream in that test answers after twice it, which is what shows the bound covers the connect only. */
const REACHABLE_CONNECT_BOUND_MS = 1_000;

/** How many connect bounds a test that the bound must end may take in all: the bound itself, and the rest for the door to answer on a loaded machine, still far short of the operating system's own connect timeout (75 s on macOS) the bound replaces. */
const BOUNDS_PER_TEST_BUDGET = 10;

/** The test's own budget for a request the connect bound must end. */
const TEST_BUDGET_MS = SHORT_CONNECT_BOUND_MS * BOUNDS_PER_TEST_BUDGET;

/** An agent whose dial never settles: the stand-in for a host that never answers the SYN, reached through the asynchronous dial form the door's reserved-port agent uses. */
class NeverConnectingAgent extends http.Agent {
  createConnection(): undefined {
    return undefined;
  }
}

/** Characters in a refusal body that put it past what the route holds to read (16,384 bytes). */
const REFUSAL_BODY_PAST_LIMIT = 20_000;

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
async function startDoor(
  target: { readonly baseUrl: string; readonly stripPrefix: string | undefined; readonly headroomUpstream: string | undefined } & Partial<Pick<PassthroughTarget, "connectTimeoutMs" | "couldNotConnect">>,
  agentFor?: (tls: boolean) => http.Agent,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const full: PassthroughTarget = { subject: "provider z", connectTimeoutMs: DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS, couldNotConnect: () => undefined, ...target };
  const route = agentFor === undefined ? createPassthroughRoute("http:z", full) : createPassthroughRoute("http:z", full, agentFor);
  const server = createFrontDoorServer(
    async (request) => {
      await serveRouted(request, {
        resolveRoute: async () => await Promise.resolve({ ok: true, route }),
        canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [],
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

  it("forwards the request fields, beta headers and tool ids a gateway must not touch, and returns the response's own keys, as Claude Code's gateway guide requires", async () => {
    const requests: UpstreamSeen[] = [];
    const reply = { id: "msg_1", type: "message", content: [{ type: "tool_use", id: "toolu_reply", name: "Bash", input: {} }], stop_reason: "tool_use", safeguard_results: [{ id: "classifier-1", verdict: "allow" }] };
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        requests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body });
        response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end(JSON.stringify(reply));
      });
    });
    const upstreamPort = await listen(server);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    const sent = {
      model: "claude-sonnet-5-5",
      max_tokens: 64,
      // A field no gateway is expected to know, as the guide names it, beside the ones that pair with a beta header.
      safeguards: [{ id: "classifier-1", type: "unrecognised" }],
      context_management: { edits: [] },
      output_config: { effort: "low" },
      system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "list things" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01ABC", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "a\nb" }] },
      ],
    };
    const betaValues = "context-management-2025-06-27,effort-2025-11-24";
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok", "anthropic-beta": betaValues, "anthropic-version": "2023-06-01", [AUTH_HEADER]: "launch-token-for-tests" },
        body: JSON.stringify(sent),
      });
      const seen = requests[0];
      expect(seen?.headers["anthropic-beta"]).toBe(betaValues);
      expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(JSON.parse(seen?.body ?? "null")).toEqual(sent);
      expect(await response.json()).toEqual(reply);
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

  /** A fake upstream answering every request with one fixed status, headers and body. */
  async function refusingUpstream(status: number, headers: Readonly<Record<string, string>>, text: string): Promise<number> {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(status, headers);
        response.end(text);
      });
    });
    return await listen(server);
  }

  it("translates an upstream's spent-quota 429 into the real API's limit headers and leaves its body as it was", async () => {
    const text = JSON.stringify({ type: "error", error: { code: "1308", message: "Usage limit reached for 5 hour. Your limit will reset at 2026-10-22 23:57:10" } });
    const port = await refusingUpstream(HTTP_STATUS.tooManyRequests, { "content-type": "application/json", "retry-after": "3600" }, text);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(port)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.tooManyRequests);
      expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("five_hour");
      expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.get("retry-after")).toBe("3600");
      expect(await response.text()).toBe(text);
    } finally {
      await door.close();
    }
  });

  it("leaves a short rate limit's 429 as the upstream sent it", async () => {
    const text = JSON.stringify({ type: "error", error: { code: "1302", message: "Rate limit reached for requests" } });
    const port = await refusingUpstream(HTTP_STATUS.tooManyRequests, { "content-type": "application/json", "retry-after": "5" }, text);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(port)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.tooManyRequests);
      expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBeNull();
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.text()).toBe(text);
    } finally {
      await door.close();
    }
  });

  it("streams on a refusal body past the most it holds, whole and untranslated", async () => {
    const text = JSON.stringify({ type: "error", error: { code: "1308", message: `Usage limit reached for 5 hour. ${"x".repeat(REFUSAL_BODY_PAST_LIMIT)}` } });
    const port = await refusingUpstream(HTTP_STATUS.tooManyRequests, { "content-type": "application/json", "retry-after": "3600" }, text);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(port)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.tooManyRequests);
      expect(response.headers.get("anthropic-ratelimit-unified-representative-claim")).toBeNull();
      expect(await response.text()).toBe(text);
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
    const told: string[] = [];
    const baseUrl = `http://127.0.0.1:${String(deadPort)}`;
    const door = await startDoor({ baseUrl, stripPrefix: "/providers/z", headroomUpstream: undefined, couldNotConnect: (line) => {
      told.push(line);
    } });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(new RegExp(`^provider z could not connect to ${baseUrl.replaceAll(".", "\\.")}: .*ECONNREFUSED`));
      // The client is answered with the same line the log is told.
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error", message: told[0] } });
    } finally {
      await door.close();
    }
  });

  it("gives a reason, not an empty one, when localhost refuses on both of its addresses", async () => {
    const probe = http.createServer();
    const deadPort = await listen(probe);
    await new Promise<void>((resolve) => {
      probe.closeAllConnections();
      probe.close(() => {
        resolve(undefined);
      });
    });
    servers.splice(servers.indexOf(probe), 1);
    const told: string[] = [];
    const door = await startDoor({ baseUrl: `http://localhost:${String(deadPort)}`, stripPrefix: "/providers/z", headroomUpstream: undefined, couldNotConnect: (line) => {
      told.push(line);
    } });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      const body = (await response.json()) as { readonly error: { readonly message: string } };
      expect(body.error.message).toMatch(/ECONNREFUSED/u);
      expect(body.error.message).not.toMatch(/:\s*$/u);
      expect(told).toEqual([body.error.message]);
    } finally {
      await door.close();
    }
  });

  it("gives up on an upstream whose dial never settles after its connect bound, naming the provider and its base URL", async () => {
    // The dial never settles, so nothing but the connect bound can end the wait: without it this request would hang until the test's own budget ran out.
    const told: string[] = [];
    const door = await startDoor(
      { baseUrl: "http://provider.example:9", stripPrefix: "/providers/z", headroomUpstream: undefined, connectTimeoutMs: SHORT_CONNECT_BOUND_MS, couldNotConnect: (line) => {
        told.push(line);
      } },
      () => new NeverConnectingAgent(),
    );
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(told).toEqual([`provider z could not connect to http://provider.example:9: no connection within ${String(SHORT_CONNECT_BOUND_MS)}ms`]);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error", message: told[0] } });
    } finally {
      await door.close();
    }
  }, TEST_BUDGET_MS);

  it("names the base URL without its userinfo or query in what the client and the log are told", async () => {
    const probe = http.createServer();
    const deadPort = await listen(probe);
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve(undefined);
      });
    });
    servers.splice(servers.indexOf(probe), 1);
    const told: string[] = [];
    const door = await startDoor({ baseUrl: `http://user:hunter2@127.0.0.1:${String(deadPort)}/v1?key=abc123`, stripPrefix: "/providers/z", headroomUpstream: undefined, couldNotConnect: (line) => {
      told.push(line);
    } });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      const printed = [await response.text(), ...told].join("\n");
      expect(printed).toContain(`http://127.0.0.1:${String(deadPort)}/v1`);
      expect(printed).not.toContain("hunter2");
      expect(printed).not.toContain("abc123");
    } finally {
      await door.close();
    }
  });

  it("names the base URL without its userinfo or query when the upstream drops the connection before answering", async () => {
    const upstream = http.createServer((request) => {
      request.socket.destroy();
    });
    const port = await listen(upstream);
    const door = await startDoor({ baseUrl: `http://user:hunter2@127.0.0.1:${String(port)}/v1?key=abc123`, stripPrefix: "/providers/z", headroomUpstream: undefined, couldNotConnect: () => undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      const printed = await response.text();
      expect(printed).toContain(`http://127.0.0.1:${String(port)}/v1 dropped the connection before answering`);
      expect(printed).not.toContain("hunter2");
      expect(printed).not.toContain("abc123");
    } finally {
      await door.close();
    }
  });

  it("names the base URL without its userinfo or query when the upstream drops a held refusal body before the head went out", async () => {
    const upstream = http.createServer((request, response) => {
      response.writeHead(HTTP_STATUS.tooManyRequests, { "content-type": "application/json" });
      response.write("{");
      setTimeout(() => {
        request.socket.destroy();
      }, 0);
    });
    const port = await listen(upstream);
    const door = await startDoor({ baseUrl: `http://user:hunter2@127.0.0.1:${String(port)}/v1?key=abc123`, stripPrefix: "/providers/z", headroomUpstream: undefined, couldNotConnect: () => undefined });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      const printed = await response.text();
      expect(printed).toContain(`http://127.0.0.1:${String(port)}/v1 dropped the connection`);
      expect(printed).not.toContain("hunter2");
      expect(printed).not.toContain("abc123");
    } finally {
      await door.close();
    }
  });

  it("bounds only the connect: an upstream that accepts at once and answers after the connect bound is served", async () => {
    const server = http.createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end('{"ok":true}');
      }, REACHABLE_CONNECT_BOUND_MS * 2);
    });
    const port = await listen(server);
    const door = await startDoor({ baseUrl: `http://127.0.0.1:${String(port)}`, stripPrefix: "/providers/z", headroomUpstream: undefined, connectTimeoutMs: REACHABLE_CONNECT_BOUND_MS });
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await door.close();
    }
  });
});

describe("armConnectDeadline", () => {
  it("destroys a request whose connection has not opened within the bound, and says it never connected", async () => {
    const forward = http.request({ host: "127.0.0.1", port: 9, agent: new NeverConnectingAgent() });
    let connection: { readonly connected: () => boolean } | undefined;
    const error = await new Promise<Error>((resolve) => {
      connection = armConnectDeadline(forward, SHORT_CONNECT_BOUND_MS, resolve);
      forward.end();
    });
    expect(forward.destroyed).toBe(true);
    expect(error.message).toBe(`no connection within ${String(SHORT_CONNECT_BOUND_MS)}ms`);
    expect(connection?.connected()).toBe(false);
  }, TEST_BUDGET_MS);
});
