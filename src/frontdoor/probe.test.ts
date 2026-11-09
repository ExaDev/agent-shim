import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { cliBundleOptions } from "../../scripts/bundle-options.mts";
import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial, type LeafCert } from "./connect";
import { PROBE_WAIT_MARGIN_MS, PROBE_WORKER_FAILURE_PREFIX, PROBE_WORKER_START_LIMIT_MS, STARTED_SIGNAL_SOURCE, probeFrontDoorSync, probeListenerAcceptSync, probeWorkerSource, requestCatalogueRefreshSync, startProbeWorker, type ProbeWorkers } from "./probe";
import * as probe from "./probe";

/** Enough time for the pure-JS 2048-bit keypairs this file generates. */
const KEYGEN_TIMEOUT_MS = 120_000;

/** The bound given to a probe whose verdict a test reads: a probe starts a worker thread, and on a machine whose run queue is several times its cores that start alone can outlast the production bound, so the verdict would be the probe's own timeout. The tests of the bound itself give the production one or their own. */
const READ_VERDICT_TIMEOUT_MS = 60_000;

/** A bound short enough for a test of the bound to wait out, and distinct from the production one, so a verdict naming it shows the bound given was the bound used. */
const SHORT_PROBE_TIMEOUT_MS = 500;
/** The reason a probe gives when the host could not start its worker thread within `PROBE_WORKER_START_LIMIT_MS`: on a host so loaded that a thread takes that long to start, a probe of a silent listener ends there, before its bound is ever reached, and says nothing about the bound the test checks. The start limit has its own tests. */
const WORKER_START_LIMIT_REASON = `the probe worker did not start within ${String(PROBE_WORKER_START_LIMIT_MS)}ms`;

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
      expect(verdict.ok ? "" : verdict.reason).toMatch(new RegExp(`(?:(?:no answer|the probe did not finish) within \\d+ms|^${WORKER_START_LIMIT_REASON}$)`));
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
      expect(verdict.ok ? "" : verdict.reason).toMatch(new RegExp(`(?:within (?:${String(SHORT_PROBE_TIMEOUT_MS)}|${String(SHORT_PROBE_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS)})ms|^${WORKER_START_LIMIT_REASON})$`));
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

describe("a probe worker's clock", () => {
  it("starts when the worker starts, so a slow start-up is not counted against the probe's bound", () => {
    const startUpMs = STARTUP_PROBE_BOUND_MS + PROBE_WAIT_MARGIN_MS + START_UP_OVERRUN_MS;
    // A worker that is slow to begin, then answers a moment after it started: the verdict is ok however long it took to start.
    const source = `
const { workerData } = require("node:worker_threads");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(startUpMs)});
${STARTED_SIGNAL_SOURCE}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(STARTUP_PROBE_BOUND_MS)});
finishProbe(workerData.ok, "");
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

  /** How many times shorter than the start limit a prompt wake must be: a wake that did not happen waits out the whole limit, and a loaded machine's start-up and scheduling stay well inside half of it. */
  const PROMPT_WAKE_DIVISOR = 2;
  /** How many start limits the probe bound of a test is whose waiter must be woken by the failure handler alone. */
  const LOST_WAKE_START_LIMITS = 6;
  const LOST_WAKE_BOUND_MS = PROBE_WORKER_START_LIMIT_MS * LOST_WAKE_START_LIMITS;

  function failureReason(source: string): string {
    const verdict = startProbeWorker(source, {}, STARTUP_PROBE_BOUND_MS).verdict();
    expect(verdict.ok).toBe(false);
    return verdict.ok ? "" : verdict.reason;
  }

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

  /** The worker waits for the probe's bound after it signals that it started (longer than the waiting thread needs to settle), so the waiting thread is blocked in its wait for a verdict before the worker writes one without waking it. */
  const SETTLE_SOURCE = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(STARTUP_PROBE_BOUND_MS)});`;
  /** Takes the claim and stores a verdict without waking anyone: what a writer that died between its store and its wake leaves behind. */
  const claimAndStoreSilently = (verdict: string): string => `{ const slots = new Int32Array(workerData.shared, 0, workerData.headerSlots); Atomics.compareExchange(slots, workerData.claimSlot, 0, 1); Atomics.store(slots, 0, ${verdict}); }`;

  it("keeps the verdict a worker published before it failed, since only the first verdict counts", () => {
    // The only wake is the failure handler's, which comes after the claimed `ok` was stored: a handler that overwrote the verdict would be read. The probe's bound is many start limits, so a wake that never came would wait out that bound, far past what even a heavily loaded host takes to start a worker and run its handler.
    const source = `${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\n${SETTLE_SOURCE}\n${claimAndStoreSilently("workerData.ok")}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)});`;
    const startedAt = performance.now();
    expect(startProbeWorker(source, {}, LOST_WAKE_BOUND_MS).verdict()).toEqual({ ok: true });
    expect(performance.now() - startedAt).toBeLessThan(LOST_WAKE_BOUND_MS / PROMPT_WAKE_DIVISOR);
  });

  it("keeps a failure when an ok is written after it", () => {
    const source = `${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\n${SETTLE_SOURCE}\n${claimAndStoreSilently("workerData.failed")}\nfinishProbe(workerData.ok, "");`;
    expect(startProbeWorker(source, {}, STARTUP_PROBE_BOUND_MS).verdict().ok).toBe(false);
  });

  it("holds the whole reason by the time the verdict is published", () => {
    const note = new SharedArrayBuffer(FAILURE_MESSAGE.length);
    const noteBytes = new Uint8Array(note);
    // Every store of the failed verdict records what the reason area held at that moment.
    const source = `${WORKER_DATA_SOURCE}
const reasonArea = new Uint8Array(workerData.shared, workerData.headerSlots * 4);
const reasonLength = new Int32Array(workerData.shared, 0, workerData.headerSlots);
const realStore = Atomics.store;
Atomics.store = (target, index, value) => {
  if (index === 0 && value === workerData.failed) {
    new Uint8Array(workerData.note).set(Buffer.from(reasonArea.subarray(0, Atomics.load(reasonLength, 1))));
  }
  return realStore(target, index, value);
};
${STARTED_SIGNAL_SOURCE}
finishProbe(workerData.failed, ${JSON.stringify(FAILURE_MESSAGE)});`;
    startProbeWorker(source, { note }, STARTUP_PROBE_BOUND_MS).verdict();
    expect(Buffer.from(noteBytes.subarray(0, FAILURE_MESSAGE.length)).toString("utf8")).toBe(FAILURE_MESSAGE);
  });

  it("still ends in a failed verdict when the failure handler itself cannot read the error", () => {
    // Stringifying an object with no prototype throws inside the handler.
    expect(failureReason(`${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\nPromise.reject(Object.create(null));`)).toBe(`${PROBE_WORKER_FAILURE_PREFIX}an error that cannot be described`);
  });

  it("names the error's message alone, never its stack", () => {
    const stackText = "STACK-TEXT at /some/private/path";
    expect(failureReason(`${WORKER_DATA_SOURCE}\n${STARTED_SIGNAL_SOURCE}\nconst error = new Error(${JSON.stringify(FAILURE_MESSAGE)}); error.stack = ${JSON.stringify(stackText)}; throw error;`)).toBe(`${PROBE_WORKER_FAILURE_PREFIX}${FAILURE_MESSAGE}`);
  });

  it("does not wait out the start limit when the worker failed before the waiter began to wait", () => {
    const probeWorker = startProbeWorker(`${WORKER_DATA_SOURCE}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)});`, {}, STARTUP_PROBE_BOUND_MS);
    // Block this thread for the wait margin, far longer than a worker needs to fail, so the failure and its wake are over before the first wait: only the stored started flag, not the wake, can end the wait then.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, PROBE_WAIT_MARGIN_MS);
    const startedAt = performance.now();
    const verdict = probeWorker.verdict();
    expect(performance.now() - startedAt).toBeLessThan(PROBE_WORKER_START_LIMIT_MS / PROMPT_WAKE_DIVISOR);
    expect(verdict.ok).toBe(false);
  });

  it("wakes the waiter promptly when it fails before it signals that it started, instead of sitting out the start limit", () => {
    const startedAt = performance.now();
    expectFailureVerdict(`${WORKER_DATA_SOURCE}\nthrow new Error(${JSON.stringify(FAILURE_MESSAGE)});`);
    expect(performance.now() - startedAt).toBeLessThan(PROBE_WORKER_START_LIMIT_MS / PROMPT_WAKE_DIVISOR);
  });

  it("does not let an error event on the worker reach the process, and reads as a failed probe", () => {
    const fake = new FakeProbeWorker();
    const probeWorker = startProbeWorker("", {}, STARTUP_PROBE_BOUND_MS, () => fake);
    // An EventEmitter with no listener for "error" throws it, as a real Worker does into the process.
    const error = new Error(FAILURE_MESSAGE);
    error.stack = "STACK-TEXT at /some/private/path";
    expect(() => fake.emit("error", error)).not.toThrow();
    const startedAt = performance.now();
    const verdict = probeWorker.verdict();
    // Only the listener's started mark ends the start wait: the fake worker runs nothing, so a listener that wrote the verdict without it would leave the waiter sitting out the start limit.
    expect(performance.now() - startedAt).toBeLessThan(PROBE_WORKER_START_LIMIT_MS / PROMPT_WAKE_DIVISOR);
    expect(verdict.ok ? "" : verdict.reason).toBe(`${PROBE_WORKER_FAILURE_PREFIX}${FAILURE_MESSAGE}`);
  });
});

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

/** `probe.ts` bundled with exactly the options the release builds the command line with (`scripts/bundle-options.mts`), into a throwaway file, and loaded; `extra` adds options on top, so a test can show what one does to the embedded sources. */
async function bundledProbe(extra: esbuild.BuildOptions): Promise<BundledProbe> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-probe-bundle-"));
  bundleDirs.push(dir);
  const outfile = path.join(dir, "probe.cjs");
  await esbuild.build({ ...cliBundleOptions(path.resolve(__dirname, "..", "..")), entryPoints: [path.resolve(__dirname, "probe.ts")], outfile, logLevel: "silent", ...extra });
  const load: (id: string) => unknown = createRequire(import.meta.url);
  const loaded = load(outfile);
  if (!isBundledProbe(loaded)) {
    throw new Error("the bundled probe does not export what the test reads");
  }
  return loaded;
}

/** The source the bundled accept probe hands to its worker, taken through the injected workers so that nothing is exported for the test alone. */
function acceptProbeSourceOf(bundled: Readonly<BundledProbe>): string {
  let handed = "";
  bundled.probeListenerAcceptSync(0, STARTUP_PROBE_BOUND_MS, {
    start: (source) => {
      handed = source;
      return { verdict: () => ({ ok: true }) };
    },
  });
  return handed;
}

describe("the probe sources in the release bundle", () => {
  it("run in a worker, which holds none of the bundle's helpers", async () => {
    const bundled = await bundledProbe({});
    expect(acceptProbeSourceOf(bundled)).not.toContain("__name(");
    const refused = bundled.probeListenerAcceptSync(await closedPort(), READ_VERDICT_TIMEOUT_MS);
    expect(refused.ok ? "" : refused.reason).toMatch(/ECONNREFUSED/);
    expect(bundled.probeListenerAcceptSync(await listenerThread(undefined), READ_VERDICT_TIMEOUT_MS)).toEqual({ ok: true });
  });

  it("fail when the bundle names its functions, which is why the build sets no keepNames", async () => {
    const bundled = await bundledProbe({ keepNames: true });
    expect(acceptProbeSourceOf(bundled)).toContain("__name(");
    const verdict = bundled.probeListenerAcceptSync(await closedPort(), READ_VERDICT_TIMEOUT_MS);
    expect(verdict.ok ? "" : verdict.reason).toContain("__name is not defined");
  });
});

describe("the start signal of the probe sources", () => {
  /** The source a probe hands its workers, read through an injected worker set, with the data it would run with. */
  function sourceOf(ask: (probeWorkers: ProbeWorkers) => unknown): { readonly source: string; readonly data: Readonly<Record<string, unknown>> } {
    let handed: { readonly source: string; readonly data: Readonly<Record<string, unknown>> } | undefined;
    ask({
      start: (source, data) => {
        handed = { source, data };
        return { verdict: () => ({ ok: true }) };
      },
    });
    if (handed === undefined) {
      throw new Error("the probe started no worker");
    }
    return handed;
  }

  const SILENT_PROBE_BOUND_MS = 1_500;
  const SHORT_START_LIMIT_MS = 300;
  let authority: CaMaterial;

  beforeAll(() => {
    authority = generateCa(new Date());
  }, KEYGEN_TIMEOUT_MS);

  it("starts every probe source with the signal, whatever the source after it", () => {
    expect(probeWorkerSource("body();")).toContain(STARTED_SIGNAL_SOURCE);
    expect(probeWorkerSource("body();").indexOf(STARTED_SIGNAL_SOURCE)).toBeLessThan(probeWorkerSource("body();").indexOf("body();"));
    const sources = [
      sourceOf((probeWorkers) => probeFrontDoorSync(1, "ca", 1, probeWorkers)).source,
      sourceOf((probeWorkers) => requestCatalogueRefreshSync(1, "ca", "token", 1, probeWorkers)).source,
      sourceOf((probeWorkers) => probeListenerAcceptSync(1, 1, probeWorkers)).source,
    ];
    for (const source of sources) {
      expect(source).toContain(STARTED_SIGNAL_SOURCE);
    }
  });

  it.each([
    ["the health probe", (probeWorkers: ProbeWorkers, port: number, caPem: string) => probeFrontDoorSync(port, caPem, SILENT_PROBE_BOUND_MS, probeWorkers)],
    ["the catalogue refresh request", (probeWorkers: ProbeWorkers, port: number, caPem: string) => requestCatalogueRefreshSync(port, caPem, "token", SILENT_PROBE_BOUND_MS, probeWorkers)],
  ])("lets %s reach its own bound when that is longer than the worker's start limit", async (_name, run) => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const address = silent.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const verdict = run({ start: (source, data, timeoutMs) => startProbeWorker(source, data, timeoutMs, undefined, SHORT_START_LIMIT_MS) }, port, authority.certPem);
      const reason = verdict.ok ? "" : verdict.reason;
      expect(reason).not.toContain("did not start");
      expect(reason).toMatch(/no answer within|did not finish within/);
    } finally {
      silent.close();
    }
  });
});
