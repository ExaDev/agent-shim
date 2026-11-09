import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

import { CheckReportJsonSchema, type CheckReportJson } from "../checkReportSchema";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
import { MAX_REPORT_CHILDREN } from "./reportLimits";
import { REPORT_PROGRESS_FD, REPORT_PROGRESS_FD_ENV, reportProgressTarget, REPORT_QUIET_MS, createReportOutputReader, createReportProgressReader, reportSilenceWindowMs, ownReleaseIdentity, type ReleaseIdentity } from "./reportProgress";
import { DoctorRunOutputSchema } from "./controlSchemas";
import type { DoctorReport } from "../doctorReport";

/** The argv that runs the door's own executable with `args`. */
export type SelfInvocation = (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };

/** What the door's control API answers `check.run` and `doctor.run` with. */
export interface DoorReports {
  readonly checkReport: (path: string, identity: string | undefined, signal: AbortSignal | undefined) => Promise<CheckReportJson>;
  readonly doctorReport: (signal: AbortSignal | undefined) => Promise<DoctorReport>;
}

/** The exit statuses after which a report command has printed its report: `doctor` exits 1 when any finding fails, and still prints the report. */
const REPORTED_STATUSES: ReadonlySet<number | null> = new Set([0, 1]);

/** The longest a timer may be set for, past which it would fire at once. */
function timerDelay(ms: number): number {
  return Math.min(ms, MAX_TIMER_DELAY_MS);
}

/** How much of a child's stderr the door keeps to name in a failure: the end of it, where the cause is, enough for a few lines of diagnostics. */
const STDERR_TAIL_CHARS = 2_048;

/** The signal that ends a report child, for an expired bound, an aborted request and an over-long stdout alike: a report holds nothing to clean up, and a child blocked in a synchronous probe could not act on a gentler one. */
const END_SIGNAL = "SIGKILL";

/** Ends `child` and everything it started: it leads its own process group (see `runSelfJson`), so the signal goes to the group and a program the report ran (the keychain tool, git) does not outlive the request. Windows has no process groups to signal, so the child alone is ended there. */
function endChild(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, END_SIGNAL);
      return;
    } catch {
      // The group is already gone, which is what was asked for.
    }
  }
  child.kill(END_SIGNAL);
}

/** The child's stream at `index` of its stdio, which `runSelfJson` opened as a pipe the child writes and the door reads; the standard tuple types only describe three entries, so the fourth (the progress pipe) is read through the generic list. */
function readablePipe(child: ChildProcess, index: number): Readable {
  const stream = child.stdio[index];
  if (!(stream instanceof Readable)) {
    throw new Error(`the report child has no pipe at descriptor ${String(index)}`);
  }
  return stream;
}

/** Whether `error` is the failure to start a program that is not there. */
function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

/** What `runSelfJson` is bounded by, and the process it starts. */
interface RunLimits {
  readonly silenceMs: number;
  readonly signal: AbortSignal | undefined;
  readonly spawn: typeof spawn;
}

/**
 * Runs the door's own executable with `args` and reads the JSON report it prints, failing with what it wrote to stderr when it printed none, or when what it printed is not JSON. The child leads its own process group and is ended, with everything it started, and the call fails, once any of these holds: it has gone `limit.silenceMs` (`reportSilenceWindowMs` of the quiet bound) without announcing anything outside a step, or stayed longer than a blocking step's announced bound and `PROBE_WAIT_MARGIN_MS` inside that step (the margin a probe's caller waits past its bound, which also covers a killed command being reaped), the child announcing each on `REPORT_PROGRESS_FD` (see `reportProgress.ts`); `limit.signal` aborts (the request's client went away); or it prints a report longer than the size it announced before it, which is the only bound on what the door keeps, since a report grows with the user's data.
 */
async function runSelfJson(selfInvocation: SelfInvocation, env: NodeJS.ProcessEnv, door: ReleaseIdentity, args: readonly string[], limit: RunLimits): Promise<unknown> {
  const invocation = selfInvocation(args);
  const command = `agent-shim ${args.join(" ")}`;
  limit.signal?.throwIfAborted();
  const { status, signal, stdout, stderr, shortRead } = await new Promise<{ readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string; readonly shortRead: { readonly received: number; readonly announced: number } | undefined }>((resolve, reject) => {
    const child = limit.spawn(invocation.command, [...invocation.args], { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...env, [REPORT_PROGRESS_FD_ENV]: reportProgressTarget(REPORT_PROGRESS_FD, process.pid, door) }, detached: true });
    const cleanups: (() => void)[] = [];
    const finish = (settle: () => void): void => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      settle();
    };
    const fail = (error: unknown): void => {
      endChild(child);
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))); });
    };
    // The watchdog is re-armed by each announcement: inside a step for its bound and margin, between steps for the silence window (`reportSilenceWindowMs` of the quiet bound: a unit's allowance plus the interval its note may be dropped for).
    let watchdog: NodeJS.Timeout;
    const arm = (allowedMs: number): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { fail(new Error(`${command} made no progress within ${String(allowedMs)}ms`)); }, timerDelay(allowedMs));
    };
    arm(limit.silenceMs);
    cleanups.push(() => { clearTimeout(watchdog); });
    const outPipe = readablePipe(child, 1);
    const errPipe = readablePipe(child, 2);
    const progress = readablePipe(child, REPORT_PROGRESS_FD);
    progress.setEncoding("utf8");
    progress.on("data", createReportProgressReader((event) => {
      arm(event.kind === "begin" ? event.boundMs + PROBE_WAIT_MARGIN_MS : limit.silenceMs);
    }));
    const onAbort = (): void => { fail(limit.signal?.reason); };
    limit.signal?.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => { limit.signal?.removeEventListener("abort", onAbort); });
    const output = createReportOutputReader((reason) => { fail(new Error(`${command} ${reason}`)); });
    let err = "";
    outPipe.on("data", (chunk: Buffer | string) => { output.push(chunk); });
    errPipe.setEncoding("utf8");
    errPipe.on("data", (chunk: string) => {
      err = (err + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", (error) => { finish(() => { reject(isMissingExecutable(error) ? new Error(`${command} could not be started: ${invocation.command} is gone, so a release replaced or removed the one this front door runs. Run \`agent-shim frontdoor restart\` to replace the door.`, { cause: error }) : error); }); });
    child.once("close", (code, endedBy) => { finish(() => { resolve({ status: code, signal: endedBy, stdout: output.report(), stderr: err, shortRead: output.shortRead() }); }); });
  });
  const diagnostics = stderr.trim();
  const ended = signal === null ? `exited ${String(status)}` : `was ended by ${signal}`;
  const withDiagnostics = (message: string): string => (diagnostics === "" ? message : `${message}: ${diagnostics}`);
  // A short read is checked first, whatever the exit: a child killed partway through a large report, or one that announced a size and printed nothing, is a cut-off report, not a missing one.
  if (shortRead !== undefined) {
    throw new Error(withDiagnostics(`${command} ${ended} having printed ${String(shortRead.received)} of the ${String(shortRead.announced)} bytes it announced`));
  }
  if (!REPORTED_STATUSES.has(status) || stdout.trim() === "") {
    throw new Error(diagnostics === "" ? `${command} ${ended} without a report` : diagnostics);
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} printed output that is not JSON (${reason})${diagnostics === "" ? "" : `: ${diagnostics}`}`, { cause: error });
  }
}

/** Runs tasks at most `max` at a time, the rest waiting their turn in order. */
function createGate(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      // The slot of the task that ends is handed to the first waiting one, so `active` stays where it was.
      await new Promise<void>((resolve) => { waiting.push(resolve); });
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) {
        active -= 1;
      } else {
        next();
      }
    }
  };
}

/** One report being collected, and how many requests are waiting on it. */
interface InFlight {
  readonly result: Promise<unknown>;
  readonly ended: AbortController;
  waiters: number;
}

/**
 * Shares one collection among requests for the same report made while it runs, each with its own abort signal: the collection is ended only when every request waiting on it has aborted, and a request that aborts stops waiting at once, and a collection every request has abandoned is no longer joined by later requests. Without it a burst of identical requests would start a child for each.
 */
function createCoalescer(): (key: string, collect: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal | undefined) => Promise<unknown> {
  const inFlight = new Map<string, InFlight>();
  // An entry is forgotten only while it is still the one held for its key: a request that came after it was ended may have started a collection of its own under the same key.
  const forget = (key: string, entry: InFlight): void => {
    if (inFlight.get(key) === entry) {
      inFlight.delete(key);
    }
  };
  return async (key, collect, signal) => {
    signal?.throwIfAborted();
    let entry = inFlight.get(key);
    if (entry === undefined) {
      const ended = new AbortController();
      const started: InFlight = { result: collect(ended.signal).finally(() => { forget(key, started); }), ended, waiters: 0 };
      inFlight.set(key, started);
      entry = started;
    }
    const shared = entry;
    shared.waiters += 1;
    // The collection's outcome is read below by every waiter; this keeps an outcome nobody is left to read from being an unhandled rejection.
    shared.result.catch(() => undefined);
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        shared.waiters -= 1;
        if (shared.waiters === 0) {
          // Ended at once, not when its collection settles (which may be a long way off, behind the gate): a request that arrives from now on starts a collection of its own and does not join one that is already cancelled.
          forget(key, shared);
          shared.ended.abort(signal?.reason);
        }
        reject(signal?.reason instanceof Error ? signal.reason : new Error("the report request was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.result.then(
        (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        (error: unknown) => { signal?.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error(String(error))); },
      );
    });
  };
}

/**
 * The door's `check` and `doctor` reports, each collected by a child of the door's own executable (`agent-shim check --json`, `agent-shim doctor --json`) rather than in the door's process: collecting them runs commands, reads the keychain and probes listeners and provider base URLs, every one of which blocks the calling thread, and the door's thread serves every session. `door` is the identity of the agent-shim that serves the reports, `ownReleaseIdentity()` of the running process unless a host says otherwise. Requests for the same report made while one runs share its child, and at most `MAX_REPORT_CHILDREN` children run at once, of any kind. See `runSelfJson` for how a child is watched and ended.
 */
export function createDoorReports(deps: Readonly<{ selfInvocation: SelfInvocation; env: NodeJS.ProcessEnv; door?: ReleaseIdentity; silenceMs?: number; spawn?: typeof spawn }>): DoorReports {
  const spawnChild = deps.spawn ?? spawn;
  // `silenceMs` fixes the silence window for a test.
  const silenceMs = deps.silenceMs ?? reportSilenceWindowMs(REPORT_QUIET_MS);
  const gate = createGate(MAX_REPORT_CHILDREN);
  const coalesce = createCoalescer();
  const collect = async (args: readonly string[], signal: AbortSignal): Promise<unknown> => await gate(async () => await runSelfJson(deps.selfInvocation, deps.env, deps.door ?? ownReleaseIdentity(), args, { silenceMs, signal, spawn: spawnChild }));
  return {
    checkReport: async (path, identity, signal) => CheckReportJsonSchema.parse(await coalesce(JSON.stringify(["check", path, identity ?? null]), async (ended) => await collect(["check", path, ...(identity === undefined ? [] : ["--identity", identity]), "--json"], ended), signal)),
    doctorReport: async (signal) => DoctorRunOutputSchema.parse(await coalesce("doctor", async (ended) => await collect(["doctor", "--json"], ended), signal)),
  };
}
