import * as http from "node:http";
import * as https from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { CONTROL_PATH_PREFIX, createRcControlHandler, frontDoorRcControl, realRcControlTransport, type RcControlTransport } from "./rcControl";
import { generateCa, mintLeaf, LOOPBACK_LEAF_NAMES, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import type { RcInjectResult, RcSessionSummary } from "./rcSessions";

const TOKEN = "control-token-under-test";
/** The sequence number the scripted inject answers with, named so the literal never reads as a magic number. */
const SEQUENCE_NUM = 412;
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const SESSIONS: readonly RcSessionSummary[] = [{ id: SESSION_ID, createdAt: 1_000, lastSeenAt: 2_000 }];

/** The plain-HTTP transport the handler tests use: the handler is transport-agnostic, so a loopback HTTP server exercises it without any TLS setup. */
function plainTransport(port: number): RcControlTransport {
  return {
    request: async (options) =>
      await new Promise((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.body === undefined ? options.headers : { ...options.headers, "content-length": String(Buffer.byteLength(options.body, "utf8")) } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on("end", () => {
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        request.once("error", reject);
        request.end(options.body);
      }),
  };
}

/** Starts the handler on a loopback server and resolves with its port and a stop. */
async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ readonly port: number; readonly stop: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return {
    port: address.port,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      });
    },
  };
}

/** One inject result the scripted handler deps answer with. */
function injectAnswering(result: RcInjectResult): (sessionId: string, text: string) => Promise<RcInjectResult> {
  return async () => await Promise.resolve(result);
}

describe("the Remote Control control handler", () => {
  let running: { port: number; stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("lists the observed sessions for the generation's token, and refuses any other credential", async () => {
    const started = await serve(createRcControlHandler({ expectedToken: TOKEN, list: () => SESSIONS, inject: injectAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }) }));
    running = started;
    const transport = plainTransport(started.port);
    const refused = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: "Bearer wrong" } });
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    const bare = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: {} });
    expect(bare.status).toBe(HTTP_STATUS.unauthorized);
    const allowed = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(allowed.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(allowed.body)).toEqual({ sessions: SESSIONS });
  });

  it("carries an inject out and answers with the sequence numbers, or with the operation's verbose failure", async () => {
    const started = await serve(
      createRcControlHandler({
        expectedToken: TOKEN,
        list: () => SESSIONS,
        inject: injectAnswering({ ok: false, message: "the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale" }),
      }),
    );
    running = started;
    const transport = plainTransport(started.port);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const delivered = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: JSON.stringify({ session: SESSION_ID, text: "run the tests" }) });
    expect(delivered.status).toBe(HTTP_STATUS.badGateway);
    expect(JSON.parse(delivered.body)).toEqual({ error: "the API refused the observed Authorization bearer for this session (HTTP 401): the bearer went stale" });
    const malformed = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: "{not json" });
    expect(malformed.status).toBe(HTTP_STATUS.badRequest);
    const empty = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers, body: JSON.stringify({ session: SESSION_ID }) });
    expect(empty.status).toBe(HTTP_STATUS.badRequest);
    const unknownPath = await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/elsewhere`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(unknownPath.status).toBe(HTTP_STATUS.notFound);
    const wrongMethod = await transport.request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/sessions`, headers, body: "{}" });
    expect(wrongMethod.status).toBe(HTTP_STATUS.methodNotAllowed);
  });

  it("passes the session and text it received to the inject operation", async () => {
    const seen: { session: string; text: string }[] = [];
    const started = await serve(
      createRcControlHandler({
        expectedToken: TOKEN,
        list: () => [],
        inject: async (session, text) => {
          seen.push({ session, text });
          return await Promise.resolve({ ok: true, sequenceNums: [SEQUENCE_NUM] });
        },
      }),
    );
    running = started;
    const answer = await plainTransport(started.port).request({ method: "POST", path: `${CONTROL_PATH_PREFIX}/inject`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ session: SESSION_ID, text: "run the tests" }) });
    expect(answer.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answer.body)).toEqual({ session: SESSION_ID, sequenceNums: [SEQUENCE_NUM] });
    expect(seen).toEqual([{ session: SESSION_ID, text: "run the tests" }]);
  });
});

describe("the control client", () => {
  let running: { port: number; stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it("lists sessions and delivers a prompt through the transport, surfacing the door's verbose failure message", async () => {
    const started = await serve(createRcControlHandler({ expectedToken: TOKEN, list: () => SESSIONS, inject: injectAnswering({ ok: true, sequenceNums: [SEQUENCE_NUM] }) }));
    running = started;
    const control = frontDoorRcControl(plainTransport(started.port), TOKEN);
    expect(await control.listSessions()).toEqual(SESSIONS);
    expect(await control.sendPrompt(SESSION_ID, "run the tests")).toEqual({ ok: true, sequenceNums: [SEQUENCE_NUM] });
    await started.stop();
    const unreachable = await frontDoorRcControl(plainTransport(started.port), TOKEN).sendPrompt(SESSION_ID, "hello");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.message).toContain("could not reach the front door's control listener");
    }
  });
});

describe("the real control transport's TLS", () => {
  let ca: CaMaterial;
  let server: https.Server | undefined;

  beforeEach(() => {
    ca = generateCa(new Date());
  }, KEYGEN_TIMEOUT_MS);

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve(undefined);
        });
      });
    }
    server = undefined;
  });

  it("reaches a listener whose leaf chains to the given CA, and refuses one signed by any other", async () => {
    const otherCa = generateCa(new Date());
    const leaf = mintLeaf(ca, [...LOOPBACK_LEAF_NAMES], new Date());
    server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions: SESSIONS }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    const answer = await realRcControlTransport(address.port, ca.certPem).request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(answer.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answer.body)).toEqual({ sessions: SESSIONS });
    // A listener holding the port whose certificate chains elsewhere fails the handshake, which is the proof a squatter cannot answer as the door.
    await expect(realRcControlTransport(address.port, otherCa.certPem).request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers: {} })).rejects.toThrow();
  }, KEYGEN_TIMEOUT_MS);
});
