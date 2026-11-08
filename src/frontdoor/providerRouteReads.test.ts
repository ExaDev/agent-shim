import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { cosmiconfigReader, type ConfigFileReader } from "../config/load";
import { fakeAsyncCredentials, fakeFs } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const OWN_PORT = 4100;

/**
 * The reads of a configuration file one provider request makes through the door's configuration port, which reads without a cache: the provider's file, once when the request is scoped (whether the session's provider is defined) and once when its route is built. The models block, the catalogue and the identity records are read through the store and the farm's port, not this one. Two small reads a request is what the uncached port costs, so it stays uncached rather than gaining a cache that would have to be validated.
 */
const FILES_A_PROVIDER_REQUEST_READS = 2;

describe("how many configuration files the door reads to resolve one request", () => {
  let providersDir: string;

  beforeEach(() => {
    providersDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-reads-"));
    fs.writeFileSync(path.join(providersDir, "z.json"), `${JSON.stringify({ displayName: "z.ai", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ literal: "placeholder" }], target: "apiKey" } })}\n`);
  });

  afterEach(() => {
    fs.rmSync(providersDir, { recursive: true, force: true });
  });

  function request(url: string, provider: string | undefined): RoutedRequest {
    return { method: "POST", url, headers: {}, body: Readable.from([Buffer.from("{}")]), signal: new AbortController().signal, session: { identity: "work", sessionId: "session", provider, headroom: false, projectId: undefined } };
  }

  /** Resolves `url` once with a reader that counts its loads, and returns the count. */
  async function readsFor(url: string, provider: string | undefined): Promise<number> {
    let reads = 0;
    const real = cosmiconfigReader();
    const counting: ConfigFileReader = (file) => {
      reads += 1;
      return real(file);
    };
    const upstream = recordingFetch(() => new Response("{}", { status: 200 }));
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0,
      fs: { ...fakeFs({}), readConfigFile: counting },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    await resolve(request(url, provider));
    return reads;
  }

  it("is two reads of the provider's file for a provider session's request, and none for one on the identity's own account", async () => {
    expect(await readsFor("/v1/messages", "z")).toBe(FILES_A_PROVIDER_REQUEST_READS);
    expect(await readsFor("/v1/messages", undefined)).toBe(0);
  });
});
