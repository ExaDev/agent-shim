import fs from "node:fs";

import { observeBlockingSteps } from "../blockingSteps";

/** The environment variable that tells a report child which file descriptor to announce its blocking steps on. Set by the door that starts the child, read by `installReportProgress`. */
export const REPORT_PROGRESS_FD_ENV = "AGENT_SHIM_REPORT_PROGRESS_FD";

/** The descriptor the door gives a report child for its progress: the first after standard input, output and error. */
export const REPORT_PROGRESS_FD = 3;

/**
 * The limit a blocking external command gets in a report child when its caller names none: a keychain read, a process-table read or a version manager's lookup answers from local state, and one still running after this is stuck, as `claude auth status` is after a request to the login service has failed.
 */
export const REPORT_UNBOUNDED_STEP_LIMIT_MS = 10_000;

/** One announcement of a report child: a blocking step begins with the longest it may take, or the last one ended. */
export type ReportProgress = { readonly kind: "begin"; readonly boundMs: number } | { readonly kind: "end" };

const BEGIN_PREFIX = "begin ";
const END_LINE = "end";

/** The line a report child writes for `event`. */
export function encodeReportProgress(event: ReportProgress): string {
  return event.kind === "begin" ? `${BEGIN_PREFIX}${String(event.boundMs)}\n` : `${END_LINE}\n`;
}

/** Reads the lines of a progress stream as they arrive in chunks of any size, handing each complete, well-formed one to `onEvent`. A line that is not one of the two announcements is ignored: the stream carries nothing else, and an unreadable line must not be taken for a sign of life. */
export function createReportProgressReader(onEvent: (event: ReportProgress) => void): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === END_LINE) {
        onEvent({ kind: "end" });
      } else if (line.startsWith(BEGIN_PREFIX)) {
        const boundMs = Number(line.slice(BEGIN_PREFIX.length));
        if (Number.isFinite(boundMs) && boundMs > 0) {
          onEvent({ kind: "begin", boundMs });
        }
      }
    }
  };
}

/**
 * Makes this process announce each of its blocking steps on the descriptor `env` names (`REPORT_PROGRESS_FD_ENV`), and gives a step that names no bound `REPORT_UNBOUNDED_STEP_LIMIT_MS`; nothing happens when `env` names no descriptor. `write` is `fs.writeSync` in production. Returns what stops the announcing, or undefined when it was never started.
 */
export function installReportProgress(env: Readonly<Record<string, string | undefined>>, write: (fd: number, text: string) => void = (fd, text) => { fs.writeSync(fd, text); }): (() => void) | undefined {
  const fd = env[REPORT_PROGRESS_FD_ENV];
  if (fd === undefined) {
    return undefined;
  }
  const descriptor = Number(fd);
  return observeBlockingSteps({
    begin: (boundMs) => { write(descriptor, encodeReportProgress({ kind: "begin", boundMs })); },
    end: () => { write(descriptor, encodeReportProgress({ kind: "end" })); },
    unboundedStepLimitMs: REPORT_UNBOUNDED_STEP_LIMIT_MS,
  });
}
