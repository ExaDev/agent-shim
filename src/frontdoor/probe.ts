import { refuseToBlockInRole } from "../processRole";
import { Worker } from "node:worker_threads";

import { DOOR_SOURCE_PORT_END, DOOR_SOURCE_PORT_START, SourcePortRange } from "./connectEffects";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe } from "./doorDial";

/** The outcome of authenticating the listener a front-door state file names. */
export type ListenerVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** How long the probe waits for the listener: a live door answers its health endpoint in milliseconds, so the bound only bites on a wedged or hostile listener. */
export const PROBE_TIMEOUT_MS = 2_000;

/** Extra time the waiting thread allows past the probe's own timeout, so the worker's own timeout verdict arrives rather than the outer wait expiring first. */
export const PROBE_WAIT_MARGIN_MS = 1_000;

/** Bytes reserved for the failure reason the worker hands back; a TLS or socket error message is one short line. */
const REASON_BYTES = 1_024;

/** Slots in the shared header: the verdict, the reason's byte length, then whether the worker has started. */
const HEADER_SLOTS = 3;
/** The header slot a worker sets once its code is running, so the waiting thread starts a probe's clock when the probe starts and not when the thread was asked for. */
const STARTED_SLOT = 2;
/** The longest the waiting thread gives a worker to begin running: starting a thread is local work that only load can stretch, so this is generous, and it exists so that a worker that never starts ends the wait instead of blocking the launcher for good. */
const PROBE_WORKER_START_LIMIT_MS = 10_000;
/** What each worker source runs first: it marks the worker started. The sources are templates over `workerData`, which carries `startedSlot`. */
export const STARTED_SIGNAL_SOURCE = "Atomics.store(new Int32Array(workerData.shared, 0, workerData.headerSlots), workerData.startedSlot, 1); Atomics.notify(new Int32Array(workerData.shared, 0, workerData.headerSlots), workerData.startedSlot);";
const INT32_BYTES = 4;
const VERDICT_PENDING = 0;
const WORKER_NOT_STARTED = 0;
const VERDICT_OK = 1;
const VERDICT_FAILED = 2;

/**
 * The probe itself, run on a worker thread so the synchronous launcher can wait on it with `Atomics.wait`: one HTTPS GET of `/healthz` on 127.0.0.1 that trusts only the agent-shim CA (`ca` replaces the default trust store) and checks the leaf names 127.0.0.1. No capability or credential is sent. Kept as plain CommonJS source because the worker evaluates it standalone, outside the bundle.
 */
const PROBE_SOURCE = `
const { workerData } = require("node:worker_threads");
${STARTED_SIGNAL_SOURCE}
const https = require("node:https");
const { port, ca, timeoutMs, shared, ok, failed, headerSlots } = workerData;
const header = new Int32Array(shared, 0, headerSlots);
const reason = new Uint8Array(shared, headerSlots * 4);
let done = false;
const finish = (verdict, message) => {
  if (done) return;
  done = true;
  const bytes = Buffer.from(String(message), "utf8").subarray(0, reason.length);
  reason.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, verdict);
  Atomics.notify(header, 0);
};
const request = https.get({ host: "127.0.0.1", port, path: "/healthz", ca: [ca], agent: false }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    if (response.statusCode === 200 && body === "ok") finish(ok, "");
    else finish(failed, "the listener answered its health probe with HTTP " + String(response.statusCode));
  });
  response.on("error", (error) => finish(failed, error.message));
});
// A hard deadline over the whole exchange, handshake included: a listener that accepts the connection and then says nothing must still fail the probe.
setTimeout(() => { request.destroy(new Error("no answer within " + String(timeoutMs) + "ms")); }, timeoutMs);
request.on("error", (error) => finish(failed, (error.code ? error.code + ": " : "") + error.message));
`;

const CATALOGUE_REQUEST_SOURCE = `
const { workerData } = require("node:worker_threads");
${STARTED_SIGNAL_SOURCE}
const https = require("node:https");
const { port, ca, token, timeoutMs, shared, ok, failed, headerSlots } = workerData;
const header = new Int32Array(shared, 0, headerSlots);
const reason = new Uint8Array(shared, headerSlots * 4);
let done = false;
const finish = (verdict, message) => {
  if (done) return;
  done = true;
  const bytes = Buffer.from(String(message), "utf8").subarray(0, reason.length);
  reason.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, verdict);
  Atomics.notify(header, 0);
};
const request = https.request({ host: "127.0.0.1", port, path: "/__agent-shim/orpc/rest/frontdoor/catalogues/refresh", method: "POST", headers: { authorization: "Bearer " + token }, ca: [ca], agent: false }, (response) => {
  response.resume();
  response.on("end", () => response.statusCode === 200 ? finish(ok, "") : finish(failed, "catalogue refresh request returned HTTP " + String(response.statusCode)));
  response.on("error", (error) => finish(failed, error.message));
});
setTimeout(() => { request.destroy(new Error("no answer within " + String(timeoutMs) + "ms")); }, timeoutMs);
request.on("error", (error) => finish(failed, (error.code ? error.code + ": " : "") + error.message));
request.end();
`;

/** Requests a catalogue keeper tick through the authenticated front-door control API. */
export function requestCatalogueRefreshSync(port: number, caPem: string, token: string, timeoutMs: number = PROBE_TIMEOUT_MS): ListenerVerdict {
  refuseToBlockInRole("a synchronous catalogue refresh request");
  return runProbeWorker(CATALOGUE_REQUEST_SOURCE, { port, ca: caPem, token }, timeoutMs);
}

/**
 * Authenticates the front door's provider listener before a launch trusts it: a TLS handshake that must chain to agent-shim's CA (whose key only this user can read) for 127.0.0.1, then a healthy answer. A process that merely holds the port (a stale state file's port re-bound by someone else, or a reused pid's listener) cannot complete that handshake, so it fails here and the launch never hands its child that address.
 *
 * Synchronous because the launcher is synchronous right through to `spawnSync`: the HTTPS request runs on a worker thread and this thread blocks on a shared buffer until the worker posts its verdict.
 *
 * The worker gives up after `timeoutMs` (`PROBE_TIMEOUT_MS` in production); a test that reads the verdict of a probe gives it a bound a loaded machine does not reach.
 */
export function probeFrontDoorSync(port: number, caPem: string, timeoutMs: number = PROBE_TIMEOUT_MS): ListenerVerdict {
  refuseToBlockInRole("a synchronous probe of the front door");
  return runProbeWorker(PROBE_SOURCE, { port, ca: caPem }, timeoutMs);
}

/**
 * The accept probe, run on a worker thread for the same reason: the door's own dial (`doorDial`, over the door's lookup and from its reserved source ports for a name), so what passes is what the door itself can connect to, closed the moment it connects so nothing is sent to the listener. The worker cannot load this bundle, so it is handed the source text of the dial's functions and of `SourcePortRange`, each of which references nothing but its own parameters.
 */
const ACCEPT_PROBE_SOURCE = `
const { workerData } = require("node:worker_threads");
${STARTED_SIGNAL_SOURCE}
const net = require("node:net");
const dns = require("node:dns");
const { host, port, portStart, portEnd, timeoutMs, shared, ok, failed, headerSlots } = workerData;
const header = new Int32Array(shared, 0, headerSlots);
const reason = new Uint8Array(shared, headerSlots * 4);
const finish = (verdict, message) => {
  const bytes = Buffer.from(String(message), "utf8").subarray(0, reason.length);
  reason.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, verdict);
  Atomics.notify(header, 0);
};
const SourcePortRange = ${SourcePortRange.toString()};
const createDoorLookup = ${createDoorLookup.toString()};
const doorDial = ${doorDial.toString()};
const probeAccept = ${probeAccept.toString()};
const runAcceptProbe = ${runAcceptProbe.toString()};
const startTimer = (callback, ms) => { const timer = setTimeout(callback, ms); return () => { clearTimeout(timer); }; };
runAcceptProbe({ net, dns, createDoorLookup, doorDial, probeAccept, SourcePortRange }, { host, port, portStart, portEnd, timeoutMs }, startTimer).then((verdict) => {
  finish(verdict.ok ? ok : failed, verdict.ok ? "" : verdict.reason);
});
`;

/**
 * Whether a listener on 127.0.0.1 accepts a TCP connection within the probe's bound (`timeoutMs`), which is all the CONNECT surface can be asked without presenting a launch's capability. Used by `doctor` and `frontdoor status` to tell a listener that accepts from one whose process is alive but whose event loop is not serving, which a supervisor pid check cannot. The bound is `timeoutMs` (`PROBE_TIMEOUT_MS` in production).
 */
export function probeListenerAcceptSync(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): ListenerVerdict {
  refuseToBlockInRole("a synchronous probe of a front door listener");
  return runProbeWorker(ACCEPT_PROBE_SOURCE, { host: "127.0.0.1", port, portStart: DOOR_SOURCE_PORT_START, portEnd: DOOR_SOURCE_PORT_END }, timeoutMs);
}

/** Where probe workers come from: `start` begins one and returns what blocks the calling thread on its verdict. Injected so a test can observe that every worker has started before any is waited on. */
export interface ProbeWorkers {
  readonly start: (source: string, data: Readonly<Record<string, unknown>>, timeoutMs: number) => { readonly verdict: () => ListenerVerdict };
}

const realProbeWorkers: ProbeWorkers = { start: (source, data, timeoutMs) => startProbeWorker(source, data, timeoutMs) };

/**
 * Whether the door's own dial reaches each address within its bound: one connect each, closed again the moment it is accepted, so no request reaches a listener. Every probe's worker is started before any is waited on, so the probes run together and the whole takes about the longest bound, not their sum. Verdicts come back in the order the targets were given. What `doctor`, `check` and a launch ask of providers' base URLs.
 */
export function probeAddressesAcceptSync(targets: readonly { readonly host: string; readonly port: number; readonly timeoutMs: number }[], workers: ProbeWorkers = realProbeWorkers): readonly ListenerVerdict[] {
  refuseToBlockInRole("a synchronous probe of a provider's address");
  const started = targets.map((target) => workers.start(ACCEPT_PROBE_SOURCE, { host: target.host, port: target.port, portStart: DOOR_SOURCE_PORT_START, portEnd: DOOR_SOURCE_PORT_END }, target.timeoutMs));
  return started.map((probe) => probe.verdict());
}


/** Runs one probe source on a worker thread and blocks this thread on its verdict, whatever the probe asks, for at most `timeoutMs` plus the margin the waiting thread allows the worker's own timeout verdict. */
function runProbeWorker(source: string, data: Readonly<Record<string, unknown>>, timeoutMs: number): ListenerVerdict {
  return startProbeWorker(source, data, timeoutMs).verdict();
}

/** Starts one probe source on a worker thread; `verdict` blocks this thread until the worker answers. The probe's clock runs from the moment the worker signals that it started, for `timeoutMs` plus the margin the worker's own timeout verdict is allowed, so a slow start-up is never counted against the probe's bound; a worker that has not started within `PROBE_WORKER_START_LIMIT_MS` fails the probe. */
export function startProbeWorker(source: string, data: Readonly<Record<string, unknown>>, timeoutMs: number): { readonly verdict: () => ListenerVerdict } {
  const startLimit = performance.now() + PROBE_WORKER_START_LIMIT_MS;
  const shared = new SharedArrayBuffer(HEADER_SLOTS * INT32_BYTES + REASON_BYTES);
  const header = new Int32Array(shared, 0, HEADER_SLOTS);
  const worker = new Worker(source, {
    eval: true,
    workerData: { ...data, timeoutMs, shared, ok: VERDICT_OK, failed: VERDICT_FAILED, headerSlots: HEADER_SLOTS, startedSlot: STARTED_SLOT },
  });
  // The worker must never keep the launcher alive: the verdict is all this thread needs from it.
  worker.unref();
  return {
    verdict: () => {
      try {
        Atomics.wait(header, STARTED_SLOT, WORKER_NOT_STARTED, Math.max(0, startLimit - performance.now()));
        // A worker that answered already has started, whether or not its signal was seen first.
        if (Atomics.load(header, STARTED_SLOT) === WORKER_NOT_STARTED && Atomics.load(header, 0) === VERDICT_PENDING) {
          return { ok: false, reason: `the probe worker did not start within ${String(PROBE_WORKER_START_LIMIT_MS)}ms` };
        }
        const waited = Atomics.wait(header, 0, VERDICT_PENDING, timeoutMs + PROBE_WAIT_MARGIN_MS);
        const verdict = Atomics.load(header, 0);
        if (waited === "timed-out" || verdict === VERDICT_PENDING) {
          return { ok: false, reason: `the probe did not finish within ${String(timeoutMs + PROBE_WAIT_MARGIN_MS)}ms` };
        }
        if (verdict === VERDICT_OK) {
          return { ok: true };
        }
        const length = Atomics.load(header, 1);
        return { ok: false, reason: Buffer.from(new Uint8Array(shared, HEADER_SLOTS * INT32_BYTES, length)).toString("utf8") };
      } finally {
        void worker.terminate();
      }
    },
  };
}
