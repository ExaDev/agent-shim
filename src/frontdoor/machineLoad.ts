import os from "node:os";

/** One reading of the machine's load: the one-minute load average (runnable threads, averaged) and the processor count it is shared across. */
export interface MachineLoadReading {
  readonly loadAverage: number;
  readonly cpus: number;
}

/**
 * The share of one processor the machine's load leaves a runnable thread: all of one while the run queue is within the processor count, the processor count over the load average beyond it. The door's time budgets are counted in time multiplied by this share, so a door the machine did not schedule is never judged as one that had the time and failed.
 *
 * Self-contained by contract (no imports, no closure over module state): the watchdog thread's source embeds this function's own text, so the thread and the main thread judge by one formula.
 */
export const processorShare = (reading: MachineLoadReading): number => (reading.loadAverage <= reading.cpus ? 1 : reading.cpus / reading.loadAverage);

/** Reads this machine's load now: `os.loadavg()`'s one-minute figure and `os.cpus()`'s count. */
export function readMachineLoad(): MachineLoadReading {
  const [oneMinute] = os.loadavg();
  if (oneMinute === undefined) {
    throw new Error("os.loadavg() returned no one-minute load average");
  }
  return { loadAverage: oneMinute, cpus: os.cpus().length };
}
