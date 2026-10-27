import * as net from "node:net";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial, type LeafCert } from "./connect";
import { PROBE_WAIT_MARGIN_MS, probeFrontDoorSync, probeListenerAcceptSync } from "./probe";

/** Enough time for the pure-JS 2048-bit keypairs this file generates. */
const KEYGEN_TIMEOUT_MS = 120_000;

/** The bound given to a probe whose verdict a test reads: a probe starts a worker thread, and on a machine whose run queue is several times its cores that start alone can outlast the production bound, so the verdict would be the probe's own timeout. The tests of the bound itself give the production one or their own. */
const READ_VERDICT_TIMEOUT_MS = 60_000;

/** A bound short enough for a test of the bound to wait out, and distinct from the production one, so a verdict naming it shows the bound given was the bound used. */
const SHORT_PROBE_TIMEOUT_MS = 500;

/**
 * A listener on its own thread. The probe blocks the calling thread while it waits for its verdict, so a server on that same thread could never answer; running it on a worker thread is what lets the synchronous probe talk to a real TLS listener in-process.
 */
const SERVER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const http = require("node:http");
const https = require("node:https");
const handler = (request, response) => {
  response.writeHead(request.url === "/healthz" ? 200 : 404, { "content-type": "text/plain" });
  response.end(request.url === "/healthz" ? "ok" : "no");
};
const server = workerData.leaf === undefined ? http.createServer(handler) : https.createServer({ key: workerData.leaf.keyPem, cert: workerData.leaf.certPem }, handler);
server.on("tlsClientError", (_error, socket) => socket.destroy());
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;

const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map(async (worker) => await worker.terminate()));
});

/** Starts a health-answering listener on a worker thread: HTTPS with `leaf`, or plain HTTP without one. */
async function listenerThread(leaf: LeafCert | undefined): Promise<number> {
  const worker = new Worker(SERVER_SOURCE, { eval: true, workerData: { leaf } });
  workers.push(worker);
  return await new Promise<number>((resolve, reject) => {
    worker.once("message", (port: unknown) => {
      if (typeof port === "number") {
        resolve(port);
        return;
      }
      reject(new Error("listener thread reported no port"));
    });
    worker.once("error", reject);
  });
}

/** A loopback port nothing listens on: bound, read, and released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve(undefined);
    });
  });
  return port;
}

describe("probeFrontDoorSync", () => {
  let ca: CaMaterial;
  let foreignCa: CaMaterial;

  beforeAll(() => {
    ca = generateCa(new Date());
    foreignCa = generateCa(new Date());
  }, KEYGEN_TIMEOUT_MS);

  it(
    "accepts a listener whose loopback leaf chains to agent-shim's CA",
    async () => {
      const port = await listenerThread(mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()));
      expect(probeFrontDoorSync(port, ca.certPem, READ_VERDICT_TIMEOUT_MS)).toEqual({ ok: true });
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "rejects a listener presenting a certificate from any other CA, even for the right names",
    async () => {
      const port = await listenerThread(mintLeaf(foreignCa, LOOPBACK_LEAF_NAMES, new Date()));
      const verdict = probeFrontDoorSync(port, ca.certPem, READ_VERDICT_TIMEOUT_MS);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toMatch(/certificate/i);
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "rejects a leaf from agent-shim's CA that does not name 127.0.0.1",
    async () => {
      const port = await listenerThread(mintLeaf(ca, ["api.anthropic.com"], new Date()));
      const verdict = probeFrontDoorSync(port, ca.certPem, READ_VERDICT_TIMEOUT_MS);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    },
    KEYGEN_TIMEOUT_MS,
  );

  it("fails within its own bound against a listener that accepts the connection and never answers", async () => {
    // The kernel completes the TCP handshake for a listening socket whether or not anything reads from it, so this squatter needs no thread of its own.
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const address = silent.address();
    try {
      const verdict = probeFrontDoorSync(typeof address === "object" && address !== null ? address.port : 0, ca.certPem);
      expect(verdict.ok ? "" : verdict.reason).toContain("no answer within");
    } finally {
      silent.close();
    }
  });

  it("gives up at the bound it is given, whether the worker's own timeout or the waiting thread's margin ends it", async () => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const address = silent.address();
    try {
      const verdict = probeFrontDoorSync(typeof address === "object" && address !== null ? address.port : 0, ca.certPem, SHORT_PROBE_TIMEOUT_MS);
      expect(verdict.ok ? "" : verdict.reason).toMatch(new RegExp(`within (${String(SHORT_PROBE_TIMEOUT_MS)}|${String(SHORT_PROBE_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS)})ms$`));
    } finally {
      silent.close();
    }
  });

  it("rejects a plain-HTTP listener and a port nothing holds", async () => {
    const plain = await listenerThread(undefined);
    expect(probeFrontDoorSync(plain, ca.certPem, READ_VERDICT_TIMEOUT_MS).ok).toBe(false);
    const nothing = probeFrontDoorSync(await closedPort(), ca.certPem, READ_VERDICT_TIMEOUT_MS);
    expect(nothing.ok ? "" : nothing.reason).toContain("ECONNREFUSED");
  });
});

describe("probeListenerAcceptSync", () => {
  it("accepts a listener that accepts a connection, without asking it anything", async () => {
    const port = await listenerThread(undefined);
    expect(probeListenerAcceptSync(port, READ_VERDICT_TIMEOUT_MS)).toEqual({ ok: true });
  });

  it("fails a port nothing listens on, naming the refusal", async () => {
    const port = await closedPort();
    const verdict = probeListenerAcceptSync(port, READ_VERDICT_TIMEOUT_MS);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/ECONNREFUSED/);
  });
});

