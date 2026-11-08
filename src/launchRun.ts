import { runLaunchPlan } from "./launcher";
import { prepareClaudeLaunch } from "./launchWiring";
import { refreshLaunchPoolUsage, type RefreshLaunchPoolUsageOptions } from "./poolUsageRefresh";
import { realSpawnPort } from "./realPorts";

/** What `runClaudeLaunch` needs: the launch to run, the stale-usage refresh's own options, and where warnings go. */
export interface RunClaudeLaunchOptions extends RefreshLaunchPoolUsageOptions {
  /** Receives each warning preparing the launch raised, before the child starts; when absent each is written to standard error, as the command line does. */
  readonly onWarning?: (message: string) => void;
}

/**
 * Runs one `claude` launch for `options.cwd` on this machine as `agent-shim run` does, and resolves to the child's exit code: a pool the launch selects first has its stale usage refreshed (`refreshLaunchPoolUsage`) so the pick ranks on current figures, then the launch is prepared (`prepareClaudeLaunch`), the child runs with the terminal's standard streams until it ends, and the launch's front door and headroom registrations are released whether it exited, was signalled (`128` plus the signal number) or could not be spawned. It does not exit this process, so the host decides what to do with the code.
 *
 * Rejects with `LaunchRefusedError` before anything is spawned when the launch is refused, and with the spawn failure, after releasing, when the child could not be started. Warnings the launch raised (an unreachable provider among them) go to `onWarning`, else standard error. Interactive offers (creating a missing identity or profile) and the launch-time update notice belong to the command line and are not made here.
 */
export async function runClaudeLaunch(options: RunClaudeLaunchOptions): Promise<number> {
  await refreshLaunchPoolUsage(options);
  const plan = prepareClaudeLaunch(options);
  const warn = options.onWarning ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  for (const message of plan.warnings) {
    warn(message);
  }
  return runLaunchPlan(plan, realSpawnPort);
}
