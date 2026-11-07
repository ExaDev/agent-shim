import path from "node:path";

import { ConfigFileNotJsonError, loadConfigFile, type LoadedFile } from "../config/load";
import { FILE_NAME_RULE, isFileName, UnsafeNameError } from "../config/names";
import { IdentitySchema, IdentitySelectorSchema, POOL_SELECTOR_PREFIX, type Identity } from "../config/schema";
import { guardedNameRead, identityIdIn, isSymlinkEntry, nameOfParsed, readIdentityRecords, type IdentityRecordsPort } from "../identityRecords";
import { sameDirectory } from "../sameDirectory";
import type { FsPort } from "./ports";

/** Which precedence rule produced an identity decision. */
export const IDENTITY_DECISION_SOURCES = [
  /** `CLAUDE_CONFIG_DIR` was already set and nothing on the command line names an identity: identity resolution is skipped entirely and the real binary uses whatever it already points to. */
  "config-dir-escape-hatch",
  /** A leading `@name` argv[0] positional, or its explicit form `--identity <name>`. */
  "argv",
  /** The `AGENT_SHIM_IDENTITY` environment variable. */
  "env",
  /** A directory rule pinning an identity to the current path. */
  "directory-pin",
  /** The persisted `~/.agent-shim/active-identity` file. */
  "active-identity-file",
  /** Nothing resolved an identity at all — a bare launch with no active identity. */
  "none",
] as const;
export type IdentityDecisionSource = (typeof IDENTITY_DECISION_SOURCES)[number];

/** The pool a `pool:<name>` selector names, or undefined when `selector` names an identity directly. */
export function poolNameOf(selector: string): string | undefined {
  return selector.startsWith(POOL_SELECTOR_PREFIX) ? selector.slice(POOL_SELECTOR_PREFIX.length) : undefined;
}

/** The result of deciding which identity applies to this launch. */
export interface IdentityDecision {
  /** The resolved identity name. Absent when the escape hatch applied, when nothing resolved one, or when a pool was selected (the launcher picks a member from `pool`). */
  readonly name?: string;
  /** The pool selected by a `pool:<name>` selector, when the launch named a pool instead of an identity. */
  readonly pool?: string;
  readonly source: IdentityDecisionSource;
  /** True when `CLAUDE_CONFIG_DIR` was already set, nothing on the command line named an identity, and every step below was skipped as a result. */
  readonly configDirEscapeHatch: boolean;
  /** The inherited `CLAUDE_CONFIG_DIR` an identity named on the command line outranked. Present only for a decision whose `source` is `argv` taken while the variable was set; the launch gives the child the identity's own directory in its place and says so, unless that already is the directory. */
  readonly supersededConfigDir?: string;
}

/** Reads the persisted active-identity file through `fs`: its trimmed content, or undefined when the file does not exist or is empty. */
export function readActiveIdentity(fs: Pick<FsPort, "readFileUtf8">, activeIdentityFile: string): string | undefined {
  const trimmed = fs.readFileUtf8(activeIdentityFile)?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
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

/** Where each source of an identity says it came from, for an error naming a selector that cannot be used. */
const IDENTITY_SOURCE_LABELS: Readonly<Record<IdentityDecisionSource, string>> = {
  "config-dir-escape-hatch": "CLAUDE_CONFIG_DIR",
  argv: "the identity named on the command line",
  env: "AGENT_SHIM_IDENTITY",
  "directory-pin": "a directory rule",
  "active-identity-file": "the active-identity file",
  none: "nothing",
};

/** The decision for an identity or `pool:<name>` selector. The selector becomes a directory name under the agent-shim home, whatever supplied it (a command-line argument, the environment, a file), so one that is not an identity name or `pool:<name>` is refused here, naming where it came from, instead of reaching a path. */
function selected(selector: string, source: IdentityDecisionSource, supersededConfigDir?: string): IdentityDecision {
  if (!IdentitySelectorSchema.safeParse(selector).success) {
    throw new UnsafeNameError(selector, "identity", `${FILE_NAME_RULE}, or be pool:<name> for a pool`, IDENTITY_SOURCE_LABELS[source]);
  }
  const pool = poolNameOf(selector);
  const superseded = supersededConfigDir === undefined ? {} : { supersededConfigDir };
  return pool === undefined ? { name: selector, source, configDirEscapeHatch: false, ...superseded } : { pool, source, configDirEscapeHatch: false, ...superseded };
}

/**
 * Decides which identity applies to this launch, in precedence order:
 *
 * 1. A leading `@name` argv[0] positional, or `--identity <name>`. It outranks an inherited `CLAUDE_CONFIG_DIR`, which is ambient (a session agent-shim launched exports it to every child), while the command line is a deliberate choice for this launch; the decision then carries the directory it set aside as `supersededConfigDir`.
 * 2. If `CLAUDE_CONFIG_DIR` is already set, skip identity/cascade resolution entirely: a deliberate carry-forward of the legacy script's own "don't override an explicit launcher" escape hatch. It sits above `AGENT_SHIM_IDENTITY`, since both come from the environment and naming a configuration directory is the more specific of the two.
 * 3. The `AGENT_SHIM_IDENTITY` environment variable.
 * 4. A directory-pinned identity from a directory rule.
 * 5. The persisted `~/.agent-shim/active-identity` file.
 *
 * Each of steps 2 to 5 may name `pool:<name>` instead of an identity; the decision then carries `pool` and no `name`, and the launcher picks the member.
 *
 * An empty string counts as unset for `CLAUDE_CONFIG_DIR` and `AGENT_SHIM_IDENTITY`, consistent with how this project treats empty-string environment variables everywhere else (see `src/paths.ts` and the ambient-credential guard).
 */
export function decideIdentity(params: DecideIdentityParams): IdentityDecision {
  const inheritedConfigDir = isNonEmpty(params.env.CLAUDE_CONFIG_DIR) ? params.env.CLAUDE_CONFIG_DIR : undefined;
  if (isNonEmpty(params.argv0Identity)) {
    return selected(params.argv0Identity, "argv", inheritedConfigDir);
  }
  if (inheritedConfigDir !== undefined) {
    return { source: "config-dir-escape-hatch", configDirEscapeHatch: true };
  }
  if (isNonEmpty(params.env.AGENT_SHIM_IDENTITY)) {
    return selected(params.env.AGENT_SHIM_IDENTITY, "env");
  }
  if (isNonEmpty(params.directoryPinnedIdentity)) {
    return selected(params.directoryPinnedIdentity, "directory-pin");
  }
  const persisted = params.readActiveIdentityFile();
  if (isNonEmpty(persisted)) {
    return selected(persisted, "active-identity-file");
  }
  return { source: "none", configDirEscapeHatch: false };
}

/** Which precedence rule produced a configuration-profile decision. */
export const CONFIG_PROFILE_DECISION_SOURCES = [
  /** An explicit `--config-profile` CLI flag. */
  "cli-flag",
  /** The `AGENT_SHIM_CONFIG_PROFILE` environment variable. */
  "env",
  /** A directory rule's `configProfile` selection for `$PWD`. */
  "directory-rule",
  /** The active identity's own declared `defaultConfigProfile`. */
  "identity-default",
  /** The user-global `~/.agent-shim/config.json` default. */
  "global-default",
  /** Nothing resolved a configuration profile at all. */
  "none",
] as const;
export type ConfigProfileDecisionSource = (typeof CONFIG_PROFILE_DECISION_SOURCES)[number];

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
 * 1. An explicit `--config-profile` flag or `AGENT_SHIM_CONFIG_PROFILE` environment variable (this run only).
 * 2. A directory rule's `configProfile` selection for `$PWD`.
 * 3. The active identity's own declared default (`defaultConfigProfile` in its `identity.json`).
 * 4. A global default (`~/.agent-shim/config.json`).
 */
export function decideConfigProfile(params: DecideConfigProfileParams): ConfigProfileDecision {
  if (isNonEmpty(params.cliFlagConfigProfile)) {
    return { name: params.cliFlagConfigProfile, source: "cli-flag" };
  }
  if (isNonEmpty(params.env.AGENT_SHIM_CONFIG_PROFILE)) {
    return { name: params.env.AGENT_SHIM_CONFIG_PROFILE, source: "env" };
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

/** The identity records port over the launcher's configuration port: `readConfigFile` parses each `identity.json`, a file that is not JSON is unreadable, so it claims no name and loading it by its id reports the file, and the entry's faults are read as the store's port reads them (`guardedNameRead`), so the launcher and the store resolve every name alike. */
function configRecordsPort(fs: Pick<FsPort, "readdir" | "readConfigFile">): IdentityRecordsPort {
  return {
    readdir: fs.readdir,
    sameDirectory,
    isSymlink: isSymlinkEntry,
    readName: (file) =>
      guardedNameRead(() => {
        let value: unknown;
        try {
          value = fs.readConfigFile(file);
        } catch (error) {
          if (error instanceof ConfigFileNotJsonError) {
            return "unreadable";
          }
          throw error;
        }
        return value === undefined ? "absent" : nameOfParsed(value);
      }),
  };
}

/** The id (the directory under `identitiesDir`) of the identity named `name`, read through the launcher's configuration port, or undefined when no identity is named so. Throws `DuplicateIdentityNameError` when two are. */
export function resolveIdentityId(identitiesDir: string, name: string, fs: Pick<FsPort, "readdir" | "readConfigFile">): string | undefined {
  return identityIdIn(readIdentityRecords(configRecordsPort(fs), identitiesDir), name);
}

/** What resolves many names to ids from one read of the identity records, as `resolveIdentityId` resolves one: the records are read on the first call and every later call answers from them, so ranking a pool reads each `identity.json` once however many members it names. Use one per decision, since it does not see a rename made after its first call. */
export function identityIdResolver(identitiesDir: string, fs: Pick<FsPort, "readdir" | "readConfigFile">): (name: string) => string | undefined {
  let records: ReturnType<typeof readIdentityRecords> | undefined;
  return (name) => {
    records ??= readIdentityRecords(configRecordsPort(fs), identitiesDir);
    return identityIdIn(records, name);
  };
}

/**
 * Reads and validates the `identity.json` of the identity named `name`, which is `<identitiesDir>/<id>/identity.json` for the id `resolveIdentityId` finds, via `IdentitySchema`.
 *
 * Returns undefined when the file does not exist (e.g. the identity was resolved by name but never actually created — `agent-shim identity add` is Phase 4's job, not this one's). Throws `ConfigValidationError` when the file exists but fails validation, the same as any other config file in this project.
 */
export function loadIdentity(identitiesDir: string, name: string, fs: FsPort): LoadedFile<Identity> | undefined {
  if (!isFileName(name)) {
    throw new UnsafeNameError(name, "identity", FILE_NAME_RULE);
  }
  const id = resolveIdentityId(identitiesDir, name, fs);
  return id === undefined ? undefined : loadConfigFile(path.join(identitiesDir, id, "identity.json"), IdentitySchema, fs.readConfigFile);
}
