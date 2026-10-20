import type { RunPort } from "./launcher/ports";

/** The outcome of one external command, as `RunPort` reports it. */
interface ReplayRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an external command without blocking the calling thread. */
export type AsyncRun = (command: string, args: readonly string[]) => Promise<ReplayRunResult>;

/** Thrown by a replaying `RunPort` the first time it is asked for a command it has no answer for; `resolveWithAsyncRuns` runs that command and tries again. */
class RunNeededError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {
    super(`no recorded answer for ${command} ${args.join(" ")}`);
    this.name = "RunNeededError";
  }
}

function keyOf(command: string, args: readonly string[]): string {
  return JSON.stringify([command, args]);
}

/**
 * Runs a synchronous, effect-free decision over commands that can only be run without blocking. `decide` is handed a `RunPort` that answers from what has been run so far and throws when asked for something new; each time that happens the command is run through `runAsync` and `decide` starts again, so it finishes once every command it asks for has an answer. `decide` must therefore change nothing outside itself before it returns (a read-only resolution), since it may be started several times; each command is run once, however many starts ask for it.
 */
export async function resolveWithAsyncRuns<T>(decide: (run: RunPort) => T, runAsync: AsyncRun): Promise<T> {
  const answers = new Map<string, ReplayRunResult>();
  const replay: RunPort = {
    run: (command, args) => {
      const answer = answers.get(keyOf(command, args));
      if (answer === undefined) {
        throw new RunNeededError(command, args);
      }
      return answer;
    },
  };
  for (;;) {
    try {
      return decide(replay);
    } catch (error: unknown) {
      if (!(error instanceof RunNeededError)) {
        throw error;
      }
      answers.set(keyOf(error.command, error.args), await runAsync(error.command, error.args));
    }
  }
}
