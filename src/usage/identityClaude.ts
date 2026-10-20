import { buildFarmRuntime, LaunchRefusedError, realPrepareLaunchParams, resolveClaudeLaunch } from "../launchWiring";
import { prepareLaunch } from "../launcher";
import type { LayoutPaths } from "../paths";
import { realRunAsync, type DaemonSpawner } from "../realPorts";
import { recordRuns, type AsyncRun } from "../replayRun";

/** The environment variable that makes a launch skip identity resolution, which would point a headless run at the wrong account. */
const CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR";

/** The environment as the SDK's `env` option takes it: defined values only. */
function definedEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
}

/** The launch flag every headless run adds: the identity's own account, never a provider. A provider a profile or directory rule selects would receive the run's requests at its own URL with its own credential, which an unattended run must not do on a configuration it never chose. */
const IDENTITY_ONLY_FLAG = "--no-provider";

/** The launcher argv for a headless run as `identity`: the identity, the account-only flag, then the caller's flags. */
export function identityLaunchArgv(identity: string, flags: readonly string[]): readonly string[] {
  return [`@${identity}`, IDENTITY_ONLY_FLAG, ...flags];
}

/** What running the real `claude` as an identity needs beyond the state root. */
export interface IdentityClaudeParams {
  readonly paths: LayoutPaths;
  /** The directory launches are planned for. */
  readonly cwd: string;
  /** Starts the front door and headroom daemons an identity's launch routes through. */
  readonly spawnDaemon: DaemonSpawner;
  /** The longest one run may take, which also bounds the CLI's start-up. */
  readonly timeoutMs: number;
  /** Runs the commands a launch decision asks for (the git branch of the directory, the Keychain probe of an identity's login) without blocking; the real one unless a test supplies another. */
  readonly runAsync?: AsyncRun;
}

/** What a run gets: the planned binary and environment, and the controller that ends it when the time limit passes. */
export interface IdentityClaudeRun {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly abort: AbortController;
}

/**
 * Plans a launch of the real `claude` as `identity` (its own configuration directory, credential and routing, with the daemons the launch needs), runs `use` against that plan under `timeoutMs`, and releases the plan afterwards however `use` ends. `flags` are launch flags added to the plan. Throws `LaunchRefusedError` carrying the launcher's own messages when the launch is refused, such as for a signed-out identity.
 */
export async function withIdentityClaude<T>(params: Readonly<IdentityClaudeParams>, identity: string, flags: readonly string[], use: (run: IdentityClaudeRun) => Promise<T>): Promise<T> {
  const refusals: string[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== CONFIG_DIR_VARIABLE));
  const argv = [...identityLaunchArgv(identity, flags)];
  // The launcher's decision asks for commands (a git branch, a Keychain probe) that spawn synchronously, and this runs inside the front door when the door refreshes usage: the read-only resolution of the same launch is started until every command it asks for has been run without blocking, and the launch below is planned over those answers.
  const run = await recordRuns((replay) => resolveClaudeLaunch({ argv, cwd: params.cwd, env: definedEnvironment(env), paths: params.paths }, replay), params.runAsync ?? realRunAsync);
  const plan = prepareLaunch(
    realPrepareLaunchParams(params.paths, {
      proc: {
        env,
        argv,
        exit: (code) => {
          throw new LaunchRefusedError(refusals.join("\n") || `the launch was refused (exit ${String(code)})`, code);
        },
      },
      log: {
        info: () => undefined,
        report: () => undefined,
        warn: () => undefined,
        error: (message) => {
          refusals.push(message);
        },
      },
      spawnDaemon: params.spawnDaemon,
      run,
      farm: buildFarmRuntime(params.paths, params.cwd, run),
    }),
  );
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, params.timeoutMs);
  try {
    return await use({ bin: plan.bin, env: definedEnvironment(plan.env), cwd: params.cwd, abort });
  } finally {
    clearTimeout(timer);
    plan.release();
  }
}
