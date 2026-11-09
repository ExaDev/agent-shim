import fs from "node:fs";

import { noteFileSystemWork, observeBlockingSteps } from "../blockingSteps";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";

/** The environment variable that tells a report child which file descriptor to announce its progress on: each blocking step with its bound, the end of one, and local work done. Set by the door that starts the child, read by `installReportProgress`. */
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
 * The longest one unit of a report child's work (a call that reads the user's files, say) may take without the door acting: the allowance each unit has. A report child announces each blocking step with that step's own bound (an external command its timeout, a probe wait its start limit, bound and margin) and notes each synchronous file system call as local work (`noteLocalWork`), announcing it at most once per `LOCAL_WORK_ANNOUNCE_INTERVAL_MS`, so the child's bound follows what it actually does, with no count of identities, sessions, providers or files to keep exact. See `reportSilenceWindowMs` for how long the door waits between announcements so that a unit whose note was not announced still has this whole allowance.
 */
export const REPORT_QUIET_MS = DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS * REPORT_QUIET_BOUNDS;

/** How many `work` announcements a loop that keeps working makes inside one quiet window, so one that is delayed by a loaded host still lands inside it. */
const WORK_ANNOUNCES_PER_QUIET_WINDOW = 2;

/**
 * The least time between two `work` announcements of a loop over local data: a share of the quiet bound, so a loop that keeps working announces inside every quiet window while a loop of many small units does not write once per unit.
 */
export const LOCAL_WORK_ANNOUNCE_INTERVAL_MS = REPORT_QUIET_MS / WORK_ANNOUNCES_PER_QUIET_WINDOW;

/** What a report child prints on standard output before its report: this prefix, the report's size in bytes and a line feed. Printed only by a report child, which is told its progress descriptor; the same command line run by a person prints the report alone. */
export const REPORT_SIZE_PREFIX = "agent-shim-report-bytes ";

/** The longest the size line can be: the prefix, the digits of the largest size a number holds exactly and the line feed. */
const REPORT_SIZE_LINE_MAX_CHARS = REPORT_SIZE_PREFIX.length + String(Number.MAX_SAFE_INTEGER).length + 1;

/** The line a report child prints before a report of `bytes` bytes. */
export function encodeReportSize(bytes: number): string {
  return `${REPORT_SIZE_PREFIX}${String(bytes)}\n`;
}

/** What `createReportOutputReader` returns: `push` takes standard output as it arrives, `report` is the report read so far (empty until the size line is whole). */
export interface ReportOutputReader {
  readonly push: (chunk: string) => void;
  readonly report: () => string;
}

/**
 * Reads a report child's standard output: a size line (`encodeReportSize`) and then exactly that many bytes of report. The size is what the child announced it would print, so it is the whole bound on what the door keeps: a child that prints a report longer than it announced, prints no size line, or prints a malformed one is ended through `fail` with the reason, and no constant caps a report that grows with the user's data.
 */
export function createReportOutputReader(fail: (reason: string) => void): ReportOutputReader {
  let header = "";
  let announced: number | undefined;
  let report = "";
  let reportBytes = 0;
  return {
    push: (chunk) => {
      let rest = chunk;
      if (announced === undefined) {
        header += rest;
        const lineEnd = header.indexOf("\n");
        if (lineEnd === -1) {
          if (header.length > REPORT_SIZE_LINE_MAX_CHARS) {
            fail("printed output without announcing its size");
          }
          return;
        }
        const size = header.startsWith(REPORT_SIZE_PREFIX) ? Number(header.slice(REPORT_SIZE_PREFIX.length, lineEnd)) : Number.NaN;
        if (!Number.isSafeInteger(size) || size < 0) {
          fail("printed output without announcing its size");
          return;
        }
        announced = size;
        rest = header.slice(lineEnd + 1);
      }
      reportBytes += Buffer.byteLength(rest);
      if (reportBytes > announced) {
        fail(`printed more than the ${String(announced)} bytes it announced`);
        return;
      }
      report += rest;
    },
    report: () => report,
  };
}

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

/** Reads the lines of a progress stream as they arrive in chunks of any size, handing each complete, well-formed one to `onEvent`. A line that is not one of the announcements (`begin`, `end`, `work`) is ignored: the stream carries nothing else, and an unreadable line must not be taken for a sign of life. */
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
 * Makes this process announce each of its blocking steps on the descriptor `env` names (`REPORT_PROGRESS_FD_ENV`), gives a step that names no bound `REPORT_UNBOUNDED_STEP_LIMIT_MS`, counts every synchronous call of `fsModule` (`node:fs`) as local work (`noteFileSystemWork`), and prints the size of a report before it with `writeOutput` (`encodeReportSize`); nothing happens when `env` names no descriptor. `write` is `fs.writeSync` and `now` the monotonic clock in production; `work` is announced at most once per `LOCAL_WORK_ANNOUNCE_INTERVAL_MS`, counted from the last announcement of any kind. Returns what stops the announcing, or undefined when it was never started.
 */
export function installReportProgress(env: Readonly<Record<string, string | undefined>>, write: (fd: number, text: string) => void = (fd, text) => { fs.writeSync(fd, text); }, now: () => number = () => performance.now(), fsModule: object = fs, writeOutput: (text: string) => void = (text) => { process.stdout.write(text); }): (() => void) | undefined {
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
    output: (bytes) => { writeOutput(encodeReportSize(bytes)); },
    unboundedStepLimitMs: REPORT_UNBOUNDED_STEP_LIMIT_MS,
  });
  const restoreFileSystem = noteFileSystemWork(fsModule);
  return () => {
    restoreFileSystem();
    stopObserving();
  };
}

/**
 * How long the door waits for the next announcement of a report child that is not inside a blocking step, given the allowance `quietMs` of one unit. A unit's note is dropped when the last announcement is less than `LOCAL_WORK_ANNOUNCE_INTERVAL_MS` old, so a unit can start that long after the last announcement the door saw; waiting the allowance plus that interval leaves such a unit its whole allowance, where waiting the allowance alone would leave it the allowance less up to one interval. The same window covers the child's start-up, whose first notes are dropped for the same reason.
 */
export function reportSilenceWindowMs(quietMs: number): number {
  return quietMs + LOCAL_WORK_ANNOUNCE_INTERVAL_MS;
}
