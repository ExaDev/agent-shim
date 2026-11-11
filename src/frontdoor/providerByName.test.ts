import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import type { ModelsConfig } from "../config/schema";
import { realCatalogueFetch } from "../realCatalogueRefresh";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, type RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const OWN_PORT = 4100;
const TOKEN = "launch-token-for-tests";
/** The model-list reads a refused `auto` request costs: the first lookup and the refresh after the refusal. */
const REFRESHED_LISTS = 2;
/** Bytes of padding that put a body's model field past the 64 KiB a head scan reads. */
const PAD_PAST_HEAD_BYTES = 300_000;

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
    catalogueFetch: realCatalogueFetch,
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

  it("never takes the model auto as a provider's default from its catalogue", async () => {
    const upstream = await standIn("served");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }, { catalogue: [{ id: "auto" }, { id: "second" }] }));
    try {
      const answered = await post(door, "/v1/messages", messages("spark"));
      // The stand-in serves only its own model, so the request for "second" is answered 404: what is checked is the model the door sent, which `auto` would have made the one the server serves.
      expect(answered.status).toBe(HTTP_STATUS.notFound);
      expect(modelsSeen(upstream)).toEqual(["second"]);
    } finally {
      await door.close();
    }
  });

  it("records the model `auto` as the served model of `spark/auto` when the server's list cannot be read", async () => {
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:1") })(resolverRequest("spark/auto"));
    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.servedModel).toBe("auto");
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
      expect(parseSent(answered.text).error?.message).toContain('provider "spark" has no default model: give its env ANTHROPIC_DEFAULT_SONNET_MODEL, or opt it into a catalogue');
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

  it.each([["bare", "/v1/messages/batches"], ["scoped", "/providers/z/v1/messages/batches"]])("leaves a batch request naming a provider alone (%s path): it is no Messages request, so its body is never read and its model never resolved", async (_label, url) => {
    const body = Readable.from([Buffer.from(JSON.stringify(messages("spark")))]);
    const request: RoutedRequest = { ...resolverRequest("spark"), url, body };
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9"), z: httpFile("http://127.0.0.1:10") })(request);
    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.route.name).toBe(url.startsWith("/providers/z") ? "http:z" : "anthropic");
    // The resolution says which request it serves, as the caller that places a request on a provider requires, and that request is the one that arrived: its body is the very stream, unread.
    expect(resolution.ok && resolution.request?.body).toBe(body);
    expect(resolution.ok && resolution.request?.url).toBe(url);
    expect(body.readableFlowing).toBeNull();
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

  it("does not apply a provider's routes to another spelling of its name on a file system that ignores case", async () => {
    const ignoringCase = (base: ReturnType<typeof fakeFs>): ReturnType<typeof fakeFs> => ({ ...base, readConfigFile: (file) => base.readConfigFile(file.toLowerCase()), readFileUtf8: (file) => base.readFileUtf8(file.toLowerCase()) });
    const everything = { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*" } };
    const resolve = resolverOver({ spark: httpFile("http://127.0.0.1:9", { routes: [{ when: everything, provider: "other" }] }), other: httpFile("http://127.0.0.1:10") }, { fs: ignoringCase });
    const exact = await resolve({ ...resolverRequest("claude-sonnet-5-5"), url: "/providers/spark/v1/messages" });
    expect(exact.ok && exact.route.name).toBe("http:other");
    const spelt = await resolve({ ...resolverRequest("claude-sonnet-5-5"), url: "/providers/Spark/v1/messages" });
    expect(spelt.ok).toBe(false);
    expect(!spelt.ok && spelt.status).toBe(HTTP_STATUS.notFound);
  });

  it("leaves a name that is no provider's with the route it had before", async () => {
    const resolution = await resolverOver({ spark: httpFile("http://127.0.0.1:9") })(resolverRequest("claude-sonnet-5-5"));
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.route.name).toBe("anthropic");
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

describe("a name rewrite of a body with two top-level model fields", () => {
  it.each([["a bare provider name", "spark"], ["a qualified name", "spark/chosen"]])("is refused for %s, forwarding nothing", async (_label, name) => {
    const upstream = await standIn("tier-model");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "tier-model" } }) }));
    try {
      const answered = await post(door, "/v1/messages", `{"model":"${name}","model":"other","max_tokens":16,"messages":[]}`);
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("more than one top-level model field");
      expect(upstream.posts()).toHaveLength(0);
    } finally {
      await door.close();
    }
  });
});

describe("a route's model rewrite of a body with two top-level model fields", () => {
  it("is refused, forwarding nothing to either provider", async () => {
    const upstream = await standIn("other-model");
    const route = { when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*sonnet.*" } }, provider: "other", model: "rewritten" };
    const door = await startDoor(resolverOver({ main: httpFile(upstream.baseUrl, { routes: [route] }), other: httpFile(upstream.baseUrl) }));
    try {
      const answered = await post(door, "/providers/main/v1/messages", '{"model":"claude-sonnet-4-5","model":"x","max_tokens":16,"messages":[]}');
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("more than one top-level model field");
      expect(upstream.posts()).toHaveLength(0);
    } finally {
      await door.close();
    }
  });
});

describe("the model auto on an http provider", () => {
  it("is rewritten to the served model for spark/auto, and follows a swap without a restart", async () => {
    const upstream = await standIn("model-one");
    const logs: string[] = [];
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }, { log: (message) => { logs.push(message); } }));
    try {
      expect((await post(door, "/v1/messages", messages("spark/auto"))).status).toBe(HTTP_STATUS.ok);
      upstream.serve("model-two");
      const swapped = await post(door, "/v1/messages", messages("spark/auto"));
      expect(swapped.status).toBe(HTTP_STATUS.ok);
      // The second request went out under the cached name, was answered as unknown, and was served once more under the new one.
      expect(modelsSeen(upstream)).toEqual(["model-one", "model-one", "model-two"]);
      expect(logs.filter((line) => line.includes('"model-one" as an unknown model')).length).toBe(1);
    } finally {
      await door.close();
    }
  });

  it("does not refresh or retry on a context-overflow 400 that merely mentions the model", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      await post(door, "/v1/messages", messages("spark/auto"));
      upstream.serve("model-two");
      upstream.fail("overflow");
      const answered = await post(door, "/v1/messages", messages("spark/auto"));
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(modelsSeen(upstream)).toEqual(["model-one", "model-one"]);
      expect(upstream.lists()).toBe(1);
    } finally {
      await door.close();
    }
  });

  it("retries exactly once when the retry is refused too", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      await post(door, "/v1/messages", messages("spark/auto"));
      upstream.serve("model-two");
      upstream.fail("missing");
      const answered = await post(door, "/v1/messages", messages("spark/auto"));
      expect(answered.status).toBe(HTTP_STATUS.notFound);
      expect(modelsSeen(upstream)).toEqual(["model-one", "model-one", "model-two"]);
    } finally {
      await door.close();
    }
  });

  it("serves the answer as it is when the refreshed list names the very model that was refused", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      await post(door, "/v1/messages", messages("spark/auto"));
      upstream.fail("missing");
      const answered = await post(door, "/v1/messages", messages("spark/auto"));
      expect(answered.status).toBe(HTTP_STATUS.notFound);
      expect(modelsSeen(upstream)).toEqual(["model-one", "model-one"]);
      expect(upstream.lists()).toBe(REFRESHED_LISTS);
    } finally {
      await door.close();
    }
  });

  it("answers 502 naming the provider when its credential does not resolve, without reaching its server", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { credential: { sources: [{ env: "SPARK_TOKEN_NOT_SET" }] } }) }));
    try {
      const answered = await post(door, "/v1/messages", messages("spark/auto"));
      expect(answered.status).toBe(HTTP_STATUS.badGateway);
      expect(answered.text).toContain(String.raw`the model \"auto\" follows the model provider \"spark\"'s server serves, but its live model list could not be read because the provider's credential did not resolve`);
      expect(upstream.posts()).toHaveLength(0);
      expect(upstream.lists()).toBe(0);
    } finally {
      await door.close();
    }
  });

  it("resolves the model auto when the model field sits past the head the scan reads, as the resolver in front of the route decides on the whole body", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const answered = await post(door, "/providers/spark/v1/messages", `{"pad":"${"x".repeat(PAD_PAST_HEAD_BYTES)}","model":"auto","max_tokens":16,"messages":[]}`);
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["model-one"]);
    } finally {
      await door.close();
    }
  });

  it("forwards, byte for byte, a request whose model field sits past the head and is not auto", async () => {
    const upstream = await standIn("other-model");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const body = `{"pad":"${"x".repeat(PAD_PAST_HEAD_BYTES)}","model":"other-model","max_tokens":16,"messages":[]}`;
      expect((await post(door, "/providers/spark/v1/messages", body)).status).toBe(HTTP_STATUS.ok);
      expect(upstream.posts().map((seen) => seen.body)).toEqual([body]);
    } finally {
      await door.close();
    }
  });

  it("rewrites only the top-level model value, every other byte of the body as it arrived", async () => {
    const upstream = await standIn("served-now");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const body = '{ "big":12345678901234567890,"f":1.0,"s":"a\\u00e9 \\"model\\":\\"auto\\"","nested":{"model":"auto"},  "model" : "auto" ,"messages":[]}';
      expect((await post(door, "/providers/spark/v1/messages", body)).status).toBe(HTTP_STATUS.ok);
      expect(upstream.posts()[0]?.body).toBe(body.replace('"model" : "auto"', '"model" : "served-now"'));
    } finally {
      await door.close();
    }
  });

  it("reads the list once for requests inside the cache lifetime", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      await post(door, "/v1/messages", messages("spark/auto"));
      await post(door, "/v1/messages", messages("spark/auto"));
      expect(upstream.lists()).toBe(1);
    } finally {
      await door.close();
    }
  });

  it("is what a tier entry set to auto resolves to on the provider's own session", async () => {
    const upstream = await standIn("served-now");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "auto" } }) }));
    try {
      expect((await post(door, "/providers/spark/v1/messages", messages("auto"))).status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["served-now"]);
    } finally {
      await door.close();
    }
  });

  it("answers the server's own refusal when a retry has no newer model to try", async () => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      await post(door, "/v1/messages", messages("spark/auto"));
      upstream.serve(undefined);
      const refused = await post(door, "/v1/messages", messages("spark/auto"));
      expect(refused.status).toBe(HTTP_STATUS.notFound);
      expect(refused.text).toContain("does not exist");
    } finally {
      await door.close();
    }
  });
});

/** Spellings of the name `spark/auto` a JSON encoder may write, and of a body naming it twice: the resolver and the wrapper must decide the same on each. */
const SPELLINGS: readonly (readonly [label: string, model: string])[] = [
  ["plain", "spark/auto"],
  ["with an escaped slash", "spark\\/auto"],
  ["with a \\u-escaped letter", "\\u0073park/auto"],
  ["with an escaped letter in the model part", "spark/\\u0061uto"],
];

describe("one decision for every spelling of a model name, through the resolver and the wrapper", () => {
  it.each(SPELLINGS)("routes the name %s to the served model", async (_label, spelled) => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const answered = await post(door, "/v1/messages", `{"model":"${spelled}","max_tokens":16,"messages":[]}`);
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(modelsSeen(upstream)).toEqual(["model-one"]);
    } finally {
      await door.close();
    }
  });

  it.each(SPELLINGS)("refuses the name %s when the body names its model twice", async (_label, spelled) => {
    const upstream = await standIn("model-one");
    const door = await startDoor(resolverOver({ spark: httpFile(upstream.baseUrl) }));
    try {
      const answered = await post(door, "/v1/messages", `{"model":"${spelled}","model":"other","max_tokens":16,"messages":[]}`);
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(upstream.posts()).toHaveLength(0);
    } finally {
      await door.close();
    }
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
