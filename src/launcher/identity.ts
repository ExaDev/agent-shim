import path from "node:path";

import { loadConfigFile, type LoadedFile } from "../config/load";
import { IdentitySchema, type Identity } from "../config/schema";
import type { FsPort } from "./ports";

/** Which precedence rule produced an identity decision. */
export type IdentityDecisionSource =
  /** `CLAUDE_CONFIG_DIR` was already set: identity resolution is skipped entirely and the real binary uses whatever it already points to. */
  | "config-dir-escape-hatch"
  /** A leading `@name` argv[0] positional, or its explicit form `--identity <name>`. */
  | "argv"
  /** The `CLAUDE_USE_IDENTITY` environment variable. */
  | "env"
  /** A directory rule pinning an identity to the current path. */
  | "directory-pin"
  /** The persisted `~/.claude-use/active-identity` file. */
  | "active-identity-file"
  /** Nothing resolved an identity at all — a bare launch with no active identity. */
  | "none";

/** The result of deciding which identity applies to this launch. */
export interface IdentityDecision {
  /** The resolved identity name. Absent when the escape hatch applied, or when nothing resolved one. */
  readonly name?: string;
  readonly source: IdentityDecisionSource;
  /** True when `CLAUDE_CONFIG_DIR` was already set and every step below was skipped as a result. */
  readonly configDirEscapeHatch: boolean;
}

/** Inputs to `decideIdentity`, in the exact precedence order the README's CLI reference table documents. */
export interface DecideIdentityParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The identity `parseLauncherArgv` found in a leading `@name` or an `--identity <name>` flag, if either was given. */
  readonly argv0Identity?: string;
  /** An identity pinned to `$PWD` by a directory rule. Accepted as an already-resolved value here — the rules-loading code that produces it lands in Phase 4/5. */
  readonly directoryPinnedIdentity?: string;
  /** Reads the persisted active-identity file, returning undefined when it does not exist or is empty. Injected so this stays pure. */
  readonly readActiveIdentityFile: () => string | undefined;
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * Decides which identity applies to this launch, in precedence order:
 *
 * 1. If `CLAUDE_CONFIG_DIR` is already set, skip identity/cascade resolution entirely: a deliberate carry-forward of the legacy script's own "don't override an explicit launcher" escape hatch.
 * 2. A leading `@name` argv[0] positional, or `--identity <name>`.
 * 3. The `CLAUDE_USE_IDENTITY` environment variable.
 * 4. A directory-pinned identity from a directory rule.
 * 5. The persisted `~/.claude-use/active-identity` file.
 *
 * An empty string counts as unset for `CLAUDE_CONFIG_DIR` and `CLAUDE_USE_IDENTITY`, consistent with how this project treats empty-string environment variables everywhere else (see `src/paths.ts` and the ambient-credential guard).
 */
export function decideIdentity(params: DecideIdentityParams): IdentityDecision {
  if (isNonEmpty(params.env.CLAUDE_CONFIG_DIR)) {
    return { source: "config-dir-escape-hatch", configDirEscapeHatch: true };
  }
  if (isNonEmpty(params.argv0Identity)) {
    return { name: params.argv0Identity, source: "argv", configDirEscapeHatch: false };
  }
  if (isNonEmpty(params.env.CLAUDE_USE_IDENTITY)) {
    return { name: params.env.CLAUDE_USE_IDENTITY, source: "env", configDirEscapeHatch: false };
  }
  if (isNonEmpty(params.directoryPinnedIdentity)) {
    return { name: params.directoryPinnedIdentity, source: "directory-pin", configDirEscapeHatch: false };
  }
  const persisted = params.readActiveIdentityFile();
  if (isNonEmpty(persisted)) {
    return { name: persisted, source: "active-identity-file", configDirEscapeHatch: false };
  }
  return { source: "none", configDirEscapeHatch: false };
}

/** Which precedence rule produced a configuration-profile decision. */
export type ConfigProfileDecisionSource =
  /** An explicit `--config-profile` CLI flag. */
  | "cli-flag"
  /** The `CLAUDE_USE_CONFIG_PROFILE` environment variable. */
  | "env"
  /** A directory rule's `configProfile` selection for `$PWD`. */
  | "directory-rule"
  /** The active identity's own declared `defaultConfigProfile`. */
  | "identity-default"
  /** The user-global `~/.claude-use/config.json` default. */
  | "global-default"
  /** Nothing resolved a configuration profile at all. */
  | "none";

/** The result of deciding which configuration profile applies to this launch. */
export interface ConfigProfileDecision {
  readonly name?: string;
  readonly source: ConfigProfileDecisionSource;
}

/** Inputs to `decideConfigProfile`, in the exact precedence order the README's "Configuration profiles" section documents. */
export interface DecideConfigProfileParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cliFlagConfigProfile?: string;
  readonly directoryRuleConfigProfile?: string;
  readonly identityDefaultConfigProfile?: string;
  readonly globalDefaultConfigProfile?: string;
}

/**
 * Decides which configuration profile applies to this launch, in precedence order:
 *
 * 1. An explicit `--config-profile` flag or `CLAUDE_USE_CONFIG_PROFILE` environment variable (this run only).
 * 2. A directory rule's `configProfile` selection for `$PWD`.
 * 3. The active identity's own declared default (`defaultConfigProfile` in its `identity.json`).
 * 4. A global default (`~/.claude-use/config.json`).
 */
export function decideConfigProfile(params: DecideConfigProfileParams): ConfigProfileDecision {
  if (isNonEmpty(params.cliFlagConfigProfile)) {
    return { name: params.cliFlagConfigProfile, source: "cli-flag" };
  }
  if (isNonEmpty(params.env.CLAUDE_USE_CONFIG_PROFILE)) {
    return { name: params.env.CLAUDE_USE_CONFIG_PROFILE, source: "env" };
  }
  if (isNonEmpty(params.directoryRuleConfigProfile)) {
    return { name: params.directoryRuleConfigProfile, source: "directory-rule" };
  }
  if (isNonEmpty(params.identityDefaultConfigProfile)) {
    return { name: params.identityDefaultConfigProfile, source: "identity-default" };
  }
  if (isNonEmpty(params.globalDefaultConfigProfile)) {
    return { name: params.globalDefaultConfigProfile, source: "global-default" };
  }
  return { source: "none" };
}

/**
 * Reads and validates one identity's `identity.json` from `<identitiesDir>/<name>/identity.json`, via `IdentitySchema`.
 *
 * Returns undefined when the file does not exist (e.g. the identity was resolved by name but never actually created — `claude-use identity add` is Phase 4's job, not this one's). Throws `ConfigValidationError` when the file exists but fails validation, the same as any other config file in this project.
 */
export function loadIdentity(identitiesDir: string, name: string, fs: FsPort): LoadedFile<Identity> | undefined {
  return loadConfigFile(path.join(identitiesDir, name, "identity.json"), IdentitySchema, fs.readConfigFile);
}
