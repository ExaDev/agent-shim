import path from "node:path";

import { parseEnvBool } from "../cli/parsers";
import type { LaunchFlags, Provider } from "../config/schema";
import { mergeAnthropicCustomHeaders } from "../headroom/headers";
import type { HeadroomUp } from "./ports";

/** The fully resolved launch flags for one launch. */
export interface ResolvedLaunchFlags {
  readonly skipPermissions: boolean;
  readonly remoteControl: boolean;
  readonly headroom: boolean;
}

/** The one-off command-line forms of the three boolean launch flags, each undefined when neither its positive nor its `--no-` form was given. */
interface LaunchFlagOverrides {
  readonly skipPermissions?: boolean;
  readonly remoteControl?: boolean;
  readonly headroom?: boolean;
}

/** Inputs to `resolveLaunchFlags`. */
export interface ResolveLaunchFlagsParams {
  /** The cascade's resolved `launch` block, when a cascade was loaded for this launch. */
  readonly cascade?: LaunchFlags;
  /** The launch's own `--[no-]skip-permissions`, `--[no-]remote-control` and `--[no-]headroom` flags. */
  readonly flags?: LaunchFlagOverrides;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves `skipPermissions`/`remoteControl`/`headroom` for one launch. Each setting has the same three forms, decided in the same order: an explicit command-line flag outright, then its environment variable (`CLAUDE_USE_SKIP_PERMISSIONS`, `CLAUDE_USE_REMOTE_CONTROL`, `CLAUDE_USE_HEADROOM`), then the cascade, and OFF when none of them says otherwise. The flag outranks the environment variable because it is the more deliberate of the two one-off forms (typed on this very command line, not inherited from a shell profile), and both outrank the cascade because they are one-off overrides of it.
 *
 * Environment variables read with the shared boolean vocabulary (`true`/`1`, `false`/`0`), so `CLAUDE_USE_SKIP_PERMISSIONS=0` switches off a cascade's `skipPermissions: true` for one launch; any other value throws `InvalidEnvBoolError`.
 *
 * This default-off posture is a deliberate change from the legacy bash tool, which passed `--dangerously-skip-permissions` unconditionally on every launch.
 */
export function resolveLaunchFlags(params: ResolveLaunchFlagsParams): ResolvedLaunchFlags {
  return {
    skipPermissions:
      params.flags?.skipPermissions ??
      parseEnvBool("CLAUDE_USE_SKIP_PERMISSIONS", params.env.CLAUDE_USE_SKIP_PERMISSIONS) ??
      params.cascade?.skipPermissions ??
      false,
    remoteControl:
      params.flags?.remoteControl ??
      parseEnvBool("CLAUDE_USE_REMOTE_CONTROL", params.env.CLAUDE_USE_REMOTE_CONTROL) ??
      params.cascade?.remoteControl ??
      false,
    headroom:
      params.flags?.headroom ?? parseEnvBool("CLAUDE_USE_HEADROOM", params.env.CLAUDE_USE_HEADROOM) ?? params.cascade?.headroom ?? false,
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

/** The provider resolved for this launch, with its token already obtained from the parent environment, the token command or the provider's fixed env credential. */
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
  /** The headroom daemon this launch routes through, when headroom resolved on. How the child is routed depends on the mode: with a provider, the child talks to the daemon directly and the provider's own base URL moves into the per-request `x-headroom-base-url` header; without one (an OAuth launch), the child keeps talking to the real API through the supervisor's MITM proxy, because Claude Code enables Remote Control and connectors only against `api.anthropic.com`. */
  readonly headroom?: HeadroomUp;
}

/**
 * Builds the environment the real `claude` binary is spawned with.
 *
 * When the `CLAUDE_CONFIG_DIR`-already-set escape hatch applied, or no identity was resolved at all (a bare launch with no active identity, matching the legacy script's own "no profile means plain `~/.claude`" behaviour), `CLAUDE_CONFIG_DIR` is left untouched. Otherwise `CLAUDE_CONFIG_DIR` is set to the resolved identity's own directory under `identitiesDir` — farm population into that directory is Phase 5's job, not this function's.
 *
 * A resolved provider is applied regardless of the identity outcome, because it selects which API endpoint the child talks to, not which login's data it sees: `ANTHROPIC_BASE_URL` points at the provider, `ANTHROPIC_AUTH_TOKEN` carries the token resolved from the provider's `tokenEnv`, `tokenCommand` or fixed env credential, `CLAUDE_USE_PROVIDER` names the provider for the statusline, and the provider's own `env` entries land verbatim. `ANTHROPIC_API_KEY` is explicitly cleared (to the empty string, which Claude Code treats as unset) unless the provider's `env` names its own value: an ambient `ANTHROPIC_API_KEY` inherited from the parent would outrank the token just set, silently authenticating the child as the ambient key instead of the provider. A provider with `authScheme: "apiKey"` inverts that pair: `ANTHROPIC_API_KEY` carries the token and `ANTHROPIC_AUTH_TOKEN` is cleared, so an ambient bearer token cannot outrank it either.
 *
 * A resolved headroom daemon is applied last, on top of the provider, and picks its routing mode from provider presence alone (no user-facing setting decides it): with a provider, the child's `ANTHROPIC_BASE_URL` becomes the local proxy (never the provider's own URL) and the provider's upstream moves into the `x-headroom-base-url` header, exactly as before. Without a provider (an OAuth launch), the base URL is left untouched and routing happens one layer down instead: `HTTPS_PROXY` points the child at the supervisor's MITM proxy and `NODE_EXTRA_CA_CERTS` trusts its CA, so the child still believes it is talking to the real `api.anthropic.com` (the belief Remote Control and connectors require) while the proxy's terminated TLS feeds headroom's paths to the daemon. `HEADROOM_PROXY_URL` names the daemon for anything else that wants it, and `ANTHROPIC_CUSTOM_HEADERS` gains `x-headroom-project-id` (memory scoping) in both modes, merged with any headers the provider's own `env` or the parent environment already set.
 *
 * `$CLAUDE_EXTRA_FLAGS` is never stripped from the child's environment: some wrappers set it two process-levels up and rely on inheritance through a `claude` invoked from inside a running session.
 */
export function buildEnv(params: BuildEnvParams): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...params.baseEnv };
  // Captured before the provider application below, which would otherwise overwrite it: the parent's own custom headers and the provider's must MERGE when headroom adds its entries, not replace each other.
  const parentCustomHeaders = params.baseEnv.ANTHROPIC_CUSTOM_HEADERS;
  let providerCustomHeaders: string | undefined;

  if (!params.configDirEscapeHatch && params.resolvedIdentityName !== undefined) {
    env.CLAUDE_CONFIG_DIR = path.join(params.identitiesDir, params.resolvedIdentityName);
  }

  if (params.provider !== undefined) {
    const providerEnv = params.provider.definition.env ?? {};
    providerCustomHeaders = providerEnv.ANTHROPIC_CUSTOM_HEADERS;
    env.ANTHROPIC_BASE_URL = params.provider.definition.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = params.provider.token;
    env.ANTHROPIC_API_KEY = providerEnv.ANTHROPIC_API_KEY ?? "";
    env.CLAUDE_USE_PROVIDER = params.provider.definition.displayName;
    for (const [key, value] of Object.entries(providerEnv)) {
      env[key] = value;
    }
    if (params.provider.definition.authScheme === "apiKey") {
      // Applied after the provider's own env so a fixed env.ANTHROPIC_AUTH_TOKEN (the token source for such a provider) cannot reappear; ProviderSchema already rejects a non-empty env.ANTHROPIC_API_KEY for this scheme. The empty string is how Claude Code is told a variable is unset.
      env.ANTHROPIC_API_KEY = params.provider.token;
      env.ANTHROPIC_AUTH_TOKEN = "";
    }
  }

  if (params.headroom !== undefined) {
    env.HEADROOM_PROXY_URL = `http://127.0.0.1:${String(params.headroom.port)}`;
    env.ANTHROPIC_CUSTOM_HEADERS = mergeAnthropicCustomHeaders(
      [
        ...(parentCustomHeaders === undefined ? [] : [parentCustomHeaders]),
        ...(providerCustomHeaders === undefined ? [] : [providerCustomHeaders]),
      ],
      [
        { name: "x-headroom-project-id", value: params.headroom.projectId },
        ...(params.provider === undefined
          ? []
          : [{ name: "x-headroom-base-url", value: params.provider.definition.baseUrl }]),
      ],
    );
    if (params.provider !== undefined) {
      // Provider mode: the child talks only to the local proxy; the provider's real upstream moves into the per-request header above, which is what lets one daemon serve several providers at once.
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${String(params.headroom.port)}`;
    } else {
      // OAuth mode: ANTHROPIC_BASE_URL is left exactly as the parent environment had it (unset for a normal OAuth launch), because Claude Code enables Remote Control and connectors only against the real api.anthropic.com. Compression still happens: the proxy terminates that host's TLS and hands headroom-served paths to the daemon.
      env.HTTPS_PROXY = `http://127.0.0.1:${String(params.headroom.mitmPort)}`;
      env.NODE_EXTRA_CA_CERTS = params.headroom.caCertPath;
    }
  }

  return env;
}
