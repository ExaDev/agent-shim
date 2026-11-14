import { describe, expect, it } from "vitest";

import { faultLog, keepTicking } from "./keepTicking";
import { errorWithCode } from "./test-helpers";

describe("keepTicking", () => {
  it("does not throw a tick's failure, logs a failure unless it repeats the last one, and logs once when a tick succeeds again", () => {
    const logged: string[] = [];
    const faults: (string | undefined)[] = ["EMFILE: too many open files", "EMFILE: too many open files", "EIO: i/o error", undefined, undefined];
    const callback = keepTicking("catalogue keeper", () => {
      const fault = faults.shift();
      if (fault !== undefined) throw new Error(fault);
    }, (line) => { logged.push(line); });
    const ticks = faults.length;
    for (let tick = 0; tick < ticks; tick += 1) expect(callback).not.toThrow();
    expect(logged).toEqual(["catalogue keeper failed: EMFILE: too many open files", "catalogue keeper failed: EIO: i/o error", "catalogue keeper ticked again"]);
  });

  it("logs a failure again after a different failure or after a success", () => {
    const logged: string[] = [];
    const faults: (string | undefined)[] = ["A", "B", "A", undefined, "A"];
    const callback = keepTicking("x", () => {
      const fault = faults.shift();
      if (fault !== undefined) throw new Error(fault);
    }, (line) => { logged.push(line); });
    const ticks = faults.length;
    for (let tick = 0; tick < ticks; tick += 1) callback();
    expect(logged).toEqual(["x failed: A", "x failed: B", "x failed: A", "x ticked again", "x failed: A"]);
  });

  it("catches a tick's rejected promise, so no rejection goes unhandled", async () => {
    const logged: string[] = [];
    keepTicking("window keeper", async () => { await Promise.reject(new Error("ENFILE")); }, (line) => { logged.push(line); })();
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(logged).toEqual(["window keeper failed: ENFILE"]);
  });

  it("goes on with no log, dropping the failure", () => {
    expect(keepTicking("sweep", () => { throw new Error("x"); }, undefined)).not.toThrow();
  });

  describe.each(["EMFILE", "ENOSPC"])("with a log whose write fails with %s", (code) => {
    /** A log that fails as an append to a log file does when the process has no descriptor left or the disk no space. */
    const failingLog = (): never => { throw errorWithCode(`${code}: failed, open '/state/frontdoor/log'`, code); };

    it("does not throw out of the timer when the tick fails too", () => {
      const callback = keepTicking("catalogue keeper", () => { throw errorWithCode(`${code}: failed, scandir '/state/providers'`, code); }, failingLog);
      expect(callback).not.toThrow();
      expect(callback).not.toThrow();
    });

    it("leaves no rejection unhandled when the tick's promise rejects", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        keepTicking("window keeper", async () => { await Promise.reject(errorWithCode(code, code)); }, failingLog)();
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("lets faultLog record a failure and a success without throwing", () => {
      const faults = faultLog("supervisor tick", failingLog);
      expect(() => { faults.failed(errorWithCode(code, code)); }).not.toThrow();
      expect(() => { faults.succeeded(); }).not.toThrow();
    });
  });
});
