import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { CATALOGUE_REFRESH_TIMEOUT_MS, type CatalogueFetch } from "../providerCatalogue";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { serveRouted } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const TOKEN = "launch-token-for-tests";
const OK = 200;
/** The age a served model stays fresh for, as the lookup documents it. */
const SERVED_AGE_MS = 60_000;
const REQUESTS = 5;

const servers: http.Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(async (close) => { await close(); }));
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }));
});

/** The resolver's model-list reads and its clock are both injected, so the test drives the served-model cache and its failure window with that clock alone: the real clock never moves in any test, so a read of it would show as a cache that does not expire. */
async function setup(): Promise<{ readonly send: () => Promise<number>; readonly reads: () => number; readonly advance: (ms: number) => void; readonly serve: (outcome: "list" | "fail") => void }> {
  let clock = 0;
  let reads = 0;
  let outcome: "list" | "fail" = "list";
  const fetchList: CatalogueFetch = async () => {
    reads += 1;
    return outcome === "fail" ? await Promise.reject(new Error("down")) : await Promise.resolve({ status: OK, body: { data: [{ id: "served" }] } });
  };
  const upstream = http.createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(OK, { "content-type": "application/json" });
    response.end("{}");
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const port = (upstream.address() as AddressInfo).port;
  const stub = recordingFetch(() => {
    throw new Error("no codex call");
  });
  const resolve = createProviderRouteResolver({
    fs: fakeFs({ [`${PROVIDERS_DIR}/spark.json`]: { displayName: "Spark", baseUrl: `http://127.0.0.1:${String(port)}`, credential: { sources: [{ literal: "t" }] } } }),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => 1,
    env: {},
    credentials: fakeAsyncCredentials(),
    catalogueFetch: fetchList,
    log: () => undefined,
    now: () => clock,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
  });
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken(TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  closers.push(handle.close);
  const url = `http://127.0.0.1:${String(handle.port)}/providers/spark/v1/messages`;
  return {
    send: async () => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: TOKEN }, body: JSON.stringify({ model: "auto", max_tokens: 1, messages: [] }) }).then(async (response) => { await response.text(); return response; })).status,
    reads: () => reads,
    advance: (ms) => {
      clock += ms;
    },
    serve: (next) => {
      outcome = next;
    },
  };
}

describe("the served-model cache runs on the resolver's injected clock", () => {
  it("reads the list once for requests within the age, and again once the injected clock has passed it", async () => {
    const world = await setup();
    for (let request = 0; request < REQUESTS; request += 1) {
      expect(await world.send()).toBe(OK);
    }
    expect(world.reads()).toBe(1);
    world.advance(SERVED_AGE_MS);
    await world.send();
    expect(world.reads()).toBe(2);
  });

  it("holds a failed read for the failure window on the injected clock, and reads again after it", async () => {
    const world = await setup();
    world.serve("fail");
    await world.send();
    const failed = world.reads();
    await world.send();
    expect(world.reads()).toBe(failed);
    world.advance(CATALOGUE_REFRESH_TIMEOUT_MS);
    world.serve("list");
    expect(await world.send()).toBe(OK);
    expect(world.reads()).toBeGreaterThan(failed);
  });
});
