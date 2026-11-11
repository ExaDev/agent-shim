import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { buildLayoutPaths } from "../paths";
import { catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, catalogueSettingsText } from "../providerCatalogue";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { targetRefs } from "../models/targets";
import { servedModelPorts } from "./cachedCatalogue";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const credential = { sources: [{ literal: "placeholder" }] };
const MAIN = { displayName: "Main", baseUrl: "http://127.0.0.1:9", credential, catalogue: { tier: "sonnet" as const } };
const OTHER = { displayName: "Other", baseUrl: "http://127.0.0.1:9", credential, env: { ANTHROPIC_MODEL: "other-model" } };
const UNREADABLE = 0o000;
const READABLE = 0o600;

describe("a stored catalogue the door cannot read, over a real file", () => {
  const roots: string[] = [];
  const files: string[] = [];
  afterEach(() => {
    for (const file of files.splice(0)) fs.chmodSync(file, READABLE);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A resolver whose stored catalogues are read from real files under a temporary root, holding a catalogue of provider `main` that `main`'s digest matches. */
  function world(): { readonly resolve: ReturnType<typeof createProviderRouteResolver>; readonly catalogueFile: string; readonly log: string[] } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-unreadable-catalogue-"));
    roots.push(root);
    const paths = buildLayoutPaths(root);
    // The providers also exist as real files, which the door's target listing reads for every provider.
    fs.mkdirSync(paths.providersDir, { recursive: true });
    fs.writeFileSync(path.join(paths.providersDir, "main.json"), JSON.stringify(MAIN));
    fs.writeFileSync(path.join(paths.providersDir, "other.json"), JSON.stringify(OTHER));
    const catalogueFile = catalogueCachePath(paths, "main");
    fs.mkdirSync(path.dirname(catalogueFile), { recursive: true });
    fs.writeFileSync(catalogueFile, JSON.stringify({ fetchedAt: 1, url: "http://127.0.0.1:9/v1/models", models: [{ id: "served" }] }));
    fs.mkdirSync(path.dirname(catalogueSettingsPath(paths, "main")), { recursive: true });
    fs.writeFileSync(catalogueSettingsPath(paths, "main"), catalogueSettingsText(catalogueSettingsFingerprint(MAIN), 1));
    const log: string[] = [];
    const stub = recordingFetch(() => {
      throw new Error("no upstream call");
    });
    const resolve = createProviderRouteResolver({
      fs: fakeFs({ [`${PROVIDERS_DIR}/main.json`]: MAIN, [`${PROVIDERS_DIR}/other.json`]: OTHER }),
      providersDir: PROVIDERS_DIR,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => 1,
      env: {},
      credentials: fakeAsyncCredentials(),
      now: () => 0,
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      targets: () => targetRefs(paths),
      ...servedModelPorts(paths, (line) => {
        log.push(line);
      }),
    });
    return { resolve, catalogueFile, log };
  }

  const request = (model = "main", provider = "other"): RoutedRequest => ({ method: "POST", url: `/providers/${provider}/v1/messages`, headers: {}, body: Readable.from([Buffer.from(JSON.stringify({ model, messages: [] }))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } });

  it("takes the default of a bare provider name from the catalogue while the file is readable", async () => {
    const { resolve } = world();
    const resolution = await resolve(request());
    expect(resolution.ok).toBe(true);
  });

  it("refuses a bare provider name that needs a default from it with a 400 naming the provider and the cause class, and no path", async () => {
    const { resolve, catalogueFile, log } = world();
    files.push(catalogueFile);
    fs.chmodSync(catalogueFile, UNREADABLE);
    if (process.getuid?.() === 0) return;
    const resolution = await resolve(request());
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.status).toBe(HTTP_STATUS.badRequest);
    const message = resolution.ok ? "" : resolution.message;
    expect(message).toContain('provider "main"');
    expect(message).toContain("stored catalogue cannot be read (EACCES)");
    expect(message).not.toContain(path.dirname(catalogueFile));
    expect(log.join("\n")).not.toContain("internal error");
  });

  it("is no reason to refuse another provider's bare name, which lists every provider's targets to ask whether the session's own provider serves it", async () => {
    const { resolve, catalogueFile, log } = world();
    files.push(catalogueFile);
    fs.chmodSync(catalogueFile, UNREADABLE);
    if (process.getuid?.() === 0) return;
    const resolution = await resolve(request("other", "main"));
    expect(resolution.ok).toBe(true);
    expect(log.join("\n")).not.toContain("EACCES");
  });
});
