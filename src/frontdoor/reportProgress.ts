import fs from "node:fs";

import packageJson from "../../package.json";
import { CliError } from "../cliError";
import { noteFileSystemWork, observeBlockingSteps } from "../blockingSteps";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";

/** The environment variable that tells a report child which file descriptor to announce its progress on and which process started it (`reportProgressTarget`): each blocking step with its bound, the end of one, and local work done. Set by the door that starts the child, read by `installReportProgress`. */
export const REPORT_PROGRESS_FD_ENV = "AGENT_SHIM_REPORT_PROGRESS_FD";

/** Raised in a report child started by a front door of another release: the report it would print is in the form of its own release, which the door cannot read. */
export class ReportReleaseSkewError extends CliError {
  constructor(doorRelease: string, ownRelease: string) {
    super(`the front door that asked for this report runs agent-shim ${doorRelease}, and this is agent-shim ${ownRelease}, whose reports it cannot read. Run \`agent-shim frontdoor restart\` to replace the door with one from this release.`);
    this.name = "ReportReleaseSkewError";
  }
}

/** The value of `REPORT_PROGRESS_FD_ENV` for a child of process `parentPid`, a front door of release `release`, that is to announce on `fd`: the descriptor, the process that opened it and the release of the door. A process that inherited the variable from further up, or from a shell, is not that process's child, and `installReportProgress` ignores it. */
export function reportProgressTarget(fd: number, parentPid: number, release: string): string {
  return `${String(fd)}:${String(parentPid)}:${release}`;
}

/** The descriptor named by `value` for a process whose parent is `parentPid`, or undefined when `value` is not one `reportProgressTarget` gives, or names another process as the one that opened the descriptor. Throws `ReportReleaseSkewError` when the door that did is of a release other than `ownRelease`. */
function progressDescriptorFor(value: string, parentPid: number, ownRelease: string): number | undefined {
  const match = /^([0-9]+):([0-9]+):(.+)$/.exec(value);
  if (match === null || Number(match[2]) !== parentPid) {
    return undefined;
  }
  const doorRelease = match[3] ?? "";
  if (doorRelease !== ownRelease) {
    throw new ReportReleaseSkewError(doorRelease, ownRelease);
  }
  return Number(match[1]);
}

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

/** What the size on a size line must be: decimal digits and nothing else, so a size that `Number` would read from an empty string, spaces, an exponent, a prefix or a sign is refused. */
const SIZE_DIGITS = /^\d+$/u;

/** The line a report child prints before a report of `bytes` bytes. */
export function encodeReportSize(bytes: number): string {
  return `${REPORT_SIZE_PREFIX}${String(bytes)}\n`;
}

/** What `createReportOutputReader` returns: `push` takes standard output as it arrives, `report` is the report read so far (empty until the size line is whole), and `shortRead` says how many bytes of the announced size are missing once the child has ended (undefined when the report is whole or no size was announced). */
export interface ReportOutputReader {
  readonly push: (chunk: Buffer | string) => void;
  readonly report: () => string;
  readonly shortRead: () => { readonly received: number; readonly announced: number } | undefined;
}

/**
 * Reads a report child's standard output: a size line (`encodeReportSize`) and then exactly that many bytes of report. The size is what the child announced it would print, so it is the whole bound on what the door keeps: a child that prints a report longer than it announced, prints no size line, or prints a malformed one is ended through `fail` with the reason, and no constant caps a report that grows with the user's data.
 */
export function createReportOutputReader(fail: (reason: string) => void): ReportOutputReader {
  const LINE_FEED = 0x0a;
  let header = Buffer.alloc(0);
  let announced: number | undefined;
  const chunks: Buffer[] = [];
  let reportBytes = 0;
  return {
    push: (chunk) => {
      let rest = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (announced === undefined) {
        header = Buffer.concat([header, rest]);
        const lineEnd = header.indexOf(LINE_FEED);
        if (lineEnd === -1) {
          if (header.length > REPORT_SIZE_LINE_MAX_CHARS) {
            fail("printed output without announcing its size");
          }
          return;
        }
        const line = header.subarray(0, lineEnd).toString("latin1");
        const digits = line.startsWith(REPORT_SIZE_PREFIX) ? line.slice(REPORT_SIZE_PREFIX.length) : "";
        const size = SIZE_DIGITS.test(digits) ? Number(digits) : Number.NaN;
        if (!Number.isSafeInteger(size) || size < 0) {
          fail("printed output without announcing its size");
          return;
        }
        announced = size;
        rest = header.subarray(lineEnd + 1);
      }
      // Bytes are counted as they arrive and decoded once at the end: decoding each chunk would count a character cut off mid-sequence as its replacement character.
      reportBytes += rest.length;
      if (reportBytes > announced) {
        fail(`printed more than the ${String(announced)} bytes it announced`);
        return;
      }
      chunks.push(rest);
    },
    report: () => Buffer.concat(chunks).toString("utf8"),
    shortRead: () => (announced !== undefined && reportBytes < announced ? { received: reportBytes, announced } : undefined),
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
 * Makes this process announce each of its blocking steps on the descriptor `env` names (`REPORT_PROGRESS_FD_ENV`), gives a step that names no bound `REPORT_UNBOUNDED_STEP_LIMIT_MS`, counts every synchronous call of `fsModule` (`node:fs`) as local work (`noteFileSystemWork`), and prints the size of a report before it with `writeOutput` (`encodeReportSize`); nothing happens when `env` names no descriptor, or a value that does not name this process's parent as the process that opened the descriptor (`reportProgressTarget`), which is what a process that inherited the variable from further up sees. The variable is removed from `env` whenever it was set (`env` is the process's own environment, mutable in spite of its type), so no process this one starts inherits it. `ownParentPid` is `process.ppid` and `ownRelease` the version of this release in production; a door of another release makes this throw `ReportReleaseSkewError`, so the report is refused with a message and not printed in a form the door cannot read. `write` is `fs.writeSync` and `now` the monotonic clock in production; `work` is announced at most once per `LOCAL_WORK_ANNOUNCE_INTERVAL_MS`, counted from the last announcement of any kind. Returns what stops the announcing, or undefined when it was never started.
 */
export function installReportProgress(env: Readonly<Record<string, string | undefined>>, write: (fd: number, text: string) => void = (fd, text) => { fs.writeSync(fd, text); }, now: () => number = () => performance.now(), fsModule: object = fs, writeOutput: (text: string) => void = (text) => { process.stdout.write(text); }, ownParentPid: number = process.ppid, ownRelease: string = packageJson.version): (() => void) | undefined {
  const fd = env[REPORT_PROGRESS_FD_ENV];
  if (fd === undefined) {
    return undefined;
  }
  // The variable is for this process alone: left in `env` it would reach every process this one starts, and one of those that is an agent-shim would write its announcements to whatever its descriptor is.
  Reflect.deleteProperty(env, REPORT_PROGRESS_FD_ENV);
  const descriptor = progressDescriptorFor(fd, ownParentPid, ownRelease);
  if (descriptor === undefined) {
    return undefined;
  }
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
