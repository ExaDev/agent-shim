import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const psRuns = vi.hoisted(() => ({ count: 0, active: 0, mostActive: 0, throwNext: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: ((command: string, ...rest: readonly unknown[]) => {
      if (command === "ps") {
        if (psRuns.throwNext) {
          psRuns.throwNext = false;
          throw new Error("spawn refused");
        }
        psRuns.count += 1;
        psRuns.active += 1;
        psRuns.mostActive = Math.max(psRuns.mostActive, psRuns.active);
        const callback = rest[rest.length - 1] as (...args: readonly unknown[]) => void;
        const wrapped = (...args: readonly unknown[]): void => {
          psRuns.active -= 1;
          callback(...args);
        };
        return (actual.execFile as (...args: readonly unknown[]) => unknown)(command, ...rest.slice(0, -1), wrapped);
      }
      return (actual.execFile as (...args: readonly unknown[]) => unknown)(command, ...rest);
    }) as typeof actual.execFile,
  };
});

import { realRunningAmong } from "./realPorts";

/** More callers than any one tick has, all asking at once. */
const CONCURRENT_CALLERS = 40;
/** One read in flight when the callers ask, and one read for everyone who asked while it ran. */
const MOST_READS_FOR_ONE_BURST = 2;

describe.skipIf(process.platform === "win32")("realRunningAmong process-table reads", () => {
  /** A pid that has exited and been reaped, so nothing holds it. */
  function exitedPid(): number {
    return spawnSync(process.execPath, ["-e", "0"]).pid;
  }

  it("shares one process-table read among callers that ask while another is running, and runs one at a time", async () => {
    const gone = exitedPid();
    psRuns.count = 0;
    psRuns.mostActive = 0;
    const answers = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, async () => await realRunningAmong([process.pid, gone])));
    expect(psRuns.count).toBeLessThanOrEqual(MOST_READS_FOR_ONE_BURST);
    expect(psRuns.mostActive).toBe(1);
    for (const answer of answers) {
      expect(answer).toEqual(new Set([process.pid]));
    }
  });

  it("answers each caller for its own pids when callers ask about different pids at once", async () => {
    const gone = exitedPid();
    const [mine, theirs] = await Promise.all([realRunningAmong([process.pid]), realRunningAmong([process.ppid, gone])]);
    expect(mine).toEqual(new Set([process.pid]));
    expect(theirs.has(gone)).toBe(false);
    expect(theirs.has(process.ppid)).toBe(true);
  });

  it("reports nothing for a read that cannot be started and reads again for the next caller", async () => {
    psRuns.throwNext = true;
    expect(await realRunningAmong([process.pid])).toEqual(new Set([process.pid]));
    expect(await realRunningAmong([process.pid])).toEqual(new Set([process.pid]));
  });

  it("is not made to fail by a pid ps cannot read, and still answers for the others asking at once", async () => {
    const [, good] = await Promise.all([realRunningAmong([0, -1]), realRunningAmong([process.pid, exitedPid()])]);
    expect(good).toEqual(new Set([process.pid]));
  });
});
