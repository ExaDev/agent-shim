import os from "node:os";
import path from "node:path";

/**
 * The resolved set of paths claude-use reads and writes under its own root.
 *
 * `root` is always CLAUDE_USE_HOME when that environment variable is set (used by every test in this project, and by any real installation that wants to relocate its state), falling back to `~/.claude-use` only when the variable is unset. Every other field is derived from `root` so there is exactly one place a path can go wrong.
 */
export interface LayoutPaths {
  /** The resolved root directory — CLAUDE_USE_HOME, or ~/.claude-use when unset. */
  readonly root: string;
  /** Directory holding one subdirectory per identity (symlink farm + local credentials/daemon state). */
  readonly identitiesDir: string;
  /** Directory holding named, reusable configuration profile JSON files. */
  readonly configProfilesDir: string;
  /** Directory holding one `<name>.json` provider definition per API provider. */
  readonly providersDir: string;
  /** Path to the directory-rules.json file describing directory-scoped identity/profile pins. */
  readonly directoryRulesFile: string;
  /** Path to the persisted active-identity file (the identity `claude-use identity use` selected). */
  readonly activeIdentityFile: string;
  /** Path to the global config.json (user-global override layer, and default profile/walk-limit settings). */
  readonly globalConfigFile: string;
  /** Path to the categories.local.json overlay recording answers to "unclassified entry" prompts. */
  readonly categoriesLocalFile: string;
  /** Path to the claude-shim.json marker recording where `claude-use shim enable` last placed a `claude`-named copy of this executable, and how. */
  readonly claudeShimFile: string;
  /** Directory holding the headroom daemon's coordination state: state.json, the start lock, and the session registry. */
  readonly headroomDir: string;
  /** Path to the headroom supervisor's state.json: pids, port, version, allowlist hash, last error. */
  readonly headroomStateFile: string;
  /** Path to the exclusive-create marker guarding "who spawns the supervisor" so concurrent launches start at most one. */
  readonly headroomLockFile: string;
  /** Directory holding one `<launcher-pid>.json` session-registry entry per live launch routed through headroom. */
  readonly headroomSessionsDir: string;
  /** Directory holding daemon logs (the headroom proxy's stdout/stderr and the supervisor's own output). */
  readonly logsDir: string;
  /** Path to the headroom daemon's combined log, appended to by both the supervisor and the proxy it owns. */
  readonly headroomLogPath: string;
  /** Directory holding the front-door daemon's coordination state: state.json, the start lock, and the session registry. */
  readonly frontdoorDir: string;
  /** Directory holding the front door's certificate authority, which signs both the provider listener's loopback leaf and the CONNECT surface's intercept leaf: ca.pem (public, handed to children through NODE_EXTRA_CA_CERTS) and ca.key (mode 0600). */
  readonly frontdoorCaDir: string;
  /** Path to the front door's CA certificate, generated once and stable across restarts so children keep trusting it. */
  readonly frontdoorCaCertFile: string;
  /** Path to the front door's CA private key, mode 0600: whoever can read it can impersonate the door to every routed child. */
  readonly frontdoorCaKeyFile: string;
  /** Directory of combined CA bundles: a parent environment's own NODE_EXTRA_CA_CERTS file plus the front door's CA, one file per distinct combination, for children that must keep trusting both. */
  readonly frontdoorCaBundlesDir: string;
  /** Path to the front door's state.json: its supervisor pid, its port, and the sticky port it last served on. */
  readonly frontdoorStateFile: string;
  /** Path to the exclusive-create marker guarding "who spawns the front-door supervisor" so concurrent launches start at most one. */
  readonly frontdoorLockFile: string;
  /** Directory holding one `<launcher-pid>.json` session-registry entry per live launch routed through the front door. */
  readonly frontdoorSessionsDir: string;
  /** Path to the front door's log: one line per lifecycle event and routed failure, never a token. */
  readonly frontdoorLogPath: string;
}

/**
 * Resolves the current CLAUDE_USE_HOME root: the environment variable when set to a non-empty string, otherwise `~/.claude-use`. An empty string counts as unset, consistent with how this project treats empty-string environment variables elsewhere (see the ambient-credential guard).
 */
export function resolveClaudeUseHome(): string {
  const fromEnv = process.env.CLAUDE_USE_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".claude-use");
}

/**
 * Resolves the canonical `~/.claude` directory every farm symlink points back into: `CLAUDE_USE_CLAUDE_HOME` when set to a non-empty string, otherwise `~/.claude`.
 *
 * The override exists for the same reason `CLAUDE_USE_HOME` does. Exercising a real resync end to end means building and swapping real directories, and doing that against a real, in-use `~/.claude` to find out whether the code is correct is not an acceptable way to find out. Pointing both variables at throwaway directories makes a full end-to-end run safe.
 */
export function resolveClaudeHome(): string {
  const fromEnv = process.env.CLAUDE_USE_CLAUDE_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".claude");
}

/** Builds the full LayoutPaths structure from a given root directory. */
export function buildLayoutPaths(root: string): LayoutPaths {
  return {
    root,
    identitiesDir: path.join(root, "identities"),
    configProfilesDir: path.join(root, "config-profiles"),
    providersDir: path.join(root, "providers"),
    directoryRulesFile: path.join(root, "directory-rules.json"),
    activeIdentityFile: path.join(root, "active-identity"),
    globalConfigFile: path.join(root, "config.json"),
    categoriesLocalFile: path.join(root, "categories.local.json"),
    claudeShimFile: path.join(root, "claude-shim.json"),
    headroomDir: path.join(root, "headroom"),
    headroomStateFile: path.join(root, "headroom", "state.json"),
    headroomLockFile: path.join(root, "headroom", "start.lock"),
    headroomSessionsDir: path.join(root, "headroom", "sessions"),
    logsDir: path.join(root, "logs"),
    headroomLogPath: path.join(root, "logs", "headroom.log"),
    frontdoorDir: path.join(root, "frontdoor"),
    frontdoorCaDir: path.join(root, "frontdoor", "ca"),
    frontdoorCaCertFile: path.join(root, "frontdoor", "ca", "ca.pem"),
    frontdoorCaKeyFile: path.join(root, "frontdoor", "ca", "ca.key"),
    frontdoorCaBundlesDir: path.join(root, "frontdoor", "ca", "bundles"),
    frontdoorStateFile: path.join(root, "frontdoor", "state.json"),
    frontdoorLockFile: path.join(root, "frontdoor", "start.lock"),
    frontdoorSessionsDir: path.join(root, "frontdoor", "sessions"),
    frontdoorLogPath: path.join(root, "logs", "frontdoor.log"),
  };
}

/** Resolves CLAUDE_USE_HOME and builds the full LayoutPaths structure in one call. */
export function resolveLayoutPaths(): LayoutPaths {
  return buildLayoutPaths(resolveClaudeUseHome());
}
