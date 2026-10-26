import { CliError } from "../cliError";
import { daemonIdentity, EARLIER_RELEASE_ALLOWLIST, earlierReleaseDaemon, type DaemonIdentity } from "./earlierRelease";
import type { LayoutPaths } from "../paths";
import {
  hashAllowlistFile,
  migrateHeadroomState,
  parseAllowlistFile,
  readStartLock,
  resolveServingHeadroomState,
  writeSession,
  type HeadroomFs,
  type HeadroomLock,
} from "./state";

/**
 * How long one launch waits for the daemon to report ready, and for its supervisor to record an allowlist the launch needs. Generous on purpose: a first-ever launch can sit behind `uv tool install` building headroom from a git URL, and a warm daemon answers (and a running supervisor records a changed allowlist) within one of its ticks, so the bound only ever bites when something is genuinely broken.
 */
export const HEADROOM_START_TIMEOUT_MS = 120_000;

/** The launcher's poll rate while waiting for the daemon. Fast enough not to add perceptible latency on a warm start, slow enough not to hammer the state file. */
const HEADROOM_LAUNCHER_POLL_MS = 250;

/** Why a launch that waited out the timeout for the daemon's allowlist is still not admitted, by what the daemon's command line says it is. */
function awaitingCause(daemonPid: number, identity: DaemonIdentity, allowlistFile: string): string {
  if (identity === "unreadable") {
    return `could not read the command line of the headroom daemon (pid ${String(daemonPid)}), so whether it reads an allowlist file is unknown, and its allowlist was not recorded as admitting this launch's upstreams within ${String(HEADROOM_START_TIMEOUT_MS)}ms`;
  }
  if (identity === "not-headroom") {
    return `the headroom daemon pid ${String(daemonPid)} the state records is no longer a headroom proxy on its socket, and no daemon was recorded as admitting this launch's upstreams within ${String(HEADROOM_START_TIMEOUT_MS)}ms`;
  }
  return `the headroom supervisor has not written an allowlist admitting this launch's upstreams to ${allowlistFile} within ${String(HEADROOM_START_TIMEOUT_MS)}ms`;
}

/**
 * Whether the daemon admits every one of `required`: the allowlist file lists them all, and `recordedHash` (the state's `allowlistHash`) is the hash of exactly the entries the file lists, which the supervisor records only once the file holding them is in place for the daemon to read.
 */
function daemonAdmits(fs: HeadroomFs, allowlistFile: string, recordedHash: string | undefined, required: readonly string[]): boolean {
  const content = fs.readFileUtf8(allowlistFile);
  if (content === undefined || recordedHash === undefined) {
    return false;
  }
  const served = parseAllowlistFile(content);
  return recordedHash === hashAllowlistFile(content) && required.every((upstream) => served.includes(upstream));
}

/** Raised when the daemon cannot be brought up in time, or reports a fatal `lastError`: a launch that asked for headroom must never silently fall back to a direct connection. */
export class HeadroomStartError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "HeadroomStartError";
  }
}

/** Every effect the ensure step performs, injected so it runs against fakes in tests. */
export interface EnsureHeadroomPorts {
  readonly fs: HeadroomFs;
  /** Zombie-aware liveness: a supervisor or daemon that exited without being reaped still answers signal 0 as alive, but will never serve a request or write state, so it must read as dead here (see `realIsProcessRunning`). */
  readonly isRunning: (pid: number) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  /** The command line of a running process as `ps` reports it, or undefined when it cannot be read: how a daemon started by an earlier release, which reads no allowlist file, is told apart. */
  readonly daemonCommandLine: (pid: number) => string | undefined;
  /** Spawns the detached supervisor process that owns the headroom daemon, returning its pid. */
  readonly spawnSupervisor: (paths: LayoutPaths) => number;
}

/** What one attempt to start the supervisor under the start lock did. */
export type SupervisorStart =
  /** The caller took the lock and spawned the supervisor. */
  | "spawned"
  /** Another live process holds the lock, so it is spawning the supervisor and the caller waits on the state file. */
  | "held"
  /** The lock's holder had died, so the lock was removed and the caller decides again from the state file. */
  | "cleared-stale-lock";

/**
 * The exclusive-create start lock decides which of several concurrent callers spawns the one supervisor: its holder spawns, everyone else waits on the state file, and a lock whose holder has died is removed so the next decision can take it. Shared by a launch (`ensureHeadroom`) and the front door's keeper, so both start the supervisor the same way and never two at once.
 *
 * The lock is not cleared when the supervisor comes up: it stays until its holder exits, so a holder that outlives the start (the front door) removes its own lock once the supervisor is serving.
 */
export function startSupervisorUnderLock(params: {
  readonly paths: LayoutPaths;
  readonly holderPid: number;
  readonly ports: Pick<EnsureHeadroomPorts, "fs" | "now" | "isRunning" | "spawnSupervisor">;
}): SupervisorStart {
  const { paths, ports } = params;
  ports.fs.mkdirp(paths.headroomDir);
  const created = ports.fs.writeFileExclusive(paths.headroomLockFile, `${JSON.stringify({ pid: params.holderPid, at: ports.now() } satisfies HeadroomLock)}\n`);
  if (created) {
    ports.spawnSupervisor(paths);
    return "spawned";
  }
  const lock = readStartLock(ports.fs, paths.headroomLockFile);
  if (lock === undefined || !ports.isRunning(lock.pid)) {
    // A dead holder's lock is litter from a launcher that died before the supervisor it spawned could clear it.
    ports.fs.removeRecursive(paths.headroomLockFile);
    return "cleared-stale-lock";
  }
  return "held";
}

/**
 * Brings the headroom daemon up for this launch, or finds it already running, and registers this launcher pid in its session registry (the fact that keeps the daemon alive and defers a restart for a changed install source or setting until this launch is done). A launch that routes a provider waits, within the same bound, until the supervisor records that the daemon serves an allowlist admitting it.
 *
 * The exclusive-create start lock decides which of several concurrent launches spawns the one supervisor: its holder spawns and keeps waiting like everyone else, everyone else waits on the state file, and a lock whose holder has died is removed and retried. Readiness is "state names a live supervisor, a live headroom pid, and a socket path", which the supervisor only writes after its own `/readyz` probe over that socket has passed, so polling state alone never mistakes a bound-but-not-ready socket for a usable daemon.
 *
 * Throws `HeadroomStartError` (naming the daemon log path and any recorded `lastError`, or the allowlist file when that is what the launch waited on) when the daemon is not up, or not serving the allowlist the launch needs, within `HEADROOM_START_TIMEOUT_MS`, or when a live supervisor has recorded a fatal error (a platform without unix sockets and a socket directory that fails the owner-only check are recorded this way, so the launch fails with the reason).
 */
export function ensureHeadroom(params: {
  readonly paths: LayoutPaths;
  readonly launcherPid: number;
  readonly ports: EnsureHeadroomPorts;
  /**
   * The upstreams the daemon must admit for this launch to work, read fresh on every poll because the front door's address among them can change while the launch waits. Given for a launch that routes a provider through headroom, whose requests come back to the front door's direct origin and are refused by a daemon whose allowlist lacks it; absent for a launch that only needs Claude Code's own API, which every daemon admits. `launchRequiredUpstreams` computes them for a provider launch: the serving door's direct origin. The daemon may admit more (a superseded door still serving its own sessions keeps its origin admitted), so the check is that these are among what it serves, not that the lists are equal.
   */
  readonly requiredUpstreams?: () => readonly string[];
}): { readonly socketPath: string } {
  const { paths, ports } = params;
  let deadline = ports.now() + HEADROOM_START_TIMEOUT_MS;
  let spawnedSupervisor = false;
  // The one file-lifecycle step a launch owns: folding the previous release's state file onto the shared name, or removing it once its generation has drained, before any polling starts.
  migrateHeadroomState(ports.fs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, ports.isRunning);

  // A running daemon's arguments never change, so its command line is read once per wait, however many polls the wait takes, and a pid the supervisor replaces is read afresh.
  const commandLines = new Map<number, string | undefined>();
  const commandLineOf = (pid: number): string | undefined => {
    if (!commandLines.has(pid)) {
      commandLines.set(pid, ports.daemonCommandLine(pid));
    }
    return commandLines.get(pid);
  };

  for (;;) {
    // Decided afresh on every poll: only a daemon that is up right now can be waiting on its allowlist, so one that died after an earlier poll found it stale times out as a daemon that is not up, with whatever error its supervisor recorded.
    let awaiting: { readonly daemonPid: number; readonly identity: DaemonIdentity } | undefined;
    const state = resolveServingHeadroomState(ports.fs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, ports.isRunning)?.state;
    if (state?.supervisorPid !== undefined && ports.isRunning(state.supervisorPid)) {
      if (state.installing !== undefined) {
        // A live supervisor in the middle of `uv tool install` is making the progress this launch is waiting for. The start bound runs from the install's end, so a cold build of a changed pin never fails the launch that happened to trigger it.
        deadline = ports.now() + HEADROOM_START_TIMEOUT_MS;
      }
      const daemonUp = state.socketPath !== undefined && state.headroomPid !== undefined && ports.isRunning(state.headroomPid);
      if (daemonUp && state.socketPath !== undefined && state.headroomPid !== undefined) {
        const required = params.requiredUpstreams?.();
        if (required === undefined || daemonAdmits(ports.fs, paths.headroomAllowlistFile, state.allowlistHash, required)) {
          writeSession(ports.fs, paths.headroomSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), supervisorPid: state.supervisorPid });
          return { socketPath: state.socketPath };
        }
        const commandLine = commandLineOf(state.headroomPid);
        const earlierRelease = earlierReleaseDaemon(ports.fs, paths, { commandLine, socketPath: state.socketPath, recordedHash: state.allowlistHash });
        if (earlierRelease !== undefined) {
          if (earlierRelease.admitsServingDoor) {
            writeSession(ports.fs, paths.headroomSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), supervisorPid: state.supervisorPid });
            return { socketPath: state.socketPath };
          }
          // Nothing rewrites an earlier release's allowlist, so waiting would only run out the timeout: say what ends it instead.
          throw new HeadroomStartError(
            `the running headroom daemon (pid ${String(state.headroomPid)}) was ${EARLIER_RELEASE_ALLOWLIST}, and its allowlist cannot be shown to admit the serving front door; ` +
              `launch with --no-headroom until then. Supervisor and daemon log: ${paths.headroomLogPath}`,
          );
        }
        // The daemon's allowlist file does not yet list the serving door's direct origin (the door moved to another port, or a second door took over), so it would answer every request with "Rejected unsafe upstream base URL". Its supervisor rewrites the file the daemon re-reads and records the hash of that file's entries on its next tick, with no restart, so the launch waits for a recorded file that holds the origin rather than registering against an allowlist that refuses it.
        awaiting = { daemonPid: state.headroomPid, identity: daemonIdentity(commandLine, state.socketPath) };
      }
      if (state.lastError !== undefined) {
        throw new HeadroomStartError(
          `the headroom daemon reported a fatal error and is not serving: ${state.lastError} ` +
            `(daemon log: ${paths.headroomLogPath})`,
        );
      }
    } else if (!spawnedSupervisor) {
      const started = startSupervisorUnderLock({ paths, holderPid: params.launcherPid, ports });
      if (started === "spawned") {
        spawnedSupervisor = true;
      } else if (started === "cleared-stale-lock") {
        continue;
      }
    }

    if (ports.now() >= deadline) {
      const lastError = state?.lastError === undefined ? "" : ` (last error: ${state.lastError})`;
      if (awaiting !== undefined) {
        throw new HeadroomStartError(`${awaitingCause(awaiting.daemonPid, awaiting.identity, paths.headroomAllowlistFile)}${lastError}, so the daemon would refuse every request this launch sends through it; launch with --no-headroom to bypass it. Supervisor and daemon log: ${paths.headroomLogPath}`);
      }
      throw new HeadroomStartError(`the headroom daemon did not become ready within ${String(HEADROOM_START_TIMEOUT_MS)}ms${lastError}. Daemon log: ${paths.headroomLogPath}`);
    }
    ports.sleep(HEADROOM_LAUNCHER_POLL_MS);
  }
}
