import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  /** Path to the file recording the former names of renamed providers, so a session launched under an old name keeps being served until it ends. Absent until a provider is first renamed. */
  readonly providerAliasesFile: string;
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
  /** Directory holding the headroom daemon's coordination state: the state file, the start lock, the session registry, and the owner-only socket directory, which also holds the allowlist file. */
  readonly headroomDir: string;
  /** Path to the headroom supervisor's state file: pids, socket path, version, the hash of the allowlist the daemon serves, last error. One unversioned name every release shares, arbitrated by the ownership rules in `headroom/state.ts` rather than by a version in the file name. */
  readonly headroomStateFile: string;
  /** The live routing setting `agent-shim headroom enable|disable` writes and the front door re-reads per request: which sessions go through headroom, whatever their launch asked for. */
  readonly headroomRoutingFile: string;
  /** The previous release's versioned name for the state file, read only while a supervisor from that release is still alive and removed once its generation has drained (see `migrateHeadroomState`). */
  readonly headroomLegacyStateFile: string;
  /** Path to the file the headroom daemon reads its upstream allowlist from (`--allowed-base-urls-file`): the direct origin of every live front door, one per line. It lives in the owner-only socket directory because headroom refuses an allowlist file whose directory another user could write to, and that directory is the one this tool already creates mode 0700 (narrowing it if it existed wider) and checks before every daemon start. The supervisor replaces the file owner-only and atomically whenever a door's origin changes, and the daemon re-reads it on its next request, so a moved or retired front door never needs a restart. */
  readonly headroomAllowlistFile: string;
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
  /** Path to the Sign in with ChatGPT file (the host id and, once signed in, the grant, mode 0600): whoever can read it can spend the person's ChatGPT plan until it is signed out. */
  readonly chatgptSignInFile: string;
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
  /** Directory holding one `<supervisor-pid>.json` per live front door, recording that door's own direct port: every door still serving sessions forwards its headroom traffic back to its own direct origin, so headroom must admit each of them, not only the one `state.json` names. */
  readonly frontdoorDirectRecordsDir: string;
  /** Directory holding one empty marker file per front door that has released its addresses and is finishing the connections it carried, named by its supervisor pid. */
  readonly frontdoorDrainingDir: string;
  /**
   * Directory holding one `<cse-session-id>.json` Remote Control client credential per observed session, mode 0700 with 0600 files: the OAuth-kind bearer and protocol headers the door replays as the session's attached client, persisted so a door generation that starts after a session's create can still attach. The same secret the identity's own store holds, at the same owner-only protection.
   */
  readonly frontdoorRcCredentialsDir: string;
  /** Path to the front door's log: one line per lifecycle event and routed failure, never a token. */
  readonly frontdoorLogPath: string;
  /** Directory holding the usage store, mode 0700: the request log and the per-identity snapshots. Metadata only, never content or credentials. */
  readonly usageDir: string;
  /** Directory of the append-only usage log: one `<YYYY-MM-DD>.<writer-pid>.jsonl` segment per writing process per UTC day. */
  readonly usageLogDir: string;
  /** Directory of the latest-state snapshots, one `<identity>.json` per identity: the stable file other tools read. */
  readonly usageSnapshotsDir: string;
  /** Directory of the built-in statusline's own state (the day's cost ledger, under `session/` what it keeps between refreshes about each transcript it reads, and under `run/` the short-lived output files of the programs it runs), each file of the ledger and under `session/` read as absent when it is missing, is not a regular file or is not of its shape, and none restored: a session's entry for today in the cost ledger starts again from the cost reported by the session's next render that lists the `dailyCost` segment and has a cost to record (or from the previous day's total, by the rule a session's first render of the day carries it by), so the day's total no longer counts what the session spent before that figure, and its entry for the day before, which is only read, carries nothing; the transcript reader's cache is folded again from the start of the transcript; the speed sample is replaced by that of the next render that lists the `speed` segment and has a figure to measure, which draws no speed; and the transcript's last good context frame is none until the next good frame is written. */
  readonly statuslineDir: string;
  /** One file per provider holding the model catalogue the door last fetched from it. */
  readonly catalogueDir: string;
  /** Path to the file recording what the person has allowed the MCP server's agents to do (`agent-shim mcp permissions`), mode 0600 and written only by that command: the running server re-reads it on every request, so a change needs no restart. */
  readonly mcpPermissionsFile: string;
  /** The last identity picked from a pool for each directory, so a conversation stays on the account whose prompt cache is warm. */
  readonly usagePicksFile: string;
  /** The last anchor the front door's window keeper handled for each identity, so a restart neither replays an anchor nor skips one. */
  readonly usageAnchorsFile: string;
  /** The last trigger instance the front door's job keeper handled for each job, so a restart neither repeats nor skips a run. */
  readonly usageJobsFile: string;
  /** Directory of one append-only `<job>.log` per job: the result of each unattended run. */
  readonly jobLogsDir: string;
  /** Directory of the supervised sessions' shared state, one subdirectory per pool: the live sessions each launcher registers, so sessions on one account see each other, and the lock that serialises their moves. Runtime state, never configuration. */
  readonly superviseDir: string;
  /** Directory of the model-move requests the front door writes for supervised sessions that picked a model served under another identity: one `<sessionId>.json` per pending request, claimed and removed by the session's supervisor. Runtime state, never configuration. */
  readonly modelMovesDir: string;
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
    providerAliasesFile: path.join(root, "provider-aliases.json"),
    directoryRulesFile: path.join(root, "directory-rules.json"),
    activeIdentityFile: path.join(root, "active-identity"),
    globalConfigFile: path.join(root, "config.json"),
    categoriesLocalFile: path.join(root, "categories.local.json"),
    claudeShimFile: path.join(root, "claude-shim.json"),
    headroomDir: path.join(root, "headroom"),
    headroomStateFile: path.join(root, "headroom", "state.json"),
    headroomRoutingFile: path.join(root, "headroom", "routing.json"),
    headroomLegacyStateFile: path.join(root, "headroom", "state.v2.json"),
    headroomAllowlistFile: path.join(root, "headroom", "run", "allowlist.txt"),
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
    chatgptSignInFile: path.join(root, "codex", "chatgpt-sign-in.json"),
    frontdoorStateFile: path.join(root, "frontdoor", "state.json"),
    frontdoorLockFile: path.join(root, "frontdoor", "start.lock"),
    frontdoorControlTokenFile: path.join(root, "frontdoor", "control-token"),
    frontdoorSessionsDir: path.join(root, "frontdoor", "sessions"),
    frontdoorDirectRecordsDir: path.join(root, "frontdoor", "direct"),
    frontdoorDrainingDir: path.join(root, "frontdoor", "draining"),
    frontdoorRcCredentialsDir: path.join(root, "frontdoor", "rc-credentials"),
    frontdoorLogPath: path.join(root, "logs", "frontdoor.log"),
    usageDir: path.join(root, "usage"),
    usageLogDir: path.join(root, "usage", "log"),
    usageSnapshotsDir: path.join(root, "usage", "snapshots"),
    statuslineDir: path.join(root, "statusline"),
    catalogueDir: path.join(root, "catalogues"),
    usagePicksFile: path.join(root, "usage", "picks.json"),
    usageAnchorsFile: path.join(root, "usage", "anchors.json"),
    usageJobsFile: path.join(root, "usage", "jobs.json"),
    jobLogsDir: path.join(root, "logs", "jobs"),
    superviseDir: path.join(root, "supervise"),
    modelMovesDir: path.join(root, "model-moves"),
    mcpPermissionsFile: path.join(root, "mcp", "permissions.json"),
  };
}

/** Resolves AGENT_SHIM_HOME and builds the full LayoutPaths structure in one call. */
export function resolveLayoutPaths(): LayoutPaths {
  return buildLayoutPaths(resolveAgentShimHome());
}
