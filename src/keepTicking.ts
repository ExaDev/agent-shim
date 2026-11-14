/**
 * `log` as a logger that does not throw: a log write that fails (an append opened under EMFILE, a disk with no space left) is dropped. A caller handling a failure logs through this, since the log meets the same shortage as the failure being handled and must not throw it out of the handler.
 */
export function quietLog(log: ((line: string) => void) | undefined): (line: string) => void {
  return (line) => {
    try {
      log?.(line);
    } catch {
      // The line is lost; the failure it describes is still handled, and the next line is tried again.
    }
  };
}

/**
 * What a background loop logs of its failures: `failed` logs `<name> failed: <message>` unless the last thing logged was that same failure, and `succeeded` logs `<name> ticked again` once after a failure. A failure is logged again after a different failure or after a success. Each line goes through `quietLog`, so neither throws, whether `log` is absent or its write fails.
 */
export function faultLog(name: string, log: ((line: string) => void) | undefined): { readonly failed: (error: unknown) => void; readonly succeeded: () => void } {
  const write = quietLog(log);
  let lastFault: string | undefined;
  return {
    failed: (error) => {
      const fault = error instanceof Error ? error.message : String(error);
      if (fault !== lastFault) {
        lastFault = fault;
        write(`${name} failed: ${fault}`);
      }
    },
    succeeded: () => {
      if (lastFault !== undefined) {
        lastFault = undefined;
        write(`${name} ticked again`);
      }
    },
  };
}

/**
 * `tick` as a timer callback that does not throw out of the timer: a long-lived process (the front door, a supervisor) ends on an exception thrown from a timer, and every session it serves with it. A failure, thrown or a rejected promise the tick returns, goes to `faultLog`, whose log write cannot throw either, and the next tick runs as usual: a failure of the moment (a file descriptor shortage, which the log's own append meets too) ends neither the timer nor the process. A promise the tick starts and does not return is its own to catch.
 */
export function keepTicking(name: string, tick: () => unknown, log: ((line: string) => void) | undefined): () => void {
  const faults = faultLog(name, log);
  return () => {
    let outcome: unknown;
    try {
      outcome = tick();
    } catch (error) {
      faults.failed(error);
      return;
    }
    if (outcome instanceof Promise) {
      outcome.then(faults.succeeded, faults.failed);
      return;
    }
    faults.succeeded();
  };
}
