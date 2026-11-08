import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

import { CheckReportJsonSchema, type CheckReportJson } from "../checkReportSchema";
import { MAX_TIMER_DELAY_MS } from "../config/schema";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
import { REPORT_PROGRESS_FD, REPORT_PROGRESS_FD_ENV, REPORT_QUIET_MS, createReportProgressReader } from "./reportProgress";
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

const BYTES_PER_MIB = 1_048_576;

/**
 * The most a report child may print to stdout before the door ends it. A report holds one finding or row per provider, identity and directory rule, each a few hundred bytes, so sixteen mebibytes is far past any real report while still bounding the door's memory against a child that prints without end.
 */
const REPORT_STDOUT_LIMIT_MIB = 16;
const REPORT_STDOUT_LIMIT_BYTES = REPORT_STDOUT_LIMIT_MIB * BYTES_PER_MIB;

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

/** What `runSelfJson` is bounded by, and the process it starts. */
interface RunLimits {
  readonly quietMs: number;
  readonly stdoutLimitBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly spawn: typeof spawn;
}

/** Runs the door's own executable with `args` and reads the JSON it prints, failing with what it wrote to stderr when it printed none, or when what it printed is not JSON. The child leads its own process group and is ended, with everything it started, and the call fails, once it has gone `limit.quietMs` without announcing a blocking step or the end of one, or longer than a step's announced bound and `PROBE_WAIT_MARGIN_MS` (the margin a probe's caller waits past its bound, which also covers a killed command being reaped) inside it (the child announces each on `REPORT_PROGRESS_FD`, see `reportProgress.ts`), `limit.signal` aborts (the request's client went away) or it has printed more than `limit.stdoutLimitBytes`. */
async function runSelfJson(selfInvocation: SelfInvocation, env: NodeJS.ProcessEnv, args: readonly string[], limit: RunLimits): Promise<unknown> {
  const invocation = selfInvocation(args);
  const command = `agent-shim ${args.join(" ")}`;
  limit.signal?.throwIfAborted();
  const { status, stdout, stderr } = await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = limit.spawn(invocation.command, [...invocation.args], { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...env, [REPORT_PROGRESS_FD_ENV]: String(REPORT_PROGRESS_FD) }, detached: true });
    const releases: (() => void)[] = [];
    const finish = (settle: () => void): void => {
      for (const release of releases) {
        release();
      }
      settle();
    };
    const fail = (error: unknown): void => {
      endChild(child);
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))); });
    };
    // The watchdog is re-armed by each announcement: inside a step for its bound and margin, between steps for the quiet bound.
    let watchdog: NodeJS.Timeout;
    const arm = (allowedMs: number): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { fail(new Error(`${command} made no progress within ${String(allowedMs)}ms`)); }, timerDelay(allowedMs));
    };
    arm(limit.quietMs);
    releases.push(() => { clearTimeout(watchdog); });
    const outPipe = readablePipe(child, 1);
    const errPipe = readablePipe(child, 2);
    const progress = readablePipe(child, REPORT_PROGRESS_FD);
    progress.setEncoding("utf8");
    progress.on("data", createReportProgressReader((event) => {
      arm(event.kind === "begin" ? event.boundMs + PROBE_WAIT_MARGIN_MS : limit.quietMs);
    }));
    const onAbort = (): void => { fail(limit.signal?.reason); };
    limit.signal?.addEventListener("abort", onAbort, { once: true });
    releases.push(() => { limit.signal?.removeEventListener("abort", onAbort); });
    let out = "";
    let outBytes = 0;
    let err = "";
    outPipe.setEncoding("utf8");
    outPipe.on("data", (chunk: string) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > limit.stdoutLimitBytes) {
        fail(new Error(`${command} printed more than ${String(limit.stdoutLimitBytes)} bytes`));
        return;
      }
      out += chunk;
    });
    errPipe.setEncoding("utf8");
    errPipe.on("data", (chunk: string) => {
      err = (err + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", (error) => { finish(() => { reject(error); }); });
    child.once("close", (code) => { finish(() => { resolve({ status: code, stdout: out, stderr: err }); }); });
  });
  const diagnostics = stderr.trim();
  if (!REPORTED_STATUSES.has(status) || stdout.trim() === "") {
    throw new Error(diagnostics === "" ? `${command} exited ${String(status)} without a report` : diagnostics);
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} printed output that is not JSON (${reason})${diagnostics === "" ? "" : `: ${diagnostics}`}`, { cause: error });
  }
}

/**
 * The door's `check` and `doctor` reports, each collected by a child of the door's own executable (`agent-shim check --json`, `agent-shim doctor --json`) rather than in the door's process: collecting them runs commands, reads the keychain and probes listeners and provider base URLs, every one of which blocks the calling thread, and the door's thread is the event loop that answers every session (see `refuseToBlockInRole`). The child prints exactly the JSON `check --json` and `doctor --json` print, which is the control API's contract, validated here against the same schemas the API's output is.
 */
export function createDoorReports(deps: Readonly<{ selfInvocation: SelfInvocation; env: NodeJS.ProcessEnv; quietMs?: number; stdoutLimitBytes?: number; spawn?: typeof spawn }>): DoorReports {
  const spawnChild = deps.spawn ?? spawn;
  const stdoutLimitBytes = deps.stdoutLimitBytes ?? REPORT_STDOUT_LIMIT_BYTES;
  // `quietMs` fixes the quiet bound for a test.
  const quietMs = deps.quietMs ?? REPORT_QUIET_MS;
  return {
    checkReport: async (path, identity, signal) => CheckReportJsonSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["check", path, ...(identity === undefined ? [] : ["--identity", identity]), "--json"], { quietMs, stdoutLimitBytes, signal, spawn: spawnChild })),
    doctorReport: async (signal) => DoctorRunOutputSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["doctor", "--json"], { quietMs, stdoutLimitBytes, signal, spawn: spawnChild })),
  };
}
