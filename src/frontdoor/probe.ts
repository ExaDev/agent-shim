import { refuseToBlockInRole } from "../processRole";
import { Worker, type WorkerOptions } from "node:worker_threads";

import { DOOR_SOURCE_PORT_COUNT, DOOR_SOURCE_PORT_END, DOOR_SOURCE_PORT_START, SourcePortRange } from "./connectEffects";
import { createDoorLookup, doorDial, probeAccept, runAcceptProbe } from "./doorDial";

/** The outcome of authenticating the listener a front-door state file names. */
export type ListenerVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** How long the probe waits for the listener: a live door answers its health endpoint in milliseconds, so the bound only bites on a wedged or hostile listener. */
export const PROBE_TIMEOUT_MS = 2_000;

/** Extra time the waiting thread allows past the probe's own timeout, so the worker's own timeout verdict arrives rather than the outer wait expiring first. */
export const PROBE_WAIT_MARGIN_MS = 1_000;

/** Bytes reserved for the failure reason the worker hands back; a TLS or socket error message is one short line. */
const REASON_BYTES = 1_024;

/** Slots in the shared header: the verdict, the reason's byte length, whether the worker has started, then the claim on the verdict. */
const HEADER_SLOTS = 4;
/** The header slot a worker sets once its code is running, so the waiting thread starts a probe's clock when the probe starts and not when the thread was asked for. */
const STARTED_SLOT = 2;
/** The header slot whoever writes a verdict first takes (0 to 1) before writing the reason and then the verdict, so exactly one writer's reason and verdict are ever published and the reason is complete whenever the verdict slot is not pending. */
const CLAIM_SLOT = 3;
/** The longest the waiting thread gives a worker to begin running: starting a thread is local work that only load can stretch, so this is generous, and it exists so that a worker that never starts ends the wait instead of blocking the launcher for good. */
export const PROBE_WORKER_START_LIMIT_MS = 10_000;
/** What each worker source runs first: it marks the worker started. The sources are templates over `workerData`, which carries `startedSlot`. */
export const STARTED_SIGNAL_SOURCE = "Atomics.store(new Int32Array(workerData.shared, 0, workerData.headerSlots), workerData.startedSlot, 1); Atomics.notify(new Int32Array(workerData.shared, 0, workerData.headerSlots), workerData.startedSlot);";
/** The text every probe source starts with: the worker's data and the signal that it started. Every source is built through it, so a source cannot omit the signal, which would leave a probe whose own bound is longer than the start limit ending at the start limit. */
export function probeWorkerSource(body: string): string {
  return `const { workerData } = require("node:worker_threads");\n${STARTED_SIGNAL_SOURCE}\n${body}`;
}

/** What a failed probe's reason starts with when the worker itself broke (an uncaught error, a rejected promise, source that does not parse), ahead of the error's message and nothing else of it. */
export const PROBE_WORKER_FAILURE_PREFIX = "the probe worker failed: ";
const INT32_BYTES = 4;
const VERDICT_PENDING = 0;
const WORKER_NOT_STARTED = 0;
const VERDICT_OK = 1;
const VERDICT_FAILED = 2;

/**
 * What every worker runs first, in front of the probe source. It defines `finishProbe(verdict, message)`, the one way a worker publishes a verdict: it takes the claim slot (a later call is ignored), writes the reason and its length, stores the verdict and wakes the waiting thread, which is blocked and cannot hear an event. It always wakes the waiter, even when it lost the claim, so a wake never depends on who won. It also turns an uncaught error or a rejected promise anywhere in the worker into a failed verdict (the `unhandledRejection` handler is redundant under Node's default mode, where an unhandled rejection becomes an uncaught exception, and matters only under `--unhandled-rejections=warn` or `none`, which a worker inherits from the process's execArgv; it stays so the verdict does not depend on that flag), which marks the worker started so the waiter does not sit out the start limit. The reason is the error's message alone, and a message that cannot be read still ends in a published verdict.
 */
const WORKER_PRELUDE_SOURCE = `
(() => {
  const { workerData } = require("node:worker_threads");
  const header = new Int32Array(workerData.shared, 0, workerData.headerSlots);
  const reason = new Uint8Array(workerData.shared, workerData.headerSlots * 4);
  globalThis.finishProbe = (verdict, message) => {
    try {
      const bytes = Buffer.from(String(message), "utf8").subarray(0, reason.length);
      if (Atomics.compareExchange(header, workerData.claimSlot, 0, 1) === 0) {
        reason.set(bytes);
        Atomics.store(header, 1, bytes.length);
        Atomics.store(header, 0, verdict);
      }
    } finally {
      Atomics.notify(header, 0);
    }
  };
  const fail = (error) => {
    let message;
    try {
      message = workerData.failurePrefix + (error instanceof Error ? error.message : String(error));
    } catch {
      message = workerData.failurePrefix + "an error that cannot be described";
    }
    try {
      globalThis.finishProbe(workerData.failed, message);
    } finally {
      Atomics.store(header, workerData.startedSlot, 1);
      Atomics.notify(header, workerData.startedSlot);
    }
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  // A worker that ends itself (process.exit in a probe source or a library it calls) runs this in its own thread before it goes: the waiting thread cannot hear the exit event of a worker, since its event loop is blocked on the verdict, so the worker says so itself. A verdict already published is not replaced (the writer takes the claim once).
  process.on("exit", (code) => {
    globalThis.finishProbe(workerData.failed, workerData.failurePrefix + "the worker exited without a verdict (exit code " + String(code) + ")");
  });
})();
`;

/**
 * The probe itself, run on a worker thread so the synchronous launcher can wait on it with `Atomics.wait`: one HTTPS GET of `/healthz` on 127.0.0.1 that trusts only the agent-shim CA (`ca` replaces the default trust store) and checks the leaf names 127.0.0.1. No capability or credential is sent. Kept as plain CommonJS source because the worker evaluates it standalone, outside the bundle.
 */
const PROBE_SOURCE = probeWorkerSource(`
const https = require("node:https");
const { port, ca, timeoutMs, ok, failed } = workerData;
const finish = finishProbe;
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
`);

const CATALOGUE_REQUEST_SOURCE = probeWorkerSource(`
const https = require("node:https");
const { port, ca, token, timeoutMs, ok, failed } = workerData;
const finish = finishProbe;
const request = https.request({ host: "127.0.0.1", port, path: "/__agent-shim/orpc/rest/frontdoor/catalogues/refresh", method: "POST", headers: { authorization: "Bearer " + token }, ca: [ca], agent: false }, (response) => {
  response.resume();
  response.on("end", () => response.statusCode === 200 ? finish(ok, "") : finish(failed, "catalogue refresh request returned HTTP " + String(response.statusCode)));
  response.on("error", (error) => finish(failed, error.message));
});
setTimeout(() => { request.destroy(new Error("no answer within " + String(timeoutMs) + "ms")); }, timeoutMs);
request.on("error", (error) => finish(failed, (error.code ? error.code + ": " : "") + error.message));
request.end();
`);

/** Where probe workers come from: `start` begins one and returns what blocks the calling thread on its verdict. Injected so a test can observe the order in which workers start and are waited on. */
export interface ProbeWorkers {
  readonly start: (source: string, data: Readonly<Record<string, unknown>>, timeoutMs: number) => { readonly verdict: () => ListenerVerdict };
}

const realProbeWorkers: ProbeWorkers = { start: (source, data, timeoutMs) => startProbeWorker(source, data, timeoutMs) };

/** Requests a catalogue keeper tick through the authenticated front-door control API. */
export function requestCatalogueRefreshSync(port: number, caPem: string, token: string, timeoutMs: number = PROBE_TIMEOUT_MS, workers: ProbeWorkers = realProbeWorkers): ListenerVerdict {
  refuseToBlockInRole("a synchronous catalogue refresh request");
  return workers.start(CATALOGUE_REQUEST_SOURCE, { port, ca: caPem, token }, timeoutMs).verdict();
}

/**
 * Authenticates the front door's provider listener before a launch trusts it: a TLS handshake that must chain to agent-shim's CA (whose key only this user can read) for 127.0.0.1, then a healthy answer. A process that merely holds the port (a stale state file's port re-bound by someone else, or a reused pid's listener) cannot complete that handshake, so it fails here and the launch never hands its child that address.
 *
 * Synchronous because the launcher is synchronous right through to `spawnSync`: the HTTPS request runs on a worker thread and this thread blocks on a shared buffer until the worker posts its verdict.
 *
 * The worker gives up after `timeoutMs` (`PROBE_TIMEOUT_MS` in production); a test that reads the verdict of a probe gives it a bound a loaded machine does not reach.
 */
export function probeFrontDoorSync(port: number, caPem: string, timeoutMs: number = PROBE_TIMEOUT_MS, workers: ProbeWorkers = realProbeWorkers): ListenerVerdict {
  refuseToBlockInRole("a synchronous probe of the front door");
  return workers.start(PROBE_SOURCE, { port, ca: caPem }, timeoutMs).verdict();
}

/**
 * The accept probe, run on a worker thread for the same reason: the door's own dial (`doorDial`, over the door's lookup and from its reserved source ports for a name), so what passes is what the door itself can connect to, closed the moment it connects so nothing is sent to the listener. The worker cannot load this bundle, so it is handed the source text of the dial's functions and of `SourcePortRange`, each of which references nothing but its own parameters.
 * Read by `probe.test.ts` from the bundled module, to check the embedded text, which no import of this module names.
 */
const ACCEPT_PROBE_SOURCE = probeWorkerSource(`
const net = require("node:net");
const dns = require("node:dns");
const { host, port, portStart, portEnd, portFirst, timeoutMs, ok, failed } = workerData;
const finish = finishProbe;
const SourcePortRange = ${SourcePortRange.toString()};
const createDoorLookup = ${createDoorLookup.toString()};
const doorDial = ${doorDial.toString()};
const probeAccept = ${probeAccept.toString()};
const runAcceptProbe = ${runAcceptProbe.toString()};
const startTimer = (callback, ms) => { const timer = setTimeout(callback, ms); return () => { clearTimeout(timer); }; };
runAcceptProbe({ net, dns, createDoorLookup, doorDial, probeAccept, SourcePortRange }, { host, port, portStart, portEnd, portFirst, timeoutMs }, startTimer).then((verdict) => {
  finish(verdict.ok ? ok : failed, verdict.ok ? "" : verdict.reason);
});
`);

/**
 * Whether a listener on 127.0.0.1 accepts a TCP connection within the probe's bound (`timeoutMs`), which is all the CONNECT surface can be asked without presenting a launch's capability. Used by `doctor` and `frontdoor status` to tell a listener that accepts from one whose process is alive but whose event loop is not serving, which a supervisor pid check cannot. The bound is `timeoutMs` (`PROBE_TIMEOUT_MS` in production).
 */
export function probeListenerAcceptSync(port: number, timeoutMs: number = PROBE_TIMEOUT_MS, workers: ProbeWorkers = realProbeWorkers): ListenerVerdict {
  refuseToBlockInRole("a synchronous probe of a front door listener");
  return workers.start(ACCEPT_PROBE_SOURCE, { host: "127.0.0.1", port, portStart: DOOR_SOURCE_PORT_START, portEnd: DOOR_SOURCE_PORT_END }, timeoutMs).verdict();
}

/**
 * The share of the door's reserved source ports (as the reciprocal of a fraction) that the probes of one batch may hold at once: a probe of a named host takes one while it connects, and the door's live dials draw on the same range.
 */
const PROBE_PORT_SHARE_DENOMINATOR = 100;

/** How many probe workers one batch runs at once: the probes' share of the reserved range, a worker holding one source port while it connects. Each worker is a thread with an isolate of its own, so the bound also keeps a batch's memory to a fixed number of them however many providers are configured. */
export const MAX_CONCURRENT_PROBES = Math.max(1, Math.floor(DOOR_SOURCE_PORT_COUNT / PROBE_PORT_SHARE_DENOMINATOR));

/** What a process's id is multiplied by to place its batch's first port in the range: a number that does not divide the range's width, so processes with successive ids start far apart and batches of different processes do not all begin at the first port. */
const PORT_BASE_SPREAD = 389;

/** Where a batch of this process starts in the reserved range, as an offset from its first port. */
const processPortBase = (): number => (process.pid * PORT_BASE_SPREAD) % DOOR_SOURCE_PORT_COUNT;

/** A probe target's identity: two providers on one host and port with one bound need one connection between them. */
const targetKey = (target: { readonly host: string; readonly port: number; readonly timeoutMs: number }): string => `${target.host}\u0000${String(target.port)}\u0000${String(target.timeoutMs)}`;

/**
 * Whether the door's own dial reaches each address within its bound: one connect each, closed again the moment it is accepted, so no request reaches a listener. Targets that name the same host, port and bound are probed once and share the verdict. At most `MAX_CONCURRENT_PROBES` workers run at once, each started before the verdict of the one that many places ahead is waited on, so the probes run together up to that bound and the rest start as earlier ones answer. Each worker's source-port rotation starts at its own place in the reserved range: the batch's offset (`portBase`, from the process id by default, so batches of different processes start apart) plus the worker's index times a stride that spreads the batch's workers over the range, or by one port where there are more targets than ports. While the batch has no more unique targets than the range has ports, every worker's first port is its own, since workers running at once differ in index by fewer than `MAX_CONCURRENT_PROBES` and the stride is at least one; past the range's width the index wraps onto ports earlier workers used, which the dial walks past within its own retry bound (one attempt for each port of the range). The ports a probe used stay in TIME_WAIT for a while after it closes, so a process runs one batch: `doctor`, `check` and a launch each probe once. Verdicts are returned in the order of `targets`.
 */
export function probeAddressesAcceptSync(targets: readonly { readonly host: string; readonly port: number; readonly timeoutMs: number }[], workers: ProbeWorkers = realProbeWorkers, portBase?: number): readonly ListenerVerdict[] {
  refuseToBlockInRole("a synchronous probe of a provider's address");
  const base = portBase ?? processPortBase();
  const distinct = new Map<string, { readonly host: string; readonly port: number; readonly timeoutMs: number }>();
  for (const target of targets) {
    distinct.set(targetKey(target), target);
  }
  const unique = Array.from(distinct.values());
  const stride = Math.max(1, Math.floor(DOOR_SOURCE_PORT_COUNT / unique.length));
  const verdicts = new Map<string, ListenerVerdict>();
  const running: { readonly key: string; readonly verdict: () => ListenerVerdict }[] = [];
  const settleOldest = (): void => {
    const oldest = running.shift();
    if (oldest !== undefined) {
      verdicts.set(oldest.key, oldest.verdict());
    }
  };
  unique.forEach((target, index) => {
    if (running.length >= MAX_CONCURRENT_PROBES) {
      settleOldest();
    }
    const portFirst = DOOR_SOURCE_PORT_START + ((base + index * stride) % DOOR_SOURCE_PORT_COUNT);
    // A worker that cannot be started is that target's failed verdict, and the workers already running are still settled, so their threads are ended and the launch or doctor run goes on to say what it found.
    try {
      running.push({ key: targetKey(target), verdict: workers.start(ACCEPT_PROBE_SOURCE, { host: target.host, port: target.port, portStart: DOOR_SOURCE_PORT_START, portEnd: DOOR_SOURCE_PORT_END, portFirst }, target.timeoutMs).verdict });
    } catch (error) {
      const reason = `${PROBE_WORKER_FAILURE_PREFIX}the worker could not be started: ${error instanceof Error ? error.message : String(error)}`;
      running.push({ key: targetKey(target), verdict: () => ({ ok: false, reason }) });
    }
  });
  while (running.length > 0) {
    settleOldest();
  }
  return targets.map((target) => {
    const verdict = verdicts.get(targetKey(target));
    if (verdict === undefined) {
      throw new Error("the batch probe settled no verdict for one of its targets");
    }
    return verdict;
  });
}

/** The part of a worker thread this module uses, so a test can stand in a worker that reports an error. */
interface ProbeWorkerHandle {
  readonly on: (event: "error", listener: (error: Error) => void) => unknown;
  readonly unref: () => unknown;
  readonly terminate: () => Promise<number>;
}

/** The blocking wait on a header slot: `Atomics.wait`, which a test replaces with one that records how each wait ended (woken, already changed, or out of time), so a test of a prompt wake asserts on that outcome and not on how long the host took. */
export type ProbeWait = (header: Int32Array, index: number, value: number, timeoutMs: number) => "ok" | "not-equal" | "timed-out";

/** Starts a worker thread running `source`; the real one is `node:worker_threads`. */
export type ProbeWorkerSpawn = (source: string, options: WorkerOptions) => ProbeWorkerHandle;

const spawnRealWorker: ProbeWorkerSpawn = (source, options) => new Worker(source, options);

/**
 * Starts one probe source on a worker thread; `verdict` blocks this thread until the worker answers. The probe's clock runs from the moment the worker signals that it started, for `timeoutMs` plus the margin the worker's own timeout verdict is allowed, so a slow start-up is never counted against the probe's bound; a worker that has not started within `PROBE_WORKER_START_LIMIT_MS` fails the probe. The wait is one blocking step (`withBlockingStep`) bounded by the start limit, the probe's bound and the margin.
 *
 * A worker that breaks is a failed probe, never a crash of this process: `WORKER_PRELUDE_SOURCE` turns an uncaught error or rejection inside the worker into a failed verdict that wakes the waiting thread. The `error` listener here exists only so that an error event never reaches the process as an unhandled one; it writes the same claimed verdict, but the waiting thread blocks this thread's event loop and every caller reads `verdict()` straight after starting, so the listener cannot wake a wait that is already under way. A worker that dies with no one to write a verdict (running out of memory, say) therefore ends as the bounded "did not finish" verdict. The probe source runs through `new Function`, so a source that does not parse also arrives as an error inside the worker.
 *
 * The probe sources embed the source text of functions from this bundle (`Function.prototype.toString`), and the text must run on its own in the worker: it can reference nothing but its own parameters. A bundler option that rewrites function bodies (esbuild's `keepNames` injects calls to a `__name` helper that exists only in the bundle) makes the worker throw a ReferenceError. The check is deliberately narrow, on what is embedded and not on the whole bundle, since a bundled dependency compiled with `keepNames` is harmless: `probe.test.ts` builds this module with the release's own options (`scripts/bundle-options.mts`) and fails if the source handed to a worker contains a `__name` call or does not run in a worker.
 */
export function startProbeWorker(source: string, data: Readonly<Record<string, unknown>>, timeoutMs: number, spawn: ProbeWorkerSpawn = spawnRealWorker, startLimitMs: number = PROBE_WORKER_START_LIMIT_MS, wait: ProbeWait = Atomics.wait): { readonly verdict: () => ListenerVerdict } {
  const startLimit = performance.now() + startLimitMs;
  const shared = new SharedArrayBuffer(HEADER_SLOTS * INT32_BYTES + REASON_BYTES);
  const header = new Int32Array(shared, 0, HEADER_SLOTS);
  let worker: ProbeWorkerHandle;
  try {
    worker = spawn(`${WORKER_PRELUDE_SOURCE}\nnew Function("require", ${JSON.stringify(source)})(require);`, {
      eval: true,
      workerData: { ...data, timeoutMs, shared, ok: VERDICT_OK, failed: VERDICT_FAILED, headerSlots: HEADER_SLOTS, startedSlot: STARTED_SLOT, failurePrefix: PROBE_WORKER_FAILURE_PREFIX, claimSlot: CLAIM_SLOT },
    });
  } catch (error) {
    // A thread that cannot be created (out of memory, out of descriptors) is a failed probe, never a throw out of a launch or a batch whose other workers are already running.
    const reason = `${PROBE_WORKER_FAILURE_PREFIX}the worker could not be started: ${error instanceof Error ? error.message : String(error)}`;
    return { verdict: () => ({ ok: false, reason }) };
  }
  worker.on("error", (error: Error) => {
    if (Atomics.compareExchange(header, CLAIM_SLOT, 0, 1) !== 0) {
      return;
    }
    const bytes = Buffer.from(PROBE_WORKER_FAILURE_PREFIX + error.message, "utf8").subarray(0, REASON_BYTES);
    new Uint8Array(shared, HEADER_SLOTS * INT32_BYTES).set(bytes);
    Atomics.store(header, 1, bytes.length);
    Atomics.store(header, 0, VERDICT_FAILED);
    Atomics.store(header, STARTED_SLOT, 1);
  });
  // The worker must never keep the launcher alive: the verdict is all this thread needs from it.
  worker.unref();
  return {
    verdict: () => {
      try {
        wait(header, STARTED_SLOT, WORKER_NOT_STARTED, Math.max(0, startLimit - performance.now()));
        // A worker that answered already has started, whether or not its signal was seen first.
        if (Atomics.load(header, STARTED_SLOT) === WORKER_NOT_STARTED && Atomics.load(header, 0) === VERDICT_PENDING) {
          return { ok: false, reason: `the probe worker did not start within ${String(startLimitMs)}ms` };
        }
        wait(header, 0, VERDICT_PENDING, timeoutMs + PROBE_WAIT_MARGIN_MS);
        const verdict = Atomics.load(header, 0);
        if (verdict === VERDICT_PENDING) {
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
