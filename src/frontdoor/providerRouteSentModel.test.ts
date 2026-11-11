import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const credential = { sources: [{ literal: "placeholder" }] };

/** A resolver over provider `main`, whose one route (a condition that always holds) sends every request on to `cheap`. */
function resolver(): ReturnType<typeof createProviderRouteResolver> {
  const stub = recordingFetch(() => {
    throw new Error("no upstream call");
  });
  return createProviderRouteResolver({
    fs: fakeFs({
      [`${PROVIDERS_DIR}/main.json`]: { displayName: "Main", baseUrl: "http://127.0.0.1:9", credential, routes: [{ when: { kind: "allOf", operands: [] }, provider: "cheap" }] },
      [`${PROVIDERS_DIR}/cheap.json`]: { displayName: "Cheap", baseUrl: "http://127.0.0.1:9", credential },
    }),
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

function requestWith(body: unknown): RoutedRequest {
  return { method: "POST", url: "/providers/main/v1/messages", headers: {}, body: Readable.from([Buffer.from(JSON.stringify(body))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
}

describe("the served model a matched route reports", () => {
  it("is the model the body names, and none at all for a body that names none", async () => {
    const resolve = resolver();
    const named = await resolve(requestWith({ model: "claude-sonnet-5-5", messages: [] }));
    expect(named.ok && named.servedModel).toBe("claude-sonnet-5-5");
    const unnamed = await resolve(requestWith({ messages: [] }));
    expect(unnamed.ok).toBe(true);
    expect(unnamed).not.toHaveProperty("servedModel");
  });
});
