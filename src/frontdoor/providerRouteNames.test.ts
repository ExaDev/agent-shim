import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import type { ModelsConfig } from "../config/schema";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const OWN_PORT = 4100;
const httpProvider = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } };

/** The codex ports the resolver mounts, none of which these tests reach. */
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

function resolver(files: Record<string, unknown>, models?: ModelsConfig, accountMoves?: (sessionId: string, to: string, model: string) => Promise<boolean>): ReturnType<typeof createProviderRouteResolver> {
  return createProviderRouteResolver({
    fs: fakeFs(files),
    providersDir: PROVIDERS_DIR,
    codexPorts: codexPorts(),
    directPort: () => OWN_PORT,
    env: { Z: "tok-from-z" },
    credentials: fakeAsyncCredentials(),
    ...(models === undefined ? {} : { models: () => models }),
    ...(accountMoves === undefined ? {} : { accountMoves }),
  });
}

function request(url: string, model = "opus"): RoutedRequest {
  return {
    method: "POST",
    url,
    headers: {},
    body: Readable.from([Buffer.from(JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }))]),
    signal: new AbortController().signal,
    session: { identity: undefined, sessionId: "s-1", provider: "z", headroom: false, projectId: undefined },
  };
}

describe("a name in a request cannot reach a file outside its directory", () => {
  it("answers a provider path whose encoded name would reach a file outside the providers directory as an unknown provider, not an internal error", async () => {
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider, [`${FAKE_HOME}/x.json`]: httpProvider });
    for (const encoded of ["..%2f..%2fx", "%2e%2e%2fx", "a%2fb"]) {
      const resolution = await resolve(request(`/providers/${encoded}/v1/messages`));
      expect(resolution.ok, encoded).toBe(false);
      if (!resolution.ok) {
        expect(resolution.status, encoded).toBe(HTTP_STATUS.notFound);
        expect(resolution.message, encoded).toContain("no provider named");
      }
    }
  });

  it("does not treat an identity that would name a path as an account target, and requests no move to it", async () => {
    const moves: [string, string, string][] = [];
    const models: ModelsConfig = { virtual: { sneaky: { mode: "ordered", members: ["acct:../../x/opus"] } } };
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }, models, async (sessionId, to, model) => {
      moves.push([sessionId, to, model]);
      return await Promise.resolve(true);
    });
    await resolve(request("/providers/z/v1/messages", "acct:../../x/opus"));
    await resolve(request("/providers/z/v1/messages", "sneaky"));
    expect(moves).toEqual([]);
  });

  it("still requests a move to an identity with an ordinary name", async () => {
    const moves: [string, string, string][] = [];
    const resolve = resolver({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }, undefined, async (sessionId, to, model) => {
      moves.push([sessionId, to, model]);
      return await Promise.resolve(true);
    });
    await resolve(request("/providers/z/v1/messages", "acct:work/opus"));
    expect(moves).toEqual([["s-1", "work", "opus"]]);
  });
});
