import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeCredentials, fakeFs } from "../test-helpers";
import type { FsPort } from "../launcher/ports";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { AUTH_HEADER, type RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
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
  return { method: "POST", url, headers: {}, body: Readable.from(["{}"]) as unknown as RoutedRequest["body"], signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
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
