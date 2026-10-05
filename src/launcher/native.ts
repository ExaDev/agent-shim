import { UsageError } from "../cliError";
import type { ParsedLauncherArgv } from "./argv";
import type { ProcPort, SpawnPort } from "./ports";
import { spawnClaude } from "./spawn";
import type { ClaudeBinaryResolver } from "../versionDiscovery";

/** Raised when `--native` is combined with a launch flag: a native launch applies nothing from agent-shim, so the flag would be silently ignored. */
export class NativeLaunchConflictError extends UsageError {
  constructor(readonly conflicts: readonly string[]) {
    super(`--native runs the real claude with nothing from agent-shim applied, so it cannot be combined with ${conflicts.join(", ")}. Drop --native, or drop those.`);
    this.name = "NativeLaunchConflictError";
  }
}

/** The launch flags present in `parsed`, as the user typed them, in a stable order. `--native` itself is not among them. */
function otherLaunchFlags(parsed: ParsedLauncherArgv): string[] {
  return [
    ...(parsed.identity === undefined ? [] : ["@<identity> / --identity"]),
    ...(parsed.configProfile === undefined ? [] : ["--config-profile"]),
    ...(parsed.provider === undefined ? [] : [parsed.provider === false ? "--no-provider" : "--provider"]),
    ...(parsed.claudeVersion === undefined ? [] : ["--claude-version"]),
    ...(parsed.headroom === undefined ? [] : ["--[no-]headroom"]),
    ...(parsed.trackUsage === undefined ? [] : ["--[no-]track-usage"]),
    ...(parsed.skipPermissions === undefined ? [] : ["--[no-]skip-permissions"]),
    ...(parsed.remoteControl === undefined ? [] : ["--[no-]remote-control"]),
    ...(parsed.wait === undefined ? [] : ["--[no-]wait"]),
    ...(parsed.categoryFlags.length === 0 ? [] : ["--category"]),
    ...(parsed.shareFlags.length === 0 ? [] : ["--share"]),
    ...(parsed.hideFlags.length === 0 ? [] : ["--hide"]),
  ];
}

/** Everything a native launch touches, injected so it runs against fakes in tests. */
export interface NativeLaunchParams {
  readonly parsed: ParsedLauncherArgv;
  readonly proc: ProcPort;
  readonly spawn: SpawnPort;
  /** Discovers the real `claude` binary, skipping agent-shim's own. */
  readonly resolveClaudeBinary: ClaudeBinaryResolver;
}

/**
 * Runs the real `claude` with every remaining argument forwarded verbatim and the caller's environment as it is: no identity, pool, configuration profile, directory rule, farm, `CLAUDE_CONFIG_DIR`, provider or identity credential, front door, headroom, usage tracking, injected launch flag or ambient-credential guard. For ruling the shim out when debugging Claude Code, or running against plain `~/.claude`.
 *
 * Throws `NativeLaunchConflictError` when another launch flag was given, rather than ignoring it.
 */
export function runNativeLaunch(params: NativeLaunchParams): never {
  const conflicts = otherLaunchFlags(params.parsed);
  if (conflicts.length > 0) {
    throw new NativeLaunchConflictError(conflicts);
  }
  const discovered = params.resolveClaudeBinary();
  return spawnClaude({ bin: discovered.path, args: params.parsed.rest, env: params.proc.env, spawn: params.spawn, proc: params.proc });
}
