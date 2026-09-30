import { CliError } from "../cliError";
import { readStartLock, writeSession, type HeadroomFs, type HeadroomLock } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { readCodexState } from "./state";

/** How long one launch waits for the codex daemon. The worker is this same binary binding a loopback port, so a cold start takes a second or two; the bound only bites when something is genuinely broken. */
const CODEX_START_TIMEOUT_MS = 30_000;

/** The launcher's poll rate while waiting for the daemon. */
const CODEX_LAUNCHER_POLL_MS = 100;

/** Raised when the codex daemon cannot be brought up in time or has recorded a fatal error: a codex launch has no other way to reach the backend, so it must fail rather than start a session that can never answer. */
export class CodexStartError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "CodexStartError";
  }
}

/** Every effect the ensure step performs, injected so it runs against fakes. */
export interface EnsureCodexPorts {
  readonly fs: HeadroomFs;
  /** Zombie-aware liveness (see `realIsProcessRunning`). */
  readonly isRunning: (pid: number) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  /** Spawns the detached codex supervisor, returning its pid. */
  readonly spawnSupervisor: (paths: LayoutPaths) => number;
}

/**
 * Brings the codex daemon up for this launch, or finds it running, and registers this launcher pid in its session registry: the fact that keeps the daemon from idling out while this session lives. The same lock-and-poll coordination as `ensureHeadroom`: the exclusive-create start lock decides which of several concurrent launches spawns the one supervisor, everyone waits on state.json, and a lock whose holder died is removed and retried. Ready means state names a live supervisor, a live worker and a port, which the supervisor writes only after the worker has answered its health check.
 */
export function ensureCodex(params: { readonly paths: LayoutPaths; readonly launcherPid: number; readonly ports: EnsureCodexPorts }): { readonly port: number } {
  const { paths, ports } = params;
  const deadline = ports.now() + CODEX_START_TIMEOUT_MS;
  let spawned = false;

  for (;;) {
    const state = readCodexState(ports.fs, paths.codexStateFile);
    if (state?.supervisorPid !== undefined && ports.isRunning(state.supervisorPid)) {
      if (state.port !== undefined && state.workerPid !== undefined && ports.isRunning(state.workerPid)) {
        writeSession(ports.fs, paths.codexSessionsDir, { pid: params.launcherPid, startedAt: ports.now() });
        return { port: state.port };
      }
      if (state.lastError !== undefined) {
        throw new CodexStartError(`claude-use: the codex daemon reported a fatal error and is not serving: ${state.lastError} (daemon log: ${paths.codexLogPath})`);
      }
    } else if (!spawned) {
      ports.fs.mkdirp(paths.codexDir);
      const created = ports.fs.writeFileExclusive(paths.codexLockFile, `${JSON.stringify({ pid: params.launcherPid, at: ports.now() } satisfies HeadroomLock)}\n`);
      if (created) {
        ports.spawnSupervisor(paths);
        spawned = true;
      } else {
        const lock = readStartLock(ports.fs, paths.codexLockFile);
        if (lock === undefined || !ports.isRunning(lock.pid)) {
          // A dead holder's lock is litter from a launcher that died before its supervisor could clear it.
          ports.fs.removeRecursive(paths.codexLockFile);
          continue;
        }
      }
    }

    if (ports.now() >= deadline) {
      const lastError = state?.lastError;
      throw new CodexStartError(
        `claude-use: the codex daemon did not become ready within ${String(CODEX_START_TIMEOUT_MS)}ms` +
          (lastError === undefined ? "" : ` (last error: ${lastError})`) +
          `. Daemon log: ${paths.codexLogPath}`,
      );
    }
    ports.sleep(CODEX_LAUNCHER_POLL_MS);
  }
}
