import type { CredentialTargetVar } from "../config/schema";

/**
 * The environment variables that authenticate Claude Code directly from the process environment, ahead of any stored identity credential. If any of these is set, every identity would silently authenticate as the same key/token/backend while it's set — defeating the entire premise of separate identities. Order here is also lookup order: `detectAmbientCredential` reports the first one found.
 */
export const AMBIENT_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export type AmbientCredentialVar = (typeof AMBIENT_CREDENTIAL_VARS)[number];

/** Which guarded variable was found set, and to what. */
export interface AmbientCredentialDetection {
  readonly variable: AmbientCredentialVar;
}

/** A credential this launch itself exports to the child: the variable it lands in and its value. */
export interface InjectedCredential {
  readonly variable: CredentialTargetVar;
  readonly token: string;
}

/**
 * Detects whether any of `AMBIENT_CREDENTIAL_VARS` is set to a non-empty value in `env`, returning the first one found in declared order, or undefined when none are set.
 *
 * An empty string counts as unset, not set — confirmed load-bearing: one of Joe's real wrapper scripts (`o`, running Claude Code against OpenRouter) does `export ANTHROPIC_API_KEY=""` specifically to *clear* it so `ANTHROPIC_AUTH_TOKEN` takes effect instead, and this must never trip the guard.
 *
 * `injected`, when given, is the credential this launch exports for its own identity. Its variable holding exactly that value is not ambient: it is what a agent-shim launch of the same identity left in the environment of the session this one starts from (a `claude @work` run inside a `claude @work` session). The same variable holding any other value still counts.
 */
export function detectAmbientCredential(
  env: Readonly<Record<string, string | undefined>>,
  injected?: InjectedCredential,
): AmbientCredentialDetection | undefined {
  for (const variable of AMBIENT_CREDENTIAL_VARS) {
    const value = env[variable];
    if (value === undefined || value === "") {
      continue;
    }
    if (injected?.variable === variable && value === injected.token) {
      continue;
    }
    return { variable };
  }
  return undefined;
}

/**
 * Builds the exact refusal message: which variable was found, why it matters, and the two ways to opt in (a one-off env var, or a persistent per-identity setting). Mirrors the message documented in the project's README. `identityName` is included in the persistent-opt-in command when known; when no identity has been resolved yet (e.g. the `CLAUDE_CONFIG_DIR`-already-set escape hatch, or no identity resolved at all), a generic `<name>` placeholder is used instead, matching the README's own generic wording.
 */
export function formatAmbientCredentialGuardMessage(variable: AmbientCredentialVar, identityName?: string): string {
  const identitySetCommand =
    identityName === undefined
      ? "agent-shim identity set <name> --allow-ambient-credential"
      : `agent-shim identity set ${identityName} --allow-ambient-credential`;
  return [
    `error: ${variable} is set in the environment. This identity's isolated`,
    "credential would be bypassed — every identity authenticates as this same key",
    "while it's set. Unset it, or if this is deliberate, opt in per-launch with",
    "AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1, or persistently for this identity with",
    `\`${identitySetCommand}\`.`,
  ].join("\n");
}

/** Inputs to the ambient-credential guard evaluation. */
export interface EvaluateAmbientCredentialGuardParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The active identity's own `allowAmbientCredential` setting from its `identity.json`, or false when no identity is known. */
  readonly allowAmbientCredential: boolean;
  /** True when `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1` is set for this one invocation. */
  readonly allowAmbientCredentialOverride: boolean;
  /** The active identity's name, for the message's persistent-opt-in command. Undefined when no identity is known. */
  readonly identityName?: string;
  /**
   * True when this launch routes through an API provider. The guard inspects the PARENT environment, before `buildEnv` runs; a provider launch has every credential variable removed by `buildEnv` itself (the door attaches the provider's credential at its route, so the child presents nothing), so an ambient credential in the parent environment never reaches the child and there is nothing left for this guard to protect against. Everything else about the guard (including `IdentitySchema.allowAmbientCredential`) is unchanged by this flag.
   */
  readonly providerSelected?: boolean;
  /** The launching identity's own credential, when its credential block resolved: see `detectAmbientCredential`. */
  readonly injectedCredential?: InjectedCredential;
}

/** The result of one guard evaluation: either launch may proceed, or it must be refused with an explanatory message. */
export type AmbientCredentialGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly variable: AmbientCredentialVar; readonly message: string };

/**
 * Evaluates the ambient-credential guard: refuses unless no guarded variable is set, or the active identity opted in (`allowAmbientCredential: true`), or this one invocation opted in (`AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1`), or a provider takes over the child's credential (see `providerSelected`).
 *
 * This guard is about credential isolation, not identity/config-dir selection — it must still run even when the `CLAUDE_CONFIG_DIR`-already-set escape hatch applies (callers pass `allowAmbientCredential: false` and no `identityName` in that case, since there is no active identity to consult).
 */
export function evaluateAmbientCredentialGuard(
  params: EvaluateAmbientCredentialGuardParams,
): AmbientCredentialGuardResult {
  const detected = detectAmbientCredential(params.env, params.injectedCredential);
  if (detected === undefined) {
    return { ok: true };
  }
  if (params.allowAmbientCredentialOverride || params.allowAmbientCredential || params.providerSelected === true) {
    return { ok: true };
  }
  return {
    ok: false,
    variable: detected.variable,
    message: formatAmbientCredentialGuardMessage(detected.variable, params.identityName),
  };
}
