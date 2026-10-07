import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeCredentials, fakeFs } from "../test-helpers";
import type { FsPort } from "../launcher/ports";
import type { UsageSnapshot } from "../usage/schema";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, type RoutedRequest } from "./route";

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

function resolver(files: Record<string, unknown>, directPort = OWN_PORT): ReturnType<typeof createProviderRouteResolver> {
  return createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => directPort, env: { Z: "tok-from-z" }, credentials: fakeCredentials() });
}

function request(url: string): RoutedRequest {
  return { method: "POST", url, headers: {}, body: Readable.from(["{}"]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
}

describe("createProviderRouteResolver", () => {
  it("mounts the in-process codex translator for a codex provider, named for it and headroom-eligible with the direct listener's bare origin as the hop's upstream", async () => {
    const resolution = await resolver({ [`${PROVIDERS_DIR}/codex.json`]: codexProvider })(request("/providers/codex/v1/messages"));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.route.name).toBe("codex:codex");
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
      await serveRouted(pipelineRequest, { resolveRoute: resolve, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
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
    const resolve = createProviderRouteResolver({ fs: mutable.fs, providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeCredentials() });
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
    const resolve = createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeCredentials(), usageSnapshotOf: (identity) => (identity === "work" ? snapshot : undefined) });
    const server = createFrontDoorServer(
      async (pipelineRequest) => {
        await serveRouted(pipelineRequest, { resolveRoute: resolve, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
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
