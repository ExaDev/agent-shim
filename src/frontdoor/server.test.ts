import https from "node:https";
import * as net from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, parseAnthropicSse, recordingFetch, type RecordedCall } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeFs } from "../test-helpers";
import type { SessionIdentity } from "./route";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, IDENTITY_HEADER, SESSION_HEADER, type FrontDoorRoute } from "./route";
import { serveRouted, type PipelineDeps, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial } from "./connect";
import { createFrontDoorServer, frontDoorHealthy, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.claude-use/providers`;
const POLL_MS = 10;
const SETTLE_MS = 30;
const STREAM_GAP_MS = 30;
const TICK_MS = 10;
const ABORT_TIMEOUT_MS = 2_000;
/** The per-launch capability token the door accepts in these tests. */
const LAUNCH_TOKEN = "launch-token-for-tests";

/** A successful text turn as the codex backend streams it. */
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 100, output_tokens: 5 } } },
];

/** A codex provider definition as the fake filesystem serves it. */
const codexProvider = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };

const MESSAGES_BODY = JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "user-a" } });

/** A resolution that answers with one fixed route. */
function resolves(route: FrontDoorRoute): PipelineDeps["resolveRoute"] {
  return async () => await Promise.resolve({ ok: true, route } satisfies RouteResolution);
}

/** A resolution that refuses everything with one fixed error. */
function refuses(status: number, message: string): PipelineDeps["resolveRoute"] {
  return async () => await Promise.resolve({ ok: false, status, message } satisfies RouteResolution);
}

/** Starts a front door on a free port (or the sticky one, for restart tests) with the given route resolution. */
async function startDoor(resolveRoute: PipelineDeps["resolveRoute"], preferredPort?: number): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly port: number }> {
  const logs: string[] = [];
  const server = createFrontDoorServer(
    async (request) => {
      await serveRouted(request, { resolveRoute, responseObservers: [], admit: admitLaunchToken(LAUNCH_TOKEN), log: (line) => { logs.push(line); } });
    },
    (line) => {
      logs.push(line);
    },
  );
  const handle = await listenFrontDoor(server, preferredPort === undefined ? {} : { preferredPort });
  return { url: `http://127.0.0.1:${String(handle.port)}`, port: handle.port, close: handle.close };
}

/** Starts a front door whose routes come from the provider files in `files`, with a recording fake upstream for the codex translation. */
async function startProviderDoor(files: Record<string, unknown>, preferredPort?: number): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly port: number; readonly calls: readonly RecordedCall[] }> {
  const upstream = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const ports: Omit<CodexRoutePorts, "loadProvider"> = {
    upstream: { fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" },
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
  let ownPort = 0;
  const resolveRoute = createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: ports, directPort: () => ownPort });
  const door = await startDoor(resolveRoute, preferredPort);
  ownPort = door.port;
  return { ...door, calls: upstream.calls };
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

describe("createFrontDoorServer", () => {
  it("answers its health probe without routing anything", async () => {
    const door = await startDoor(refuses(HTTP_STATUS.notFound, "unrouted"));
    try {
      const response = await fetch(`${door.url}/healthz`);
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(await response.text()).toBe("ok");
    } finally {
      await door.close();
    }
  });

  it("serves the codex translation through the whole listener: provider resolution, mount, pipeline, transport", async () => {
    const door = await startProviderDoor({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const frames = parseAnthropicSse(await response.text());
      expect(frames.map((frame) => frame.event)).toContain("content_block_delta");
      expect(door.calls.length).toBe(1);
    } finally {
      await door.close();
    }
  });

  it("strips the identity and session headers before the route, so nothing it forwards can carry them upstream", async () => {
    let seen: { readonly headers: Readonly<Record<string, unknown>>; readonly session: SessionIdentity } | undefined;
    const echo: FrontDoorRoute = {
      name: "echo",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (request, response) => {
        seen = { headers: request.headers, session: request.session };
        response.start(HTTP_STATUS.ok, { "Content-Type": "application/json" });
        await response.write(JSON.stringify(Object.keys(request.headers).sort()));
        response.end();
      },
    };
    const door = await startDoor(resolves(echo));
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        method: "POST",
        headers: { [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", authorization: "Bearer tok", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: "{}",
      });
      const echoed: unknown = await response.json();
      if (!Array.isArray(echoed) || echoed.some((name) => typeof name !== "string")) {
        throw new Error("the echo route answers with a list of header names");
      }
      expect(echoed).toContain("authorization");
      expect(echoed).not.toContain(IDENTITY_HEADER);
      expect(echoed).not.toContain(SESSION_HEADER);
      expect(echoed).not.toContain(HEADROOM_FLAG_HEADER);
      expect(seen?.session).toEqual({ identity: "work", sessionId: "session-1", headroom: true, projectId: undefined });
    } finally {
      await door.close();
    }
  });

  it("streams a response chunk by chunk as the route produces it, not buffered until it ends", async () => {
    const routeState = { secondChunkPushed: false };
    const streamer: FrontDoorRoute = {
      name: "streamer",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        response.start(HTTP_STATUS.ok, { "Content-Type": "text/event-stream" });
        await response.write("data: first\n\n");
        await new Promise((resolve) => {
          setTimeout(resolve, STREAM_GAP_MS);
        });
        routeState.secondChunkPushed = true;
        await response.write("data: second\n\n");
        response.end();
      },
    };
    const door = await startDoor(resolves(streamer));
    try {
      const response = await fetch(`${door.url}/providers/x/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: LAUNCH_TOKEN }, body: "{}" });
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("no response body to read");
      }
      const text = new TextDecoder();
      let received = "";
      for (;;) {
        const read: { done: boolean; value?: unknown } = await reader.read();
        if (read.done) {
          break;
        }
        if (!(read.value instanceof Uint8Array)) {
          throw new Error("the reader yielded a non-chunk");
        }
        received += text.decode(read.value);
        // The first chunk must have arrived while the route was still mid-stream, proving incremental delivery rather than a buffered whole.
        if (received.includes("first")) {
          expect(routeState.secondChunkPushed).toBe(false);
          break;
        }
      }
      expect(received).toContain("first");
    } finally {
      await door.close();
    }
  });

  it("aborts the route the moment the client disconnects mid-stream", async () => {
    let seen: AbortSignal | undefined;
    const endless: FrontDoorRoute = {
      name: "endless",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (request, response) => {
        seen = request.signal;
        response.start(HTTP_STATUS.ok, { "Content-Type": "text/event-stream" });
        for (;;) {
          await response.write("data: tick\n\n");
          await new Promise((resolve) => {
            setTimeout(resolve, TICK_MS);
          });
        }
      },
    };
    const door = await startDoor(resolves(endless));
    try {
      const abort = new AbortController();
      const response = await fetch(`${door.url}/providers/x/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: LAUNCH_TOKEN }, body: "{}", signal: abort.signal });
      const reader = response.body?.getReader();
      await reader?.read();
      expect(seen?.aborted).toBe(false);
      abort.abort();
      await waitFor(() => seen?.aborted === true, ABORT_TIMEOUT_MS);
      expect(seen?.aborted).toBe(true);
    } finally {
      await door.close();
    }
  });

  it("does not abort a response that finished normally", async () => {
    let seen: AbortSignal | undefined;
    const once: FrontDoorRoute = {
      name: "once",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (request, response) => {
        seen = request.signal;
        response.start(HTTP_STATUS.ok, { "Content-Type": "application/json" });
        await response.write('{"ok":true}');
        response.end();
      },
    };
    const door = await startDoor(resolves(once));
    try {
      const response = await fetch(`${door.url}/providers/x/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: LAUNCH_TOKEN }, body: "{}" });
      expect(await response.text()).toBe('{"ok":true}');
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      expect(seen?.aborted).toBe(false);
    } finally {
      await door.close();
    }
  });

  it("answers an unrouted target as an Anthropic-shaped error", async () => {
    const door = await startDoor(refuses(HTTP_STATUS.notFound, "no such endpoint"));
    try {
      const response = await fetch(`${door.url}/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: LAUNCH_TOKEN }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.notFound);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    } finally {
      await door.close();
    }
  });

  it("refuses a request carrying no launch capability, without any route being asked", async () => {
    let routeReached = false;
    const marker: FrontDoorRoute = {
      name: "marker",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        routeReached = true;
        response.start(HTTP_STATUS.ok, { "Content-Type": "text/plain" });
        await response.write("reached");
        response.end();
      },
    };
    const door = await startDoor(resolves(marker));
    try {
      const without = await fetch(`${door.url}/providers/x/v1/messages`, { method: "POST", body: "{}" });
      expect(without.status).toBe(HTTP_STATUS.unauthorized);
      const wrong = await fetch(`${door.url}/providers/x/v1/messages`, { method: "POST", headers: { [AUTH_HEADER]: "not-a-live-launch" }, body: "{}" });
      expect(wrong.status).toBe(HTTP_STATUS.unauthorized);
      expect(await without.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
      expect(routeReached).toBe(false);
    } finally {
      await door.close();
    }
  });

  it("moves off a sticky port something else holds without reporting that bind failure as a fatal listener error", async () => {
    const squatter = net.createServer();
    await new Promise<void>((resolve) => {
      squatter.listen(0, "127.0.0.1", resolve);
    });
    const address = squatter.address();
    const taken = typeof address === "object" && address !== null ? address.port : 0;
    const fatal: Error[] = [];
    const server = createFrontDoorServer(async () => {
      await Promise.resolve();
    }, () => undefined);
    try {
      const handle = await listenFrontDoor(server, {
        preferredPort: taken,
        onError: (error) => {
          fatal.push(error);
        },
      });
      expect(handle.port).not.toBe(taken);
      expect(await frontDoorHealthy(handle.port)).toBe(true);
      expect(fatal).toEqual([]);
      await handle.close();
    } finally {
      await new Promise<void>((resolve) => {
        squatter.close(() => {
          resolve(undefined);
        });
      });
    }
  });

  it("restores service on the same port after the door dies, which is what a frozen base URL needs", async () => {
    const door = await startProviderDoor({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider });
    const port = door.port;
    const first = await fetch(`http://127.0.0.1:${String(port)}/providers/codex/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
    expect(first.status).toBe(HTTP_STATUS.ok);
    await first.text();
    // The supervisor process dying closes the listener; the next generation is what binds the sticky port again.
    await door.close();
    const replacement = await startProviderDoor({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, port);
    try {
      expect(replacement.port).toBe(port);
      expect(await frontDoorHealthy(port)).toBe(true);
      const second = await fetch(`http://127.0.0.1:${String(port)}/providers/codex/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(second.status).toBe(HTTP_STATUS.ok);
      await second.text();
    } finally {
      await replacement.close();
    }
  });
});

/** Enough time for the pure-JS 2048-bit keypairs the TLS tests generate once. */
const KEYGEN_TIMEOUT_MS = 120_000;

/** One HTTPS request that trusts exactly `ca` and nothing else: what a routed child does with NODE_EXTRA_CA_CERTS for a loopback address no public CA will certify. Resolves with the status, or rejects with the TLS error. */
async function requestTrusting(port: number, ca: string, headers: Readonly<Record<string, string>>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", port, method: "POST", path: "/providers/codex/v1/messages", ca: [ca], agent: false, headers: { "content-type": "application/json", ...headers } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end(MESSAGES_BODY);
  });
}

describe("the TLS provider listener", () => {
  let ca: CaMaterial;
  let foreignCa: CaMaterial;

  beforeAll(() => {
    ca = generateCa(new Date());
    foreignCa = generateCa(new Date());
  }, KEYGEN_TIMEOUT_MS);

  /** A door serving the given leaf over TLS, admitting the test's launch token. */
  async function startTlsDoor(leaf: ReturnType<typeof mintLeaf>, onRequest: (authorization: string | undefined) => void): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
    const server = createFrontDoorServer(
      async (request) => {
        onRequest(request.headers.authorization);
        await serveRouted(request, { resolveRoute: refuses(HTTP_STATUS.notFound, "nothing here"), responseObservers: [], admit: admitLaunchToken(LAUNCH_TOKEN), log: () => undefined });
      },
      () => undefined,
      leaf,
    );
    const handle = await listenFrontDoor(server, { ca: ca.certPem });
    return { port: handle.port, close: handle.close };
  }

  it(
    "completes a handshake with a client that trusts only claude-use's CA, and answers its health probe only over that trust",
    async () => {
      const seen: (string | undefined)[] = [];
      const door = await startTlsDoor(mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()), (authorization) => {
        seen.push(authorization);
      });
      try {
        expect(await requestTrusting(door.port, ca.certPem, { [AUTH_HEADER]: LAUNCH_TOKEN, authorization: "Bearer made-up" })).toBe(HTTP_STATUS.notFound);
        expect(seen).toEqual(["Bearer made-up"]);
        expect(await frontDoorHealthy(door.port, ca.certPem)).toBe(true);
        expect(await frontDoorHealthy(door.port, foreignCa.certPem)).toBe(false);
      } finally {
        await door.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "leaves a client trusting claude-use's CA unable to talk to a server holding a certificate from any other CA, so its credential is never sent",
    async () => {
      const seen: (string | undefined)[] = [];
      // The hostile server is a complete front door in every respect but its certificate, which chains to a CA whose key it does hold.
      const impostor = await new Promise<{ readonly port: number; readonly close: () => Promise<void> }>((resolve) => {
        const leaf = mintLeaf(foreignCa, LOOPBACK_LEAF_NAMES, new Date());
        const server = createFrontDoorServer(
          async (request) => {
            seen.push(request.headers.authorization);
            await Promise.resolve();
          },
          () => undefined,
          leaf,
        );
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve({
            port: typeof address === "object" && address !== null ? address.port : 0,
            close: async () => {
              await new Promise<void>((closed) => {
                server.close(() => {
                  closed(undefined);
                });
              });
            },
          });
        });
      });
      try {
        await expect(requestTrusting(impostor.port, ca.certPem, { [AUTH_HEADER]: LAUNCH_TOKEN, authorization: "Bearer made-up" })).rejects.toThrow(/certificate/i);
        expect(seen).toEqual([]);
      } finally {
        await impostor.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});

