import { spawn } from "node:child_process";

import type { LayoutPaths } from "../paths";
import { selfInvocation } from "../realPorts";

/**
 * Runs headless identity work (a window opening, a job) in a short-lived process of this same executable rather than inside the front door. A launch that routes through the door must be able to probe it, and a probe made from the door's own process blocks the loop the door answers it on, so the door judged itself unresponsive and retired itself. A child has its own pid, which is also what the door's one-entry-per-pid session registry needs, and a run that hangs or crashes cannot take the door, and every session routed through it, down with it.
 */

/** How long beyond a run's own time limit the child may take to start and wind down before it is killed: the executable's start-up and the SDK's shutdown, which the run's own limit does not cover. */
const CHILD_GRACE_MS = 30_000;

/** The last of a child's standard error kept for the failure message, enough for the launcher's own refusal text without holding a long transcript. */
const STDERR_TAIL_CHARS = 2000;

/** How the child is started: this executable by default, a stand-in in tests. */
export interface ChildRunOptions {
  readonly paths: LayoutPaths;
  readonly args: readonly string[];
  /** The run's own time limit; the child is killed this long plus a grace period after it starts. */
  readonly timeoutMs: number;
  readonly invocation?: (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
}

/**
 * Runs the child to completion: resolves when it exits 0, rejects with the tail of its standard error when it exits non-zero or cannot start, and kills it when it outlasts its limit plus the grace period.
 */
export async function runChild(options: Readonly<ChildRunOptions>): Promise<void> {
  const invocation = (options.invocation ?? selfInvocation)(options.args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AGENT_SHIM_HOME: options.paths.root } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS);
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs + CHILD_GRACE_MS);
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() === "" ? `the child ended with ${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}` : stderr.trim()));
    });
  });
}
