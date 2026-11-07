import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, fakeResponse, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { ANTIGRAVITY_DEFAULT_TIER_MODELS, CODEX_DEFAULT_TIER_MODELS } from "../config/schema";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag } from "../test-helpers";
import { createUsageMiddleware } from "../usage/middleware";
import type { UsageRecord } from "../usage/schema";
import { createMainLoopRouteRecord, type MainLoopRouteRecord } from "./mainLoopRoute";
import { serveRouted, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER, PROVIDER_HEADER, SESSION_HEADER, type RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const LAUNCH_TOKEN = "launch-token-for-tests";
const OWN_PORT = 4100;
const HAIKU_NAME = "claude-haiku-5-5";
/** The model the `http` provider's own tier environment names for the haiku tier. */
const Z_HAIKU_MODEL = "glm-4.5-air";

/** A complete Responses API text turn, the shape the codex translator turns into an Anthropic reply. */
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 9, output_tokens: 2 } } },
];

interface UpstreamSeen {
  readonly url: string;
  readonly model: unknown;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }),
  );
});

/** An Anthropic-compatible upstream that records each request's path and model, answering `status`. */
async function fakeUpstream(status: number = HTTP_STATUS.ok): Promise<{ readonly port: number; readonly seen: UpstreamSeen[] }> {
  const seen: UpstreamSeen[] = [];
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ url: incoming.url ?? "", model: typeof parsed === "object" && parsed !== null && "model" in parsed ? parsed.model : undefined });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === HTTP_STATUS.ok ? JSON.stringify({ type: "message", model: Z_HAIKU_MODEL, usage: { input_tokens: 1, output_tokens: 1 } }) : JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("upstream has no TCP address");
  }
  return { port: (address satisfies AddressInfo).port, seen };
}

/** The codex translator's ports over `fetch`, with the fixed-token auth store. */
function codexPortsOver(fetch: ReturnType<typeof recordingFetch>["fetch"]): Omit<CodexRoutePorts, "loadProvider"> {
  return {
    upstreams: sameUpstreamForEveryLogin({ fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }),
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
}

/** Codex ports for a world with no codex provider, which never call an upstream. */
function unusedCodexPorts(): Omit<CodexRoutePorts, "loadProvider"> {
  return codexPortsOver(
    recordingFetch(() => {
      throw new Error("this world has no codex provider");
    }).fetch,
  );
}

interface World {
  readonly url: string;
  readonly upstream: { readonly seen: UpstreamSeen[] };
  readonly codexCalls: readonly { readonly init: { readonly body?: string } }[];
  readonly records: UsageRecord[];
  /** The door's resolver itself, for requests whose route must be chosen but never served: the Anthropic route is the real API. */
  readonly resolve: ReturnType<typeof createProviderRouteResolver>;
  readonly close: () => Promise<void>;
}

/** A door serving an `http` provider `z` (whose tier environment maps haiku) and a `codex` provider `cx`, with the usage middleware recording into `records`. */
async function startWorld(record: MainLoopRouteRecord = createMainLoopRouteRecord({ holdsSession: () => true }), upstreamStatus: number = HTTP_STATUS.ok): Promise<World> {
  const upstream = await fakeUpstream(upstreamStatus);
  const codexFetch = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const codexPorts = codexPortsOver(codexFetch.fetch);
  const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0,
    mainLoopRoutes: record,
    fs: fakeFs({
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: Z_HAIKU_MODEL } },
      [`${PROVIDERS_DIR}/cx.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } },
    }),
    providersDir: PROVIDERS_DIR,
    codexPorts,
    directPort: () => OWN_PORT,
    env: {},
    credentials: fakeAsyncCredentials(),
  });
  const records: UsageRecord[] = [];
  const usage = createUsageMiddleware({
    record: (entry) => {
      records.push(entry);
    },
    defer: (task) => {
      task();
    },
    now: () => 0,
    log: () => undefined,
  });
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [usage], admit: admitLaunchToken(LAUNCH_TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, upstream, codexCalls: codexFetch.calls, records, resolve, close: handle.close };
}

/** Sends one Messages request as a launch's child would: its capability, its session id, and, when given, the class Claude Code states and a launch provider. */
async function send(world: World, options: { readonly model: string; readonly session?: string; readonly requestClass?: string; readonly provider?: string }): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${world.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AUTH_HEADER]: LAUNCH_TOKEN,
      [SESSION_HEADER]: options.session ?? "s-1",
      ...(options.requestClass === undefined ? {} : { "x-claude-code-request-class": options.requestClass }),
      ...(options.provider === undefined ? {} : { [PROVIDER_HEADER]: options.provider }),
    },
    body: JSON.stringify({ model: options.model, stream: false, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: response.status, text: await response.text() };
}

/** One request as the pipeline hands the resolver a provider-less session's Messages call of class `requestClass`. */
function routed(model: string, requestClass: string): RoutedRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json", "x-claude-code-request-class": requestClass },
    body: Readable.from([Buffer.from(JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }))]),
    signal: new AbortController().signal,
    session: { identity: undefined, sessionId: "s-1", provider: undefined, headroom: false, projectId: undefined },
  };
}

/** The model the codex translator sent its backend on its `index`th call. */
function codexModel(world: World, index: number): unknown {
  const body = world.codexCalls[index]?.init.body;
  const parsed: unknown = body === undefined ? undefined : JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "model" in parsed ? parsed.model : undefined;
}

describe("a provider-less session's helper requests follow its main loop", () => {
  it("sends an auxiliary request for a Claude haiku name to the provider the main loop is on, under that provider's haiku mapping", async () => {
    const world = await startWorld();
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen).toEqual([
        { url: "/v1/messages", model: "glm-5.3" },
        { url: "/v1/messages", model: Z_HAIKU_MODEL },
      ]);
      // A main request with no class header is the main loop too, and moves the session to the codex provider, whose own translator maps the haiku name by tier.
      expect((await send(world, { model: "cx/gpt-5.6" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "compaction" })).status).toBe(HTTP_STATUS.ok);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
      expect(world.upstream.seen).toHaveLength(2);
    } finally {
      await world.close();
    }
  });

  it("sends the helpers back to the Anthropic route once the main loop returns there", async () => {
    const record = createMainLoopRouteRecord({ holdsSession: () => true });
    const world = await startWorld(record);
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect(record.routeOf("s-1")).toEqual({ kind: "provider", provider: "z" });
      // The Anthropic route is the real API, which a test must not reach: these requests are resolved, never served.
      const main = await world.resolve(routed("claude-opus-5-5", "main"));
      expect(main.ok && main.route.name).toBe("anthropic");
      expect(record.routeOf("s-1")).toEqual({ kind: "anthropic" });
      const helper = await world.resolve(routed(HAIKU_NAME, "auxiliary"));
      expect(helper.ok && helper.route.name).toBe("anthropic");
      expect(helper.ok && helper.request?.url).not.toContain("/providers/");
    } finally {
      await world.close();
    }
  });

  it("refuses a helper request from a session with no main-loop request yet, naming why, and forwards nothing", async () => {
    const world = await startWorld();
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.badRequest);
      const body: unknown = JSON.parse(helper.text);
      expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
      expect(helper.text).toContain("no main-loop request from this session");
      expect(world.upstream.seen).toEqual([]);
      expect(world.codexCalls).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("leaves a session launched on a provider routing by its launch header, helpers included", async () => {
    const record = createMainLoopRouteRecord({ holdsSession: () => true });
    const world = await startWorld(record);
    try {
      // No main request first: the launch header alone routes the helper, as it always has.
      expect((await send(world, { model: Z_HAIKU_MODEL, requestClass: "auxiliary", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: Z_HAIKU_MODEL, requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL, Z_HAIKU_MODEL]);
      expect(record.routeOf("s-1")).toBeUndefined();
    } finally {
      await world.close();
    }
  });

  it("keeps each session's main loop its own", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main", session: "s-a" });
      await send(world, { model: "cx/gpt-5.6", requestClass: "main", session: "s-b" });
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-a" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-b" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-c" })).status).toBe(HTTP_STATUS.badRequest);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
    } finally {
      await world.close();
    }
  });

  it("records the request class and the requested model in the usage log, on an error response too", async () => {
    const world = await startWorld(createMainLoopRouteRecord({ holdsSession: () => true }), HTTP_STATUS.tooManyRequests);
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.records.map((entry) => ({ provider: entry.provider, status: entry.status, requestClass: entry.requestClass, requestedModel: entry.requestedModel }))).toEqual([
        { provider: "z", status: HTTP_STATUS.tooManyRequests, requestClass: "main", requestedModel: "z/glm-5.3" },
        { provider: "z", status: HTTP_STATUS.tooManyRequests, requestClass: "auxiliary", requestedModel: HAIKU_NAME },
      ]);
    } finally {
      await world.close();
    }
  });
});

describe("the main-loop route record", () => {
  it("lives as long as the session's launch, dropping an ended launch's entry on a read and on any write", () => {
    const live = new Set(["s-a", "s-b"]);
    const record = createMainLoopRouteRecord({ holdsSession: (sessionId) => live.has(sessionId) });
    record.record("s-a", { kind: "provider", provider: "z" });
    record.record("s-b", { kind: "anthropic" });
    live.delete("s-a");
    expect(record.routeOf("s-a")).toBeUndefined();
    live.add("s-a");
    // The entry went with the launch: a launch carrying the same id again starts with nothing recorded.
    expect(record.routeOf("s-a")).toBeUndefined();
    record.record("s-a", { kind: "provider", provider: "z" });
    live.delete("s-b");
    record.record("s-a", { kind: "anthropic" });
    live.add("s-b");
    expect(record.routeOf("s-b")).toBeUndefined();
    expect(record.routeOf("s-a")).toEqual({ kind: "anthropic" });
  });
});

/** A Gemini-shaped streaming backend standing in for the antigravity provider's cloud endpoint: it records the model each generation call names in its path, and answers one complete text chunk. */
async function fakeGeminiBackend(): Promise<{ readonly endpoint: string; readonly generated: string[] }> {
  const generated: string[] = [];
  const server = http.createServer((incoming, response) => {
    incoming.resume();
    incoming.on("end", () => {
      const match = /\/models\/([^/:]+):streamGenerateContent/.exec(incoming.url ?? "");
      if (match?.[1] === undefined) {
        // Anything else (the quota summary) has nothing to report here.
        response.writeHead(HTTP_STATUS.notFound, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      generated.push(decodeURIComponent(match[1]));
      response.writeHead(HTTP_STATUS.ok, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("backend has no TCP address");
  }
  return { endpoint: `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`, generated };
}

describe("a native session on antigravity/auto", () => {
  it("sends the /goal judge's auxiliary request for a Claude haiku name to antigravity under its haiku mapping, and nothing to the Anthropic route", async () => {
    const backend = await fakeGeminiBackend();
    const resolveRoute = createProviderRouteResolver({ log: () => undefined, now: () => 0,
      mainLoopRoutes: createMainLoopRouteRecord({ holdsSession: () => true }),
      fs: fakeFs({ [`${PROVIDERS_DIR}/antigravity.json`]: { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "ag-token" }] }, antigravity: { mode: "cloud", cloud: { endpoint: backend.endpoint } } } }),
      providersDir: PROVIDERS_DIR,
      codexPorts: unusedCodexPorts(),
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    // The Anthropic route is the real API: a request the door would send there is answered here instead, and counted, so the test never leaves the machine.
    const toAnthropic: string[] = [];
    const guarded = async (request: RoutedRequest): Promise<RouteResolution> => {
      const resolution = await resolveRoute(request);
      if (!resolution.ok || resolution.route.name !== "anthropic") {
        return resolution;
      }
      return {
        ok: true,
        route: {
          name: "anthropic",
          headroomEligible: false,
          headroomUpstream: undefined,
          serve: async (served, response) => {
            toAnthropic.push(served.headers["x-claude-code-request-class"]?.toString() ?? "(no class)");
            response.start(HTTP_STATUS.badGateway, { "content-type": "application/json" });
            await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message: "the test's stand-in for the Anthropic route" } }));
            response.end();
          },
        },
      };
    };
    const server = createFrontDoorServer(
      async (pipelineRequest) => {
        await serveRouted(pipelineRequest, { resolveRoute: guarded, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken(LAUNCH_TOKEN), now: () => 0, log: () => undefined });
      },
      () => undefined,
    );
    const handle = await listenFrontDoor(server);
    const url = `http://127.0.0.1:${String(handle.port)}`;
    // A native launch: no provider header, only the capability and the session id.
    const post = async (model: string, requestClass: string): Promise<number> => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN, [SESSION_HEADER]: "s-native", "x-claude-code-request-class": requestClass },
        body: JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      await response.text();
      return response.status;
    };
    try {
      expect(await post("antigravity/auto", "main")).toBe(HTTP_STATUS.ok);
      // What Claude Code's prompt-hook judge (query source hook_prompt) sends: class auxiliary, a Claude haiku name.
      expect(await post(HAIKU_NAME, "auxiliary")).toBe(HTTP_STATUS.ok);
      expect(toAnthropic).toEqual([]);
      expect(backend.generated).toHaveLength(2);
      expect(backend.generated[1]).toBe(ANTIGRAVITY_DEFAULT_TIER_MODELS.haiku[0]);
    } finally {
      await handle.close();
    }
  });
});
