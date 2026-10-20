import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import type { ModelsConfig } from "../config/schema";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag } from "../test-helpers";
import type { FsPort } from "../launcher/ports";
import type { UsageSnapshot } from "../usage/schema";
import { createProviderRouteResolver} from "./providerRoute";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, type RoutedRequest, type RoutedResponse } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;

/** When the quota-test fixture's windows reset: one day out, far enough to be live at any test instant. */
const DAY_RESET_MS = 86_400_000;


/** The max_tokens threshold the one numeric fact routes above. */
const MAX_TOKENS_THRESHOLD = 8192;

/** How many of the four further facts the one test drives onto the heavy target. */
const FACT_ROUTE_COUNT = 4;
const OWN_PORT = 4100;

const codexProvider = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };
const httpProvider = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } };
const antigravityProvider = { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ env: "Z" }] }, antigravity: { mode: "cloud" } };

/** A complete Responses API text turn, the shape the codex translator turns into an Anthropic SSE reply. */
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 9, output_tokens: 2 } } },
];

/** The codex ports the resolver mounts, faked to the shape the real front-door process wires: a recording fetch and the fixed-token auth store. */
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

function resolver(files: Record<string, unknown>, directPort = OWN_PORT, models?: unknown, accountMoves?: (sessionId: string, to: string, model: string) => boolean): ReturnType<typeof createProviderRouteResolver> {
  return createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => directPort, env: { Z: "tok-from-z" }, ...(models === undefined ? {} : { models: () => models as ModelsConfig | undefined }), ...(accountMoves === undefined ? {} : { accountMoves }), credentials: fakeAsyncCredentials() });
}

function request(url: string, body = "{}"): RoutedRequest {
  return { method: "POST", url, headers: {}, body: Readable.from([Buffer.from(body)]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
}

describe("createProviderRouteResolver", () => {
  it("serves a request a provider's routes redirected to a codex target, whose body the routing layer read and replayed", async () => {
    const router = {
      kind: "http",
      displayName: "Router",
      baseUrl: "http://127.0.0.1:9",
      credential: { sources: [{ literal: "router-token" }] },
      routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*sonnet.*" } }, provider: "codex" }],
    };
    const answering = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
    const ports: Omit<CodexRoutePorts, "loadProvider"> = {
      upstreams: sameUpstreamForEveryLogin({ fetch: answering.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }),
      writeUsageSnapshot: () => undefined,
      now: () => 0,
      log: () => undefined,
    };
    const door = await startDoor(
      createProviderRouteResolver({ fs: fakeFs({ [`${PROVIDERS_DIR}/router.json`]: router, [`${PROVIDERS_DIR}/codex.json`]: codexProvider }), providersDir: PROVIDERS_DIR, codexPorts: ports, directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials() }),
    );
    try {
      const body = JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "user-a" } });
      const response = await fetch(`${door.url}/providers/router/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body });
      expect(response.status).toBe(HTTP_STATUS.ok);
    } finally {
      await door.close();
    }
  });

  it("mounts the in-process codex translator for a codex provider, named for it and headroom-eligible with the direct listener's bare origin as the hop's upstream", async () => {
    const resolution = await resolver({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider })(request("/providers/codex/v1/messages"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.route.name).toBe("codex:codex");
      expect(resolution.route.headroomEligible).toBe(true);
      expect(resolution.route.headroomUpstream).toBe(`http://127.0.0.1:${String(OWN_PORT)}`);
    }
  });

  it("mounts the in-process antigravity translator for an antigravity provider, named for it and headroom-eligible with the direct listener's bare origin as the hop's upstream", async () => {
    const resolution = await resolver({ [`${PROVIDERS_DIR}/ag.json`]: antigravityProvider })(request("/providers/ag/v1/messages"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.route.name).toBe("antigravity:ag");
      expect(resolution.route.headroomEligible).toBe(true);
      expect(resolution.route.headroomUpstream).toBe(`http://127.0.0.1:${String(OWN_PORT)}`);
    }
  });

  it("mounts the pass-through route for an http provider, also reached through the direct listener when headroom sits in front", async () => {
    const resolution = await resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider })(request("/providers/z/v1/messages"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.route.name).toBe("http:z");
      expect(resolution.route.headroomEligible).toBe(true);
      expect(resolution.route.headroomUpstream).toBe(`http://127.0.0.1:${String(OWN_PORT)}`);
    }
  });

  it("rides a bare /v1/ target (an OAuth session on the CONNECT surface) on a pass-through to Claude Code's own API with no per-request upstream", async () => {
    const resolution = await resolver({})(request("/v1/messages"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.route.name).toBe("anthropic");
      expect(resolution.route.headroomEligible).toBe(true);
      expect(resolution.route.headroomUpstream).toBeUndefined();
    }
  });

  it("resolves a bare name only the models block defines on every session, and keeps a name the session's own provider serves itself", async () => {
    const plain = (model: string): RoutedRequest => ({
      ...request("/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
      session: { identity: undefined, sessionId: undefined, provider: "z", headroom: false, projectId: undefined },
    });
    // `fast` is only the block's to serve; `glm-5.3` z serves itself, so it stays z's own.
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] }, "glm-5.3": { mode: "ordered", members: ["z/glm-5.3", "s/glm-5.3"] } } };
    const resolve = createProviderRouteResolver({ fs: fakeFs({ [`${PROVIDERS_DIR}/z.json`]: httpProvider, [`${PROVIDERS_DIR}/s.json`]: { displayName: "S", baseUrl: "https://api.synthetic.new/anthropic", credential: { sources: [{ literal: "s-token" }] } } }), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: { Z: "tok-from-z" }, credentials: fakeAsyncCredentials(), models: () => models, targets: () => ["z/glm-5.3", "s/glm-5.3"] });
    const fast = await resolve(plain("fast"));
    if (!fast.ok) throw new Error(fast.message);
    expect(fast.route.name).toBe("http:z");
    expect(fast.modelChoice).toEqual({ requested: "fast", providers: ["z"] });
    const own = await resolve(plain("glm-5.3"));
    if (!own.ok) throw new Error(own.message);
    expect(own.route.name).toBe("http:z");
    expect(own.modelChoice).toBeUndefined(); });

  it("routes a provider-qualified model name on every session, whatever it launched on, with no flag asked or given", async () => {
    const plain = (model: string, provider: string | undefined): RoutedRequest => ({ ...request("/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })), session: { identity: undefined, sessionId: undefined, provider, headroom: false, projectId: undefined } });
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider, [`${PROVIDERS_DIR}/s.json`]: { displayName: "S", baseUrl: "https://api.synthetic.new/anthropic", credential: { sources: [{ literal: "s-token" }] } } });
    // z naming s's model leaves z for s; a qualified name for the session's own provider is served right there under the bare name.
    const cross = await resolve(plain("s/glm-5.2", "z"));
    expect(cross.ok && cross.route.name).toBe("http:s");
    const own = await resolve(plain("z/glm-5.3", "z"));
    expect(own.ok && own.route.name).toBe("http:z");
    // A slash alone is not a provider ref: a first segment no provider defines (an aggregator's `vendor/model`) stays the session's own provider's business.
    const slashed = await resolve(plain("hf:zai-org/GLM-5.1", "z"));
    expect(slashed.ok && slashed.route.name).toBe("http:z");
  });

  it("routes a provider-qualified model name from a provider-less (OAuth) session that asked to route by name onto that provider's route", async () => {
    const byName = (model: string, url = "/v1/messages"): RoutedRequest => ({
      ...request(url, JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
      session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
    });
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider });

    const qualified = await resolve(byName("z/glm-5.3"));
    expect(qualified.ok).toBe(true);
    if (qualified.ok) {
      expect(qualified.route.name).toBe("http:z");
      expect(qualified.request?.url).toContain("/providers/z/v1/messages");
    }

    // A bare name the models block does not define is Claude Code's own on an OAuth session: it still rides the pass-through to Anthropic, never resolved through the models block.
    const bare = await resolve(byName("claude-sonnet-4-5"));
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.route.name).toBe("anthropic");
    }

    // The Remote Control family of paths is never a provider's to serve, whatever the model field would resolve to.
    const rc = await resolve(byName("z/glm-5.3", "/v1/code/sessions/s-1/events"));
    expect(rc.ok).toBe(true);
    if (rc.ok) {
      expect(rc.route.name).not.toBe("http:z");
    }
  });

  it("routes a name the models block defines, a virtual model's or a family's, from a provider-less (OAuth) session that asked to route by name", async () => {
    const byName = (model: string): RoutedRequest => ({
      ...request("/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
      session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
    });
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } };
    const resolve = createProviderRouteResolver({ fs: fakeFs({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: { Z: "tok-from-z" }, credentials: fakeAsyncCredentials(), models: () => models, targets: () => ["z/glm-5.3"] });

    const virtual = await resolve(byName("fast"));
    expect(virtual.ok).toBe(true);
    if (virtual.ok) {
      expect(virtual.route.name).toBe("http:z");
    }
    const family = await resolve(byName("family:glm-5-3"));
    expect(family.ok).toBe(true);
    if (family.ok) {
      expect(family.route.name).toBe("http:z");
    }
    // The same block leaves a bare name it does not define on the pass-through to Anthropic.
    const bare = await resolve(byName("claude-sonnet-4-5"));
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.route.name).toBe("anthropic");
    }
  });

  it("serves a provider session's bare /v1/ target through its provider's route, the request rewritten under the scoped path the route parses", async () => {
    // An antigravity provider whose credential never resolves: the route must get as far as its credential (a 401 naming the provider), which a bare unrewritten path never reaches because the route cannot parse a provider out of it.
    const resolve = resolver({ [`${PROVIDERS_DIR}/ag.json`]: { kind: "antigravity", displayName: "AG", credential: { sources: [{ env: "NOT_SET_ANYWHERE" }] }, antigravity: { mode: "cloud" } } });
    const sessionRequest = (url: string): RoutedRequest => ({ ...request(url, JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "Reply OK" }] })), session: { identity: undefined, sessionId: undefined, provider: "ag", headroom: false, projectId: undefined } });
    const resolution = await resolve(sessionRequest("/v1/messages?beta=true"));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.route.name).toBe("antigravity:ag");
    const chunks: string[] = [];
    let status = 0;
    const response: RoutedResponse = {
      headersSent: false,
      start: (code) => {
        status = code;
      },
      flush: () => undefined,
      write: async (chunk) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        await Promise.resolve();
      },
      end: () => undefined,
      destroy: () => undefined,
    };
    await resolution.route.serve(sessionRequest("/v1/messages?beta=true"), response);
    expect(status).toBe(HTTP_STATUS.unauthorized);
    expect(chunks.join("")).not.toContain("no provider specified in path");
  });

  it("refuses an unknown provider and any path that names no provider and is not a bare /v1/ path", async () => {
    const resolve = resolver({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider });
    expect(await resolve(request("/providers/missing/v1/messages"))).toEqual({ ok: false, status: HTTP_STATUS.notFound, message: 'no provider named "missing"' });
    expect(await resolve(request("/api/oauth/token"))).toMatchObject({ ok: false, status: HTTP_STATUS.notFound });
  });

  it("refuses a provider file that fails validation, naming what is wrong", async () => {
    const resolve = resolver({ [`${PROVIDERS_DIR}/broken.json`]: { displayName: "Broken" } });
    const resolution = await resolve(request("/providers/broken/v1/messages"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.status).toBe(HTTP_STATUS.internalServerError);
      expect(resolution.message).toContain("provider broken is invalid");
    }
  });
});

/** What the local fake upstream saw of one request. */
interface UpstreamSeen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
}

const upstreams: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    upstreams.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

/** A fake provider upstream that records each request's headers and answers with a fixed JSON body. */
async function fakeUpstream(): Promise<{ readonly port: number; readonly seen: () => readonly UpstreamSeen[] }> {
  const requests: UpstreamSeen[] = [];
  const server = http.createServer((incoming, response) => {
    incoming.on("data", () => undefined);
    incoming.on("end", () => {
      requests.push({ url: incoming.url ?? "", headers: { ...incoming.headers } });
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  upstreams.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("upstream has no TCP address");
  }
  return { port: (address satisfies AddressInfo).port, seen: () => requests };
}

/** Starts a door serving one provider route resolved by the resolver under test, admitted by a fixed launch token. */
async function startDoor(resolve: ReturnType<typeof createProviderRouteResolver>): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
}

/** A filesystem port over a record the test can mutate between requests, so a provider file edit is visible to the next request the way a real edit would be. */
function mutableFs(): { readonly fs: FsPort; readonly files: Record<string, unknown> } {
  const files: Record<string, unknown> = {};
  const base = fakeFs({});
  return {
    files,
    fs: {
      ...base,
      readFileUtf8: (filePath) => {
        const value = files[filePath];
        return typeof value === "string" ? value : base.readFileUtf8(filePath);
      },
      readConfigFile: (filePath) => {
        const value = files[filePath];
        return value === undefined || typeof value === "string" ? undefined : value;
      },
    },
  };
}

describe("the credential an http provider's route attaches", () => {
  it("replaces whatever credential the child presented with the provider file's own resolved one, in the bearer target's header form", async () => {
    const upstream = await fakeUpstream();
    const door = await startDoor(resolver({ [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-provider-token" }] } } }));
    try {
      // What a Remote Control session in OAuth mode presents: the stored OAuth bearer, with the provider's own key nowhere in the child.
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer minted-oauth-bearer", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.ok);
      const seen = upstream.seen()[0];
      expect(seen?.headers.authorization).toBe("Bearer z-provider-token");
      expect(seen?.headers["x-api-key"]).toBeUndefined();
    } finally {
      await door.close();
    }
  });

  it("answers an apiKey-target provider with x-api-key and drops the presented bearer entirely", async () => {
    const upstream = await fakeUpstream();
    const door = await startDoor(
      resolver({ [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-api-key" }], target: "apiKey" } } }),
    );
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer minted-oauth-bearer", "x-api-key": "wrongly-presented-key", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.ok);
      const seen = upstream.seen()[0];
      expect(seen?.headers["x-api-key"]).toBe("z-api-key");
      expect(seen?.headers.authorization).toBeUndefined();
    } finally {
      await door.close();
    }
  });

  it("answers an Anthropic-shaped error naming the provider when no source yields a token, and forwards nothing upstream", async () => {
    const upstream = await fakeUpstream();
    const door = await startDoor(resolver({ [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ env: "NOT_SET_ANYWHERE" }] } } }));
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer minted-oauth-bearer", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      const body = (await response.json()) as { type: string; error: { type: string; message: string } };
      expect(body.error.type).toBe("api_error");
      expect(body.error.message).toContain("provider z");
      expect(upstream.seen()).toHaveLength(0);
    } finally {
      await door.close();
    }
  });

  it("re-resolves per request, so a provider file whose credential block was edited applies to the next request with no restart", async () => {
    const upstream = await fakeUpstream();
    const mutable = mutableFs();
    mutable.files[`${PROVIDERS_DIR}/z.json`] = { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-first-token" }] } };
    const resolve = createProviderRouteResolver({ fs: mutable.fs, providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials() });
    const door = await startDoor(resolve);
    try {
      expect((await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" })).status).toBe(HTTP_STATUS.ok);
      expect(upstream.seen()[0]?.headers.authorization).toBe("Bearer z-first-token");
      mutable.files[`${PROVIDERS_DIR}/z.json`] = { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-rotated-token" }] } };
      expect((await fetch(`${door.url}/providers/z/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" })).status).toBe(HTTP_STATUS.ok);
      expect(upstream.seen()[1]?.headers.authorization).toBe("Bearer z-rotated-token");
    } finally {
      await door.close();
    }
  });
});

/** A fake upstream that also records each request's body text, so a routed request proves its replayed body is unbroken. */
async function bodyRecordingUpstream(): Promise<{ readonly port: number; readonly seen: () => readonly { url: string; body: string }[] }> {
  const requests: { url: string; body: string }[] = [];
  const server = http.createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    incoming.on("end", () => {
      requests.push({ url: incoming.url ?? "", body });
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  upstreams.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("upstream has no TCP address");
  }
  return { port: (address satisfies AddressInfo).port, seen: () => requests };
}

describe("per-request routing by model", () => {
  it("sends a request whose model matches to the entry's provider, its body replayed whole and its credential attached", async () => {
    const main = await bodyRecordingUpstream();
    const cheap = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*haiku.*" } }, provider: "cheap" }] },
      [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: `http://127.0.0.1:${String(cheap.port)}`, credential: { sources: [{ literal: "cheap-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, messages: [{ role: "user", content: "route me" }] });
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(main.seen()).toEqual([]);
      const seen = cheap.seen()[0];
      expect(seen?.url).toBe("/v1/messages");
      expect(seen?.body).toBe(body);
    } finally {
      await door.close();
    }
  });

  it("keeps a request whose model matches no entry on the provider itself", async () => {
    const main = await bodyRecordingUpstream();
    const cheap = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*haiku.*" } }, provider: "cheap" }] },
      [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: `http://127.0.0.1:${String(cheap.port)}`, credential: { sources: [{ literal: "cheap-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: JSON.stringify({ model: "claude-opus-4-5", messages: [] }) });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(cheap.seen()).toEqual([]);
      expect(main.seen()[0]?.url).toBe("/v1/messages");
    } finally {
      await door.close();
    }
  });

  it("falls through an entry whose condition a body with no model field leaves undecided, rather than routing on a guess", async () => {
    const main = await bodyRecordingUpstream();
    const cheap = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "exists", operand: { kind: "reference", key: "request.model" } }, provider: "cheap" }] },
      [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: `http://127.0.0.1:${String(cheap.port)}`, credential: { sources: [{ literal: "cheap-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: JSON.stringify({ messages: [] }) });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(cheap.seen()).toEqual([]);
      expect(main.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });

  it("routes on an image anywhere in the conversation, which the whole-body scan the predicate chooses can see", async () => {
    const main = await bodyRecordingUpstream();
    const vision = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "compare", op: "eq", left: { kind: "reference", key: "request.hasImage" }, right: { kind: "booleanLiteral", value: true } }, provider: "vision" }] },
      [`${PROVIDERS_DIR}/vision.json`]: { displayName: "Vision", baseUrl: `http://127.0.0.1:${String(vision.port)}`, credential: { sources: [{ literal: "vision-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      // The image block sits in the newest turn, the last element of the conversation: only a whole-body scan finds it.
      const body = JSON.stringify({ model: "claude-opus-4-5", messages: [{ role: "user", content: "hello" }, { role: "user", content: [{ type: "image", source: { type: "base64" } }] }] });
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(main.seen()).toEqual([]);
      expect(vision.seen()[0]?.body).toBe(body);
      // A conversation with no image block stays on the provider.
      await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: JSON.stringify({ model: "claude-opus-4-5", messages: [{ role: "user", content: "plain" }] }) });
      expect(main.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });

  it("rewrites the model field for a route that names another form, changing exactly that one field", async () => {
    const main = await bodyRecordingUpstream();
    const openrouter = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*sonnet.*" } }, provider: "openrouter", model: "anthropic/claude-sonnet-4" }] },
      [`${PROVIDERS_DIR}/openrouter.json`]: { displayName: "OpenRouter", baseUrl: `http://127.0.0.1:${String(openrouter.port)}`, credential: { sources: [{ literal: "or-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 512, messages: [{ role: "user", content: "hi" }] }) });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(JSON.parse(openrouter.seen()[0]?.body ?? "{}")).toMatchObject({ model: "anthropic/claude-sonnet-4", max_tokens: 512 });
      expect(main.seen()).toEqual([]);
    } finally {
      await door.close();
    }
  });

  it("skips a target whose quota the condition says is spent, falling through to the provider itself", async () => {
    const main = await bodyRecordingUpstream();
    const spent = await bodyRecordingUpstream();
    const fresh = await bodyRecordingUpstream();
    // The identity's snapshot records the spent target at full utilisation and the fresh one barely used; the route demands under-full utilisation, so the first target is skipped and the second serves.
    const snapshot: UsageSnapshot = { schemaVersion: 1, identity: "work", updatedAt: new Date(0).toISOString(), providers: { spent: { lastRequestAt: new Date(0).toISOString(), lastStatus: 200, rateLimit: { observedAt: new Date(0).toISOString(), headers: {}, unified: { sevenDay: { utilization: 1, resetsAt: new Date(DAY_RESET_MS).toISOString(), status: "rejected" } } } }, fresh: { lastRequestAt: new Date(0).toISOString(), lastStatus: 200, rateLimit: { observedAt: new Date(0).toISOString(), headers: {}, unified: { sevenDay: { utilization: 0.1, resetsAt: new Date(DAY_RESET_MS).toISOString(), status: "allowed" } } } } } };
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "allOf", operands: [{ kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*haiku.*" } }, { kind: "compare", op: "lt", left: { kind: "reference", key: "provider.spent.sevenDay.utilization" }, right: { kind: "numberLiteral", value: 0.9 } }] }, provider: "spent" }, { when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*haiku.*" } }, provider: "fresh" }] },
      [`${PROVIDERS_DIR}/spent.json`]: { displayName: "Spent", baseUrl: `http://127.0.0.1:${String(spent.port)}`, credential: { sources: [{ literal: "spent-token" }] } },
      [`${PROVIDERS_DIR}/fresh.json`]: { displayName: "Fresh", baseUrl: `http://127.0.0.1:${String(fresh.port)}`, credential: { sources: [{ literal: "fresh-token" }] } },
    };
    const resolve = createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials(), usageSnapshotOf: (identity) => (identity === "work" ? snapshot : undefined) });
    const server = createFrontDoorServer(
      async (pipelineRequest) => {
        await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
      },
      () => undefined,
    );
    const handle = await listenFrontDoor(server);
    const door = { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
    try {
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests", "x-agent-shim-identity": "work" }, body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }) });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(spent.seen()).toEqual([]);
      expect(fresh.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });

  it("routes on the further request facts: tools, thinking, max_tokens and count_tokens calls", async () => {
    const main = await bodyRecordingUpstream();
    const heavy = await bodyRecordingUpstream();
    // One entry per fact: a request carrying tools, or enabled thinking, or a max_tokens above the threshold, or a count_tokens call, all go to the heavy target; everything else stays.
    const fact = (key: string, node: unknown) => ({ kind: "allOf", operands: [{ kind: "compare", op: "eq", left: { kind: "reference", key }, right: node }] });
    const routes = [
      { when: fact("request.toolsPresent", { kind: "booleanLiteral", value: true }), provider: "heavy" },
      { when: fact("request.thinking", { kind: "booleanLiteral", value: true }), provider: "heavy" },
      { when: { kind: "compare", op: "gt", left: { kind: "reference", key: "request.maxTokens" }, right: { kind: "numberLiteral", value: 8192 } }, provider: "heavy" },
      { when: fact("request.isCountTokens", { kind: "booleanLiteral", value: true }), provider: "heavy" },
    ];
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes },
      [`${PROVIDERS_DIR}/heavy.json`]: { displayName: "Heavy", baseUrl: `http://127.0.0.1:${String(heavy.port)}`, credential: { sources: [{ literal: "heavy-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const post = async (url: string, body: string): Promise<void> => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body });
        expect(response.status).toBe(HTTP_STATUS.ok);
      };
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", tools: [{ name: "bash" }], messages: [] }));
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] }));
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", max_tokens: 16384, messages: [] }));
      await post(`${door.url}/providers/main/v1/messages/count_tokens`, JSON.stringify({ model: "claude-opus-4-5", messages: [] }));
      expect(heavy.seen()).toHaveLength(FACT_ROUTE_COUNT);
      // The plain request, under every threshold and carrying none of the flags, stays on the provider.
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", max_tokens: 1024, messages: [] }));
      expect(main.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });

  it("routes on the further request facts: tools, thinking, max_tokens and count_tokens calls", async () => {
    const main = await bodyRecordingUpstream();
    const heavy = await bodyRecordingUpstream();
    // One entry per fact: a request carrying tools, or enabled thinking, or a max_tokens above the threshold, or a count_tokens call, all go to the heavy target; everything else stays.
    const flagRoute = (key: string) => ({ when: { kind: "compare", op: "eq", left: { kind: "reference", key }, right: { kind: "booleanLiteral", value: true } }, provider: "heavy" });
    const routes = [
      flagRoute("request.toolsPresent"),
      flagRoute("request.thinking"),
      { when: { kind: "compare", op: "gt", left: { kind: "reference", key: "request.maxTokens" }, right: { kind: "numberLiteral", value: MAX_TOKENS_THRESHOLD } }, provider: "heavy" },
      flagRoute("request.isCountTokens"),
    ];
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes },
      [`${PROVIDERS_DIR}/heavy.json`]: { displayName: "Heavy", baseUrl: `http://127.0.0.1:${String(heavy.port)}`, credential: { sources: [{ literal: "heavy-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const post = async (url: string, body: string): Promise<void> => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body });
        expect(response.status).toBe(HTTP_STATUS.ok);
      };
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", tools: [{ name: "bash" }], messages: [] }));
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] }));
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", max_tokens: 16384, messages: [] }));
      await post(`${door.url}/providers/main/v1/messages/count_tokens`, JSON.stringify({ model: "claude-opus-4-5", messages: [] }));
      expect(heavy.seen()).toHaveLength(FACT_ROUTE_COUNT);
      // The plain request, under every threshold and carrying none of the flags, stays on the provider.
      await post(`${door.url}/providers/main/v1/messages`, JSON.stringify({ model: "claude-opus-4-5", max_tokens: 1024, messages: [] }));
      expect(main.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });

  it("refuses a routing table that circles back on itself, naming the cycle", async () => {
    const main = await bodyRecordingUpstream();
    const cheap = await bodyRecordingUpstream();
    // main sends haiku models to cheap; cheap sends everything back to main. A haiku request therefore circles, and the resolution refuses it naming the chain instead of looping.
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: `http://127.0.0.1:${String(main.port)}`, credential: { sources: [{ literal: "main-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*haiku.*" } }, provider: "cheap" }] },
      [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: `http://127.0.0.1:${String(cheap.port)}`, credential: { sources: [{ literal: "cheap-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*" } }, provider: "main" }] },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/main/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: JSON.stringify({ model: "claude-haiku-4-5" }) });
      expect(response.status).toBe(HTTP_STATUS.internalServerError);
      expect(await response.text()).toContain("provider routing cycle");
    } finally {
      await door.close();
    }
  });
});

describe("a router provider", () => {
  it("resolves a provider-qualified model name to that provider's route", async () => {
    const router = { kind: "router", displayName: "Router" };
    const upstream = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/router.json`]: router,
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/router/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" },
        body: JSON.stringify({ model: "z/glm-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(upstream.seen()[0]?.url).toContain("/v1/messages");
      // The qualified name is rewritten to the model name the target serves it under: the provider receives `glm-5.3`, not the routing qualifier.
      expect((JSON.parse(upstream.seen()[0]?.body ?? "{}") as { model?: string }).model).toBe("glm-5.3");
    } finally {
      await door.close();
    }
  });

  it("chooses a virtual model's member through its selection mode, skipping the member whose quota is spent, and serves the member's own model name", async () => {
    const router = { kind: "router", displayName: "Router" };
    const spent = await bodyRecordingUpstream();
    const fresh = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/router.json`]: router,
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(spent.port)}`, credential: { sources: [{ literal: "z-token" }] } },
      [`${PROVIDERS_DIR}/m.json`]: { displayName: "M", baseUrl: `http://127.0.0.1:${String(fresh.port)}`, credential: { sources: [{ literal: "m-token" }] } },
    };
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/one", "m/two"] } } };
    const snapshot: UsageSnapshot = { schemaVersion: 1, identity: "work", updatedAt: new Date(0).toISOString(), providers: { z: { lastRequestAt: new Date(0).toISOString(), lastStatus: 200, rateLimit: { observedAt: new Date(0).toISOString(), headers: {}, unified: { sevenDay: { utilization: 1, resetsAt: new Date(DAY_RESET_MS).toISOString(), status: "rejected" } } } } } };
    const resolve = createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials(), models: () => models, usageSnapshotOf: (identity) => (identity === "work" ? snapshot : undefined) });
    const server = createFrontDoorServer(
      async (pipelineRequest) => {
        await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
      },
      () => undefined,
    );
    const handle = await listenFrontDoor(server);
    const door = { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
    try {
      const response = await fetch(`${door.url}/providers/router/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests", "x-agent-shim-identity": "work" },
        body: JSON.stringify({ model: "fast", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(spent.seen()).toEqual([]);
      expect(fresh.seen()).toHaveLength(1);
      expect((JSON.parse(fresh.seen()[0]?.body ?? "{}") as { model?: string }).model).toBe("two");
    } finally {
      await door.close();
    }
  });

  it("resolves a virtual model's name through the models block to its member's provider", async () => {
    const router = { kind: "router", displayName: "Router" };
    const upstream = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/router.json`]: router,
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] } },
    };
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } };
    const door = await startDoor(resolver(files, OWN_PORT, models));
    try {
      const response = await fetch(`${door.url}/providers/router/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" },
        body: JSON.stringify({ model: "fast", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(upstream.seen()[0]?.url).toContain("/v1/messages");
    } finally {
      await door.close();
    }
  });

  it("strips the context marker from the member name it writes, because no provider serves a model under it", async () => {
    const router = { kind: "router", displayName: "Router" };
    const upstream = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/router.json`]: router,
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] } },
    };
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3[1m]"] } } };
    const door = await startDoor(resolver(files, OWN_PORT, models));
    try {
      const response = await fetch(`${door.url}/providers/router/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" },
        body: JSON.stringify({ model: "fast", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      // The marker sizes Claude Code's context window and never reaches a provider: the rewrite writes the name the provider serves, not the ref verbatim.
      expect((JSON.parse(upstream.seen()[0]?.body ?? "{}") as { model?: string }).model).toBe("glm-5.3");
    } finally {
      await door.close();
    }
  });
});

describe("an account model member", () => {
  const sessionRequest = (model: string): RoutedRequest => ({
    ...request("/providers/z/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
    session: { identity: undefined, sessionId: "s-1", provider: "z", headroom: false, projectId: undefined },
  });

  it("is answered with a clear refusal naming the identity, and a move request is left for the session's supervisor", async () => {
    const moves: [string, string, string][] = [];
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }, OWN_PORT, undefined, (sessionId, to, model) => {
      moves.push([sessionId, to, model]);
      return true;
    });
    const resolution = await resolve(sessionRequest("acct:work/opus"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.status).toBe(HTTP_STATUS.badRequest);
      expect(resolution.message).toContain('identity "work"');
      expect(resolution.message).toContain("being moved there");
    }
    expect(moves).toEqual([["s-1", "work", "opus"]]);
  });

  it("names the command to run when nothing supervises the session", async () => {
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider });
    const resolution = await resolve(sessionRequest("acct:work/opus"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toContain(`claude @work --resume`);
    }
  });

  it("resolves a virtual model whose first member is an account member the same way", async () => {
    const moves: [string, string, string][] = [];
    const models: ModelsConfig = { virtual: { opusAnywhere: { mode: "ordered", members: ["acct:work/opus"] } } };
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }, OWN_PORT, models, (sessionId, to, model) => {
      moves.push([sessionId, to, model]);
      return true;
    });
    const resolution = await resolve(sessionRequest("opusAnywhere"));
    expect(resolution.ok).toBe(false);
    expect(moves).toEqual([["s-1", "work", "opus"]]);
  });
});

describe("routing by name from a provider session", () => {
  it("routes a provider-qualified model name off the launch provider when the session asked to route by name", async () => {
    const upstream = await bodyRecordingUpstream();
    const elsewhere = await bodyRecordingUpstream();
    const files: Record<string, unknown> = {
      [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] } },
      [`${PROVIDERS_DIR}/m.json`]: { displayName: "M", baseUrl: `http://127.0.0.1:${String(elsewhere.port)}`, credential: { sources: [{ literal: "m-token" }] } },
    };
    const door = await startDoor(resolver(files));
    try {
      const response = await fetch(`${door.url}/providers/z/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" },
        body: JSON.stringify({ model: "m/glm-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(upstream.seen()).toHaveLength(0);
      expect(elsewhere.seen()).toHaveLength(1);
    } finally {
      await door.close();
    }
  });
});

describe("a family and the capabilities it carries", () => {
  const files: Record<string, unknown> = {
    [`${PROVIDERS_DIR}/z.json`]: { displayName: "Z", baseUrl: "https://z.example/api", credential: { sources: [{ literal: "z-token" }] } },
    [`${PROVIDERS_DIR}/s.json`]: { displayName: "S", baseUrl: "https://s.example/api", credential: { sources: [{ literal: "s-token" }] } },
    [`${PROVIDERS_DIR}/m.json`]: { displayName: "M", baseUrl: "https://m.example/api", credential: { sources: [{ literal: "m-token" }] } },
  };
  const targets = ["z/glm-5.1", "s/hf:zai-org/GLM-5.1", "m/MiniMax-M3"];
  const spentZ: UsageSnapshot = { schemaVersion: 1, identity: "work", updatedAt: new Date(0).toISOString(), providers: { z: { lastRequestAt: new Date(0).toISOString(), lastStatus: 200, rateLimit: { observedAt: new Date(0).toISOString(), headers: {}, unified: { sevenDay: { utilization: 1, resetsAt: new Date(DAY_RESET_MS).toISOString(), status: "rejected" } } } } } };

  const resolverOf = (models: ModelsConfig, snapshot?: UsageSnapshot): ReturnType<typeof createProviderRouteResolver> =>
    createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials(), models: () => models, targets: () => targets, ...(snapshot === undefined ? {} : { usageSnapshotOf: () => snapshot }) });

  /** A routing session's request for `model`, its body optionally carrying an image block. */
  const asked = (model: string, withImage = false): RoutedRequest => ({
    ...request("/providers/z/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: withImage ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] : "hi" }] })),
    session: { identity: "work", sessionId: "s-1", provider: "z", headroom: false, projectId: undefined },
  });

  /** The provider and model name the resolution handed on, read from the replayed body. */
  const servedBy = async (resolution: Awaited<ReturnType<ReturnType<typeof createProviderRouteResolver>>>): Promise<{ readonly route: string; readonly model: string }> => {
    if (!resolution.ok) {
      throw new Error(`refused: ${resolution.message}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of resolution.request?.body ?? []) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return { route: resolution.route.name, model: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model };
  };

  it("serves a request naming a family from the first of its targets that stands, under that target's own model name", async () => {
    expect(await servedBy(await resolverOf({})(asked("family:glm-5-1")))).toEqual({ route: "http:z", model: "glm-5.1" });
    expect(await servedBy(await resolverOf({}, spentZ)(asked("family:glm-5-1")))).toEqual({ route: "http:s", model: "hf:zai-org/GLM-5.1" });
  });

  it("expands a family member of a virtual model to the family's targets", async () => {
    const models: ModelsConfig = { virtual: { across: { mode: "ordered", members: ["family:glm-5-1", "m/MiniMax-M3"] } } };
    expect(await servedBy(await resolverOf(models, spentZ)(asked("across")))).toEqual({ route: "http:s", model: "hf:zai-org/GLM-5.1" });
  });

  it("chooses a family row's target by the mode the family's settings name", async () => {
    const models: ModelsConfig = { families: { "glm-5-1": { mode: "most-allowance" } } };
    expect((await servedBy(await resolverOf(models, spentZ)(asked("family:glm-5-1")))).route).toBe("http:s");
  });

  it("rules out, for a request carrying an image, a target whose family says it takes none", async () => {
    const models: ModelsConfig = { virtual: { smart: { mode: "adaptive", members: ["z/glm-5.1", "m/MiniMax-M3"] } }, families: { "glm-5-1": { vision: false } } };
    expect((await servedBy(await resolverOf(models)(asked("smart", true)))).route).toBe("http:m");
    expect((await servedBy(await resolverOf(models)(asked("smart", false)))).route).toBe("http:z");
  });
});


describe("a virtual model's choice on the resolution", () => {
  const sessionRequest = (model: string): RoutedRequest => ({
    ...request("/providers/z/v1/messages", JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
    session: { identity: undefined, sessionId: "s-1", provider: "z", headroom: false, projectId: undefined },
  });
  const files: Record<string, unknown> = {
    [`${PROVIDERS_DIR}/z.json`]: httpProvider,
    [`${PROVIDERS_DIR}/ag.json`]: antigravityProvider,
  };

  it("carries the name the session asked for and every provider its members span", async () => {
    const models: ModelsConfig = { virtual: { pick: { mode: "ordered", members: ["z/glm-5.3", "ag/gemini-2.5-pro"] } } };
    const resolution = await resolver(files, OWN_PORT, models)(sessionRequest("pick"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.modelChoice).toEqual({ requested: "pick", providers: ["z", "ag"] });
    }
  });

  it("is absent for a qualified name the session picked itself", async () => {
    const resolution = await resolver(files)(sessionRequest("ag/gemini-2.5-pro"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.modelChoice).toBeUndefined();
    }
  });
});
