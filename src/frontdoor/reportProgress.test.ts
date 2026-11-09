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
  ReportReleaseSkewError,
  reportProgressTarget,
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

const PARENT = 4_242;
const RELEASE = "12.0.0";

/** The value a door that is process `PARENT` gives a child announcing on `DESCRIPTOR`. */
const TARGET = reportProgressTarget(DESCRIPTOR, PARENT, RELEASE);

/** `installReportProgress` as the child of process `PARENT`. */
function installAsChild(env: Readonly<Record<string, string | undefined>>, write: (fd: number, text: string) => void, now: () => number = () => 0, fsModule: object = {}, writeOutput: (text: string) => void = () => undefined): (() => void) | undefined {
  return installReportProgress(env, write, now, fsModule, writeOutput, PARENT, RELEASE);
}

describe("installReportProgress", () => {
  it("removes the variable from the environment it was read from, so no process started later inherits it", () => {
    const env: Record<string, string | undefined> = { [REPORT_PROGRESS_FD_ENV]: String(DESCRIPTOR), OTHER: "kept" };
    uninstall = installAsChild(env, () => undefined);
    expect(env).toEqual({ OTHER: "kept" });
  });

  it("removes the variable and announces nothing when it does not name this process's parent, or is not a descriptor and a parent", () => {
    for (const named of [reportProgressTarget(DESCRIPTOR, PARENT + 1, RELEASE), reportProgressTarget(DESCRIPTOR, PARENT + 1, "13.0.0"), String(DESCRIPTOR), `${String(DESCRIPTOR)}:${String(PARENT)}`, "not-a-number", "3:x", "3.5:4242", "-1:4242", "", ":4242", "3:"]) {
      const written: string[] = [];
      const env: Record<string, string | undefined> = { [REPORT_PROGRESS_FD_ENV]: named };
      expect(installReportProgress(env, (_fd, text) => { written.push(text); }, () => 0, {}, () => undefined, PARENT, RELEASE), named).toBeUndefined();
      withBlockingStep(undefined, () => undefined);
      expect(env).toEqual({});
      expect(written).toEqual([]);
    }
  });

  it("refuses, naming both releases and how to replace the door, when the door that started it is of another release, and still removes the variable", () => {
    const env: Record<string, string | undefined> = { [REPORT_PROGRESS_FD_ENV]: reportProgressTarget(DESCRIPTOR, PARENT, "12.1.0") };
    expect(() => installReportProgress(env, () => undefined, () => 0, {}, () => undefined, PARENT, RELEASE)).toThrow(ReportReleaseSkewError);
    expect(() => installReportProgress({ [REPORT_PROGRESS_FD_ENV]: reportProgressTarget(DESCRIPTOR, PARENT, "12.1.0") }, () => undefined, () => 0, {}, () => undefined, PARENT, RELEASE)).toThrow(/runs agent-shim 12\.1\.0, and this is agent-shim 12\.0\.0.*agent-shim frontdoor restart/);
    expect(env).toEqual({});
  });

  it("does nothing when the environment names no descriptor", () => {
    const written: string[] = [];
    expect(installReportProgress({}, (_fd, text) => { written.push(text); })).toBeUndefined();
    withBlockingStep(undefined, () => undefined);
    expect(written).toEqual([]);
  });

  it("writes each step's bound and end to the named descriptor, and gives an unbounded step the report limit", () => {
    const written: { readonly fd: number; readonly text: string }[] = [];
    uninstall = installAsChild({ [REPORT_PROGRESS_FD_ENV]: TARGET }, (fd, text) => { written.push({ fd, text }); });
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
    uninstall = installAsChild({ [REPORT_PROGRESS_FD_ENV]: TARGET }, (_fd, text) => { written.push(text); }, () => clock);
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
    const stop = installAsChild({ [REPORT_PROGRESS_FD_ENV]: TARGET }, (_fd, text) => { written.push(text); }, () => clock, module);
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
  /** The first byte of a two-byte UTF-8 character (U+00C3 onward). */
  const TWO_BYTE_LEAD = Array.from(Buffer.from("é").subarray(0, 1));
  /** Where the test splits a report: inside the two-byte character, then inside the three-byte one. */
  const FIRST_SPLIT = 7;
  const SECOND_SPLIT = 9;
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

  it("counts the raw bytes of a report cut off inside a multibyte character, whatever the chunking", () => {
    const failures: string[] = [];
    const reader = createReportOutputReader((reason) => { failures.push(reason); });
    const announced = 10;
    // Eight bytes and the first byte of a two-byte character: nine bytes received, one short of what was announced.
    reader.push(Buffer.concat([Buffer.from(encodeReportSize(announced)), Buffer.from("aaaaaaaa"), Buffer.from(TWO_BYTE_LEAD)]));
    expect(failures).toEqual([]);
    expect(reader.shortRead()).toEqual({ received: 9, announced });
  });

  it("reads a healthy multibyte report whole when a character is split across chunks", () => {
    const failures: string[] = [];
    const reader = createReportOutputReader((reason) => { failures.push(reason); });
    const report = Buffer.from('{"a":"é€😀"}');
    reader.push(Buffer.concat([Buffer.from(encodeReportSize(report.length)), report.subarray(0, FIRST_SPLIT)]));
    reader.push(report.subarray(FIRST_SPLIT, SECOND_SPLIT));
    reader.push(report.subarray(SECOND_SPLIT));
    expect(failures).toEqual([]);
    expect(reader.shortRead()).toBeUndefined();
    expect(reader.report()).toBe('{"a":"é€😀"}');
  });

  it("counts the report in bytes, not characters", () => {
    const report = "{\"a\":\"é\"}";
    expect(read([`${encodeReportSize(Buffer.byteLength(report))}${report}`]).failures).toEqual([]);
    expect(read([`${encodeReportSize(1)}é`]).failures).toEqual(["printed more than the 1 bytes it announced"]);
  });

  it("fails on a report longer than it announced", () => {
    expect(read([`${encodeReportSize(2)}abc`]).failures).toEqual(["printed more than the 2 bytes it announced"]);
  });

  it.each(["", " 12", "12 ", "12\r", "1e3", "0x10", "+5", "-4", "1.5", "１２", "12abc"])("refuses the size %j as malformed, and keeps no report", (size) => {
    const failures: string[] = [];
    const reader = createReportOutputReader((reason) => { failures.push(reason); });
    reader.push(`${REPORT_SIZE_PREFIX}${size}\n{}`);
    expect(failures).toEqual(["printed output without announcing its size"]);
    expect(reader.report()).toBe("");
  });

  it("accepts a size of digits, including zero and leading zeros", () => {
    const failures: string[] = [];
    const empty = createReportOutputReader((reason) => { failures.push(reason); });
    empty.push(`${REPORT_SIZE_PREFIX}0\n`);
    const padded = createReportOutputReader((reason) => { failures.push(reason); });
    padded.push(`${REPORT_SIZE_PREFIX}002\n{}`);
    expect(failures).toEqual([]);
    expect(padded.report()).toBe("{}");
  });

  it("fails on output with no size line, a malformed one or one that never ends", () => {
    expect(read(["{}\n"]).failures).toEqual(["printed output without announcing its size"]);
    expect(read([`${REPORT_SIZE_PREFIX}many\n`]).failures).toEqual(["printed output without announcing its size"]);
    expect(read([`${REPORT_SIZE_PREFIX}-4\n`]).failures).toEqual(["printed output without announcing its size"]);
    expect(read(["x".repeat(REPORT_SIZE_PREFIX.length + String(Number.MAX_SAFE_INTEGER).length + 2)]).failures).toEqual(["printed output without announcing its size"]);
  });

  it("says how much of the announced size is missing once the child has ended, and nothing when the report is whole", () => {
    const reader = createReportOutputReader(() => undefined);
    expect(reader.shortRead()).toBeUndefined();
    const announced = "abcdefghij";
    const FIRST_PART = 3;
    reader.push(`${encodeReportSize(announced.length)}${announced.slice(0, FIRST_PART)}`);
    expect(reader.shortRead()).toEqual({ received: FIRST_PART, announced: announced.length });
    reader.push(announced.slice(FIRST_PART));
    expect(reader.shortRead()).toBeUndefined();
  });

  it("is told of a report's size by the installed observer, before the report", () => {
    const printed: string[] = [];
    const stop = installAsChild({ [REPORT_PROGRESS_FD_ENV]: TARGET }, () => undefined, () => 0, {}, (text) => { printed.push(text); });
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
