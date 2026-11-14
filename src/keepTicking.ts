/**
 * What a background loop logs of its failures: `failed` logs `<name> failed: <message>` unless the last thing logged was that same failure, and `succeeded` logs `<name> ticked again` once after a failure. A failure is logged again after a different failure or after a success. With no `log`, nothing is written and the loop still goes on.
 */
export function faultLog(name: string, log: ((line: string) => void) | undefined): { readonly failed: (error: unknown) => void; readonly succeeded: () => void } {
  let lastFault: string | undefined;
  return {
    failed: (error) => {
      const fault = error instanceof Error ? error.message : String(error);
      if (fault !== lastFault) {
        lastFault = fault;
        log?.(`${name} failed: ${fault}`);
      }
    },
    succeeded: () => {
      if (lastFault !== undefined) {
        lastFault = undefined;
        log?.(`${name} ticked again`);
      }
    },
  };
}

/**
 * `tick` as a timer callback that does not throw out of the timer: a long-lived process (the front door, a supervisor) ends on an exception thrown from a timer, and every session it serves with it. A failure, thrown or a rejected promise the tick returns, goes to `faultLog`, and the next tick runs as usual, so a failure of the moment (a file descriptor shortage) stops nothing. A promise the tick starts and does not return is its own to catch.
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
