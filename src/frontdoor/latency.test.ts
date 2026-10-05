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
/** Requests timed per side before the bound is first checked. Enough that each side's fastest sample approaches its true floor on a quiet machine, few enough to keep the whole test well under a second. */
const MIN_SAMPLES = 80;
/**
 * How long the floors may keep being refined when the bound is not yet met. A fastest sample only approaches a path's floor if some samples run on an unstarved scheduler slice, so on a machine with far more runnable processes than cores a fixed 80 samples can miss every such slice and overstate the door's cost; sampling on until the budget lapses gives the floor the chance to show. A real regression adds its cost to every proxied sample, so no amount of extra sampling hides it.
 */
const SAMPLING_BUDGET_MS = 20_000;
/** Headroom the test's own timeout leaves beyond the sampling budget for set-up and teardown. */
const TIMEOUT_MARGIN_MS = 10_000;
/**
 * The bound on what the door's hop may add to a request's latency floor (each side's fastest sample). The hop is one loopback listener that clones a header map and streams a body it never reads: measured in the tens of microseconds on CI hardware. The bound sits two orders of magnitude above that real cost while still failing if the hop ever grows multi-millisecond work (a TLS handshake per request, a relay plus a buffering pass). The floor, not the median, carries the bound because contention on a shared runner adds stalls asymmetrically to the heavier path, superlinearly on a saturated machine: a median-difference bound measured that noise instead of the door (observed at over three times this cap on an otherwise-green run, #204; a floor ratio bound failed the same way at 2.5x with no regression present), while each side's fastest sample approaches the path's true cost. Sub-millisecond regressions (one extra relay alone) sit below any bound that survives real runners and belong to the correctness suites.
 */
const ADDED_FLOOR_BOUND_MS = 2;

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
      let fastestDirect = Number.POSITIVE_INFINITY;
      let fastestProxied = Number.POSITIVE_INFINITY;
      const started = performance.now();
      for (let sampled = 0; ; sampled += 1) {
        fastestDirect = Math.min(fastestDirect, await time(directUrl));
        fastestProxied = Math.min(fastestProxied, await time(doorUrl));
        const added = fastestProxied - fastestDirect;
        if (sampled + 1 >= MIN_SAMPLES && (added < ADDED_FLOOR_BOUND_MS || performance.now() - started > SAMPLING_BUDGET_MS)) {
          expect(added).toBeLessThan(ADDED_FLOOR_BOUND_MS);
          break;
        }
      }
    } finally {
      await handle.close();
    }
  }, SAMPLING_BUDGET_MS + TIMEOUT_MARGIN_MS);
});
