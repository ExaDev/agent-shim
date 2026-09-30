import type { HeadroomFs } from "../headroom/state";
import { listSessions, pruneDeadSessions } from "../headroom/state";
import { backoffForAttempt, HEADROOM_START_RETRY_BUDGET } from "../headroom/supervisor";
import type { LayoutPaths } from "../paths";
import { readCodexState, writeCodexState, type CodexState } from "./state";

/** Every effect the codex supervisor performs, injected so its whole lifecycle runs against fakes: no real process, port, clock or HTTP call in a unit test. */
export interface CodexSupervisorPorts {
  readonly fs: HeadroomFs;
  readonly paths: LayoutPaths;
  readonly ownPid: number;
  readonly now: () => number;
  /** An event-loop-yielding wait, for the same reason headroom's is: the worker's exit event (which reaps it) is only delivered while the loop turns. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Zombie-aware liveness, exit-event-backed for a worker this supervisor spawned. */
  readonly isRunning: (pid: number) => boolean;
  readonly freePort: () => Promise<number>;
  readonly isPortFree: (port: number) => Promise<boolean>;
  /** Starts the translation worker listening on `port`, returning its pid. The implementation keeps the child handle and its exit listener, and detaches it from any terminal. */
  readonly spawnWorker: (port: number) => number;
  /** Stops a process this supervisor owns, escalating SIGTERM to SIGKILL. */
  readonly stopProcess: (pid: number) => void;
  /** True once `GET /healthz` on the port answers. */
  readonly ready: (port: number) => Promise<boolean>;
  readonly log: (line: string) => void;
}

/** Options for `runCodexSupervisor`. */
export interface RunCodexSupervisorOptions {
  /** Bounds the loop's iterations so a test can observe steady state; such a run returns `CODEX_SUPERVISOR_STILL_RUNNING`. */
  readonly tickLimit?: number;
}

/** Returned by a tick-bounded run that reached its limit while still supervising. Never an exit code. */
export const CODEX_SUPERVISOR_STILL_RUNNING = -1;

/** The supervisor's tick rate for crash detection and the idle clock. */
export const CODEX_POLL_MS = 1_000;

/** How long one started worker has to answer `/healthz`. The worker is this same binary binding one loopback port, so it answers within a tick or two unless something is broken. */
const CODEX_READY_TIMEOUT_MS = 10_000;


const MS_PER_MINUTE = 60_000;

/**
 * Runs the codex supervisor: starts the translation worker on the sticky port, restarts it (on the same port while it is free) when it dies, prunes sessions whose launcher pid is gone, and stops the worker and exits once no session has been live for `idleShutdownMinutes`. Returns the exit code: 0 for an idle shutdown, 1 for giving up.
 *
 * The worker runs as a separate process so that a crash in the translation path (anything from an uncaught error to the process being killed mid-stream) costs the sessions one failed request: this supervisor restarts it on the same address within a tick, and Claude Code's own retry reaches the replacement. A session's base URL is frozen at launch, which is why the address must not move.
 */
export async function runCodexSupervisor(idleShutdownMinutes: number, ports: CodexSupervisorPorts, options: RunCodexSupervisorOptions = {}): Promise<number> {
  const { fs, paths } = ports;
  const previous = readCodexState(fs, paths.codexStateFile);
  let lastPort = previous?.lastPort;
  const sticky = (): Pick<CodexState, "lastPort"> => (lastPort === undefined ? {} : { lastPort });

  // Consecutive failed starts before giving up: headroom's budget, for headroom's reason (a worker that cannot come up that many times in a row is broken, not unlucky).
  const fail = (message: string): number => {
    writeCodexState(fs, paths.codexStateFile, { lastError: message, ...sticky() });
    fs.removeRecursive(paths.codexLockFile);
    ports.log(`claude-use codex supervisor: ${message}`);
    return 1;
  };

  writeCodexState(fs, paths.codexStateFile, { supervisorPid: ports.ownPid, ...sticky() });
  const orphan = previous?.workerPid;
  if (orphan !== undefined && ports.isRunning(orphan)) {
    // A worker whose supervisor was killed outright keeps holding the sticky port; take it over so the replacement can start on the same address.
    ports.log(`claude-use codex supervisor: stopping worker pid ${String(orphan)} left behind by the previous supervisor`);
    ports.stopProcess(orphan);
  }

  let workerPid: number | undefined;
  let failures = 0;
  let idleSince: number | undefined;
  let ticks = 0;

  for (;;) {
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      return CODEX_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    pruneDeadSessions(fs, paths.codexSessionsDir, ports.isRunning);

    const crashed = workerPid !== undefined && !ports.isRunning(workerPid);
    if (workerPid === undefined || crashed) {
      if (crashed) {
        ports.log(`claude-use codex supervisor: worker pid ${String(workerPid)} died`);
        workerPid = undefined;
        // Until the replacement is ready, state must not name a serving port for a process that just died.
        writeCodexState(fs, paths.codexStateFile, { supervisorPid: ports.ownPid, ...sticky() });
      }
      if (failures >= HEADROOM_START_RETRY_BUDGET) {
        return fail(`the codex worker failed to become ready ${String(failures)} times in a row; giving up`);
      }
      const previousSticky = lastPort;
      const port = lastPort !== undefined && (await ports.isPortFree(lastPort)) ? lastPort : await ports.freePort();
      const pid = ports.spawnWorker(port);
      if (await waitUntilReady(ports, port)) {
        failures = 0;
        workerPid = pid;
        lastPort = port;
        if (previousSticky !== undefined && port !== previousSticky) {
          ports.log(
            `claude-use codex supervisor: sticky port ${String(previousSticky)} was occupied; moving to ${String(port)} (sessions launched against the old port are stale until they relaunch)`,
          );
        }
        writeCodexState(fs, paths.codexStateFile, { supervisorPid: ports.ownPid, workerPid: pid, port, ...sticky() });
        fs.removeRecursive(paths.codexLockFile);
        idleSince = undefined;
        ports.log(`claude-use codex supervisor: worker pid ${String(pid)} ready on 127.0.0.1:${String(port)}`);
      } else {
        ports.stopProcess(pid);
        failures += 1;
        ports.log(`claude-use codex supervisor: worker did not become ready on port ${String(port)} (attempt ${String(failures)} of ${String(HEADROOM_START_RETRY_BUDGET)})`);
        await ports.sleep(backoffForAttempt(failures));
        continue;
      }
    } else if (listSessions(fs, paths.codexSessionsDir).length === 0) {
      idleSince ??= ports.now();
      if (ports.now() - idleSince >= idleShutdownMinutes * MS_PER_MINUTE) {
        ports.log(`claude-use codex supervisor: no sessions for ${String(idleShutdownMinutes)} minute(s); stopping the worker and exiting`);
        ports.stopProcess(workerPid);
        writeCodexState(fs, paths.codexStateFile, sticky());
        return 0;
      }
    } else {
      idleSince = undefined;
    }

    await ports.sleep(CODEX_POLL_MS);
  }
}

async function waitUntilReady(ports: CodexSupervisorPorts, port: number): Promise<boolean> {
  const deadline = ports.now() + CODEX_READY_TIMEOUT_MS;
  for (;;) {
    if (await ports.ready(port)) {
      return true;
    }
    if (ports.now() >= deadline) {
      return false;
    }
    await ports.sleep(CODEX_POLL_MS);
  }
}
