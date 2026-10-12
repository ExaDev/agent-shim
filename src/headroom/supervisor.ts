import path from "node:path";

import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE, type HeadroomGlobalConfig } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { directOrigin, frontDoorOrigin, listFrontDoorDirectRecords, liveFrontDoorDirectRecords, pruneDeadFrontDoorDirectRecords, pruneMalformedFrontDoorDirectFiles, readFrontDoorState, type FrontDoorDirectRecord, type FrontDoorLiveness } from "../frontdoor/state";
import { hashSettings, settingsOf, type HeadroomSettings } from "./settings";
import { redactText } from "../frontdoor/capture";
import { headroomSocketPath, prepareHeadroomSocket, pruneStaleHeadroomSockets, verifyAllowlistFile, type HeadroomSocketTrustPorts } from "./socket";
import { daemonIdentity } from "./earlierRelease";
import { pinnedGitCommit } from "./source";
import {
  formatAllowlistFile,
  hashAllowlist,
  migrateHeadroomState,
  pruneDeadSessions,
  pruneStaleAllowlistTemporaries,
  readHeadroomState,
  resolveServingHeadroomState,
  sessionsForSupervisor,
  writeAllowlistFile,
  writeHeadroomState,
  type HeadroomFs,
  type HeadroomState,
} from "./state";

/** Everything the supervisor needs to run the daemon, resolved from the global config and the filesystem before it starts. */
export interface HeadroomSupervisorConfig {
  /** The install spec as configured (`headroom.source`), already defaulted. */
  readonly source: string;
  /** `headroom.idleShutdownMinutes`, already defaulted. */
  readonly idleShutdownMinutes: number;
  /** The token-saving settings (`mode`, `targetRatio`, `ccr`, the rollout channel and its opt-ins), as configured; unset fields leave headroom on its own defaults. */
  readonly settings: HeadroomSettings;
}

/** How the supervisor resolves the configured source against its defaults. */
export function resolveSupervisorConfig(configured: Readonly<HeadroomGlobalConfig>): HeadroomSupervisorConfig {
  return {
    source: configured.source ?? HEADROOM_DEFAULT_SOURCE,
    idleShutdownMinutes: configured.idleShutdownMinutes ?? HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES,
    settings: settingsOf(configured),
  };
}

/**
 * Every effect the supervisor performs, injected so the whole lifecycle is testable against fakes: no real process, port, clock, or HTTP call ever happens in a unit test.
 */
export interface SupervisorPorts {
  readonly fs: HeadroomFs;
  readonly paths: LayoutPaths;
  readonly ownPid: number;
  readonly now: () => number;
  /**
   * Waits `ms`, yielding to the event loop while it does. Deliberately NOT a synchronous Atomics.wait-style sleep: the real supervisor learns of its child's death through the ChildProcess exit event, and a blocking sleep would stop the event loop from ever delivering it (the exact failure that left an unreaped zombie answering liveness checks as alive).
   */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Zombie-aware liveness, and for a daemon this supervisor spawned, exit-event-backed: the implementation keeps the spawned ChildProcess handle, consumes its exit event (which is also what reaps it), and reports the pid as not running from that moment. A bare signal-0 check is not enough, because a defunct process still answers it.
   */
  readonly isRunning: (pid: number) => boolean;
  /** Which of the recorded doors' pids are running front-door supervisors, from one read of the process table per call (see `FrontDoorLiveness`): a door's direct record outlives a crash, and the pid it names can be reused by an unrelated process, whose record must not keep the dead door's origin admitted. The supervisor calls it once per tick. */
  readonly frontDoorLiveness: (pids: readonly number[]) => FrontDoorLiveness;
  /** The daemon log's size in bytes (0 before it exists): where the next start attempt's own output will begin. */
  readonly daemonLogSize: () => number;
  /** The daemon log from byte `fromByte` to its end, at most its last `maxBytes`, read without loading the whole file (nothing rotates the log). */
  readonly readDaemonLogTail: (fromByte: number, maxBytes: number) => string;
  /** The command line of a running process as `ps` reports it, or undefined when it cannot be read: how a recorded orphan daemon is confirmed to be one before it is signalled (see `daemonIdentity`). */
  readonly daemonCommandLine: (pid: number) => string | undefined;
  /** The platform facts and owner-only checks the daemon's socket directory is prepared and verified with (see `prepareHeadroomSocket`). */
  readonly socketTrust: HeadroomSocketTrustPorts;
  /**
   * Starts `headroom proxy` serving on the unix socket `socketPath` (and on no TCP port), reading its upstream allowlist from `allowlistFile`, which it re-reads on the next request after the file is replaced, returning its pid. Output goes to the daemon log. The implementation must keep the ChildProcess handle and attach an exit listener (detaching the process is fine; unref'ing a child you still need events from is not, since without the listener nothing reaps it and it lingers as a zombie).
   */
  readonly spawnHeadroom: (socketPath: string, allowlistFile: string, settings: Readonly<HeadroomSettings>) => number;
  /** Reads the headroom config block as it stands on disk now. The supervisor calls it every tick, so a changed `source` or setting is noticed while the daemon runs and applied by a restart once no session is registered against this supervisor. */
  readonly readConfig: () => HeadroomSupervisorConfig;
  /** Stops a process the supervisor owns, escalating SIGTERM to SIGKILL on a bounded timeout (see `stopSupervisedProcess`). */
  readonly stopProcess: (pid: number) => void;
  /** True once `GET /readyz` over the unix socket succeeds. */
  readonly ready: (socketPath: string) => Promise<boolean>;
  /** Runs `uv tool install <spec>`, logging output to the daemon log. Returns ok=false with the error when `uv` is absent or the install fails. */
  readonly install: (spec: string) => { readonly ok: boolean; readonly error?: string };
  /** The installed `headroom --version` output, or undefined when the binary is not on PATH. */
  readonly headroomVersion: () => string | undefined;
  /** The commit the installed headroom was built from, as the install itself records it (`direct_url.json`), or undefined when it was not installed from a git source. */
  readonly installedCommit: () => string | undefined;
  readonly log: (line: string) => void;
}

/** First retry delay after a failed start. Half a second keeps a transient blip invisible to the next launch. */
export const HEADROOM_BACKOFF_BASE_MS = 500;
/** Ceiling for the retry delay: with no live sessions there is no user waiting, so half a minute between attempts is the most the daemon log should grow. */
export const HEADROOM_BACKOFF_CAP_MS = 30_000;
/** Consecutive failed starts before the supervisor gives up, records `lastError`, and exits: a proxy that cannot come up five times in a row is broken, not unlucky. */
export const HEADROOM_START_RETRY_BUDGET = 5;
/** How long one started proxy has to answer `/readyz` before the attempt counts as failed. A cold Python process on loopback takes seconds, not minutes. */
const HEADROOM_READY_TIMEOUT_MS = 15_000;
/** How many trailing lines of a daemon's own output an early-exit `lastError` carries: enough for a command-line usage error (usage, hint, blank, error) or a Python traceback's last frame and its exception, few enough to read as one message. */
const DAEMON_EXIT_LOG_LINES = 6;
/** The longest a single line of daemon output is kept in `lastError`, in characters: a usage error or a traceback frame fits well inside it, and a longer line (a dumped request, a minified blob) is cut with `...` rather than flooding every launch's error. */
export const DAEMON_EXIT_LOG_LINE_CHARS = 400;
/** The most of the daemon log an early-exit report reads: many times what `DAEMON_EXIT_LOG_LINES` lines of a usage error or a traceback's last frame take, so the lines are always there, and a fixed bound however large the unrotated log has grown. */
const DAEMON_LOG_TAIL_BYTES = 8192;
/** The supervisor's own tick rate for crash detection, allowlist rewrites, drift checks, and idle shutdown. */
export const HEADROOM_POLL_MS = 1_000;

/** Milliseconds per minute, so the idle shutdown threshold reads as the config field it derives from. */
const MS_PER_MINUTE = 60_000;

/** The process-control primitives the escalating stop needs, injected so the escalation itself is unit-testable against a process that ignores SIGTERM. */
export interface StopProcessPrimitives {
  /** Delivers a signal; throws when the target is already gone. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  /** Zombie-aware liveness: a defunct process is not running. */
  readonly isRunning: (pid: number) => boolean;
  /** Synchronous wait between liveness polls; blocking is correct here, since nothing productive can happen until the target is gone or the grace expires. */
  readonly waitMs: (ms: number) => void;
  readonly now: () => number;
}

/** How `stopSupervisedProcess` ended. `still-running` means even SIGKILL did not clear the pid within its grace (an uninterruptible process); callers log it loudly. */
export type StopOutcome = "exited-on-term" | "killed" | "still-running";

/** Poll interval while waiting for a stopped process to disappear: often enough to escalate quickly, rarely enough not to spin. */
const STOP_POLL_MS = 100;
/** Grace after SIGTERM before escalating to SIGKILL: enough for a proxy to drain an in-flight request, short enough that a restart is not visibly stalled. This proxy's server has been observed to ignore SIGTERM outright, so the escalation is not optional. */
export const TERM_GRACE_MS = 1500;
/** Grace after SIGKILL before declaring the process unkillable. SIGKILL is immediate at the kernel level; this only bounds the wait for the scheduler to reap it. */
export const KILL_GRACE_MS = 1500;

/**
 * Stops a process the supervisor owns: SIGTERM, wait up to `TERM_GRACE_MS`; SIGKILL, wait up to `KILL_GRACE_MS`; then report. Liveness during the waits must be zombie-aware: an unreaped target still answers signal 0, which would read as "survived SIGKILL".
 */
export function stopSupervisedProcess(pid: number, primitives: StopProcessPrimitives): StopOutcome {
  const send = (signal: NodeJS.Signals): void => {
    try {
      primitives.signal(pid, signal);
    } catch {
      // Already gone: the stop's job is done, whichever signal was about to be sent.
    }
  };

  send("SIGTERM");
  if (awaitExit(pid, primitives, TERM_GRACE_MS)) {
    return "exited-on-term";
  }
  send("SIGKILL");
  if (awaitExit(pid, primitives, KILL_GRACE_MS)) {
    return "killed";
  }
  return "still-running";
}

/** Polls `isRunning` until the pid is gone or `budgetMs` elapses. */
function awaitExit(pid: number, primitives: StopProcessPrimitives, budgetMs: number): boolean {
  const deadline = primitives.now() + budgetMs;
  while (primitives.isRunning(pid)) {
    if (primitives.now() >= deadline) {
      return false;
    }
    primitives.waitMs(STOP_POLL_MS);
  }
  return true;
}

/** The backoff for attempt `attempt` (1-based): base doubled per failure, capped. */
export function backoffForAttempt(attempt: number): number {
  return Math.min(HEADROOM_BACKOFF_CAP_MS, HEADROOM_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/**
 * Whether an installed `headroom --version` string satisfies the configured source. A source carrying a PEP 440 specifier (`headroom>=0.39`, `headroom==0.39.1`) is checked against the version; anything else (a bare git URL, the default) carries no version to check and is satisfied by any install, with drift handled by comparing `installedSource` instead.
 */
export function versionSatisfies(version: string | undefined, source: string): boolean {
  if (version === undefined) {
    return false;
  }
  const specifier = /==|>=|<=|!=|>|<|~=/.exec(source);
  if (specifier === null) {
    return true;
  }
  const installed = parseVersion(version);
  const wanted = parseVersion(source.slice(specifier.index + specifier[0].length));
  if (installed === undefined || wanted === undefined) {
    return true;
  }
  const cmp = compareVersions(installed, wanted);
  switch (specifier[0]) {
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "~=":
      // Compatible release: same major.minor prefix, not older. With the wanted version's last component dropped, plain >= over the prefix.
      return compareVersions(installed.slice(0, Math.max(0, wanted.length - 1)), wanted.slice(0, Math.max(0, wanted.length - 1))) === 0 && cmp >= 0;
    default:
      return true;
  }
}

/** The numeric components of the first version-looking token in `input`, or undefined when there is none. */
function parseVersion(input: string): readonly number[] | undefined {
  const match = /(\d+)(\.\d+)*/.exec(input);
  if (match === null) {
    return undefined;
  }
  return match[0].split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

/** Options for `runSupervisor`. */
export interface RunSupervisorOptions {
  /**
   * Bounds the supervisor loop's iterations. The real supervisor runs until it exits on its own (idle shutdown or fatal error); a bounded run is how tests observe steady-state behaviour (drift deferral, restart-on-crash, pruning) without an infinite loop, and such a run returns `HEADROOM_SUPERVISOR_STILL_RUNNING` instead of an exit code.
   */
  readonly tickLimit?: number;
}

/** Returned by a tick-bounded `runSupervisor` that reached its limit while still managing the daemon: not an exit code, and never produced without `tickLimit`. */
export const HEADROOM_SUPERVISOR_STILL_RUNNING = -1;

/**
 * Runs the headroom supervisor loop: install the daemon, start it, keep it alive (for crash or drift), and stop it after the configured idle period with an empty session registry. Returns the process exit code (0 for an idle shutdown, 1 for a fatal setup failure).
 *
 * Every effect flows through `ports`, so the whole loop is unit-testable with a fake clock, filesystem, and processes. The loop awaits its sleeps, which in the real implementation run on a timer: between ticks the event loop turns, the spawned child's exit event is delivered (and the child thereby reaped), and the next tick's liveness check reads the truth.
 */
export async function runSupervisor(
  initialConfig: HeadroomSupervisorConfig,
  ports: SupervisorPorts,
  options: RunSupervisorOptions = {},
): Promise<number> {
  const { fs, paths } = ports;
  // Replaced from disk at the top of every tick, so an edited `source` or setting is seen while the daemon runs.
  let config = initialConfig;

  // A supervisor start owns the same file-lifecycle step a launch's ensure performs, so the shared name is claimed or the legacy file retired here too.
  migrateHeadroomState(fs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, ports.isRunning);
  const previousState = resolveServingHeadroomState(fs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, ports.isRunning)?.state;
  if (
    previousState?.supervisorPid !== undefined &&
    previousState.supervisorPid !== ports.ownPid &&
    ports.isRunning(previousState.supervisorPid)
  ) {
    // Another live supervisor already keeps headroom up for every launch: a second daemon would only split the sessions, and "taking over" the state file would repoint new launches while the first supervisor keeps serving (and later rewriting) its own.
    ports.log(`agent-shim headroom supervisor ${String(ports.ownPid)}: supervisor ${String(previousState.supervisorPid)} already owns the daemon; exiting`);
    return 0;
  }
  let installedSource = previousState?.installedSource;
  /**
   * Whether this supervisor may write the state file: no other live supervisor is recorded there. An absent file or a dead owner is claimable, so a deleted or stale file heals itself, and the loser of two simultaneous claims finds the winner's pid at its next write and stands down.
   */
  const ownsState = (): boolean => {
    const owner = readHeadroomState(fs, paths.headroomStateFile)?.supervisorPid;
    return owner === undefined || owner === ports.ownPid || !ports.isRunning(owner);
  };

  /**
   * Writes the state file unless another live supervisor owns it, returning whether it wrote. A superseded supervisor keeps serving the sessions it already has but must not overwrite the owner's record: the state file names the daemon new launches connect to, and a crash-restart here would repoint them at a daemon being drained.
   */
  const writeOwnState = (state: Readonly<HeadroomState>): boolean => {
    if (!ownsState()) {
      return false;
    }
    writeHeadroomState(fs, paths.headroomStateFile, state);
    return true;
  };

  const fail = (message: string): number => {
    if (writeOwnState({ lastError: message })) {
      fs.removeRecursive(paths.headroomLockFile);
    }
    ports.log(`agent-shim headroom supervisor: ${message}`);
    return 1;
  };

  /**
   * Replaces the allowlist file when its content differs from `allowlist`, returning the failure message when reading or replacing it throws. Comparing the content rather than a remembered hash also restores a file removed or edited behind the supervisor's back, which the daemon would otherwise serve (a missing file admits nothing).
   */
  const syncAllowlistFile = (allowlist: readonly string[]): string | undefined => {
    try {
      if (fs.readFileUtf8(paths.headroomAllowlistFile) !== formatAllowlistFile(allowlist)) {
        writeAllowlistFile(fs, paths.headroomAllowlistFile, allowlist);
        ports.log(`agent-shim headroom supervisor: wrote allowlist [${allowlist.join(", ")}] to ${paths.headroomAllowlistFile}`);
      }
      return undefined;
    } catch (error) {
      return `could not write the headroom allowlist file ${paths.headroomAllowlistFile}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  /** Holds the allowlist file and every directory on its path to the rules `verifyAllowlistFile` judges (headroom's, from `/` down, and agent-shim's owner-only rule for its socket directory and the file), repairing what lies in agent-shim's own directories on every tick it fails: returns the error the supervisor ends with when a directory outside agent-shim's root fails headroom's rule or the repair did not work, or undefined when the file passes. */
  const allowlistFileRefusal = (allowlist: readonly string[]): string | undefined => {
    const problem = verifyAllowlistFile(paths.headroomAllowlistFile, ports.socketTrust);
    if (problem === undefined) {
      return undefined;
    }
    // A directory above agent-shim's own (a group-writable home, a shared /tmp) is not this tool's to change: headroom refuses the file while it stands, so the daemon is stopped at once with the remedy.
    if (!problem.repairable) {
      return `headroom would refuse its allowlist file, and agent-shim cannot repair it: ${problem.message}`;
    }
    // What lies in agent-shim's own directories is repairable by this user: narrowing the headroom and socket directories it creates, and rewriting the file (owner-only, renamed into place) over a widened, symlinked or another user's file. A daemon is stopped only for what that cannot fix.
    ports.log(`agent-shim headroom supervisor: repairing the allowlist file: ${problem.message}`);
    try {
      fs.mkdirPrivate(paths.headroomDir);
      fs.mkdirPrivate(path.dirname(paths.headroomAllowlistFile));
      writeAllowlistFile(fs, paths.headroomAllowlistFile, allowlist);
    } catch (error) {
      return `could not write the headroom allowlist file ${paths.headroomAllowlistFile}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const remaining = verifyAllowlistFile(paths.headroomAllowlistFile, ports.socketTrust);
    return remaining === undefined ? undefined : `the allowlist file breaks agent-shim's rules for it, and rewriting it did not repair it: ${remaining.message}`;
  };

  /**
   * Installs headroom when the binary is missing, its version fails the configured source's specifier, or the configured source changed since the last install this supervisor performed. An absent `installedSource` with a satisfying binary does NOT install: a user's own `uv tool install headroom` is a legitimate install to respect. A source that pins a commit is the exception: the install must have been built from exactly that commit, whatever the record says.
   *
   * Returns undefined when headroom is installed as configured, else why it is not. The install is recorded in state while it runs (see `HeadroomState.installing`), because it can outlast a launcher's start bound on a cold build and a launcher must be able to tell that from a supervisor that is stuck.
   */
  const ensureInstalled = (): string | undefined => {
    const version = ports.headroomVersion();
    const versionOk = version !== undefined && versionSatisfies(version, config.source);
    // A source that pins a commit is checked against the install itself, never against this supervisor's own record of what it installed: a record that was lost or rewritten would otherwise adopt whatever build happens to be present as the pinned one.
    const pinned = pinnedGitCommit(config.source);
    const commitOk = pinned === undefined || ports.installedCommit() === pinned;
    if (versionOk && commitOk && (installedSource === undefined || installedSource === config.source)) {
      // Adopting the satisfying install as this source's: an absent record with a healthy binary is a user's own install to respect, and recording it here is what stops every later tick reading as source drift.
      installedSource = config.source;
      return undefined;
    }
    ports.log(`agent-shim headroom supervisor: installing headroom from ${config.source}`);
    writeOwnState({ supervisorPid: ports.ownPid, installedSource, installing: config.source });
    const result = ports.install(config.source);
    if (!result.ok) {
      return `could not install headroom from ${config.source}: ${result.error ?? "install failed"}`;
    }
    installedSource = config.source;
    return undefined;
  };

  // The socket is settled before anything is installed: a platform without unix sockets, or a socket directory the door would refuse, can never serve, and installing first would only delay the refusal.
  const socket = prepareHeadroomSocket(fs, ports.socketTrust, paths, ports.ownPid);
  if (socket.refused !== undefined) {
    return fail(socket.refused);
  }
  const { socketPath } = socket;
  pruneStaleHeadroomSockets(fs, paths, ports.isRunning);
  pruneStaleAllowlistTemporaries(fs, paths.headroomAllowlistFile, ports.isRunning);

  const installFailure = ensureInstalled();
  if (installFailure !== undefined) {
    return fail(installFailure);
  }
  const version = ports.headroomVersion() ?? "unknown";

  // Fresh ownership: whatever came before, this supervisor is now the one keeping headroom alive.
  writeOwnState({ supervisorPid: ports.ownPid, version, installedSource });
  ports.log(`agent-shim headroom supervisor ${String(ports.ownPid)}: managing headroom on allowlist [${currentHeadroomAllowlistInputs(fs, paths, ports.frontDoorLiveness).frontDoorOrigins.join(", ")}]`);

  const orphanPid = previousState?.headroomPid;
  // The socket the orphan was started on: the one recorded, or, for a daemon recorded before it was ready, its generation's.
  const orphanSocket = previousState?.socketPath ?? (previousState?.supervisorPid === undefined ? undefined : headroomSocketPath(paths, previousState.supervisorPid));
  const orphanIdentity = orphanPid === undefined || orphanSocket === undefined || !ports.isRunning(orphanPid) ? undefined : daemonIdentity(ports.daemonCommandLine(orphanPid), orphanSocket);
  if (orphanPid !== undefined && (orphanIdentity === "not-headroom" || orphanIdentity === "unreadable")) {
    // A recorded pid can have been given to another process since, and one whose command line cannot be read cannot be shown to be ours: neither is ever signalled.
    ports.log(`agent-shim headroom supervisor: leaving pid ${String(orphanPid)} alone: the state records it as the previous daemon, but it ${orphanIdentity === "unreadable" ? "cannot be identified" : "is no longer a headroom proxy on that generation's socket"}`);
  }
  if (orphanPid !== undefined && (orphanIdentity === "this-release" || orphanIdentity === "earlier-release")) {
    // A predecessor's daemon that outlived it (its supervisor died by a signal nothing could intercept, say) would keep running forever: nothing supervises it, nothing idles it out. Take it over before starting its own.
    ports.log(`agent-shim headroom supervisor: stopping daemon pid ${String(orphanPid)} left behind by the previous supervisor`);
    ports.stopProcess(orphanPid);
  }

  let headroomPid: number | undefined;
  let runningHash: string | undefined;
  let runningSettingsHash: string | undefined;
  let consecutiveFailures = 0;
  // What the most recent failed attempt's daemon wrote before it exited, or undefined when that attempt timed out with the daemon still running.
  let lastExitOutput: string | undefined;
  let idleSince: number | undefined;
  let superseded = false;
  let ticks = 0;

  /** The state record of a daemon this supervisor has brought up: what it runs with, as opposed to what the configuration asks for while a restart is pending. */
  const servingState = (pid: number): HeadroomState => ({
    supervisorPid: ports.ownPid,
    headroomPid: pid,
    socketPath,
    version,
    allowlistHash: runningHash,
    settingsHash: runningSettingsHash,
    installedSource,
  });

  for (;;) {
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      return HEADROOM_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    config = ports.readConfig();
    const settingsHash = hashSettings(config.settings);
    // One read of the process table per tick, shared by the pruning and the allowlist so both act on the same verdict.
    const inputs = currentHeadroomAllowlistInputs(fs, paths, ports.frontDoorLiveness);
    // A door that crashed never removed its direct record; pruning it is what withdraws its origin once nothing can route through it.
    pruneDeadFrontDoorDirectRecords(fs, paths.frontdoorDirectRecordsDir, inputs.frontDoorRecords, inputs.frontDoorLiveness);
    pruneMalformedFrontDoorDirectFiles(fs, paths.frontdoorDirectRecordsDir, ports.isRunning);
    // Recomputed every tick: a front door can move, come or go at any moment, and the allowlist is the daemon's whole security posture.
    const allowlist = inputs.frontDoorOrigins;
    const allowlistHash = hashAllowlist(allowlist);
    pruneDeadSessions(fs, paths.headroomSessionsDir, ports.isRunning);
    const ownsNow = ownsState();
    if (!ownsNow && !superseded) {
      ports.log("agent-shim headroom supervisor: another supervisor now owns the state file; serving this daemon's own sessions until they end");
    }
    superseded = !ownsNow;
    // Brought in line before anything below can spawn, so a daemon never starts on a stale file, and only by the state's owner: the file is shared by every generation, and a superseded supervisor keeps serving its own sessions on whatever the owner keeps it at rather than contending with the owner's writes. A supervisor that cannot write the file cannot keep the daemon's allowlist current, so it stops the daemon rather than leave it serving an allowlist nothing will correct, with nothing left to idle it out.
    // Checked, and repaired where it can be, before any hash is recorded below: headroom reads a file that fails its own rule as admitting nothing, so recording such a file as served would let launches through that every request then fails, and `verifyAllowlistFile` judges every directory on the path by headroom's rule and the file by a stricter one, so a file that passes it is one headroom reads. A supervisor that cannot write the file, or cannot repair it, stops the daemon rather than leave it serving an allowlist nothing will correct, with nothing left to idle it out.
    const allowlistFailure = ownsNow ? (syncAllowlistFile(allowlist) ?? allowlistFileRefusal(allowlist)) : undefined;
    if (allowlistFailure !== undefined) {
      if (headroomPid !== undefined && ports.isRunning(headroomPid)) {
        ports.stopProcess(headroomPid);
      }
      return fail(allowlistFailure);
    }

    const crashed = headroomPid !== undefined && !ports.isRunning(headroomPid);
    if (headroomPid === undefined || crashed) {
      if (crashed) {
        ports.log(`agent-shim headroom supervisor: headroom pid ${String(headroomPid)} died`);
        headroomPid = undefined;
        runningHash = undefined;
        runningSettingsHash = undefined;
        // Clear the daemon fields immediately: until the replacement is ready, state must not claim a serving socket for a process that just died, or `headroom status` and waiting launchers read a healthy daemon that no longer exists. The front door reads the socket path live and its headroom hop answers 502 until the daemon is back on the same path.
        writeOwnState({
          supervisorPid: ports.ownPid,
          version,
          installedSource,
        });
      }
      if (consecutiveFailures >= HEADROOM_START_RETRY_BUDGET) {
        return fail(
          `headroom failed to become ready ${String(consecutiveFailures)} times in a row; giving up` +
            (lastExitOutput === undefined ? "" : `; the last attempt exited before it was ready, and its log ends: ${lastExitOutput}`),
        );
      }
      // A plain crash-restart keeps the existing install; only a changed source needs another install pass.
      const restartInstallFailure = installedSource !== config.source ? ensureInstalled() : undefined;
      if (restartInstallFailure !== undefined) {
        return fail(restartInstallFailure);
      }
      // Every restart in this generation serves on the same path: headroom replaces a socket nothing is listening on, so a crashed predecessor's leftover never blocks it.
      // Where this attempt's own output starts in the shared log, so an early exit reports what this daemon wrote rather than anything before it.
      const logOffset = ports.daemonLogSize();
      const pid = ports.spawnHeadroom(socketPath, paths.headroomAllowlistFile, config.settings);
      // Recorded before the readiness wait, without the socket path that is the ready signal, so a successor that finds this supervisor gone can identify and stop a daemon it never saw become ready.
      writeOwnState({ supervisorPid: ports.ownPid, headroomPid: pid, version, installedSource });
      const outcome = await waitUntilReady(ports, socketPath, pid);
      if (outcome === "ready") {
        consecutiveFailures = 0;
        lastExitOutput = undefined;
        headroomPid = pid;
        runningHash = allowlistHash;
        runningSettingsHash = settingsHash;
        const recorded = writeOwnState(servingState(pid));
        if (recorded) {
          // The start lock has done its job: state now names a live supervisor, so every future launcher finds it there instead.
          fs.removeRecursive(paths.headroomLockFile);
        }
        idleSince = undefined;
        ports.log(`agent-shim headroom supervisor: headroom pid ${String(pid)} ready on unix socket ${socketPath}`);
      } else {
        consecutiveFailures += 1;
        if (outcome === "exited") {
          lastExitOutput = lastLines(ports.readDaemonLogTail(logOffset, DAEMON_LOG_TAIL_BYTES));
          ports.log(
            `agent-shim headroom supervisor: headroom exited before it was ready on unix socket ${socketPath} ` +
              `(attempt ${String(consecutiveFailures)} of ${String(HEADROOM_START_RETRY_BUDGET)})`,
          );
        } else {
          lastExitOutput = undefined;
          ports.stopProcess(pid);
          ports.log(
            `agent-shim headroom supervisor: headroom did not become ready on unix socket ${socketPath} ` +
              `(attempt ${String(consecutiveFailures)} of ${String(HEADROOM_START_RETRY_BUDGET)})`,
          );
        }
        await ports.sleep(backoffForAttempt(consecutiveFailures));
        continue;
      }
    } else {
      if (runningHash !== allowlistHash) {
        // The file already holds this allowlist (synced at the top of the tick) and the daemon reads it on its next request, so recording the hash is all that is left: it is what lets a provider launch waiting in `ensureHeadroom` through. Sessions on this daemon carry on with no restart.
        runningHash = allowlistHash;
        writeOwnState(servingState(headroomPid));
        ports.log(`agent-shim headroom supervisor: headroom pid ${String(headroomPid)} now serves allowlist [${allowlist.join(", ")}]`);
      }
      // A changed install spec or setting means the daemon would run differently from what the configuration asks for, and only a restart applies it, which would cut off live sessions, so it waits until none is registered against this supervisor.
      if (runningSettingsHash !== settingsHash || installedSource !== config.source) {
        if (sessionsForSupervisor(fs, paths.headroomSessionsDir, ports.ownPid).length === 0) {
          ports.log("agent-shim headroom supervisor: configuration drifted and no sessions are live; restarting headroom");
          ports.stopProcess(headroomPid);
          headroomPid = undefined;
          runningHash = undefined;
          runningSettingsHash = undefined;
          continue;
        }
      }

      const sessions = sessionsForSupervisor(fs, paths.headroomSessionsDir, ports.ownPid);
      if (sessions.length === 0) {
        idleSince ??= ports.now();
        const idleMs = ports.now() - idleSince;
        if (idleMs >= config.idleShutdownMinutes * MS_PER_MINUTE) {
          ports.log(
            `agent-shim headroom supervisor: no sessions for ${String(config.idleShutdownMinutes)} minute(s); stopping headroom and exiting`,
          );
          ports.stopProcess(headroomPid);
          // A superseded supervisor leaves the new owner's record alone.
          writeOwnState({ version });
          return 0;
        }
      } else {
        idleSince = undefined;
      }
    }

    await ports.sleep(HEADROOM_POLL_MS);
  }
}


/**
 * What the headroom allowlist is computed from, as it stands right now. The allowlist is exactly `frontDoorOrigins`: headroom checks an upstream against it only when a request names one, and the front door's hop names only its own direct origin, for every provider route; an OAuth request names none and goes to Claude Code's own API, which no allowlist entry is needed for.
 */
export interface HeadroomAllowlistInputs {
  /** Every door's direct record on disk, and the one process-table read that judged them, so a caller that prunes acts on the same verdict the origins were computed from. */
  readonly frontDoorRecords: readonly FrontDoorDirectRecord[];
  readonly frontDoorLiveness: FrontDoorLiveness;
  /** The direct origin `state.json` names (the serving door's, or the sticky one before any door has served) together with the recorded origin of every other live door, sorted and without repeats; empty before any door has ever served. */
  readonly frontDoorOrigins: readonly string[];
}

/** A recorded front door no read of the process table could answer for, kept on the allowlist until one can: its pid, its direct origin, and why the read failed. */
export interface UndeterminedFrontDoor {
  readonly pid: number;
  readonly origin: string;
  readonly reason: string;
}

/** The recorded doors `inputs`' process-table read could not answer for, for `headroom status` and `doctor` to name. */
export function undeterminedFrontDoors(inputs: HeadroomAllowlistInputs): readonly UndeterminedFrontDoor[] {
  return inputs.frontDoorRecords.flatMap((record) => {
    const reason = inputs.frontDoorLiveness.unknown.get(record.pid);
    return reason === undefined ? [] : [{ pid: record.pid, origin: directOrigin(record.directPort), reason }];
  });
}

/** Reads the allowlist's inputs from disk, asking `frontDoorLiveness` once about every recorded door (see `liveFrontDoorDirectRecords`). */
export function currentHeadroomAllowlistInputs(fs: HeadroomFs, paths: LayoutPaths, frontDoorLiveness: (pids: readonly number[]) => FrontDoorLiveness): HeadroomAllowlistInputs {
  const named = frontDoorOrigin(readFrontDoorState(fs, paths.frontdoorStateFile));
  const records = listFrontDoorDirectRecords(fs, paths.frontdoorDirectRecordsDir);
  const liveness = frontDoorLiveness(records.map((record) => record.pid));
  const live = liveFrontDoorDirectRecords(records, liveness).map((record) => directOrigin(record.directPort));
  return {
    frontDoorRecords: records,
    frontDoorLiveness: liveness,
    frontDoorOrigins: [...new Set([...(named === undefined ? [] : [named]), ...live])].sort(),
  };
}

/**
 * The upstreams the headroom daemon must admit for one launch that routes a provider through it: the direct origin of the front door `state.json` names, the door the launch is sent to, whose hop names that origin as headroom's upstream for every provider request. Empty before any door has served, when there is nothing to wait for. What `ensureHeadroom`'s `requiredUpstreams` takes.
 */
export function launchRequiredUpstreams(fs: HeadroomFs, paths: LayoutPaths): readonly string[] {
  const door = frontDoorOrigin(readFrontDoorState(fs, paths.frontdoorStateFile));
  return door === undefined ? [] : [door];
}

/** How one start attempt's readiness wait ended. */
type ReadyOutcome = "ready" | "exited" | "timed-out";

/** Polls `/readyz` over the socket until it answers, the daemon `pid` exits (a daemon that refused its arguments or crashed on start will never answer, so waiting out the timeout would only delay the retry and hide the cause), or `HEADROOM_READY_TIMEOUT_MS` elapses. */
async function waitUntilReady(ports: SupervisorPorts, socketPath: string, pid: number): Promise<ReadyOutcome> {
  const deadline = ports.now() + HEADROOM_READY_TIMEOUT_MS;
  for (;;) {
    if (await ports.ready(socketPath)) {
      return "ready";
    }
    if (!ports.isRunning(pid)) {
      return "exited";
    }
    if (ports.now() >= deadline) {
      return "timed-out";
    }
    await ports.sleep(HEADROOM_POLL_MS);
  }
}

/** The last `DAEMON_EXIT_LOG_LINES` non-blank lines of `output`, credential-shaped text redacted (the record is printed by `headroom status`, `doctor` and every failed launch), joined into one line for `lastError`, or a note that the daemon wrote nothing. */
function lastLines(output: string): string {
  const lines = redactText(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => (line.length > DAEMON_EXIT_LOG_LINE_CHARS ? `${line.slice(0, DAEMON_EXIT_LOG_LINE_CHARS)}...` : line));
  return lines.length === 0 ? "(the daemon wrote nothing)" : lines.slice(-DAEMON_EXIT_LOG_LINES).join(" | ");
}
