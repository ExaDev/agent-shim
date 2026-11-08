import fs from "node:fs";

import { noteFileSystemWork, observeBlockingSteps } from "../blockingSteps";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";

/** The environment variable that tells a report child which file descriptor to announce its blocking steps on. Set by the door that starts the child, read by `installReportProgress`. */
export const REPORT_PROGRESS_FD_ENV = "AGENT_SHIM_REPORT_PROGRESS_FD";

/** The descriptor the door gives a report child for its progress: the first after standard input, output and error. */
export const REPORT_PROGRESS_FD = 3;

/**
 * The limit a blocking external command gets in a report child when its caller names none: a keychain read, a process-table read or a version manager's lookup answers from local state, and one still running after this is stuck, as `claude auth status` is after a request to the login service has failed.
 */
export const REPORT_UNBOUNDED_STEP_LIMIT_MS = 10_000;

/** How many default probe bounds of silence the door allows: the child's start-up, and a stretch of local work that announces nothing. Both are held to the order of one default probe bound, since each answers from local state, and the margin covers a loaded host. */
const REPORT_QUIET_BOUNDS = 2;

/**
 * The longest a report child may go without announcing anything (see `REPORT_PROGRESS_FD_ENV`). It announces each blocking step with that step's own bound (an external command its timeout, a probe wait its start limit, bound and margin) and each unit of a loop over local data (`noteLocalWork`, at most once per `LOCAL_WORK_ANNOUNCE_INTERVAL_MS`), so the child's bound follows what it actually does, with no count of identities, sessions, providers or files to keep exact. The quiet bound covers only the child's start-up and a stretch that does neither.
 */
export const REPORT_QUIET_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS * REPORT_QUIET_BOUNDS;

/** How many `work` announcements a loop that keeps working makes inside one quiet window, so one that is delayed by a loaded host still lands inside it. */
const WORK_ANNOUNCES_PER_QUIET_WINDOW = 2;

/**
 * The least time between two `work` announcements of a loop over local data: a share of the quiet bound, so a loop that keeps working announces inside every quiet window while a loop of many small units does not write once per unit.
 */
export const LOCAL_WORK_ANNOUNCE_INTERVAL_MS = REPORT_QUIET_MS / WORK_ANNOUNCES_PER_QUIET_WINDOW;

/** One announcement of a report child: a blocking step begins with the longest it may take, the last one ended, or a loop over local data did more of its work. */
export type ReportProgress = { readonly kind: "begin"; readonly boundMs: number } | { readonly kind: "end" } | { readonly kind: "work" };

const BEGIN_PREFIX = "begin ";
const END_LINE = "end";
const WORK_LINE = "work";

/** The line a report child writes for `event`. */
export function encodeReportProgress(event: ReportProgress): string {
  if (event.kind === "begin") {
    return `${BEGIN_PREFIX}${String(event.boundMs)}\n`;
  }
  return event.kind === "end" ? `${END_LINE}\n` : `${WORK_LINE}\n`;
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
      } else if (line === WORK_LINE) {
        onEvent({ kind: "work" });
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
 * Makes this process announce each of its blocking steps on the descriptor `env` names (`REPORT_PROGRESS_FD_ENV`), gives a step that names no bound `REPORT_UNBOUNDED_STEP_LIMIT_MS`, and counts every synchronous call of `fsModule` (`node:fs`) as local work (`noteFileSystemWork`); nothing happens when `env` names no descriptor. `write` is `fs.writeSync` and `now` the monotonic clock in production; `work` is announced at most once per `LOCAL_WORK_ANNOUNCE_INTERVAL_MS`, counted from the last announcement of any kind. Returns what stops the announcing, or undefined when it was never started.
 */
export function installReportProgress(env: Readonly<Record<string, string | undefined>>, write: (fd: number, text: string) => void = (fd, text) => { fs.writeSync(fd, text); }, now: () => number = () => performance.now(), fsModule: object = fs): (() => void) | undefined {
  const fd = env[REPORT_PROGRESS_FD_ENV];
  if (fd === undefined) {
    return undefined;
  }
  const descriptor = Number(fd);
  let lastAnnouncedMs = now();
  const announce = (event: ReportProgress): void => {
    lastAnnouncedMs = now();
    write(descriptor, encodeReportProgress(event));
  };
  const stopObserving = observeBlockingSteps({
    begin: (boundMs) => { announce({ kind: "begin", boundMs }); },
    end: () => { announce({ kind: "end" }); },
    localWork: () => {
      if (now() - lastAnnouncedMs >= LOCAL_WORK_ANNOUNCE_INTERVAL_MS) {
        announce({ kind: "work" });
      }
    },
    unboundedStepLimitMs: REPORT_UNBOUNDED_STEP_LIMIT_MS,
  });
  const restoreFileSystem = noteFileSystemWork(fsModule);
  return () => {
    restoreFileSystem();
    stopObserving();
  };
}
