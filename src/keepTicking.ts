/**
 * `tick` as a timer callback that never throws out of the timer: a long-lived process (the front door, a supervisor) ends on an exception thrown from a timer, and every session it serves with it. A failure, thrown or a rejected promise, is logged as `<name> failed: <message>` the first time it happens and not again while the same failure repeats, and the next tick runs as usual, so a failure of the moment (a file descriptor shortage) stops nothing. When a tick succeeds again after failing, that is logged once. With no `log` the failure is dropped and the loop still goes on.
 */
export function keepTicking(name: string, tick: () => unknown, log: ((line: string) => void) | undefined): () => void {
  let lastFault: string | undefined;
  const failed = (error: unknown): void => {
    const fault = error instanceof Error ? error.message : String(error);
    if (fault !== lastFault) {
      lastFault = fault;
      log?.(`${name} failed: ${fault}`);
    }
  };
  const succeeded = (): void => {
    if (lastFault !== undefined) {
      lastFault = undefined;
      log?.(`${name} ticked again`);
    }
  };
  return () => {
    let outcome: unknown;
    try {
      outcome = tick();
    } catch (error) {
      failed(error);
      return;
    }
    if (outcome instanceof Promise) {
      outcome.then(succeeded, failed);
      return;
    }
    succeeded();
  };
}
