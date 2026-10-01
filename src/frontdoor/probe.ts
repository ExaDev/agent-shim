import { Worker } from "node:worker_threads";

/** The outcome of authenticating the listener a front-door state file names. */
export type ListenerVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** How long the probe waits for the listener: a live door answers its health endpoint in milliseconds, so the bound only bites on a wedged or hostile listener. */
const PROBE_TIMEOUT_MS = 2_000;

/** Extra time the waiting thread allows past the probe's own timeout, so the worker's own timeout verdict arrives rather than the outer wait expiring first. */
const PROBE_WAIT_MARGIN_MS = 1_000;

/** Bytes reserved for the failure reason the worker hands back; a TLS or socket error message is one short line. */
const REASON_BYTES = 1_024;

/** Slots in the shared header: the verdict, then the reason's byte length. */
const HEADER_SLOTS = 2;
const INT32_BYTES = 4;
const VERDICT_PENDING = 0;
const VERDICT_OK = 1;
const VERDICT_FAILED = 2;

/**
 * The probe itself, run on a worker thread so the synchronous launcher can wait on it with `Atomics.wait`: one HTTPS GET of `/healthz` on 127.0.0.1 that trusts only the claude-use CA (`ca` replaces the default trust store) and checks the leaf names 127.0.0.1. No capability or credential is sent. Kept as plain CommonJS source because the worker evaluates it standalone, outside the bundle.
 */
const PROBE_SOURCE = `
const { workerData } = require("node:worker_threads");
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
const request = https.get({ host: "127.0.0.1", port, path: "/healthz", ca: [ca], agent: false, timeout: timeoutMs }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    if (response.statusCode === 200 && body === "ok") finish(ok, "");
    else finish(failed, "the listener answered its health probe with HTTP " + String(response.statusCode));
  });
  response.on("error", (error) => finish(failed, error.message));
});
request.on("timeout", () => { request.destroy(new Error("no answer within " + String(timeoutMs) + "ms")); });
request.on("error", (error) => finish(failed, (error.code ? error.code + ": " : "") + error.message));
`;

/**
 * Authenticates the front door's provider listener before a launch trusts it: a TLS handshake that must chain to claude-use's CA (whose key only this user can read) for 127.0.0.1, then a healthy answer. A process that merely holds the port (a stale state file's port re-bound by someone else, or a reused pid's listener) cannot complete that handshake, so it fails here and the launch never hands its child that address.
 *
 * Synchronous because the launcher is synchronous right through to `spawnSync`: the HTTPS request runs on a worker thread and this thread blocks on a shared buffer until the worker posts its verdict.
 */
export function probeFrontDoorSync(port: number, caPem: string): ListenerVerdict {
  const shared = new SharedArrayBuffer(HEADER_SLOTS * INT32_BYTES + REASON_BYTES);
  const header = new Int32Array(shared, 0, HEADER_SLOTS);
  const worker = new Worker(PROBE_SOURCE, {
    eval: true,
    workerData: { port, ca: caPem, timeoutMs: PROBE_TIMEOUT_MS, shared, ok: VERDICT_OK, failed: VERDICT_FAILED, headerSlots: HEADER_SLOTS },
  });
  // The worker must never keep the launcher alive: the verdict is all this thread needs from it.
  worker.unref();
  try {
    const waited = Atomics.wait(header, 0, VERDICT_PENDING, PROBE_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS);
    const verdict = Atomics.load(header, 0);
    if (waited === "timed-out" || verdict === VERDICT_PENDING) {
      return { ok: false, reason: `the probe did not finish within ${String(PROBE_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS)}ms` };
    }
    if (verdict === VERDICT_OK) {
      return { ok: true };
    }
    const length = Atomics.load(header, 1);
    return { ok: false, reason: Buffer.from(new Uint8Array(shared, HEADER_SLOTS * INT32_BYTES, length)).toString("utf8") };
  } finally {
    void worker.terminate();
  }
}
