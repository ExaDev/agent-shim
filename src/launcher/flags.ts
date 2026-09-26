import path from "node:path";

import type { LaunchFlags, Provider } from "../config/schema";

/** The fully resolved launch flags for one launch. */
export interface ResolvedLaunchFlags {
  readonly skipPermissions: boolean;
  readonly remoteControl: boolean;
}

function isEnvFlagSet(value: string | undefined): boolean {
  return value === "1";
}

/** Inputs to `resolveLaunchFlags`. */
export interface ResolveLaunchFlagsParams {
  /**
   * The already-resolved cascade value for launch flags, when one exists. Undefined for this phase, since the cascade/farm resync that would produce it lands in Phase 5 — `resolveLaunchFlags` treats an absent cascade exactly like one that set nothing, so this function needs no change once Phase 5 starts supplying a real value here.
   */
  readonly cascade?: LaunchFlags;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves `skipPermissions`/`remoteControl` for one launch: the cascade's own value (once Phase 5 wires it) OR-ed with the one-off environment variable escape hatch, defaulting to OFF for both when neither says otherwise.
 *
 * This default-off posture is a deliberate change from the legacy bash tool, which passed `--dangerously-skip-permissions` unconditionally on every launch.
 */
export function resolveLaunchFlags(params: ResolveLaunchFlagsParams): ResolvedLaunchFlags {
  return {
    skipPermissions: params.cascade?.skipPermissions === true || isEnvFlagSet(params.env.CLAUDE_USE_SKIP_PERMISSIONS),
    remoteControl: params.cascade?.remoteControl === true || isEnvFlagSet(params.env.CLAUDE_USE_REMOTE_CONTROL),
  };
}

/**
 * Builds the tool's own flag arguments from resolved launch flags.
 *
 * `--remote-control=` always carries a literal trailing `=` with an empty value — never bare `--remote-control` — confirmed as a deliberate fix in the legacy script's own git history to stop the flag from consuming the next positional argument as its value.
 */
export function buildFlagArgs(flags: ResolvedLaunchFlags): string[] {
  const args: string[] = [];
  if (flags.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (flags.remoteControl) {
    args.push("--remote-control=");
  }
  return args;
}

/** Inputs to `buildArgv`. */
export interface BuildArgvParams {
  readonly toolFlags: readonly string[];
  readonly extraFlags: readonly string[];
  readonly passthrough: readonly string[];
}

/**
 * Assembles the final argv passed to the real `claude` binary: tool flags, then `$CLAUDE_EXTRA_FLAGS`, then the user's own forwarded arguments, in that exact order.
 *
 * Extra flags must land BEFORE the passthrough args — confirmed load-bearing against real wrapper scripts (`cpl`, `mp`, `zpl`) that set `CLAUDE_EXTRA_FLAGS="--print"` and then pass a positional prompt afterwards; reversing this order would feed the prompt to `--print` as if it were a flag value instead of a trailing positional.
 */
export function buildArgv(params: BuildArgvParams): string[] {
  return [...params.toolFlags, ...params.extraFlags, ...params.passthrough];
}

/** The provider resolved for this launch, with its token already read out of the parent environment. */
export interface ResolvedProvider {
  readonly name: string;
  readonly definition: Provider;
  readonly token: string;
}

/** Inputs to `buildEnv`. */
export interface BuildEnvParams {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** True when `CLAUDE_CONFIG_DIR` was already set and the escape hatch applied — `buildEnv` must leave it untouched in that case. */
  readonly configDirEscapeHatch: boolean;
  /** The identity name resolved for this launch, when one was resolved. */
  readonly resolvedIdentityName?: string;
  readonly identitiesDir: string;
  /** The provider resolved for this launch, when one was resolved. Its token is supplied by the caller because reading it and refusing an unset one needs the caller's log/exit ports. */
  readonly provider?: ResolvedProvider;
}

/**
 * Builds the environment the real `claude` binary is spawned with.
 *
 * When the `CLAUDE_CONFIG_DIR`-already-set escape hatch applied, or no identity was resolved at all (a bare launch with no active identity, matching the legacy script's own "no profile means plain `~/.claude`" behaviour), `CLAUDE_CONFIG_DIR` is left untouched. Otherwise `CLAUDE_CONFIG_DIR` is set to the resolved identity's own directory under `identitiesDir` — farm population into that directory is Phase 5's job, not this function's.
 *
 * A resolved provider is applied regardless of the identity outcome, because it selects which API endpoint the child talks to, not which login's data it sees: `ANTHROPIC_BASE_URL` points at the provider, `ANTHROPIC_AUTH_TOKEN` carries the token read from the provider's `tokenEnv`, `CLAUDE_USE_PROVIDER` names the provider for the statusline, and the provider's own `env` entries land verbatim. `ANTHROPIC_API_KEY` is explicitly cleared (to the empty string, which Claude Code treats as unset) unless the provider's `env` names its own value: an ambient `ANTHROPIC_API_KEY` inherited from the parent would outrank the token just set, silently authenticating the child as the ambient key instead of the provider.
 *
 * `$CLAUDE_EXTRA_FLAGS` is never stripped from the child's environment: some wrappers set it two process-levels up and rely on inheritance through a `claude` invoked from inside a running session.
 */
export function buildEnv(params: BuildEnvParams): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...params.baseEnv };

  if (!params.configDirEscapeHatch && params.resolvedIdentityName !== undefined) {
    env.CLAUDE_CONFIG_DIR = path.join(params.identitiesDir, params.resolvedIdentityName);
  }

  if (params.provider !== undefined) {
    const providerEnv = params.provider.definition.env ?? {};
    env.ANTHROPIC_BASE_URL = params.provider.definition.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = params.provider.token;
    env.ANTHROPIC_API_KEY = providerEnv.ANTHROPIC_API_KEY ?? "";
    env.CLAUDE_USE_PROVIDER = params.provider.definition.displayName;
    for (const [key, value] of Object.entries(providerEnv)) {
      env[key] = value;
    }
  }

  return env;
}
