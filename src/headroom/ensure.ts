import { CliError } from "../cliError";
import type { LayoutPaths } from "../paths";
import {
  readHeadroomState,
  readStartLock,
  sessionsForSupervisor,
  writeSession,
  type HeadroomFs,
  type HeadroomLock,
} from "./state";

/**
 * How long one launch waits for the daemon to report ready. Generous on purpose: a first-ever launch can sit behind `uv tool install` building headroom from a git URL, and a warm daemon answers within one poll, so the bound only ever bites when something is genuinely broken.
 */
const HEADROOM_START_TIMEOUT_MS = 120_000;

/** The launcher's poll rate while waiting for the daemon. Fast enough not to add perceptible latency on a warm start, slow enough not to hammer the state file. */
const HEADROOM_LAUNCHER_POLL_MS = 250;

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
  /** Spawns the detached supervisor process that owns the headroom daemon, returning its pid. */
  readonly spawnSupervisor: (paths: LayoutPaths) => number;
}

/**
 * Brings the headroom daemon up for this launch, or finds it already running, and registers this launcher pid in its session registry (the fact that keeps the daemon alive and defers drift restarts until this launch is done).
 *
 * The exclusive-create start lock decides which of several concurrent launches spawns the one supervisor: its holder spawns and keeps waiting like everyone else, everyone else waits on the state file, and a lock whose holder has died is removed and retried. Readiness is "state names a live supervisor, a live headroom pid, and a socket path", which the supervisor only writes after its own `/readyz` probe over that socket has passed, so polling state alone never mistakes a bound-but-not-ready socket for a usable daemon.
 *
 * Throws `HeadroomStartError` (naming the daemon log path and any recorded `lastError`) when the daemon is not up within `HEADROOM_START_TIMEOUT_MS`, or when a live supervisor has recorded a fatal error (a platform without unix sockets and a socket directory that fails the owner-only check are recorded this way, so the launch fails with the reason).
 */
export function ensureHeadroom(params: {
  readonly paths: LayoutPaths;
  readonly launcherPid: number;
  readonly ports: EnsureHeadroomPorts;
  /**
   * The hash of the allowlist the daemon must have been started with for this launch to work, read fresh on every poll because the front door's address it contains can change while the launch waits. Given for a launch that routes a provider through headroom, whose requests come back to the front door's direct origin and are refused by a daemon that was started without it; absent for a launch that only needs Claude Code's own API, which every daemon admits.
   */
  readonly requiredAllowlistHash?: () => string;
}): { readonly socketPath: string } {
  const { paths, ports } = params;
  const deadline = ports.now() + HEADROOM_START_TIMEOUT_MS;
  let spawnedSupervisor = false;
  let awaitingAllowlist = false;

  for (;;) {
    const state = readHeadroomState(ports.fs, paths.headroomStateFile);
    if (state?.supervisorPid !== undefined && ports.isRunning(state.supervisorPid)) {
      const daemonUp = state.socketPath !== undefined && state.headroomPid !== undefined && ports.isRunning(state.headroomPid);
      if (daemonUp && state.socketPath !== undefined) {
        const required = params.requiredAllowlistHash?.();
        if (required === undefined || state.allowlistHash === required) {
          writeSession(ports.fs, paths.headroomSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), supervisorPid: state.supervisorPid });
          return { socketPath: state.socketPath };
        }
        // The daemon's allowlist predates something this launch routes through (the front door moved to another port, or a provider changed), so it would answer every request with "Rejected unsafe upstream base URL". The supervisor restarts it as soon as no session is registered against it, so registering here would pin the stale daemon for as long as this launch lives: wait for the restart instead, or refuse when a live session is what holds it up.
        const holders = sessionsForSupervisor(ports.fs, paths.headroomSessionsDir, state.supervisorPid).filter((session) => ports.isRunning(session.pid));
        if (holders.length > 0) {
          throw new HeadroomStartError(
            `agent-shim: the running headroom daemon was started before this launch's front door address and would refuse every request this launch sends through it. ` +
              `It restarts once the launches using it end (pid ${holders.map((session) => String(session.pid)).join(", ")}); end them and launch again, or launch with --no-headroom.`,
          );
        }
        awaitingAllowlist = true;
      }
      if (state.lastError !== undefined) {
        throw new HeadroomStartError(
          `agent-shim: the headroom daemon reported a fatal error and is not serving: ${state.lastError} ` +
            `(daemon log: ${paths.headroomLogPath})`,
        );
      }
    } else if (!spawnedSupervisor) {
      ports.fs.mkdirp(paths.headroomDir);
      const created = ports.fs.writeFileExclusive(
        paths.headroomLockFile,
        `${JSON.stringify({ pid: params.launcherPid, at: ports.now() } satisfies HeadroomLock)}\n`,
      );
      if (created) {
        ports.spawnSupervisor(paths);
        spawnedSupervisor = true;
      } else {
        const lock = readStartLock(ports.fs, paths.headroomLockFile);
        if (lock === undefined || !ports.isRunning(lock.pid)) {
          // A dead holder's lock is litter from a launcher that died before the supervisor it spawned could clear it.
          ports.fs.removeRecursive(paths.headroomLockFile);
          continue;
        }
      }
    }

    if (ports.now() >= deadline) {
      const lastError = state?.lastError;
      throw new HeadroomStartError(
        `agent-shim: the headroom daemon did not become ready within ${String(HEADROOM_START_TIMEOUT_MS)}ms` +
          (lastError === undefined ? "" : ` (last error: ${lastError})`) +
          (awaitingAllowlist ? " (the running daemon's allowlist does not admit this launch's front door, and it did not restart)" : "") +
            `. Daemon log: ${paths.headroomLogPath}`,
      );
    }
    ports.sleep(HEADROOM_LAUNCHER_POLL_MS);
  }
}
