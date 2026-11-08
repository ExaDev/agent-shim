import { spawn, type ChildProcess } from "node:child_process";

import { CheckReportJsonSchema, type CheckReportJson } from "../checkReportSchema";
import { MAX_TIMER_DELAY_MS, isHttpProvider, type Provider } from "../config/schema";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS, providerConnectTimeoutMs } from "../providerReachability";
import { PROBE_WAIT_MARGIN_MS } from "./probe";
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

/** The steps of a report besides the provider probe that block on something outside the child: its own start-up, a git query, the keychain read and the listener probe. */
const REPORT_LOCAL_STEPS = 4;

/**
 * The time a report child gets besides its provider probe: each of its `REPORT_LOCAL_STEPS` other blocking steps answers from local state, far inside one default probe bound, and is allowed a whole one, so they fit back to back whatever the host's load.
 */
export const REPORT_STARTUP_ALLOWANCE_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS * REPORT_LOCAL_STEPS;

/**
 * How long a report child may run before the door kills it and fails the request. The only step of either report that waits on the network is the provider probe, which runs once with every provider's probe together, so it lasts the longest probe bound among the providers (each provider's own `connectTimeoutMs`, else the default) plus the margin the probe's caller waits past it (`PROBE_WAIT_MARGIN_MS`); `REPORT_STARTUP_ALLOWANCE_MS` covers everything else. The sum is capped at the longest delay a timer takes, since a longer one would fire at once.
 */
export function reportChildTimeoutMs(providers: readonly Provider[]): number {
  const longestProbeMs = Math.max(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS, ...providers.filter(isHttpProvider).map(providerConnectTimeoutMs));
  return Math.min(longestProbeMs + PROBE_WAIT_MARGIN_MS + REPORT_STARTUP_ALLOWANCE_MS, MAX_TIMER_DELAY_MS);
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

/** What `runSelfJson` is bounded by, and the process it starts. */
interface RunLimits {
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly spawn: typeof spawn;
}

/** Runs the door's own executable with `args` and reads the JSON it prints, failing with what it wrote to stderr when it printed none, or when what it printed is not JSON. The child leads its own process group and is ended, with everything it started, and the call fails, once `limit.timeoutMs` has passed, `limit.signal` aborts (the request's client went away) or it has printed more than `limit.stdoutLimitBytes`. */
async function runSelfJson(selfInvocation: SelfInvocation, env: NodeJS.ProcessEnv, args: readonly string[], limit: RunLimits): Promise<unknown> {
  const invocation = selfInvocation(args);
  const command = `agent-shim ${args.join(" ")}`;
  limit.signal?.throwIfAborted();
  const { status, stdout, stderr } = await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = limit.spawn(invocation.command, [...invocation.args], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
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
    const deadline = setTimeout(() => { fail(new Error(`${command} did not report within ${String(limit.timeoutMs)}ms`)); }, limit.timeoutMs);
    releases.push(() => { clearTimeout(deadline); });
    const onAbort = (): void => { fail(limit.signal?.reason); };
    limit.signal?.addEventListener("abort", onAbort, { once: true });
    releases.push(() => { limit.signal?.removeEventListener("abort", onAbort); });
    let out = "";
    let outBytes = 0;
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > limit.stdoutLimitBytes) {
        fail(new Error(`${command} printed more than ${String(limit.stdoutLimitBytes)} bytes`));
        return;
      }
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
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
export function createDoorReports(deps: Readonly<{ selfInvocation: SelfInvocation; env: NodeJS.ProcessEnv; providers: () => readonly Provider[]; timeoutMs?: number; stdoutLimitBytes?: number; spawn?: typeof spawn }>): DoorReports {
  const spawnChild = deps.spawn ?? spawn;
  const stdoutLimitBytes = deps.stdoutLimitBytes ?? REPORT_STDOUT_LIMIT_BYTES;
  // `timeoutMs` fixes the bound for a test; otherwise it is derived from the providers as each request arrives.
  const boundOfRequest = () => deps.timeoutMs ?? reportChildTimeoutMs(deps.providers());
  return {
    checkReport: async (path, identity, signal) => CheckReportJsonSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["check", path, ...(identity === undefined ? [] : ["--identity", identity]), "--json"], { timeoutMs: boundOfRequest(), stdoutLimitBytes, signal, spawn: spawnChild })),
    doctorReport: async (signal) => DoctorRunOutputSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["doctor", "--json"], { timeoutMs: boundOfRequest(), stdoutLimitBytes, signal, spawn: spawnChild })),
  };
}
