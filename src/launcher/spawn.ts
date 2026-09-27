import os from "node:os";

import type { ProcPort, SpawnPort, SpawnResult } from "./ports";

/** Inputs to `spawnClaude`. */
export interface SpawnClaudeParams {
  /** Full path to the real `claude` binary to run, as discovered by `src/versionDiscovery.ts`. */
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: SpawnPort;
  readonly proc: ProcPort;
  /**
   * Runs immediately before the child's exit code propagates. The real `process.exit` never unwinds a `finally` block, so a caller with cleanup to do on the success path (releasing a headroom session registration, say) cannot rely on one; it passes the cleanup here instead.
   */
  readonly beforeExit?: () => void;
}

// The conventional shell exit-code offset for a signal-terminated process (matching what a real shell's `exec` would report): 128 plus the signal's own number.
const SIGNAL_EXIT_CODE_OFFSET = 128;

/**
 * Derives the exit code to propagate from a completed `spawnSync` result: the child's own exit status when it exited normally, or the conventional `128 + signal number` when it was terminated by a signal, or `1` as a last resort when the result carries neither. `os.constants.signals` is a closed mapping over every `NodeJS.Signals` name to its numeric value, so indexing it with a non-null `result.signal` is always defined -- confirmed directly, not merely assumed, since the earlier defensive `undefined` fallback here was itself flagged as unreachable.
 */
function exitCodeFor(result: SpawnResult): number {
  if (result.status !== null) {
    return result.status;
  }
  if (result.signal !== null) {
    return SIGNAL_EXIT_CODE_OFFSET + os.constants.signals[result.signal];
  }
  return 1;
}

/**
 * Runs the real `claude` binary and propagates its exit code faithfully, the Node equivalent of the legacy bash tool's `exec` (process replacement): `spawnSync(bin, args, { stdio: "inherit" })` followed by `process.exit(status)`.
 *
 * Throws when the child could not even be spawned (e.g. `bin` does not exist) rather than silently exiting — a spawn failure is a real problem, not a clean exit code to propagate.
 */
export function spawnClaude(params: SpawnClaudeParams): never {
  const result = params.spawn.spawnSync(params.bin, params.args, { stdio: "inherit", env: params.env });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (params.beforeExit !== undefined) {
    params.beforeExit();
  }
  return params.proc.exit(exitCodeFor(result));
}
