import { spawn } from "node:child_process";

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

/** Runs the door's own executable with `args` and reads the JSON it prints, failing with what it wrote to stderr when it printed none. The child is killed, and the call fails, once `limit.timeoutMs` has passed or `limit.signal` aborts (the request's client went away). */
async function runSelfJson(selfInvocation: SelfInvocation, env: NodeJS.ProcessEnv, args: readonly string[], limit: { readonly timeoutMs: number; readonly signal: AbortSignal | undefined; readonly spawn: typeof spawn }): Promise<unknown> {
  const invocation = selfInvocation(args);
  const { status, stdout, stderr } = await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = limit.spawn(invocation.command, [...invocation.args], { stdio: ["ignore", "pipe", "pipe"], env, signal: limit.signal });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent-shim ${args.join(" ")} did not report within ${String(limit.timeoutMs)}ms`));
    }, limit.timeoutMs);
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
  if (!REPORTED_STATUSES.has(status) || stdout.trim() === "") {
    throw new Error(stderr.trim() === "" ? `agent-shim ${args.join(" ")} exited ${String(status)} without a report` : stderr.trim());
  }
  const parsed: unknown = JSON.parse(stdout);
  return parsed;
}

/**
 * The door's `check` and `doctor` reports, each collected by a child of the door's own executable (`agent-shim check --json`, `agent-shim doctor --json`) rather than in the door's process: collecting them runs commands, reads the keychain and probes listeners and provider base URLs, every one of which blocks the calling thread, and the door's thread is the event loop that answers every session (see `refuseToBlockInRole`). The child prints exactly the JSON `check --json` and `doctor --json` print, which is the control API's contract, validated here against the same schemas the API's output is.
 */
export function createDoorReports(deps: Readonly<{ selfInvocation: SelfInvocation; env: NodeJS.ProcessEnv; providers: () => readonly Provider[]; timeoutMs?: number; spawn?: typeof spawn }>): DoorReports {
  const spawnChild = deps.spawn ?? spawn;
  // `timeoutMs` fixes the bound for a test; otherwise it is derived from the providers as each request arrives.
  const boundOfRequest = () => deps.timeoutMs ?? reportChildTimeoutMs(deps.providers());
  return {
    checkReport: async (path, identity, signal) => CheckReportJsonSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["check", path, ...(identity === undefined ? [] : ["--identity", identity]), "--json"], { timeoutMs: boundOfRequest(), signal, spawn: spawnChild })),
    doctorReport: async (signal) => DoctorRunOutputSchema.parse(await runSelfJson(deps.selfInvocation, deps.env, ["doctor", "--json"], { timeoutMs: boundOfRequest(), signal, spawn: spawnChild })),
  };
}
