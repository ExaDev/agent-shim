import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial, type LeafCert } from "./connect";
import { PROBE_WAIT_MARGIN_MS, PROBE_WORKER_FAILURE_PREFIX, STARTED_SIGNAL_SOURCE, probeFrontDoorSync, probeListenerAcceptSync, startProbeWorker } from "./probe";
import * as probe from "./probe";

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
  if (request.method === "POST" && request.url === "/__agent-shim/orpc/rest/frontdoor/catalogues/refresh" && request.headers.authorization === "Bearer test-control-token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"requested":true}');
    return;
  }
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

  it("requests a catalogue tick over an authenticated TLS connection", async () => {
    const port = await listenerThread(mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()));
    const result = "requestCatalogueRefreshSync" in probe && typeof probe.requestCatalogueRefreshSync === "function" ? probe.requestCatalogueRefreshSync(port, ca.certPem, "test-control-token", READ_VERDICT_TIMEOUT_MS) : undefined;
    expect(result).toEqual({ ok: true });
  }, KEYGEN_TIMEOUT_MS);

  it("rejects a catalogue request with a foreign certificate or wrong token", async () => {
    const port = await listenerThread(mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()));
    expect(probe.requestCatalogueRefreshSync(port, foreignCa.certPem, "test-control-token", READ_VERDICT_TIMEOUT_MS).ok).toBe(false);
    expect(probe.requestCatalogueRefreshSync(port, ca.certPem, "wrong-token", READ_VERDICT_TIMEOUT_MS).ok).toBe(false);
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
      expect(verdict.ok ? "" : verdict.reason).toMatch(/(?:no answer|the probe did not finish) within \d+ms/);
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

/** A probe bound for the start-up test: the probe itself needs none of it, so it is as short as a bound can be. */
const STARTUP_PROBE_BOUND_MS = 50;
/** How much longer than the whole waiting budget a slow start-up takes, so that the budget is certainly overrun by start-up alone. */
const START_UP_OVERRUN_MS = 200;
/** How long the worker takes to answer after it has signalled that it started: more than the waiting thread needs to wake from its start wait, so the verdict is still unset when it begins waiting for one, and well inside the probe's bound plus margin, so a clock running from the start still sees it. Without this pause a worker that answers at once lets a clock measured from the spawn pass too, since a wait with no time left returns at once when the verdict is already set. */


describe("a probe worker's clock", () => {
  it("starts when the worker starts, so a slow start-up is not counted against the probe's bound", () => {
    const startUpMs = STARTUP_PROBE_BOUND_MS + PROBE_WAIT_MARGIN_MS + START_UP_OVERRUN_MS;
    // A worker that is slow to begin, then answers a moment after it started: the verdict is ok however long it took to start.
    const source = `
const { workerData } = require("node:worker_threads");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(startUpMs)});
${STARTED_SIGNAL_SOURCE}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(STARTUP_PROBE_BOUND_MS)});
const header = new Int32Array(workerData.shared, 0, workerData.headerSlots);
Atomics.store(header, 0, workerData.ok);
Atomics.notify(header, 0);
`;
    expect(startProbeWorker(source, {}, STARTUP_PROBE_BOUND_MS).verdict()).toEqual({ ok: true });
  });
});

/** A worker that never runs anything: an emitter that can be told to report an error. */
class FakeProbeWorker extends EventEmitter {
  public unref(): this {
    return this;
  }
  public async terminate(): Promise<number> {
    return await Promise.resolve(0);
  }
}

describe("a probe worker that fails", () => {
  const FAILURE_MESSAGE = "probe-source-failure";

  /** What every probe source declares before it uses `STARTED_SIGNAL_SOURCE`. */
  const WORKER_DATA_SOURCE = `const { workerData } = require("node:worker_threads");`;

  function expectFailureVerdict(source: string, reasonPart: string = FAILURE_MESSAGE): void {
    const verdict = startProbeWorker(source, {}, STARTUP_PROBE_BOUND_MS).verdict();
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain(reasonPart);
  }

  it("fails the probe, naming the error, when its source throws after it started", () => {
    expectFailureVerdict(`${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)});`);
  });

  it("fails the probe, naming the error, when its source throws before it signals that it started", () => {
    expectFailureVerdict(`${WORKER_DATA_SOURCE}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)});\n${STARTED_SIGNAL_SOURCE}`);
  });

  it("fails the probe when its source is not valid code", () => {
    expectFailureVerdict(`${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)}`, PROBE_WORKER_FAILURE_PREFIX);
  });

  it("fails the probe, naming the reason, when a promise inside it rejects", () => {
    expectFailureVerdict(`${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\nPromise.reject(new Error(${JSON.stringify(FAILURE_MESSAGE)}));`);
  });

  it("answers with the verdict a worker wrote before it failed", () => {
    const source = `const { workerData } = require("node:worker_threads");
${STARTED_SIGNAL_SOURCE}
const header = new Int32Array(workerData.shared, 0, workerData.headerSlots);
Atomics.store(header, 0, workerData.ok);
Atomics.notify(header, 0);
throw new Error(${JSON.stringify(FAILURE_MESSAGE)});`;
    expect(startProbeWorker(source, {}, READ_VERDICT_TIMEOUT_MS).verdict()).toEqual({ ok: true });
  });

  it("does not let an error event on the worker reach the process, and reads as a failed probe", () => {
    const fake = new FakeProbeWorker();
    const probeWorker = startProbeWorker("", {}, STARTUP_PROBE_BOUND_MS, () => fake);
    // An EventEmitter with no listener for "error" throws it, as a real Worker does into the process.
    expect(() => fake.emit("error", new Error(FAILURE_MESSAGE))).not.toThrow();
    const verdict = probeWorker.verdict();
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toContain(FAILURE_MESSAGE);
  });
});

/** The language target `scripts/build.mts` bundles for. */
const BUNDLE_TARGET = "node22";

type BundledProbe = Pick<typeof probe, "probeListenerAcceptSync">;

function isBundledProbe(value: unknown): value is BundledProbe {
  return typeof value === "object" && value !== null && "probeListenerAcceptSync" in value && typeof value.probeListenerAcceptSync === "function";
}

const bundleDirs: string[] = [];

afterEach(() => {
  for (const dir of bundleDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** `probe.ts` bundled as the release bundles it (`scripts/build.mts`: no `keepNames`, no minifying) into a throwaway file, and loaded. `keepNames` is a parameter only so a test can show what it does to the embedded sources. */
async function bundledProbe(keepNames: boolean): Promise<{ readonly source: string; readonly module: BundledProbe }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-probe-bundle-"));
  bundleDirs.push(dir);
  const outfile = path.join(dir, "probe.cjs");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "probe.ts")],
    bundle: true,
    outfile,
    platform: "node",
    format: "cjs",
    target: BUNDLE_TARGET,
    keepNames,
    logLevel: "silent",
  });
  const load: (id: string) => unknown = createRequire(import.meta.url);
  const loaded = load(outfile);
  if (!isBundledProbe(loaded)) {
    throw new Error("the bundled probe does not export probeListenerAcceptSync");
  }
  return { source: fs.readFileSync(outfile, "utf8"), module: loaded };
}

describe("the probe sources in the release bundle", () => {
  it("run in a worker, which holds none of the bundle's helpers", async () => {
    const { source, module } = await bundledProbe(false);
    expect(source).not.toContain("__name(");
    const refused = module.probeListenerAcceptSync(await closedPort(), READ_VERDICT_TIMEOUT_MS);
    expect(refused.ok ? "" : refused.reason).toMatch(/ECONNREFUSED/);
    expect(module.probeListenerAcceptSync(await listenerThread(undefined), READ_VERDICT_TIMEOUT_MS)).toEqual({ ok: true });
  });

  it("fail when the bundle names its functions, which is why the build sets no keepNames", async () => {
    const { source, module } = await bundledProbe(true);
    expect(source).toContain("__name(");
    const verdict = module.probeListenerAcceptSync(await closedPort(), READ_VERDICT_TIMEOUT_MS);
    expect(verdict.ok ? "" : verdict.reason).toContain("__name is not defined");
  });
});
