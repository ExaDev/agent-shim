import { afterEach, describe, expect, it } from "vitest";

import { announceReportOutput, noteLocalWork, withBlockingStep } from "../blockingSteps";
import {
  REPORT_PROGRESS_FD_ENV,
  REPORT_UNBOUNDED_STEP_LIMIT_MS,
  createReportOutputReader,
  createReportProgressReader,
  encodeReportSize,
  REPORT_QUIET_MS,
  REPORT_SIZE_PREFIX,
  reportSilenceWindowMs,
  encodeReportProgress,
  installReportProgress,
  LOCAL_WORK_ANNOUNCE_INTERVAL_MS,
  type ReportProgress,
} from "./reportProgress";

const DESCRIPTOR = 7;
const STEP_BOUND_MS = 1_234;

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

/** Everything a reader hands over for `chunks`, fed one after the other. */
function readAll(chunks: readonly string[]): ReportProgress[] {
  const events: ReportProgress[] = [];
  const read = createReportProgressReader((event) => { events.push(event); });
  for (const chunk of chunks) {
    read(chunk);
  }
  return events;
}

describe("the progress stream", () => {
  it("reads back what was encoded, whatever the chunking", () => {
    const text = encodeReportProgress({ kind: "begin", boundMs: STEP_BOUND_MS }) + encodeReportProgress({ kind: "end" });
    const expected: ReportProgress[] = [{ kind: "begin", boundMs: STEP_BOUND_MS }, { kind: "end" }];
    expect(readAll([text])).toEqual(expected);
    expect(readAll(text.split(""))).toEqual(expected);
  });

  it("holds an incomplete line until its end arrives", () => {
    expect(readAll(["begin 12"])).toEqual([]);
    expect(readAll(["begin 12", "3\n"])).toEqual([{ kind: "begin", boundMs: 123 }]);
  });

  it("reads a work line", () => {
    expect(readAll([encodeReportProgress({ kind: "work" })])).toEqual([{ kind: "work" }]);
  });

  it("ignores a line that is not an announcement, and a bound that is not a positive number", () => {
    expect(readAll(["hello\nbegin soon\nbegin 0\nbegin -5\nbegin \n"])).toEqual([]);
  });
});

describe("installReportProgress", () => {
  it("does nothing when the environment names no descriptor", () => {
    const written: string[] = [];
    expect(installReportProgress({}, (_fd, text) => { written.push(text); })).toBeUndefined();
    withBlockingStep(undefined, () => undefined);
    expect(written).toEqual([]);
  });

  it("writes each step's bound and end to the named descriptor, and gives an unbounded step the report limit", () => {
    const written: { readonly fd: number; readonly text: string }[] = [];
    uninstall = installReportProgress({ [REPORT_PROGRESS_FD_ENV]: String(DESCRIPTOR) }, (fd, text) => { written.push({ fd, text }); });
    expect(withBlockingStep(STEP_BOUND_MS, (bound) => bound)).toBe(STEP_BOUND_MS);
    expect(withBlockingStep(undefined, (bound) => bound)).toBe(REPORT_UNBOUNDED_STEP_LIMIT_MS);
    expect(written).toEqual([
      { fd: DESCRIPTOR, text: `begin ${String(STEP_BOUND_MS)}\n` },
      { fd: DESCRIPTOR, text: "end\n" },
      { fd: DESCRIPTOR, text: `begin ${String(REPORT_UNBOUNDED_STEP_LIMIT_MS)}\n` },
      { fd: DESCRIPTOR, text: "end\n" },
    ]);
  });
});

describe("local work announcements", () => {
  it("are written at most once per interval, counted from the last announcement of any kind", () => {
    const written: string[] = [];
    let clock = 0;
    uninstall = installReportProgress({ [REPORT_PROGRESS_FD_ENV]: String(DESCRIPTOR) }, (_fd, text) => { written.push(text); }, () => clock);
    noteLocalWork();
    expect(written).toEqual([]);
    clock = LOCAL_WORK_ANNOUNCE_INTERVAL_MS - 1;
    noteLocalWork();
    expect(written).toEqual([]);
    clock = LOCAL_WORK_ANNOUNCE_INTERVAL_MS;
    noteLocalWork();
    expect(written).toEqual(["work\n"]);
    noteLocalWork();
    expect(written).toEqual(["work\n"]);
    clock += LOCAL_WORK_ANNOUNCE_INTERVAL_MS - 1;
    withBlockingStep(STEP_BOUND_MS, () => undefined);
    clock += LOCAL_WORK_ANNOUNCE_INTERVAL_MS - 1;
    noteLocalWork();
    expect(written).toHaveLength(1 + 2);
    clock += 1;
    noteLocalWork();
    expect(written).toHaveLength(1 + 2 + 1);
  });

  it("counts a synchronous call of the file system module as local work, and puts it back on uninstall", () => {
    const written: string[] = [];
    let clock = 0;
    const module = { statSync: () => "stat" };
    const original = module.statSync;
    const stop = installReportProgress({ [REPORT_PROGRESS_FD_ENV]: String(DESCRIPTOR) }, (_fd, text) => { written.push(text); }, () => clock, module);
    uninstall = stop;
    expect(module.statSync()).toBe("stat");
    expect(written).toEqual([]);
    clock = LOCAL_WORK_ANNOUNCE_INTERVAL_MS;
    expect(module.statSync()).toBe("stat");
    expect(written).toEqual(["work\n"]);
    stop?.();
    uninstall = undefined;
    expect(module.statSync).toBe(original);
  });
});

describe("the report output reader", () => {
  /** Feeds `chunks` to a reader and returns the report it kept and every failure it raised. */
  function read(chunks: readonly string[]): { readonly report: string; readonly failures: readonly string[] } {
    const failures: string[] = [];
    const reader = createReportOutputReader((reason) => { failures.push(reason); });
    for (const chunk of chunks) {
      reader.push(chunk);
    }
    return { report: reader.report(), failures };
  }

  it("keeps the report after its size line, whatever the chunking", () => {
    const text = `${encodeReportSize(Buffer.byteLength("{\"a\":1}\n"))}{"a":1}\n`;
    expect(read([text])).toEqual({ report: '{"a":1}\n', failures: [] });
    expect(read(text.split(""))).toEqual({ report: '{"a":1}\n', failures: [] });
  });

  it("counts the report in bytes, not characters", () => {
    const report = "{\"a\":\"é\"}";
    expect(read([`${encodeReportSize(Buffer.byteLength(report))}${report}`]).failures).toEqual([]);
    expect(read([`${encodeReportSize(1)}é`]).failures).toEqual(["printed more than the 1 bytes it announced"]);
  });

  it("fails on a report longer than it announced", () => {
    expect(read([`${encodeReportSize(2)}abc`]).failures).toEqual(["printed more than the 2 bytes it announced"]);
  });

  it("fails on output with no size line, a malformed one or one that never ends", () => {
    expect(read(["{}\n"]).failures).toEqual(["printed output without announcing its size"]);
    expect(read([`${REPORT_SIZE_PREFIX}many\n`]).failures).toEqual(["printed output without announcing its size"]);
    expect(read([`${REPORT_SIZE_PREFIX}-4\n`]).failures).toEqual(["printed output without announcing its size"]);
    expect(read(["x".repeat(REPORT_SIZE_PREFIX.length + String(Number.MAX_SAFE_INTEGER).length + 2)]).failures).toEqual(["printed output without announcing its size"]);
  });

  it("is told of a report's size by the installed observer, before the report", () => {
    const printed: string[] = [];
    const stop = installReportProgress({ [REPORT_PROGRESS_FD_ENV]: String(DESCRIPTOR) }, () => undefined, () => 0, {}, (text) => { printed.push(text); });
    uninstall = stop;
    announceReportOutput(STEP_BOUND_MS);
    expect(printed).toEqual([encodeReportSize(STEP_BOUND_MS)]);
  });
});

describe("reportSilenceWindowMs", () => {
  it("is a unit's allowance plus the interval a unit's note may be dropped for", () => {
    const ALLOWANCE_MS = 123;
    expect(reportSilenceWindowMs(ALLOWANCE_MS)).toBe(ALLOWANCE_MS + LOCAL_WORK_ANNOUNCE_INTERVAL_MS);
    expect(reportSilenceWindowMs(REPORT_QUIET_MS) - LOCAL_WORK_ANNOUNCE_INTERVAL_MS).toBe(REPORT_QUIET_MS);
  });
});
