import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, fakeResponse, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { type ModelsConfig } from "../config/schema";
import { realCatalogueFetch } from "../realCatalogueRefresh";
import { FAKE_HOME, editableFakeFs, fakeAsyncCredentials, followsLaunchFlag, launchOf, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createUsageMiddleware } from "../usage/middleware";
import type { UsageRecord } from "../usage/schema";
import { type MainLoopRouteRecord } from "./mainLoopRoute";
import { serveRouted, type PipelineDeps, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER, IDENTITY_HEADER, PROVIDER_HEADER, SESSION_HEADER, type RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import type { FrontDoorLaunch } from "./state";

export const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const LAUNCH_TOKEN = "launch-token-for-tests";
/** The capability the launch of the session labelled `session` holds in these tests: one launch per session label, whatever its session id says. */
export function tokenOf(session: string): string {
  return `${LAUNCH_TOKEN}:${session}`;
}
/** Admits a request presenting any `tokenOf` capability as the launch that capability stands for. */
export const admitLaunchPerSession: PipelineDeps["admit"] = (admission) => {
  const presented = admission.headers[AUTH_HEADER];
  return typeof presented === "string" && presented.startsWith(`${LAUNCH_TOKEN}:`) ? { ok: true, headers: { ...admission.forwardable }, launch: launchOf(presented) } : { ok: false, message: "no live capability" };
};
/** The launch holding the capability of `tokenOf(session)`. */
export function launchOfSession(session: string): FrontDoorLaunch {
  return launchOf(tokenOf(session));
}
export const OWN_PORT = 4100;
/** How many times the multi-byte sample repeats in a body, enough to run on past the head, and where the test splits the body into chunks, chosen to fall inside characters. */
export const REPEATS = 50;
export const FIRST_SPLIT = 7;
export const SECOND_SPLIT = 5;
/** The output budget of an ordinary request, as against a quota check's single token. */
export const ORDINARY_MAX_TOKENS = 16;
export const HAIKU_NAME = "claude-haiku-5-5";
/** The models the `http` provider's own tier environment names for each tier. */
export const Z_HAIKU_MODEL = "glm-4.5-air";
export const Z_SONNET_MODEL = "glm-4.7";
export const Z_OPUS_MODEL = "glm-5.3-pro";
/** The one model the stand-in upstream lists on `GET /v1/models`, which the model `auto` follows. */
export const LIVE_SERVED_MODEL = "live-served-model";
/** The models an http provider serves per tier, as the tier environment names them. */
export const Z_TIER_MODELS = { haiku: Z_HAIKU_MODEL, sonnet: Z_SONNET_MODEL, opus: Z_OPUS_MODEL } as const;

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

/** The model recorded for a request whose body is not JSON, so a test that corrupts a body fails on its assertion at once. */
const UNPARSEABLE_BODY = "(the body was not JSON)";

/** An Anthropic-compatible upstream that records each request's path and model, answering `status`, and answering 400 to a body that is not JSON. */
async function fakeUpstream(status: number = HTTP_STATUS.ok): Promise<{ readonly port: number; readonly seen: UpstreamSeen[]; readonly serveOnly: (model: string | undefined) => void }> {
  const seen: UpstreamSeen[] = [];
  // The one model the server serves when a test sets it: its list names it and a request for any other is answered as an unknown model; unset, the list names `LIVE_SERVED_MODEL` and every request is served.
  let only: string | undefined;
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (incoming.method === "GET" && incoming.url === "/v1/models") {
        response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: only ?? LIVE_SERVED_MODEL }] }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        seen.push({ url: incoming.url ?? "", model: UNPARSEABLE_BODY });
        response.writeHead(HTTP_STATUS.badRequest, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      seen.push({ url: incoming.url ?? "", model: typeof parsed === "object" && parsed !== null && "model" in parsed ? parsed.model : undefined });
      if (only !== undefined && typeof parsed === "object" && parsed !== null && "model" in parsed && parsed.model !== only) {
        response.writeHead(HTTP_STATUS.notFound, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `The model \`${String(parsed.model)}\` does not exist.` } }));
        return;
      }
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
  return { port: (address satisfies AddressInfo).port, seen, serveOnly: (model) => { only = model; } };
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
export function unusedCodexPorts(): Omit<CodexRoutePorts, "loadProvider"> {
  return codexPortsOver(
    recordingFetch(() => {
      throw new Error("this world has no codex provider");
    }).fetch,
  );
}

/**
 * `resolve` with the Anthropic route replaced by a stand-in: that route is the real API, so a request the door would send there is answered 502 here instead, and its class handed to `reached`, so no test ever leaves the machine and each can assert what reached Anthropic.
 */
export function standingInForAnthropic(resolve: (request: RoutedRequest) => Promise<RouteResolution>, reached: (requestClass: string, model: string | undefined) => void): (request: RoutedRequest) => Promise<RouteResolution> {
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
          const chunks: Buffer[] = [];
          // What the route would send is the request the resolution names when it rewrote the original, whose own body the scan has already read.
          for await (const chunk of (resolution.request ?? served).body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          reached(served.headers["x-claude-code-request-class"]?.toString() ?? "(no class)", typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined);
          response.start(HTTP_STATUS.badGateway, { "content-type": "application/json" });
          await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message: "the test's stand-in for the Anthropic route" } }));
          response.end();
        },
      },
    };
  };
}

export interface World {
  readonly url: string;
  readonly upstream: { readonly seen: UpstreamSeen[]; readonly serveOnly: (model: string | undefined) => void };
  /** The port of the `http` provider `z`'s upstream, for a test that rewrites the provider's file. */
  readonly upstreamPort: number;
  readonly codexCalls: readonly { readonly init: { readonly body?: string } }[];
  /** The model each generation call the antigravity provider's backend received named. */
  readonly generated: readonly string[];
  readonly records: UsageRecord[];
  /** The model name each request that reached the stand-in for the Anthropic route carried, in order. */
  readonly anthropicModels: (string | undefined)[];
  /** The class of each request that reached the stand-in for the Anthropic route. */
  readonly toAnthropic: string[];
  /** Replaces a provider's file between two requests, as a person editing it does. */
  readonly setProvider: (name: string, definition: unknown) => void;
  readonly close: () => Promise<void>;
}

/** The ports the door reads the models the providers serve through. */
export type ModelPorts = Readonly<Pick<Parameters<typeof createProviderRouteResolver>[0], "targets" | "catalogueModelsOf" | "catalogueFetch" | "selectorState">>;

/** A door serving an `http` provider `z` (whose tier environment maps haiku) and a `codex` provider `cx`, with the usage middleware recording into `records`. */
export async function startWorld(
  record: MainLoopRouteRecord = mainLoopRoutesOfLiveSessions(),
  upstreamStatus: number = HTTP_STATUS.ok,
  models?: ModelsConfig,
  zTierEnv: Readonly<Record<string, string>> = { ANTHROPIC_DEFAULT_HAIKU_MODEL: Z_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: Z_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: Z_OPUS_MODEL },
  admit: PipelineDeps["admit"] = admitLaunchPerSession,
  /** The ports the door reads the models the providers serve through, for a test that counts or steers what is read. */
  modelPorts: ModelPorts = {},
): Promise<World> {
  const upstream = await fakeUpstream(upstreamStatus);
  const gemini = await fakeGeminiBackend();
  const codexFetch = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const codexPorts = codexPortsOver(codexFetch.fetch);
  const providerFs = editableFakeFs({
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] }, env: zTierEnv },
      [`${PROVIDERS_DIR}/ag.json`]: { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "ag-token" }] }, antigravity: { mode: "cloud", cloud: { endpoint: gemini.endpoint } } },
      [`${PROVIDERS_DIR}/cx.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } },

      [`${PROVIDERS_DIR}/r.json`]: { kind: "router", displayName: "Router" },
      // A provider whose `routes` hand every request on to `z`: its resolution scans the request again, after the name-resolving scan has read the name the client sent.
      [`${PROVIDERS_DIR}/m.json`]: { displayName: "M", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "m-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*" } }, provider: "z" }] },
      // A provider file that is no valid provider: a helper whose main loop was recorded on it reaches the routing loop's own refusal.
      [`${PROVIDERS_DIR}/bad.json`]: { displayName: 5 },
  });
  const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0,
    mainLoopRoutes: record,
    fs: providerFs.fs,
    providersDir: PROVIDERS_DIR,
    codexPorts,
    directPort: () => OWN_PORT,
    env: {},
    credentials: fakeAsyncCredentials(),
    catalogueFetch: realCatalogueFetch,
    ...(models === undefined ? {} : { models: () => models }),
    ...modelPorts,
  });
  const records: UsageRecord[] = [];
  const toAnthropic: string[] = [];
  const anthropicModels: (string | undefined)[] = [];
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
      await serveRouted(pipelineRequest, { resolveRoute: standingInForAnthropic(resolve, (requestClass, model) => {
          toAnthropic.push(requestClass);
          anthropicModels.push(model);
        }), canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [usage], admit, now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, upstream, upstreamPort: upstream.port, codexCalls: codexFetch.calls, generated: gemini.generated, records, toAnthropic, anthropicModels, setProvider: (name, definition) => {
      providerFs.set(`${PROVIDERS_DIR}/${name}.json`, definition);
    }, close: handle.close };
}

/** Sends one Messages request as a launch's child would: its capability, its session id, and, when given, the class Claude Code states and a launch provider. */
export async function send(world: World, options: { readonly model: string; /** The body as sent, instead of one built from `model`: for a request with no model field or a body that is no JSON. */ readonly rawBody?: string; readonly session?: string; readonly token?: string; readonly requestClass?: string; readonly agentId?: string; readonly provider?: string; readonly maxTokens?: number; /** The identity the launch resolved, as the launcher names it. */ readonly identity?: string }): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${world.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AUTH_HEADER]: options.token ?? tokenOf(options.session ?? "s-1"),
      [SESSION_HEADER]: options.session ?? "s-1",
      ...(options.requestClass === undefined ? {} : { "x-claude-code-request-class": options.requestClass }),
      ...(options.agentId === undefined ? {} : { "x-claude-code-agent-id": options.agentId }),
      ...(options.provider === undefined ? {} : { [PROVIDER_HEADER]: options.provider }),
      ...(options.identity === undefined ? {} : { [IDENTITY_HEADER]: options.identity }),
    },
    body: options.rawBody ?? JSON.stringify({ model: options.model, stream: false, max_tokens: options.maxTokens ?? ORDINARY_MAX_TOKENS, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: response.status, text: await response.text() };
}

/** Sends one Messages request as a client that ignores the proxy would: only the capability the connection authenticated with, no session header and no provider. */
export async function sendBare(world: World, options: { readonly model: string; readonly requestClass: string }, token: string): Promise<{ readonly status: number }> {
  const response = await fetch(`${world.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", [AUTH_HEADER]: token, "x-claude-code-request-class": options.requestClass },
    body: JSON.stringify({ model: options.model, stream: false, max_tokens: ORDINARY_MAX_TOKENS, messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();
  return { status: response.status };
}

/** The model the codex translator sent its backend on its `index`th call. */
export function codexModel(world: World, index: number): unknown {
  const body = world.codexCalls[index]?.init.body;
  const parsed: unknown = body === undefined ? undefined : JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "model" in parsed ? parsed.model : undefined;
}


/** A Gemini-shaped streaming backend standing in for the antigravity provider's cloud endpoint: it records the model each generation call names in its path, and answers one complete text chunk. */
export async function fakeGeminiBackend(): Promise<{ readonly endpoint: string; readonly generated: string[] }> {
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
