import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import type { ModelsConfig } from "../config/schema";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, type RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const OWN_PORT = 4100;
const TOKEN = "launch-token-for-tests";

/** What the stand-in provider saw of one POST. */
interface SeenPost {
  readonly body: string;
  readonly url: string;
}

/** A stand-in for an Anthropic-compatible server that serves one model at a time: `GET /v1/models` lists it, `POST /v1/messages` answers 404 for any other model name and 400 `input_schema: Field required` for a tool with no `input_schema`, as vLLM does. */
interface StandIn {
  readonly baseUrl: string;
  /** Swaps the model the server serves, as a controller loading another one does. */
  readonly serve: (model: string | undefined) => void;
  /** Makes every POST answer as the given failure (`overflow`: a 400 whose message mentions the model but is a context overflow; `missing`: a 404 naming the model as absent whatever it is), or as normal when undefined. */
  readonly fail: (kind: "overflow" | "missing" | undefined) => void;
  readonly posts: () => readonly SeenPost[];
  readonly lists: () => number;
}

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

async function standIn(initial: string | undefined): Promise<StandIn> {
  let served = initial;
  let failure: "overflow" | "missing" | undefined;
  let lists = 0;
  const posts: SeenPost[] = [];
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (incoming.method === "GET" && incoming.url === "/v1/models") {
        lists += 1;
        send(HTTP_STATUS.ok, { data: served === undefined ? [] : [{ id: served }] });
        return;
      }
      posts.push({ body, url: incoming.url ?? "" });
      if (failure === "overflow") {
        send(HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "This model's maximum context length is 100 tokens, however you requested 200 tokens" } });
        return;
      }
      if (failure === "missing") {
        send(HTTP_STATUS.notFound, { type: "error", error: { type: "not_found_error", message: "The model `anything` does not exist." } });
        return;
      }
      const parsed = parseSent(body);
      const missing = parsed.tools?.findIndex((tool) => tool.input_schema === undefined) ?? -1;
      if (missing >= 0) {
        send(HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: `body.tools.${String(missing)}.input_schema: Field required` } });
        return;
      }
      if (parsed.model !== served) {
        send(HTTP_STATUS.notFound, { type: "error", error: { type: "not_found_error", message: `The model \`${String(parsed.model)}\` does not exist.` } });
        return;
      }
      send(HTTP_STATUS.ok, { ok: true });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stand-in has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`,
    serve: (model) => {
      served = model;
    },
    fail: (kind) => {
      failure = kind;
    },
    posts: () => posts,
    lists: () => lists,
  };
}

/** The fields of a request body the stand-in and the assertions read. */
interface Sent {
  readonly model?: unknown;
  readonly tool_choice?: unknown;
  readonly tools?: readonly { readonly input_schema?: unknown }[];
  readonly error?: { readonly message?: unknown };
}

/** Parses a body the tests themselves built or a stand-in answered, which is always JSON. */
function parseSent(text: string): Sent {
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`not a JSON object: ${text}`);
  }
  return parsed;
}

/** The model each recorded POST carried. */
function modelsSeen(upstream: StandIn): readonly unknown[] {
  return upstream.posts().map((seen) => parseSent(seen.body).model);
}

function codexPorts(): Omit<CodexRoutePorts, "loadProvider"> {
  const fetch = recordingFetch(() => {
    throw new Error("these tests never answer an upstream call");
  });
  return {
    upstreams: sameUpstreamForEveryLogin({ fetch: fetch.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }),
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
}

const httpFile = (baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ displayName: "Stand-in", baseUrl, credential: { sources: [{ literal: "stand-in-token" }] }, ...extra });
const codexFile = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };
const antigravityFile = (antigravity?: Record<string, unknown>): Record<string, unknown> => ({ kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "placeholder" }] }, ...(antigravity === undefined ? {} : { antigravity }) });
const routerFile = { kind: "router", displayName: "Router" };

function resolverOver(files: Record<string, unknown>, options: { readonly fs?: (base: ReturnType<typeof fakeFs>) => ReturnType<typeof fakeFs>; readonly models?: ModelsConfig; readonly targets?: readonly string[]; readonly log?: (message: string) => void; readonly catalogue?: readonly { readonly id: string }[] } = {}): ReturnType<typeof createProviderRouteResolver> {
  const entries = Object.fromEntries(Object.entries(files).map(([name, file]) => [`${PROVIDERS_DIR}/${name}.json`, file]));
  return createProviderRouteResolver({
    fs: options.fs === undefined ? fakeFs(entries) : options.fs(fakeFs(entries)),
    providersDir: PROVIDERS_DIR,
    codexPorts: codexPorts(),
    directPort: () => OWN_PORT,
    env: {},
    credentials: fakeAsyncCredentials(),
    ...(options.models === undefined ? {} : { models: () => options.models }),
    ...(options.targets === undefined ? {} : { targets: () => options.targets ?? [] }),
    log: options.log ?? (() => undefined),
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
    ...(options.catalogue === undefined ? {} : { catalogueModelsOf: () => options.catalogue ?? [] }),
  });
}

/** A door serving what the resolver resolves, admitted by a fixed launch token. */
async function startDoor(resolve: ReturnType<typeof createProviderRouteResolver>): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken(TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
}

async function post(door: { readonly url: string }, path: string, body: unknown): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${door.url}${path}`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: TOKEN }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

const messages = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...extra });

function resolverRequest(model: string, provider?: string): RoutedRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: {},
    body: Readable.from([Buffer.from(JSON.stringify(messages(model)))]),
    signal: new AbortController().signal,
    session: { identity: undefined, sessionId: "s-1", provider, headroom: false, projectId: undefined },
  };
}

async function bodyOf(request: RoutedRequest | undefined): Promise<Sent> {
  const chunks: Buffer[] = [];
  for await (const chunk of request?.body ?? []) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return parseSent(Buffer.concat(chunks).toString("utf8"));
}

describe("a bare provider name selects that provider's default model on any session", () => {
  it("routes to the model an http provider's main tier names, from a provider-less session", async () => {
    const upstream = await standIn("tier-model");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "tier-model", ANTHROPIC_DEFAULT_OPUS_MODEL: "other" } }) }));
    try {
      const answered = await post(door, "/v1/messages", messages("spark"));
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["tier-model"]);
    } finally {
      await door.close();
    }
  });

  it("falls back to the Opus then Haiku tier entry when Sonnet is unset", async () => {
    const upstream = await standIn("haiku-model");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-model" } }) }));
    try {
      expect((await post(door, "/v1/messages", messages("spark"))).status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["haiku-model"]);
    } finally {
      await door.close();
    }
  });

  it("falls back to the first model of the provider's cached catalogue when it names no tier model", async () => {
    const upstream = await standIn("qwen3.8-27b");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }, { catalogue: [{ id: "qwen3.8-27b" }, { id: "second" }] }));
    try {
      expect((await post(door, "/v1/messages", messages("spark"))).status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["qwen3.8-27b"]);
      expect(upstream.lists()).toBe(0);
    } finally {
      await door.close();
    }
  });

  it("takes the provider's main tier model over its cached catalogue's first entry", async () => {
    const upstream = await standIn("tier-model");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "tier-model" } }) }, { catalogue: [{ id: "catalogue-first" }] }));
    try {
      expect((await post(door, "/v1/messages", messages("spark"))).status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["tier-model"]);
    } finally {
      await door.close();
    }
  });

  it("selects a codex provider's configured default model, or the shipped one", async () => {
    const configured = await resolverOver({ cx: { ...codexFile, codex: { defaultModel: "gpt-test" } } })(resolverRequest("cx"));
    if (!configured.ok) throw new Error(configured.message);
    expect(configured.request?.url).toContain("/providers/cx/v1/messages");
    expect((await bodyOf(configured.request)).model).toBe("gpt-test");
    const shipped = await resolverOver({ cx: codexFile })(resolverRequest("cx"));
    if (!shipped.ok) throw new Error(shipped.message);
    expect((await bodyOf(shipped.request)).model).toBe("gpt-5.6-sol");
  });

  it("selects an antigravity provider's configured default model, or its auto alias", async () => {
    const configured = await resolverOver({ agy: antigravityFile({ defaultModel: "gemini-test" }) })(resolverRequest("agy"));
    if (!configured.ok) throw new Error(configured.message);
    expect(configured.request?.url).toContain("/providers/agy/v1/messages");
    expect((await bodyOf(configured.request)).model).toBe("gemini-test");
    const alias = await resolverOver({ agy: antigravityFile() })(resolverRequest("agy"));
    if (!alias.ok) throw new Error(alias.message);
    expect((await bodyOf(alias.request)).model).toBe("auto");
  });

  it("refuses a router provider's bare name, saying it has no default model", async () => {
    const resolution = await resolverOver({ rt: routerFile })(resolverRequest("rt"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.status).toBe(HTTP_STATUS.badRequest);
      expect(resolution.message).toContain('provider "rt" is a router and has no default model');
    }
  });

  it("refuses with a 400 naming the provider when it has no tier model and no catalogue to take one from", async () => {
    const upstream = await standIn("served");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const answered = await post(door, "/v1/messages", messages("spark"));
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(parseSent(answered.text).error?.message).toContain('provider "spark" has no default model');
      expect(upstream.posts()).toEqual([]);
      expect(upstream.lists()).toBe(0);
    } finally {
      await door.close();
    }
  });

  it("is case-sensitive on a file system that ignores case: Spark is not the provider spark, which stays the one pool", async () => {
    // Answers any spelling of a path with the file stored under its lower-case name, as a case-insensitive file system does, while the directory lists the name as stored.
    const ignoringCase = (base: ReturnType<typeof fakeFs>): ReturnType<typeof fakeFs> => ({
      ...base,
      readConfigFile: (file) => base.readConfigFile(file.toLowerCase()),
      readFileUtf8: (file) => base.readFileUtf8(file.toLowerCase()),
    });
    const resolve = resolverOver({ spark: httpFile("http://127.0.0.1:9", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "tier-model" } }) }, { fs: ignoringCase });
    const exact = await resolve(resolverRequest("spark"));
    if (!exact.ok) throw new Error(exact.message);
    expect(exact.route.name).toBe("http:spark");
    const spelt = await resolve(resolverRequest("Spark"));
    if (!spelt.ok) throw new Error(spelt.message);
    expect(spelt.route.name).toBe("anthropic");
    const qualified = await resolve(resolverRequest("Spark/chosen"));
    if (!qualified.ok) throw new Error(qualified.message);
    expect(qualified.route.name).toBe("anthropic");
    // The scoped path and the session's own provider are looked up by the same exact-case rule: another spelling is no provider named, never a second pool of the file.
    const scopedExact = await resolve({ ...resolverRequest("claude-sonnet-5-5"), url: "/providers/spark/v1/messages" });
    expect(scopedExact.ok && scopedExact.route.name).toBe("http:spark");
    const scopedSpelt = await resolve({ ...resolverRequest("claude-sonnet-5-5"), url: "/providers/Spark/v1/messages" });
    expect(scopedSpelt.ok).toBe(false);
    expect(!scopedSpelt.ok && scopedSpelt.status).toBe(HTTP_STATUS.notFound);
    const sessionSpelt = await resolve(resolverRequest("claude-sonnet-5-5", "Spark"));
    expect(sessionSpelt.ok).toBe(false);
  });

  it("leaves a name that is no provider's with the route it had before", async () => {
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9") })(resolverRequest("claude-sonnet-5-5"));
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.route.name).toBe("anthropic");
  });

  it.each([["a context marker alone", "[1m]"], ["whitespace", "   "], ["whitespace and a marker", " [1M]"]])("refuses a provider file whose model variable is %s as invalid, naming the provider, and sends nothing upstream", async (_label, value) => {
    const upstream = await standIn("served");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: value } }) }));
    try {
      const answered = await post(door, "/v1/messages", messages("spark"));
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(parseSent(answered.text).error?.message).toContain('provider "spark" cannot be used because its file is invalid');
      expect(upstream.posts()).toEqual([]);
    } finally {
      await door.close();
    }
  });

  it("serves a provider-scoped request whose model names another provider at the path the target is served under, without the first provider's prefix", async () => {
    const z = await standIn("served");
    const spark = await standIn("served");
    const door = await startDoor(resolverOver({ z: httpFile(z.baseUrl), spark: httpFile(spark.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" } }) }));
    try {
      const answered = await post(door, "/providers/z/v1/messages", messages("spark"));
      expect(answered.status).toBeLessThan(HTTP_STATUS.internalServerError);
      expect(z.posts()).toEqual([]);
      expect(modelsSeen(spark)).toEqual(["spark-main"]);
      expect(spark.posts().map((seen) => seen.url)).toEqual(["/v1/messages"]);
    } finally {
      await door.close();
    }
  });

  it("lets a virtual model named like a provider win", async () => {
    const models: ModelsConfig = { virtual: { spark: { mode: "ordered", members: ["z/glm-5.3"] } } };
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9"), z: httpFile("http://127.0.0.1:10") }, { models })(resolverRequest("spark"));
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.route.name).toBe("http:z");
    expect((await bodyOf(resolution.request)).model).toBe("glm-5.3");
  });

  it("lets the session's own provider keep a name it serves, even one equal to another provider", async () => {
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9"), z: httpFile("http://127.0.0.1:10") }, { targets: ["z/spark"] })(resolverRequest("spark", "z"));
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.route.name).toBe("http:z");
    expect((await bodyOf(resolution.request)).model).toBe("spark");
  });

  it("routes a bare name from a session launched on another provider, off that provider", async () => {
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } }), z: httpFile("http://127.0.0.1:10") })(resolverRequest("spark", "z"));
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.route.name).toBe("http:spark");
  });
});

describe("a provider named like a name another source gives a model", () => {
  const planeSession = (model: string, provider: string | undefined): RoutedRequest => resolverRequest(model, provider);

  it("does not take a name the session provider's own env maps a tier to, such as auto", async () => {
    const resolve = resolverOver({ z: httpFile("http://127.0.0.1:10", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "auto", ANTHROPIC_MODEL: "sonnet" } }), auto: httpFile("http://127.0.0.1:9", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } }), sonnet: httpFile("http://127.0.0.1:8", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } }) });
    for (const model of ["auto", "sonnet"]) {
      const resolution = await resolve(planeSession(model, "z"));
      if (!resolution.ok) throw new Error(resolution.message);
      expect(resolution.route.name, model).toBe("http:z");
    }
  });

  it("never takes a bare model name for a provider file called auto, opus or sonnet: the name keeps following the session's route", async () => {
    const files = Object.fromEntries(["auto", "opus", "sonnet"].map((name) => [name, httpFile("http://127.0.0.1:9", { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } })]));
    const resolve = resolverOver({ ...files, z: httpFile("http://127.0.0.1:10") });
    for (const model of ["auto", "opus", "sonnet"]) {
      for (const provider of [undefined, "z"]) {
        const resolution = await resolve(planeSession(model, provider));
        if (!resolution.ok) throw new Error(resolution.message);
        expect(resolution.route.name, `${model} from ${String(provider)}`).toBe(provider === undefined ? "anthropic" : "http:z");
      }
    }
  });
});
