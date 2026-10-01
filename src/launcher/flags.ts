import path from "node:path";

import { parseEnvBool } from "../cli/parsers";
import type { LaunchFlags, Provider } from "../config/schema";
import { credentialVariables, type ResolvedCredential } from "../credential";
import { mergeAnthropicCustomHeaders } from "../headroom/headers";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, IDENTITY_HEADER, PROJECT_ID_HEADER, SESSION_HEADER } from "../frontdoor/route";
import type { FrontDoorUp, HeadroomUp } from "./ports";

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

/** The provider resolved for this launch, with its credential already resolved from the provider's credential block. */
export interface ResolvedProvider {
  readonly name: string;
  readonly definition: Provider;
  readonly credential: ResolvedCredential;
}

/** A resolved provider with the base URL its sessions are sent to: the front door's provider-scoped address, which exists only once the door is up and is the same shape for both kinds (the door is what decides where the request goes from there). */
export interface RoutedProvider extends ResolvedProvider {
  readonly baseUrl: string;
}

/** Inputs to `buildEnv`. */
export interface BuildEnvParams {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** True when `CLAUDE_CONFIG_DIR` was already set and the escape hatch applied — `buildEnv` must leave it untouched in that case. */
  readonly configDirEscapeHatch: boolean;
  /** The identity name resolved for this launch, when one was resolved. */
  readonly resolvedIdentityName?: string;
  readonly identitiesDir: string;
  /** The provider resolved for this launch, when one was resolved, with the base URL it routes to. Its credential is resolved by the caller because refusing an unusable one needs the caller's log/exit ports. */
  readonly provider?: RoutedProvider;
  /** The launching identity's own resolved credential, when it has a credential block and no provider was selected. A provider's credential authenticates against the provider's endpoint, so the identity's is never applied alongside one. */
  readonly identityCredential?: ResolvedCredential;
  /** The front door this launch routes through, when one is engaged (a provider is selected, or headroom resolved on). It is what the child talks to: its provider listener for a provider session, its CONNECT surface for an OAuth one. */
  readonly frontdoor?: FrontDoorUp;
  /** The headroom daemon this launch's requests must pass through (as the door's headroom hop), when headroom resolved on. The child never talks to it directly. */
  readonly headroom?: HeadroomUp;
  /** The per-launch session id, stamped into the session header the door identifies this launch's requests by. */
  readonly sessionId: string;
}

/**
 * Builds the environment the real `claude` binary is spawned with.
 *
 * When the `CLAUDE_CONFIG_DIR`-already-set escape hatch applied, or no identity was resolved at all (a bare launch with no active identity, matching the legacy script's own "no profile means plain `~/.claude`" behaviour), `CLAUDE_CONFIG_DIR` is left untouched. Otherwise `CLAUDE_CONFIG_DIR` is set to the resolved identity's own directory under `identitiesDir` — farm population into that directory is Phase 5's job, not this function's.
 *
 * A resolved provider is applied regardless of the identity outcome, because it selects which API endpoint the child talks to, not which login's data it sees: `ANTHROPIC_BASE_URL` points at the provider's routed base URL (always the front door's provider-scoped address), `CLAUDE_USE_PROVIDER` names the provider for the statusline, the provider's own `env` entries land verbatim, and its resolved credential is exported as its target's variable (`credentialVariables`), with the other credential variables removed so an ambient one inherited from the parent cannot outrank it. Without a provider, an identity's own resolved credential is exported the same way. The token only ever reaches this environment, never the child's argv or a log line.
 *
 * A resolved front door is the whole of the child's routing, on top of the provider: `ANTHROPIC_CUSTOM_HEADERS` gains the launcher-injected session headers (identity, session id, the launch's capability token, and, when headroom resolved on, the headroom flag and the project identity headroom scopes memory to), merged with any headers the provider's own `env` or the parent environment already set. The door strips every one of them before anything leaves the machine; the token is what authorises the session's requests at the door in the first place. `NODE_EXTRA_CA_CERTS` points at the door's trust bundle in both modes, because the child reaches the door over TLS signed by claude-use's CA either way. With a provider, the child's HTTPS base URL already names the door's provider listener, so a process that merely binds that port cannot present a certificate the child accepts. Without one (an OAuth launch), the base URL is left exactly as the parent environment had it, because Claude Code enables Remote Control and connectors only against the real `api.anthropic.com`; routing happens one layer down instead, with `HTTPS_PROXY` pointing the child at the door's CONNECT surface, so the child still believes it is talking to the real `api.anthropic.com` while the surface's terminated TLS feeds the routed paths to the same pipeline. `HEADROOM_PROXY_URL` names the headroom daemon for anything else that wants it; the child never talks to that daemon directly, the door's hop does.
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
    env.ANTHROPIC_BASE_URL = params.provider.baseUrl;
    env.CLAUDE_USE_PROVIDER = params.provider.definition.displayName;
    for (const [key, value] of Object.entries(providerEnv)) {
      env[key] = value;
    }
  }

  // A provider's credential outranks the identity's, which the launcher does not even resolve alongside one. ProviderSchema keeps every credential variable out of the provider's env, so nothing above can undo this.
  const credential = params.provider?.credential ?? params.identityCredential;
  if (credential !== undefined) {
    for (const [variable, value] of Object.entries(credentialVariables(credential.target, credential.token))) {
      env[variable] = value;
    }
  }

  if (params.headroom !== undefined) {
    env.HEADROOM_PROXY_URL = `http://127.0.0.1:${String(params.headroom.port)}`;
  }

  if (params.frontdoor !== undefined) {
    env.ANTHROPIC_CUSTOM_HEADERS = mergeAnthropicCustomHeaders(
      [
        ...(parentCustomHeaders === undefined ? [] : [parentCustomHeaders]),
        ...(providerCustomHeaders === undefined ? [] : [providerCustomHeaders]),
      ],
      [
        ...(params.resolvedIdentityName === undefined ? [] : [{ name: IDENTITY_HEADER, value: params.resolvedIdentityName }]),
        { name: SESSION_HEADER, value: params.sessionId },
        { name: AUTH_HEADER, value: params.frontdoor.sessionToken },
        ...(params.headroom === undefined
          ? []
          : [
              { name: HEADROOM_FLAG_HEADER, value: "1" },
              { name: PROJECT_ID_HEADER, value: params.headroom.projectId },
            ]),
      ],
    );
    // Both routing modes reach the door over TLS whose leaf claude-use's CA signed: the provider listener's for a provider session, the CONNECT surface's intercept leaf for an OAuth one. The bundle keeps whatever the parent environment already trusted this way.
    env.NODE_EXTRA_CA_CERTS = params.frontdoor.trustBundlePath;
    if (params.provider === undefined) {
      // OAuth routing: ANTHROPIC_BASE_URL is left exactly as the parent environment had it (unset for a normal OAuth launch), because Claude Code enables Remote Control and connectors only against the real api.anthropic.com. The door's CONNECT surface terminates that host's TLS instead and feeds the routed paths to the same pipeline the provider sessions use.
      env.HTTPS_PROXY = `http://127.0.0.1:${String(params.frontdoor.connectPort)}`;
    }
  }

  return env;
}
