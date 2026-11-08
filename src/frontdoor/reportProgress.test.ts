import { afterEach, describe, expect, it } from "vitest";

import { withBlockingStep } from "../blockingSteps";
import {
  REPORT_PROGRESS_FD_ENV,
  REPORT_UNBOUNDED_STEP_LIMIT_MS,
  createReportProgressReader,
  encodeReportProgress,
  installReportProgress,
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
