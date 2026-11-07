import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { cosmiconfigReader } from "../config/load";
import { fakeAsyncCredentials, fakeFs, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createProviderRouteResolver } from "./providerRoute";
import type { RoutedRequest } from "./route";

/** Text standing in for a secret beside the syntax error, which cosmiconfig's own message would quote. */
const SECRET = "sk-FAKESECRET";

const OWN_PORT = 4100;

describe("createProviderRouteResolver and a provider file that is not JSON", () => {
  let providersDir: string;

  beforeEach(() => {
    providersDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-not-json-"));
  });

  afterEach(() => {
    fs.rmSync(providersDir, { recursive: true, force: true });
  });

  function request(url: string): RoutedRequest {
    return { method: "POST", url, headers: {}, body: Readable.from([Buffer.from("{}")]), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
  }

  it("refuses it by name with none of its text, reading it as the real reader does", async () => {
    fs.writeFileSync(path.join(providersDir, "garbled.json"), `{ "credential": { "sources": [{ "literal": ${SECRET} }] } }\n`);
    const upstream = recordingFetch(() => {
      throw new Error("a refused request must not reach an upstream");
    });
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: { ...fakeFs({}), readConfigFile: cosmiconfigReader() },
      providersDir,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const resolution = await resolve(request("/providers/garbled/v1/messages"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.status).toBe(HTTP_STATUS.internalServerError);
      expect(resolution.message).toContain("provider garbled is invalid");
      expect(resolution.message).toContain(`${path.join(providersDir, "garbled.json")} is not valid JSON`);
      expect(resolution.message).not.toContain("FAKESECRET");
    }
  });
});
