import { beforeAll, describe, expect, it } from "vitest";

import { CONNECT_INTERCEPT_HOST, generateCa, type CaMaterial } from "./connect";
import { connectThroughProxy, HTTP_OK, KEYGEN_TIMEOUT_MS, makeTlsWorld, requestOn } from "./connectTestWorld";

/**
 * What the connect surface does with a request it cannot decide or serve: a target the URL parser cannot read, and a local surface that fails while serving. Each must be answered on its own session and leave the door serving every other request, since one process carries every session's tunnels.
 */

/** The statuses these cases expect: the refusal of an unreadable target, and the answer to a failure while serving. */
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;
/** The status the surface stand-in answers its own requests with: one nothing else in the world answers, so a local answer cannot be mistaken for a routed one. */
const HTTP_LOCAL_ANSWER = 299;

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
          ownsLaunch: () => true,
          ownsPeer: async () => await Promise.resolve(true),
          mintGeneration: () => "fixed",
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

  it(
    "ends a session decided under one mint when the mint changes, and decides the reconnection afresh",
    async () => {
      let mint = "identity:other";
      const ownedUnder = (generation: string): boolean => generation === "identity:minted";
      const world = makeTlsWorld(ca, upstreamCa, {
        localSurface: {
          ownsLaunch: () => ownedUnder(mint),
          ownsPeer: async () => await Promise.resolve(ownedUnder(mint)),
          mintGeneration: () => mint,
          serve: async (_host, request, response) => {
            request.resume();
            response.writeHead(HTTP_LOCAL_ANSWER, { "content-length": "0" });
            response.end();
            return await Promise.resolve(true);
          },
        },
      });
      const { connectPort, close } = await world.start();
      try {
        // Decided as not the surface's: routed as usual.
        const before = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
        const kept = `GET /v1/messages HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\n\r\n`;
        expect((await requestOn(before, kept)).statusLine).toContain(String(HTTP_OK));
        // Everything the stale session receives after the mint changes: a session served under the old decision would answer the request; one ended for it answers nothing.
        const afterChange: Buffer[] = [];
        before.on("data", (chunk: Buffer) => {
          afterChange.push(chunk);
        });
        const ended = new Promise<void>((resolve) => {
          before.once("close", () => {
            resolve();
          });
        });
        mint = "identity:minted";
        // The next request on the same session finds the mint changed: the session is ended rather than served under the old decision.
        before.write(kept);
        await ended;
        expect(Buffer.concat(afterChange).toString("utf8")).toBe("");
        // The reconnection is decided under the new mint: the surface's.
        expect(await statusOf(connectPort, "/v1/messages")).toContain(String(HTTP_LOCAL_ANSWER));
      } finally {
        await close();
        await world.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
