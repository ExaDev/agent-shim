import { describe, expect, it } from "vitest";

import { keepTicking } from "./keepTicking";

describe("keepTicking", () => {
  it("never throws a tick's failure, logs each distinct failure once, and logs once when a tick succeeds again", () => {
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

  it("catches a tick's rejected promise, so no rejection goes unhandled", async () => {
    const logged: string[] = [];
    keepTicking("window keeper", async () => { await Promise.reject(new Error("ENFILE")); }, (line) => { logged.push(line); })();
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(logged).toEqual(["window keeper failed: ENFILE"]);
  });

  it("goes on with no log, dropping the failure", () => {
    expect(keepTicking("sweep", () => { throw new Error("x"); }, undefined)).not.toThrow();
  });
});
