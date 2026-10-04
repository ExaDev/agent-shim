import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HEADROOM_STATE_SCHEMA_VERSION } from "./headroom/state";
import { HOME_DIRNAME, LEGACY_HOME_DIRNAME } from "./legacy";

/**
 * The resolved set of paths agent-shim reads and writes under its own root.
 *
 * `root` is always AGENT_SHIM_HOME when that environment variable is set (used by every test in this project, and by any real installation that wants to relocate its state), falling back to `~/.agent-shim` (or the former `~/.claude-use`, see `resolveAgentShimHome`) only when the variable is unset. Every other field is derived from `root` so there is exactly one place a path can go wrong.
 */
export interface LayoutPaths {
  /** The resolved root directory, see `resolveAgentShimHome`. */
  readonly root: string;
  /** Directory holding one subdirectory per identity (symlink farm + local credentials/daemon state). */
  readonly identitiesDir: string;
  /** Directory holding named, reusable configuration profile JSON files. */
  readonly configProfilesDir: string;
  /** Directory holding one `<name>.json` provider definition per API provider. */
  readonly providersDir: string;
  /** Path to the directory-rules.json file describing directory-scoped identity/profile pins. */
  readonly directoryRulesFile: string;
  /** Path to the persisted active-identity file (the identity `agent-shim identity use` selected). */
  readonly activeIdentityFile: string;
  /** Path to the global config.json (user-global override layer, and default profile/walk-limit settings). */
  readonly globalConfigFile: string;
  /** Path to the categories.local.json overlay recording answers to "unclassified entry" prompts. */
  readonly categoriesLocalFile: string;
  /** Path to the claude-shim.json marker recording where `agent-shim shim enable` last placed a `claude`-named copy of this executable, and how. */
  readonly claudeShimFile: string;
  /** Directory holding the headroom daemon's coordination state: the state file, the start lock, the session registry, and the socket directory. */
  readonly headroomDir: string;
  /** Path to the headroom supervisor's state file: pids, socket path, version, allowlist hash, last error. Its name carries `HEADROOM_STATE_SCHEMA_VERSION`, so a supervisor from a release with another state schema keeps its own file instead of contending for this one. */
  readonly headroomStateFile: string;
  /** Directory, mode 0700, holding the headroom daemon's unix socket: one `<supervisor-pid>.sock` per supervisor generation. Only its owner can enter it, which is what authenticates the door's hop to the daemon. */
  readonly headroomSocketDir: string;
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
  /** Directory of combined CA bundles: a parent environment's own NODE_EXTRA_CA_CERTS (for a routed child) or HEADROOM_CA_BUNDLE (for the headroom daemon) file plus the front door's CA, one file per distinct combination, for processes that must keep trusting both. */
  readonly frontdoorCaBundlesDir: string;
  /** Path to the front door's state.json: its supervisor pid, its port, and the sticky port it last served on. */
  readonly frontdoorStateFile: string;
  /** Path to the exclusive-create marker guarding "who spawns the front-door supervisor" so concurrent launches start at most one. */
  readonly frontdoorLockFile: string;
  /**
   * Path to the serving door's control token, mode 0600: the random bearer capability this generation's Remote Control control routes demand, rewritten on every door start. Only its owner can read it, which is what authenticates a CLI invocation to the door that minted it.
   */
  readonly frontdoorControlTokenFile: string;
  /** Directory holding one `<launcher-pid>.json` session-registry entry per live launch routed through the front door. */
  readonly frontdoorSessionsDir: string;
  /** Path to the front door's log: one line per lifecycle event and routed failure, never a token. */
  readonly frontdoorLogPath: string;
  /** Directory holding the usage store, mode 0700: the request log and the per-identity snapshots. Metadata only, never content or credentials. */
  readonly usageDir: string;
  /** Directory of the append-only usage log: one `<YYYY-MM-DD>.<writer-pid>.jsonl` segment per writing process per UTC day. */
  readonly usageLogDir: string;
  /** Directory of the latest-state snapshots, one `<identity>.json` per identity: the stable file other tools read. */
  readonly usageSnapshotsDir: string;
  /** The last identity picked from a pool for each directory, so a conversation stays on the account whose prompt cache is warm. */
  readonly usagePicksFile: string;
}

/**
 * Resolves the state root: `AGENT_SHIM_HOME` when set to a non-empty string (an empty string counts as unset, consistent with how this project treats empty-string environment variables elsewhere, see the ambient-credential guard), otherwise `~/.agent-shim`, or the former `~/.claude-use` when only that exists.
 *
 * The former root is used where it stands, never moved: macOS Claude Code names each identity's Keychain entry after a hash of its exact `CLAUDE_CONFIG_DIR`, so any relocation would sign every identity out. A fresh installation, or one that already has `~/.agent-shim`, uses the current name.
 */
export function resolveAgentShimHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), isDirectory: (candidate: string) => boolean = isExistingDirectory): string {
  const fromEnv = env.AGENT_SHIM_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const current = path.join(home, HOME_DIRNAME);
  const legacy = path.join(home, LEGACY_HOME_DIRNAME);
  return !isDirectory(current) && isDirectory(legacy) ? legacy : current;
}

function isExistingDirectory(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Resolves the canonical `~/.claude` directory every farm symlink points back into: `AGENT_SHIM_CLAUDE_HOME` when set to a non-empty string, otherwise `~/.claude`.
 *
 * The override exists for the same reason `AGENT_SHIM_HOME` does. Exercising a real resync end to end means building and swapping real directories, and doing that against a real, in-use `~/.claude` to find out whether the code is correct is not an acceptable way to find out. Pointing both variables at throwaway directories makes a full end-to-end run safe.
 */
export function resolveClaudeHome(): string {
  const fromEnv = process.env.AGENT_SHIM_CLAUDE_HOME;
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
    headroomStateFile: path.join(root, "headroom", `state.v${String(HEADROOM_STATE_SCHEMA_VERSION)}.json`),
    headroomSocketDir: path.join(root, "headroom", "run"),
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
    frontdoorControlTokenFile: path.join(root, "frontdoor", "control-token"),
    frontdoorSessionsDir: path.join(root, "frontdoor", "sessions"),
    frontdoorLogPath: path.join(root, "logs", "frontdoor.log"),
    usageDir: path.join(root, "usage"),
    usageLogDir: path.join(root, "usage", "log"),
    usageSnapshotsDir: path.join(root, "usage", "snapshots"),
    usagePicksFile: path.join(root, "usage", "picks.json"),
  };
}

/** Resolves AGENT_SHIM_HOME and builds the full LayoutPaths structure in one call. */
export function resolveLayoutPaths(): LayoutPaths {
  return buildLayoutPaths(resolveAgentShimHome());
}
