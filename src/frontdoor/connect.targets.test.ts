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
const HTTP_NOT_FOUND = 404;
/** The header the surface stamps on a request of a session its local surface owns, and the one a client could send to claim it. */
const OWNED_STAMP = "x-agent-shim-self-hosted";

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

/** One request with extra header lines on a fresh tunnel, and the status line it was answered with. */
async function statusWithHeaders(connectPort: number, target: string, headers: readonly string[]): Promise<string> {
  const secure = await connectThroughProxy(connectPort, CONNECT_INTERCEPT_HOST, ca.certPem);
  const answered = await requestOn(secure, `GET ${target} HTTP/1.1\r\nHost: ${CONNECT_INTERCEPT_HOST}\r\n${headers.map((line) => `${line}\r\n`).join("")}Connection: close\r\n\r\n`);
  secure.destroy();
  return answered.statusLine;
}

/** A local surface that owns every launch or none and declines every request, so whatever happens to a request is the connect surface's own decision. */
function decliningSurface(owns: boolean): NonNullable<Parameters<typeof makeTlsWorld>[2]>["localSurface"] {
  return { ownsLaunch: () => owns, ownsPeer: async () => await Promise.resolve(owns), mintGeneration: () => "fixed", serve: async () => await Promise.resolve(false) };
}

describe("requests the connect surface cannot decide or serve", () => {
  it(
    "refuses a target the URL parser cannot read with a 400, forwarding nothing, and keeps serving",
    async () => {
      const world = makeTlsWorld(ca, upstreamCa);
      const { connectPort, close } = await world.start();
      try {
        for (const target of ["http://x:99999/v1/", "http://%zz/v1/x", "http://[::1/v1/x", "//v1/x", "//api.anthropic.com/v1/messages"]) {
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

  it(
    "never forwards a request an owned session's surface declines, and stamps what it routes as the surface's, dropping a copy the client sent",
    async () => {
      const owned = makeTlsWorld(ca, upstreamCa, { localSurface: decliningSurface(true) });
      const { connectPort, close } = await owned.start();
      try {
        expect(await statusOf(connectPort, "/api/claude_code_grove")).toContain(String(HTTP_NOT_FOUND));
        expect(owned.upstreamRequests).toEqual([]);
        expect(await statusWithHeaders(connectPort, "/v1/messages", [`${OWNED_STAMP}: 0`])).toContain(String(HTTP_OK));
        expect(owned.routedRequests.map((routed) => routed.headers[OWNED_STAMP])).toEqual(["1"]);
      } finally {
        await close();
        await owned.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "forwards a session the surface does not own as it always did, and lets no client claim ownership by sending the stamp",
    async () => {
      const native = makeTlsWorld(ca, upstreamCa, { localSurface: decliningSurface(false) });
      const { connectPort, close } = await native.start();
      try {
        expect(await statusWithHeaders(connectPort, "/v1/messages", [`${OWNED_STAMP}: 1`])).toContain(String(HTTP_OK));
        expect(native.routedRequests.map((routed) => routed.headers[OWNED_STAMP])).toEqual([undefined]);
        await statusOf(connectPort, "/api/claude_code_grove");
        expect(native.upstreamRequests.map((forwarded) => forwarded.url)).toEqual(["/api/claude_code_grove"]);
      } finally {
        await close();
        await native.stop();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});
