import { beforeAll, describe, expect, it } from "vitest";

import { CONNECT_INTERCEPT_HOST, generateCa, type CaMaterial } from "./connect";
import { connectThroughProxy, HTTP_OK, KEYGEN_TIMEOUT_MS, makeTlsWorld, requestOn } from "./connectTestWorld";

/**
 * What the connect surface does with a request it cannot decide or serve: a target the URL parser cannot read, and a local surface that fails while serving. Each must be answered on its own session and leave the door serving every other request, since one process carries every session's tunnels.
 */

/** The statuses these cases expect: the refusal of an unreadable target, and the answer to a failure while serving. */
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;

let ca: CaMaterial;
let upstreamCa: CaMaterial;

beforeAll(() => {
  ca = generateCa(new Date());
  upstreamCa = generateCa(new Date());
}, KEYGEN_TIMEOUT_MS);

/** One request on a fresh tunnel, and the status line it was answered with. */
async function statusOf(connectPort: number, target: string): Promise<string> {
  const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
  const answered = await requestOn(secure, `GET ${target} HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\nConnection: close\r\n\r\n`);
  secure.destroy();
  return answered.statusLine;
}

describe("requests the connect surface cannot decide or serve", () => {
  it(
    "refuses a target the URL parser cannot read with a 400, forwarding nothing, and keeps serving",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        for (const target of ["http://x:99999/v1/", "http://%zz/v1/x", "http://[::1/v1/x"]) {
          expect(await statusOf(connectPort, target), target).toContain(String(HTTP_BAD_REQUEST));
        }
        expect(world.routedRequests).toEqual([]);
        expect(world.upstreamRequests).toEqual([]);
        expect(await statusOf(connectPort, "/v1/messages")).toContain(String(HTTP_OK));
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "answers a local surface that fails while serving with a 500, and keeps serving",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa, {
        localSurface: {
          parsesHost: () => false,
          ownsLaunch: () => true,
          serve: async (_host, request) => {
            if (request.url === "/fails") {
              throw new Error("the local surface failed");
            }
            return await Promise.resolve(false);
          },
        },
      });
      const { connectPort, close } = await world.start();
      try {
        expect(await statusOf(connectPort, "/fails")).toContain(String(HTTP_INTERNAL_SERVER_ERROR));
        expect(await statusOf(connectPort, "/v1/messages")).toContain(String(HTTP_OK));
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
