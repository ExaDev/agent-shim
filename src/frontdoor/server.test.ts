import { describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, parseAnthropicSse, recordingFetch, type RecordedCall } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeFs } from "../test-helpers";
import type { SessionIdentity } from "./route";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, IDENTITY_HEADER, SESSION_HEADER, type FrontDoorRoute } from "./route";
import { serveRouted, type PipelineDeps, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
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
  const handle = await listenFrontDoor(server, preferredPort, () => undefined);
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
