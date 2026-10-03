import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch } from "../codex/testing";
import { FAKE_HOME, fakeFs } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

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
    upstream: { fetch: fetch.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" },
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
}

function resolver(files: Record<string, unknown>, directPort = OWN_PORT): ReturnType<typeof createProviderRouteResolver> {
  return createProviderRouteResolver({ fs: fakeFs(files), providersDir: PROVIDERS_DIR, codexPorts: codexPorts(), directPort: () => directPort });
}

function request(url: string): RoutedRequest {
  return { method: "POST", url, headers: {}, body: Readable.from(["{}"]) as unknown as RoutedRequest["body"], signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, headroom: false, projectId: undefined } };
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
