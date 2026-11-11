import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const OWN_PORT = 4100;
const REQUESTS = 5;

const httpFile = (env: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({ displayName: "Stand-in", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "stand-in-token" }] }, env, ...extra });

/** What the resolver reads from its surroundings while it resolves requests, counted. */
interface Counts {
  readonly targets: () => number;
  readonly resolve: (model: string, provider: string | undefined) => Promise<{ readonly routeName: string; readonly model: string | undefined }>;
}

/** A resolver over `files`, whose targets and catalogue ports count their calls. */
function counting(files: Readonly<Record<string, unknown>>, targetRefs: readonly string[] = []): Counts {
  let targets = 0;
  const upstream = recordingFetch(() => {
    throw new Error("these tests never answer an upstream call");
  });
  const resolver = createProviderRouteResolver({
    fs: fakeFs(Object.fromEntries(Object.entries(files).map(([name, file]) => [`${PROVIDERS_DIR}/${name}.json`, file]))),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => OWN_PORT,
    env: {},
    credentials: fakeAsyncCredentials(),
    log: () => undefined,
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
    targets: () => {
      targets += 1;
      return targetRefs;
    },
  });
  return {
    targets: () => targets,
    resolve: async (model, provider) => {
      const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([Buffer.from(JSON.stringify({ model, max_tokens: 1, messages: [] }))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider, headroom: false, projectId: undefined } };
      const resolution = await resolver(request);
      if (!resolution.ok) {
        throw new Error(resolution.message);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of resolution.request?.body ?? []) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return { routeName: resolution.route.name, model: typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined };
    },
  };
}

describe("the work a request costs the resolver on a provider session", () => {
  it("lists no targets for a bare name that is no provider's", async () => {
    const world = counting({ z: httpFile({ ANTHROPIC_MODEL: "glm-5" }) });
    for (let index = 0; index < REQUESTS; index += 1) {
      await world.resolve("glm-5", "z");
      await world.resolve("claude-haiku-4-5", "z");
    }
    expect(world.targets()).toBe(0);
  });

  it("lists no targets for a name the session provider's env names, though a provider of that name exists", async () => {
    const world = counting({ z: httpFile({ ANTHROPIC_MODEL: "spark" }), spark: httpFile({ ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" }) });
    for (let index = 0; index < REQUESTS; index += 1) {
      expect((await world.resolve("spark", "z")).routeName).toBe("http:z");
    }
    expect(world.targets()).toBe(0);
  });

  it("lists the targets only when the env does not name the model, once for each request that needs them", async () => {
    const world = counting({ z: httpFile({ ANTHROPIC_MODEL: "glm-5" }), spark: httpFile({ ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" }) }, ["z/spark"]);
    expect((await world.resolve("spark", "z")).routeName).toBe("http:z");
    expect(world.targets()).toBe(1);
  });
});
