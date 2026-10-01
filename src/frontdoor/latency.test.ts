import http from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { admitEverything } from "../test-helpers";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createPassthroughRoute } from "./passthrough";
import { serveRouted } from "./pipeline";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

/** Warm-up requests before either side is timed, so both paths measure steady-state pooled connections, not handshake setup. */
const WARM_UPS = 8;
/** Requests timed per side. Enough for a stable median, few enough to keep the whole test well under a second. */
const SAMPLES = 80;
/**
 * The bound on what the door's hop may add to a request's median latency. The hop is one loopback listener that clones a header map and streams a body it never reads: measured in the tens of microseconds on CI hardware. The bound sits two orders of magnitude above that real cost, absorbing CI scheduling noise, while still failing if the hop ever grows a request's worth of extra work (a second full relay, a TLS handshake per request, a buffering pass over the body).
 */
const ADDED_MEDIAN_BOUND_MS = 2;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
}

describe("the added hop's latency", () => {
  it("keeps the front door's per-request cost far below a request of its own", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const upstreamPort = await listen(upstream);
    const route = createPassthroughRoute("http:z", { baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, stripPrefix: "/providers/z", headroomUpstream: undefined });
    const door = createFrontDoorServer(
      async (request) => {
        await serveRouted(request, { resolveRoute: async () => await Promise.resolve({ ok: true, route }), responseObservers: [], admit: admitEverything, now: () => 0, log: () => undefined });
      },
      () => undefined,
    );
    const handle = await listenFrontDoor(door);
    const doorUrl = `http://127.0.0.1:${String(handle.port)}/providers/z/v1/messages`;
    const directUrl = `http://127.0.0.1:${String(upstreamPort)}/v1/messages`;

    const time = async (url: string): Promise<number> => {
      const started = performance.now();
      const response = await fetch(url, { method: "POST", body: "{}" });
      await response.text();
      return performance.now() - started;
    };

    try {
      for (let index = 0; index < WARM_UPS; index += 1) {
        await time(directUrl);
        await time(doorUrl);
      }
      const direct: number[] = [];
      const proxied: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        direct.push(await time(directUrl));
        proxied.push(await time(doorUrl));
      }
      const directMedian = median(direct);
      const proxiedMedian = median(proxied);
      expect(proxiedMedian - directMedian).toBeLessThan(ADDED_MEDIAN_BOUND_MS);
    } finally {
      await handle.close();
    }
  });
});
