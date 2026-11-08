import http from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, fakeResponse, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { ANTIGRAVITY_DEFAULT_TIER_MODELS, CODEX_DEFAULT_TIER_MODELS, type ModelsConfig } from "../config/schema";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, inMemoryRouteStore, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createUsageMiddleware } from "../usage/middleware";
import type { UsageRecord } from "../usage/schema";
import { createMainLoopRouteRecord, followingMainLoop, requestClassOf, withModelInHead, type MainLoopRoutePorts, type MainLoopRouteRecord } from "./mainLoopRoute";
import { serveRouted, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER, PROVIDER_HEADER, SESSION_HEADER, type RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import type { FrontDoorLaunch } from "./state";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const LAUNCH_TOKEN = "launch-token-for-tests";
const OWN_PORT = 4100;
/** How many times the multi-byte sample repeats in a body, enough to run on past the head, and where the test splits the body into chunks, chosen to fall inside characters. */
const REPEATS = 50;
const FIRST_SPLIT = 7;
const SECOND_SPLIT = 5;
/** The output budget of an ordinary request, as against a quota check's single token. */
const ORDINARY_MAX_TOKENS = 16;
const HAIKU_NAME = "claude-haiku-5-5";
/** The models the `http` provider's own tier environment names for each tier. */
const Z_HAIKU_MODEL = "glm-4.5-air";
const Z_SONNET_MODEL = "glm-4.7";
const Z_OPUS_MODEL = "glm-5.3-pro";
/** The models an http provider serves per tier, as the tier environment names them. */
const Z_TIER_MODELS = { haiku: Z_HAIKU_MODEL, sonnet: Z_SONNET_MODEL, opus: Z_OPUS_MODEL } as const;

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

/**
 * `resolve` with the Anthropic route replaced by a stand-in: that route is the real API, so a request the door would send there is answered 502 here instead, and its class handed to `reached`, so no test ever leaves the machine and each can assert what reached Anthropic.
 */
function standingInForAnthropic(resolve: (request: RoutedRequest) => Promise<RouteResolution>, reached: (requestClass: string) => void): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    const resolution = await resolve(request);
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
          reached(served.headers["x-claude-code-request-class"]?.toString() ?? "(no class)");
          response.start(HTTP_STATUS.badGateway, { "content-type": "application/json" });
          await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message: "the test's stand-in for the Anthropic route" } }));
          response.end();
        },
      },
    };
  };
}

interface World {
  readonly url: string;
  readonly upstream: { readonly seen: UpstreamSeen[] };
  readonly codexCalls: readonly { readonly init: { readonly body?: string } }[];
  /** The model each generation call the antigravity provider's backend received named. */
  readonly generated: readonly string[];
  readonly records: UsageRecord[];
  /** The class of each request that reached the stand-in for the Anthropic route. */
  readonly toAnthropic: string[];
  readonly close: () => Promise<void>;
}

/** A door serving an `http` provider `z` (whose tier environment maps haiku) and a `codex` provider `cx`, with the usage middleware recording into `records`. */
async function startWorld(
  record: MainLoopRouteRecord = mainLoopRoutesOfLiveSessions(),
  upstreamStatus: number = HTTP_STATUS.ok,
  models?: ModelsConfig,
  zTierEnv: Readonly<Record<string, string>> = { ANTHROPIC_DEFAULT_HAIKU_MODEL: Z_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: Z_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: Z_OPUS_MODEL },
): Promise<World> {
  const upstream = await fakeUpstream(upstreamStatus);
  const gemini = await fakeGeminiBackend();
  const codexFetch = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const codexPorts = codexPortsOver(codexFetch.fetch);
  const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0,
    mainLoopRoutes: record,
    fs: fakeFs({
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] }, env: zTierEnv },
      [`${PROVIDERS_DIR}/ag.json`]: { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "ag-token" }] }, antigravity: { mode: "cloud", cloud: { endpoint: gemini.endpoint } } },
      [`${PROVIDERS_DIR}/cx.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } },

      [`${PROVIDERS_DIR}/r.json`]: { kind: "router", displayName: "Router" },
    }),
    providersDir: PROVIDERS_DIR,
    codexPorts,
    directPort: () => OWN_PORT,
    env: {},
    credentials: fakeAsyncCredentials(),
    ...(models === undefined ? {} : { models: () => models }),
  });
  const records: UsageRecord[] = [];
  const toAnthropic: string[] = [];
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
      await serveRouted(pipelineRequest, { resolveRoute: standingInForAnthropic(resolve, (requestClass) => {
          toAnthropic.push(requestClass);
        }), canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [usage], admit: admitLaunchToken(LAUNCH_TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, upstream, codexCalls: codexFetch.calls, generated: gemini.generated, records, toAnthropic, close: handle.close };
}

/** Sends one Messages request as a launch's child would: its capability, its session id, and, when given, the class Claude Code states and a launch provider. */
async function send(world: World, options: { readonly model: string; readonly session?: string; readonly requestClass?: string; readonly agentId?: string; readonly provider?: string; readonly maxTokens?: number }): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${world.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AUTH_HEADER]: LAUNCH_TOKEN,
      [SESSION_HEADER]: options.session ?? "s-1",
      ...(options.requestClass === undefined ? {} : { "x-claude-code-request-class": options.requestClass }),
      ...(options.agentId === undefined ? {} : { "x-claude-code-agent-id": options.agentId }),
      ...(options.provider === undefined ? {} : { [PROVIDER_HEADER]: options.provider }),
    },
    body: JSON.stringify({ model: options.model, stream: false, max_tokens: options.maxTokens ?? ORDINARY_MAX_TOKENS, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: response.status, text: await response.text() };
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
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("maps a helper of a session whose main loop is on a router provider through the models block's tier pointer", async () => {
    // A qualified name that matches no target stays on the router provider itself (the resolver answers it with the router's passthrough), so a router is a route the record can hold. It is written to the record directly, so no test sends the main request to the passthrough.
    const stored = inMemoryRouteStore();
    stored.write({ pid: 1, startedAt: 1 }, { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored }), HTTP_STATUS.ok, { tiers: { haiku: "z/glm-5.3" } });
    try {
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
    } finally {
      await world.close();
    }
  });

  it("sends a helper to an http provider under its tier variable's model name without the context marker the variable may carry", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, { ANTHROPIC_DEFAULT_HAIKU_MODEL: `${Z_HAIKU_MODEL}[1m]` });
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
    } finally {
      await world.close();
    }
  });

  it("refuses a helper of a router session whose models block has no pointer for the helper's tier, naming the tier and the provider and reaching no upstream", async () => {
    const stored = inMemoryRouteStore();
    stored.write({ pid: 1, startedAt: 1 }, { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored }), HTTP_STATUS.ok, { tiers: { sonnet: "z/glm-4.7" } });
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.badRequest);
      expect(helper.text).toContain("haiku");
      expect(helper.text).toContain('provider \\"r\\"');
      expect(world.upstream.seen).toEqual([]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("records a router provider as the route of a main request whose qualified name matches no target, resolving it without serving it", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: record, fs: fakeFs({ [`${PROVIDERS_DIR}/r.json`]: { kind: "router", displayName: "Router" } }), providersDir: PROVIDERS_DIR, codexPorts: unusedCodexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials() });
    const resolution = await resolve({ method: "POST", url: "/v1/messages", headers: { "x-claude-code-request-class": "main" }, body: Readable.from([Buffer.from(JSON.stringify({ model: "r/anything", messages: [] }))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s-1", provider: undefined, headroom: false, projectId: undefined } });
    expect(resolution.ok && resolution.route.name).toBe("router:r");
    expect(record.routeOf("s-1")).toEqual({ kind: "provider", provider: "r" });
  });

  it("sends the helpers back to the Anthropic route once the main loop returns there", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      // `/model` back to a Claude model: the main loop is on Anthropic again, and the helper after it follows.
      await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual(["main", "auxiliary"]);
    } finally {
      await world.close();
    }
  });

  it("sends a helper request from a session with no main-loop request yet down the route the session was launched on", async () => {
    const world = await startWorld();
    try {
      // The shape of Claude Code's startup quota check: class auxiliary, a Claude haiku name, one output token, ahead of the first main-loop request.
      const quota = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", maxTokens: 1 });
      expect(quota.status).toBe(HTTP_STATUS.badGateway);
      expect(world.toAnthropic).toEqual(["auxiliary"]);
      expect(world.upstream.seen).toEqual([]);
      expect(world.codexCalls).toEqual([]);
      // The helper recorded nothing: the main loop still decides where the next helper goes.
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual(["auxiliary"]);
    } finally {
      await world.close();
    }
  });

  it("keeps a session's helpers on its provider across a door restart, a subagent included", async () => {
    const stored = inMemoryRouteStore();
    const ports = { launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored };
    const first = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(first, { model: "z/glm-5.3", requestClass: "main" });
    } finally {
      await first.close();
    }
    // The replacement door has the registry directory and nothing else.
    const second = await startWorld(createMainLoopRouteRecord(ports));
    try {
      expect((await send(second, { model: HAIKU_NAME, requestClass: "subagent" })).status).toBe(HTTP_STATUS.ok);
      expect(second.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL]);
      expect(second.toAnthropic).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("fails a helper naming the provider when the provider its main loop was on is no longer defined", async () => {
    const stored = inMemoryRouteStore();
    stored.write({ pid: 1, startedAt: 1 }, { kind: "provider", provider: "removed" });
    const world = await startWorld(createMainLoopRouteRecord({ launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored }));
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.notFound);
      expect(helper.text).toContain('no provider named \\"removed\\"');
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("leaves a session launched on a provider routing by its launch header, helpers included", async () => {
    const record = mainLoopRoutesOfLiveSessions();
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
      // A session that has recorded nothing is still on its launch's route.
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-c" })).status).toBe(HTTP_STATUS.badGateway);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
    } finally {
      await world.close();
    }
  });

  it("records the request class and the requested model in the usage log, on an error response too", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.tooManyRequests);
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

/** Every Claude name a subagent asks for, with the tier it selects: the versioned names and the unversioned family names. */
const CLAUDE_NAMES = [
  ["claude-opus-5-5", "opus"],
  ["opus", "opus"],
  ["claude-sonnet-5-5", "sonnet"],
  ["sonnet", "sonnet"],
  ["claude-haiku-5-5", "haiku"],
  ["haiku", "haiku"],
] as const;
const AGENT_CLASSES = ["subagent", "workflow"] as const;
/** One case per class and Claude name. */
const SUBAGENT_CASES = AGENT_CLASSES.flatMap((requestClass) => CLAUDE_NAMES.map(([name, tier]) => ({ requestClass, name, tier })));

describe("a subagent or workflow request follows the provider its main loop is on, under that provider's tier mapping", () => {
  it.each(SUBAGENT_CASES)("on an http provider: $requestClass asking for $name is served as the provider's $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_TIER_MODELS[tier]]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on a codex provider: $requestClass asking for $name is served as the codex $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "cx/gpt-5.6", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS[tier]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on an antigravity provider: $requestClass asking for $name is served as the antigravity $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "ag/auto", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.generated).toHaveLength(2);
      expect(world.generated[1]).toBe(ANTIGRAVITY_DEFAULT_TIER_MODELS[tier][0]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on a router provider: $requestClass asking for $name goes through the models block's $tier pointer", async ({ requestClass, name, tier }) => {
    const stored = inMemoryRouteStore();
    stored.write({ pid: 1, startedAt: 1 }, { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored }), HTTP_STATUS.ok, { tiers: { haiku: "z/glm-5.3-haiku", sonnet: "z/glm-5.3-sonnet", opus: "z/glm-5.3-opus" } });
    try {
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([`glm-5.3-${tier}`]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(AGENT_CLASSES)("leaves a %s that inherits the main model, and so arrives with its qualified name, exactly as it is", async (requestClass) => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "z/glm-5.3", requestClass })).status).toBe(HTTP_STATUS.ok);
      // The same name as the main loop, not a tier-mapped one.
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "glm-5.3"]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(AGENT_CLASSES)("sends a %s of a session whose main loop is on Anthropic to Anthropic, whatever Claude name it asks for", async (requestClass) => {
    const world = await startWorld();
    try {
      await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      await send(world, { model: "claude-sonnet-5-5", requestClass });
      await send(world, { model: HAIKU_NAME, requestClass });
      expect(world.toAnthropic).toEqual(["main", requestClass, requestClass]);
      expect(world.upstream.seen).toEqual([]);
      expect(world.codexCalls).toEqual([]);
      expect(world.generated).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("keeps a subagent across a door restart on the provider, asking for any tier", async () => {
    const stored = inMemoryRouteStore();
    const ports = { launchOfSession: () => ({ pid: 1, startedAt: 1 }), holdsLaunch: () => true, stored };
    const first = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(first, { model: "z/glm-5.3", requestClass: "main" });
    } finally {
      await first.close();
    }
    const second = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(second, { model: "claude-opus-5-5", requestClass: "subagent" });
      await send(second, { model: "claude-sonnet-5-5", requestClass: "workflow" });
      expect(second.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL, Z_SONNET_MODEL]);
      expect(second.toAnthropic).toEqual([]);
    } finally {
      await second.close();
    }
  });
});

describe("a session launched before the class header was asked for", () => {
  it("sends a request carrying only an agent id, which Claude Code attaches to every non-main agent's request whatever the header setting, to the main loop's provider", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      expect((await send(world, { model: "claude-opus-5-5", agentId: "agent-1" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_OPUS_MODEL]);
      expect(world.toAnthropic).toEqual([]);
      // The agent's request did not move the main loop: a request with neither header is still the main loop's.
      expect((await send(world, { model: "z/glm-5.3" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_OPUS_MODEL, "glm-5.3"]);
    } finally {
      await world.close();
    }
  });

  it("still counts a request with neither header as the main loop, which re-points the record", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      await send(world, { model: "claude-opus-5-5" });
      await send(world, { model: "claude-sonnet-5-5", agentId: "agent-1" });
      expect(world.toAnthropic).toEqual(["(no class)", "(no class)"]);
    } finally {
      await world.close();
    }
  });
});

describe("the main-loop route record", () => {
  /** A registry whose launches the test starts and ends, each by session id. */
  function registryOf(stored: MainLoopRoutePorts["stored"] = inMemoryRouteStore()): MainLoopRoutePorts & { readonly start: (sessionId: string, startedAt: number) => void; readonly end: (sessionId: string) => void } {
    const launches = new Map<string, FrontDoorLaunch>();
    return {
      stored,
      launchOfSession: (sessionId) => launches.get(sessionId),
      holdsLaunch: (launch) => [...launches.values()].some((held) => held.pid === launch.pid && held.startedAt === launch.startedAt),
      start: (sessionId, startedAt) => {
        launches.set(sessionId, { pid: launches.size + 1, startedAt });
      },
      end: (sessionId) => {
        launches.delete(sessionId);
      },
    };
  }

  it("lives as long as the launch, dropping an ended launch's entry on any write", () => {
    const registry = registryOf();
    const record = createMainLoopRouteRecord(registry);
    registry.start("s-a", 1);
    registry.start("s-b", 1);
    record.record("s-a", { kind: "provider", provider: "z" });
    record.record("s-b", { kind: "anthropic" });
    registry.end("s-a");
    expect(record.routeOf("s-a")).toBeUndefined();
    // A write by another launch drops the ended launch's entry: it does not come back with a launch that carries the same id.
    record.record("s-b", { kind: "provider", provider: "z" });
    registry.start("s-a", 2);
    expect(record.routeOf("s-a")).toBeUndefined();
    expect(record.routeOf("s-b")).toEqual({ kind: "provider", provider: "z" });
  });

  it("drops an ended launch's entry on a write by another launch, so the same launch registered again finds nothing in memory", () => {
    // The durable copy answers nothing, so only the in-memory entry can say what was recorded; the launch is identical (pid and start time) when it is registered again, so the one thing that can make the second read empty is the eviction.
    const launch: FrontDoorLaunch = { pid: 1, startedAt: 1 };
    const other: FrontDoorLaunch = { pid: 2, startedAt: 1 };
    const live = new Set<FrontDoorLaunch>([launch, other]);
    const bySession = new Map<string, FrontDoorLaunch>([
      ["s-a", launch],
      ["s-b", other],
    ]);
    const record = createMainLoopRouteRecord({
      launchOfSession: (sessionId) => bySession.get(sessionId),
      holdsLaunch: (held) => live.has(held),
      stored: { read: () => undefined, write: () => undefined },
    });
    record.record("s-a", { kind: "provider", provider: "z" });
    expect(record.routeOf("s-a")).toEqual({ kind: "provider", provider: "z" });
    live.delete(launch);
    record.record("s-b", { kind: "anthropic" });
    live.add(launch);
    expect(record.routeOf("s-a")).toBeUndefined();
    expect(record.routeOf("s-b")).toEqual({ kind: "anthropic" });
  });

  it("gives a launch that reuses an ended launch's session id nothing recorded, though nothing read or wrote between the two", () => {
    const registry = registryOf();
    const record = createMainLoopRouteRecord(registry);
    registry.start("s-resumed", 1);
    record.record("s-resumed", { kind: "provider", provider: "z" });
    // The launch ends and a --resume registers under the same session id with no record read or write between.
    registry.end("s-resumed");
    registry.start("s-resumed", 2);
    expect(record.routeOf("s-resumed")).toBeUndefined();
  });

  it("is found again by a record built later over the same store, as after a door restart, and by that launch only", () => {
    const stored = inMemoryRouteStore();
    const before = registryOf(stored);
    before.start("s-a", 1);
    createMainLoopRouteRecord(before).record("s-a", { kind: "provider", provider: "z" });
    // A new door process: nothing in memory, the registry still holds the launch.
    const after = registryOf(stored);
    after.start("s-a", 1);
    after.start("s-relaunched", 2);
    const restarted = createMainLoopRouteRecord(after);
    expect(restarted.routeOf("s-a")).toEqual({ kind: "provider", provider: "z" });
    expect(restarted.routeOf("s-relaunched")).toBeUndefined();
  });

  it("writes the store only when the route changes", () => {
    const writes: string[] = [];
    const base = inMemoryRouteStore();
    const registry = registryOf({
      read: base.read,
      write: (launch, route) => {
        writes.push(route.kind === "provider" ? route.provider : route.kind);
        base.write(launch, route);
      },
    });
    registry.start("s-a", 1);
    const record = createMainLoopRouteRecord(registry);
    record.record("s-a", { kind: "provider", provider: "z" });
    record.record("s-a", { kind: "provider", provider: "z" });
    record.record("s-a", { kind: "anthropic" });
    record.record("s-a", { kind: "anthropic" });
    expect(writes).toEqual(["z", "anthropic"]);
  });

  it("records nothing for a session id no live launch carries", () => {
    const registry = registryOf();
    const record = createMainLoopRouteRecord(registry);
    record.record("s-unregistered", { kind: "provider", provider: "z" });
    registry.start("s-unregistered", 1);
    expect(record.routeOf("s-unregistered")).toBeUndefined();
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
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: fakeFs({ [`${PROVIDERS_DIR}/antigravity.json`]: { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "ag-token" }] }, antigravity: { mode: "cloud", cloud: { endpoint: backend.endpoint } } } }),
      providersDir: PROVIDERS_DIR,
      codexPorts: unusedCodexPorts(),
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const toAnthropic: string[] = [];
    const guarded = standingInForAnthropic(resolveRoute, (requestClass) => {
      toAnthropic.push(requestClass);
    });
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
        body: JSON.stringify({ model, stream: true, max_tokens: ORDINARY_MAX_TOKENS, messages: [{ role: "user", content: "hi" }] }),
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

describe("the request class header", () => {
  it("is read whatever the header's case, and only the classes Claude Code sends are kept", () => {
    expect(requestClassOf({})).toBeUndefined();
    expect(requestClassOf({ "x-claude-code-request-class": "auxiliary" })).toBe("auxiliary");
    expect(requestClassOf({ "X-Claude-Code-Request-Class": "side_reply" })).toBe("side_reply");
    expect(requestClassOf({ "x-claude-code-request-class": "something-new" })).toBe("unknown");
    expect(requestClassOf({ "x-claude-code-request-class": "" })).toBe("unknown");
  });

  it("is subagent for a request that names no class but carries an agent id, the one signal of a subagent a launch not asked for the class header still sends, and the stated class wins over it", () => {
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1" })).toBe("subagent");
    expect(requestClassOf({ "X-Claude-Code-Agent-Id": "agent-1" })).toBe("subagent");
    expect(requestClassOf({ "x-claude-code-agent-id": "" })).toBeUndefined();
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "main" })).toBe("main");
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "workflow" })).toBe("workflow");
  });

  it("is unknown for a header sent twice, which Node joins into one string, and never carries the client's own text", () => {
    expect(requestClassOf({ "x-claude-code-request-class": "main, main" })).toBe("unknown");
    expect(requestClassOf({ "x-claude-code-request-class": ["main", "main"] })).toBe("unknown");
  });
});

describe("followingMainLoop over a resolver that records what it is asked", () => {
  /** A resolver that answers `ok` for any request, serving it from the route its path scopes (a bare path being Anthropic), and records the urls it was asked about. */
  function fixture(refuseMain = false): { readonly follow: (url: string, requestClass: string | undefined, session?: string) => Promise<RouteResolution>; readonly asked: string[]; readonly record: MainLoopRouteRecord } {
    const asked: string[] = [];
    const record = mainLoopRoutesOfLiveSessions();
    const resolve = async (request: RoutedRequest): Promise<RouteResolution> => {
      asked.push(request.url);
      if (refuseMain && request.headers["x-claude-code-request-class"] === "main") {
        return Promise.resolve({ ok: false, status: HTTP_STATUS.notFound, message: "refused" });
      }
      return Promise.resolve({ ok: true, route: { name: "stand-in", headroomEligible: false, headroomUpstream: undefined, serve: async () => Promise.resolve() } });
    };
    const follow = async (url: string, requestClass: string | undefined, session = "s-1"): Promise<RouteResolution> =>
      await followingMainLoop(resolve, { record, helperModel: () => ({ kind: "as-is" }) })({
        method: "POST",
        url,
        headers: requestClass === undefined ? {} : { "x-claude-code-request-class": requestClass },
        body: Readable.from([Buffer.from(JSON.stringify({ model: HAIKU_NAME, messages: [] }))]),
        signal: new AbortController().signal,
        session: { identity: undefined, sessionId: session, provider: undefined, headroom: false, projectId: undefined },
      });
    return { follow, asked, record };
  }

  it("leaves a main request refused by the resolver out of the record", async () => {
    const { follow, record } = fixture(true);
    record.record("s-1", { kind: "provider", provider: "z" });
    expect((await follow("/v1/messages", "main")).ok).toBe(false);
    expect(record.routeOf("s-1")).toEqual({ kind: "provider", provider: "z" });
  });

  it("records a request with no class header as a main request, so a launch that was not asked for the header behaves as every request main", async () => {
    const { follow, record } = fixture();
    record.record("s-1", { kind: "provider", provider: "z" });
    await follow("/v1/messages", undefined);
    expect(record.routeOf("s-1")).toEqual({ kind: "anthropic" });
  });

  it("sends a helper whose class is not one Claude Code sends where the main loop is, as it does any other helper", async () => {
    const { follow, asked, record } = fixture();
    record.record("s-1", { kind: "provider", provider: "z" });
    await follow("/v1/messages", "main, main");
    expect(asked).toEqual(["/providers/z/v1/messages"]);
  });

  it("scopes a count_tokens helper under the provider too, and leaves a path that is no inference call alone", async () => {
    const { follow, asked, record } = fixture();
    record.record("s-1", { kind: "provider", provider: "z" });
    await follow("/v1/messages/count_tokens?beta=true", "auxiliary");
    await follow("/v1/models", "auxiliary");
    expect(asked).toEqual(["/providers/z/v1/messages/count_tokens?beta=true", "/v1/models"]);
  });
});

describe("rewriting the model field in a body's head", () => {
  /** The bytes the rewrite of `chunks` produces, read whole. */
  async function rewrittenBytes(chunks: readonly Buffer[], headBytes: number, from: string, to: string): Promise<Buffer> {
    const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: { "content-length": "1" }, body: Readable.from(chunks), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
    const rewritten = withModelInHead(request, headBytes, from, to);
    expect(rewritten.headers).not.toHaveProperty("content-length");
    const out: Buffer[] = [];
    for await (const chunk of rewritten.body) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("the rewritten body emitted something other than a Buffer");
      }
      out.push(chunk);
    }
    return Buffer.concat(out);
  }

  it("rewrites a model key written with whitespace before its colon, as the scan finds it", async () => {
    const body = Buffer.from('{"model" : "' + HAIKU_NAME + '", "messages": []}', "utf8");
    const out = await rewrittenBytes([body], body.length, HAIKU_NAME, "glm-4.5-air");
    expect(out.toString("utf8")).toBe('{"model":"glm-4.5-air", "messages": []}');
  });

  it("changes only the model field and leaves a multi-byte character split across the head's end, and everything after, byte for byte", async () => {
    const body = Buffer.from(JSON.stringify({ model: HAIKU_NAME, messages: [{ role: "user", content: "日本語の会話🙂".repeat(REPEATS) }] }), "utf8");
    // The head ends inside a three-byte character, and the chunks split the body at other odd places too.
    const headBytes = body.indexOf(Buffer.from("日")) + 1;
    const chunks = [body.subarray(0, FIRST_SPLIT), body.subarray(FIRST_SPLIT, headBytes), body.subarray(headBytes, headBytes + SECOND_SPLIT), body.subarray(headBytes + SECOND_SPLIT)];
    const out = await rewrittenBytes(chunks, headBytes, HAIKU_NAME, "glm-4.5-air");
    expect(out.toString("utf8")).toBe(body.toString("utf8").replace(`"model":"${HAIKU_NAME}"`, '"model":"glm-4.5-air"'));
  });
});
