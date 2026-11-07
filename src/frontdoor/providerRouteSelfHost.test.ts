import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { FrontDoorRoute, RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const OWN_PORT = 4100;
const httpProvider = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } };

/** The codex ports the resolver mounts, faked: no case here routes to codex, so any upstream call fails loudly. */
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

/** The mode's route, faked: only its identity matters to the resolution. */
const selfHostRoute: FrontDoorRoute = { name: "rc-selfhost", headroomEligible: false, headroomUpstream: undefined, serve: async () => Promise.resolve() };

/** The mode's ownership predicate, faked to the one fact it decides on: the minted bearer. */
const owns = (headers: Readonly<IncomingHttpHeaders>): boolean => headers.authorization === "Bearer minted";

const selfHosted = (): ReturnType<typeof createProviderRouteResolver> =>
  createProviderRouteResolver({ fs: fakeFs({ [`${PROVIDERS_DIR}/z.json`]: httpProvider }), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => OWN_PORT, env: { Z: "tok-from-z" }, credentials: fakeAsyncCredentials(), rcSelfHost: { route: selfHostRoute, owns } });

/** One bare request presenting a bearer, from a session that named the given provider or none. */
function presenting(url: string, authorization: string, provider?: string): RoutedRequest {
  return { method: "POST", url, headers: { authorization }, body: Readable.from([Buffer.from("{}")]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider, headroom: false, projectId: undefined } };
}

describe("the self-hosted Remote Control mode's share of the bare /v1/ targets", () => {
  it("hands the mode every bare /v1/ request presenting its credential, so none rides the pass-through to the real API", async () => {
    const resolution = await selfHosted()(presenting("/v1/mcp_servers?limit=1000", "Bearer minted"));
    expect(resolution.ok && resolution.route.name).toBe("rc-selfhost");
  });

  it("leaves a native credential's /v1/ request on the pass-through, and a provider session's inference on its provider", async () => {
    const native = await selfHosted()(presenting("/v1/mcp_servers?limit=1000", "Bearer native"));
    expect(native.ok && native.route.name).toBe("anthropic");
    const provider = await selfHosted()(presenting("/v1/messages", "Bearer minted", "z"));
    expect(provider.ok && provider.route.name).toBe("http:z");
  });
});
