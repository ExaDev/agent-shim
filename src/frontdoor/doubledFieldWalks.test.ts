import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";
import * as walks from "./topLevelModel";

// The all-fields walk over a body is counted, not timed: a Messages request that rewrites nothing never pays for it, and one that rewrites pays for it once.
vi.mock("./topLevelModel", async (importOriginal) => {
  const actual = await importOriginal<typeof walks>();
  return { ...actual, hasSeveralTopLevelModels: vi.fn(actual.hasSeveralTopLevelModels) };
});

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;

function resolver(): ReturnType<typeof createProviderRouteResolver> {
  const stub = recordingFetch(() => {
    throw new Error("no upstream call");
  });
  const http = { displayName: "Spark", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "m" } };
  return createProviderRouteResolver({
    fs: fakeFs({ [`${PROVIDERS_DIR}/spark.json`]: http }),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => 1,
    env: {},
    credentials: fakeAsyncCredentials(),
    log: () => undefined,
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
  });
}

function post(model: string): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([Buffer.from(JSON.stringify({ model, max_tokens: 1, messages: [] }))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

describe("the walk over every model field of a body", () => {
  it.each([
    ["a Claude name no provider claims, which nothing rewrites", "claude-sonnet-5-5", 0],
    ["a name that is no provider's, which nothing rewrites", "some-model", 0],
    ["a provider's qualified name, which is rewritten", "spark/chosen", 1],
    ["a provider's bare name, which is rewritten", "spark", 1],
  ])("is made %s: %s times", async (_label, model, expected) => {
    vi.mocked(walks.hasSeveralTopLevelModels).mockClear();
    await resolver()(post(model));
    expect(vi.mocked(walks.hasSeveralTopLevelModels)).toHaveBeenCalledTimes(expected);
  });
});

describe("the memo of the doubled-field walk", () => {
  it("walks once however many times a scan is asked", async () => {
    vi.mocked(walks.hasSeveralTopLevelModels).mockClear();
    const scan = await scanRequestHead(post("spark/chosen"), true);
    scan.hasSeveralModelFields();
    scan.hasSeveralModelFields();
    scan.hasSeveralModelFields();
    expect(vi.mocked(walks.hasSeveralTopLevelModels)).toHaveBeenCalledTimes(1);
  });
});
