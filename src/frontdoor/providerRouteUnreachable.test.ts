import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { closedLoopbackPort } from "../test-ports";
import { serveRouted } from "./pipeline";
import { COULD_NOT_CONNECT_LOG_INTERVAL_MS, createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;

/** The direct listener's port the resolver is told; no request in these tests is forwarded back to it. */
const OWN_PORT = 4100;

/** Starts a door serving the routes `resolve` resolves, admitted by a fixed launch token. */
async function startDoor(resolve: ReturnType<typeof createProviderRouteResolver>): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken("launch-token-for-tests"), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  return { url: `http://127.0.0.1:${String(handle.port)}`, close: handle.close };
}

describe("an http provider the door cannot connect to", () => {
  it("answers naming the provider and its base URL, and logs that once per provider per interval while it stays down", async () => {
    const baseUrl = `http://127.0.0.1:${String(await closedLoopbackPort())}`;
    const expected = new RegExp(`^provider spark could not connect to ${baseUrl.replaceAll(".", "\\.")}: `);
    const lines: string[] = [];
    let now = 0;
    const upstream = recordingFetch(() => {
      throw new Error("these tests never answer an upstream call");
    });
    const resolve = createProviderRouteResolver({ mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      log: (line) => {
        lines.push(line);
      },
      now: () => now,
      fs: fakeFs({ [`${PROVIDERS_DIR}/spark.json`]: { displayName: "Spark", baseUrl, credential: { sources: [{ literal: "spark-token" }] } } }),
      providersDir: PROVIDERS_DIR,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const door = await startDoor(resolve);
    const send = async (): Promise<Response> => await fetch(`${door.url}/providers/spark/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: "launch-token-for-tests" }, body: "{}" });
    try {
      const first = await send();
      expect(first.status).toBe(HTTP_STATUS.badGateway);
      const body: unknown = await first.json();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^front door: ${expected.source.slice(1)}`));
      expect(body).toMatchObject({ error: { message: lines[0]?.slice("front door: ".length) } });
      now = COULD_NOT_CONNECT_LOG_INTERVAL_MS - 1;
      expect((await send()).status).toBe(HTTP_STATUS.badGateway);
      expect(lines).toHaveLength(1);
      now = COULD_NOT_CONNECT_LOG_INTERVAL_MS;
      expect((await send()).status).toBe(HTTP_STATUS.badGateway);
      expect(lines).toHaveLength(2);
    } finally {
      await door.close();
    }
  });
});
