import { HEADROOM_DEFAULT_IDLE_SHUTDOWN_MINUTES, HEADROOM_DEFAULT_SOURCE, type HeadroomGlobalConfig } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { frontDoorOrigin, readFrontDoorState } from "../frontdoor/state";
import { hashSettings, settingsOf, type HeadroomSettings } from "./settings";
import {
  hashAllowlist,
  headroomAllowlist,
  headroomUpstreams,
  pruneDeadSessions,
  readAllProviders,
  readHeadroomState,
  sessionsForSupervisor,
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
  /** Returns a free loopback port. Async because the only reliable way to reserve one is to bind and release a socket. */
  readonly freePort: () => Promise<number>;
  /** Whether nothing is currently listening on one specific loopback port: the check that decides whether the sticky `lastPort` can be reused. The same bind-and-release technique `freePort` uses, applied to a number the caller already cares about. */
  readonly isPortFree: (port: number) => Promise<boolean>;
  /**
   * Starts `headroom proxy` bound to `port` with the given allowlist, returning its pid. Output goes to the daemon log. The implementation must keep the ChildProcess handle and attach an exit listener (detaching the process is fine; unref'ing a child you still need events from is not, since without the listener nothing reaps it and it lingers as a zombie).
   */
  readonly spawnHeadroom: (port: number, allowlist: readonly string[], settings: Readonly<HeadroomSettings>) => number;
  /** Reads the headroom config block as it stands on disk now. The supervisor calls it every tick, so a changed `source` or setting is noticed while the daemon runs and applied by the same quiet-registry restart an allowlist change gets. */
  readonly readConfig: () => HeadroomSupervisorConfig;
  /** Stops a process the supervisor owns, escalating SIGTERM to SIGKILL on a bounded timeout (see `stopSupervisedProcess`). */
  readonly stopProcess: (pid: number) => void;
  /** True once `GET /readyz` on the port succeeds. */
  readonly ready: (port: number) => Promise<boolean>;
  /** Runs `uv tool install <spec>`, logging output to the daemon log. Returns ok=false with the error when `uv` is absent or the install fails. */
  readonly install: (spec: string) => { readonly ok: boolean; readonly error?: string };
  /** The installed `headroom --version` output, or undefined when the binary is not on PATH. */
  readonly headroomVersion: () => string | undefined;
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
/** The supervisor's own tick rate for crash detection, drift checks, and idle shutdown. */
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

  const previousState = readHeadroomState(fs, paths.headroomStateFile);
  if (
    previousState?.supervisorPid !== undefined &&
    previousState.supervisorPid !== ports.ownPid &&
    ports.isRunning(previousState.supervisorPid)
  ) {
    // Another live supervisor already keeps headroom up for every launch: a second daemon would only split the sessions, and "taking over" the state file would repoint new launches while the first supervisor keeps serving (and later rewriting) its own.
    ports.log(`claude-use headroom supervisor ${String(ports.ownPid)}: supervisor ${String(previousState.supervisorPid)} already owns the daemon; exiting`);
    return 0;
  }
  let installedSource = previousState?.installedSource;
  // The sticky address, inherited from the previous generation and updated on every successful start: even a fatal give-up keeps it, so the next generation starts where this one served.
  let lastPort = previousState?.lastPort;

  /** The sticky address, attached to every state write so the next generation inherits it whatever else the write says. */
  const sticky = (): Pick<HeadroomState, "lastPort"> => (lastPort === undefined ? {} : { lastPort });

  /**
   * Whether this supervisor may write state.json: no other live supervisor is recorded there. An absent file or a dead owner is claimable, so a deleted or stale file heals itself, and the loser of two simultaneous claims finds the winner's pid at its next write and stands down.
   */
  const ownsState = (): boolean => {
    const owner = readHeadroomState(fs, paths.headroomStateFile)?.supervisorPid;
    return owner === undefined || owner === ports.ownPid || !ports.isRunning(owner);
  };

  /**
   * Writes state.json unless another live supervisor owns it, returning whether it wrote. A superseded supervisor keeps serving the sessions it already has but must not overwrite the owner's record: state.json names the daemon new launches connect to, and a crash-restart here would repoint them at a daemon being drained.
   */
  const writeOwnState = (state: Readonly<HeadroomState>): boolean => {
    if (!ownsState()) {
      return false;
    }
    writeHeadroomState(fs, paths.headroomStateFile, state);
    return true;
  };

  const fail = (message: string): number => {
    if (writeOwnState({ lastError: message, ...sticky() })) {
      fs.removeRecursive(paths.headroomLockFile);
    }
    ports.log(`claude-use headroom supervisor: ${message}`);
    return 1;
  };

  /**
   * Installs headroom when the binary is missing, its version fails the configured source's specifier, or the configured source changed since the last install this supervisor performed. An absent `installedSource` with a satisfying binary does NOT install: a user's own `uv tool install headroom` is a legitimate install to respect.
   */
  const ensureInstalled = (): boolean => {
    const version = ports.headroomVersion();
    const versionOk = version !== undefined && versionSatisfies(version, config.source);
    if (versionOk && (installedSource === undefined || installedSource === config.source)) {
      // Adopting the satisfying install as this source's: an absent record with a healthy binary is a user's own install to respect, and recording it here is what stops every later tick reading as source drift.
      installedSource = config.source;
      return true;
    }
    ports.log(`claude-use headroom supervisor: installing headroom from ${config.source}`);
    const result = ports.install(config.source);
    if (!result.ok) {
      return false;
    }
    installedSource = config.source;
    return true;
  };

  if (!ensureInstalled()) {
    return fail(`could not install headroom from ${config.source}: install failed (is uv installed and on PATH?)`);
  }
  const version = ports.headroomVersion() ?? "unknown";

  // Fresh ownership: whatever came before, this supervisor is now the one keeping headroom alive. The sticky address is carried over so a new generation starts where the last one served.
  writeOwnState({ supervisorPid: ports.ownPid, version, installedSource, ...sticky() });
  ports.log(`claude-use headroom supervisor ${String(ports.ownPid)}: managing headroom on allowlist [${allowlistOf(ports).join(", ")}]`);

  const orphanPid = previousState?.headroomPid;
  if (orphanPid !== undefined && ports.isRunning(orphanPid)) {
    // A predecessor's daemon that outlived it (its supervisor died by a signal nothing could intercept, say) would keep squatting on its port forever: nothing supervises it, nothing idles it out. Take it over before starting its own.
    ports.log(`claude-use headroom supervisor: stopping daemon pid ${String(orphanPid)} left behind by the previous supervisor`);
    ports.stopProcess(orphanPid);
  }

  let headroomPid: number | undefined;
  let runningHash: string | undefined;
  let runningSettingsHash: string | undefined;
  let consecutiveFailures = 0;
  let idleSince: number | undefined;
  let superseded = false;
  let ticks = 0;

  for (;;) {
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      return HEADROOM_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    config = ports.readConfig();
    const settingsHash = hashSettings(config.settings);
    // Recomputed every tick: provider files can change on disk at any moment, and the allowlist is the daemon's whole security posture.
    const allowlist = allowlistOf(ports);
    const allowlistHash = hashAllowlist(allowlist);
    pruneDeadSessions(fs, paths.headroomSessionsDir, ports.isRunning);
    const ownsNow = ownsState();
    if (!ownsNow && !superseded) {
      ports.log("claude-use headroom supervisor: another supervisor now owns state.json; serving this daemon's own sessions until they end");
    }
    superseded = !ownsNow;

    const crashed = headroomPid !== undefined && !ports.isRunning(headroomPid);
    if (headroomPid === undefined || crashed) {
      if (crashed) {
        ports.log(`claude-use headroom supervisor: headroom pid ${String(headroomPid)} died`);
        headroomPid = undefined;
        runningHash = undefined;
        runningSettingsHash = undefined;
        // Clear the daemon fields immediately: until the replacement is ready, state must not claim a serving port for a process that just died, or `headroom status` and waiting launchers read a healthy daemon that no longer exists. The front door reads the port live and its headroom hop answers 502 until the daemon is back. `lastPort` stays, so the replacement restarts on the same address.
        writeOwnState({
          supervisorPid: ports.ownPid,
          version,
          installedSource,
          ...sticky(),
        });
      }
      if (consecutiveFailures >= HEADROOM_START_RETRY_BUDGET) {
        return fail(`headroom failed to become ready ${String(consecutiveFailures)} times in a row; giving up`);
      }
      // A plain crash-restart keeps the existing install; only a changed source needs another install pass.
      if (installedSource !== config.source && !ensureInstalled()) {
        return fail(`could not install headroom from ${config.source}: install failed (is uv installed and on PATH?)`);
      }
      // The address must stay stable across restarts: every live session's environment was frozen at launch with HEADROOM_PROXY_URL pointing at the daemon, so a restart that moves strands those sessions on a dead address for the rest of their lives. The sticky lastPort is reused whenever it is still free; only a genuinely occupied port justifies moving, and then the old sessions are unavoidably stale until they relaunch, which is why the move is logged.
      const previousSticky = lastPort;
      const port =
        lastPort !== undefined && (await ports.isPortFree(lastPort)) ? lastPort : await ports.freePort();
      const pid = ports.spawnHeadroom(port, allowlist, config.settings);
      const ready = await waitUntilReady(ports, port);
      if (ready) {
        consecutiveFailures = 0;
        headroomPid = pid;
        runningHash = allowlistHash;
        runningSettingsHash = settingsHash;
        lastPort = port;
        if (previousSticky !== undefined && port !== previousSticky) {
          ports.log(
            `claude-use headroom supervisor: sticky port ${String(previousSticky)} was occupied; moving to ${String(port)} (sessions launched against the old port are stale until they relaunch)`,
          );
        }
        const recorded = writeOwnState({
          supervisorPid: ports.ownPid,
          headroomPid: pid,
          port,
          version,
          allowlistHash,
          settingsHash,
          installedSource: config.source,
          ...sticky(),
        });
        if (recorded) {
          // The start lock has done its job: state now names a live supervisor, so every future launcher finds it there instead.
          fs.removeRecursive(paths.headroomLockFile);
        }
        idleSince = undefined;
        ports.log(`claude-use headroom supervisor: headroom pid ${String(pid)} ready on 127.0.0.1:${String(port)}`);
      } else {
        ports.stopProcess(pid);
        consecutiveFailures += 1;
        ports.log(
          `claude-use headroom supervisor: headroom did not become ready on port ${String(port)} ` +
            `(attempt ${String(consecutiveFailures)} of ${String(HEADROOM_START_RETRY_BUDGET)})`,
        );
        await ports.sleep(backoffForAttempt(consecutiveFailures));
        continue;
      }
    } else {
      // Running: drift first. A changed allowlist, install spec or setting means the daemon would run differently from what the configuration asks for, but restarting would cut off live sessions, so it waits until none is registered against this supervisor.
      if (runningHash !== allowlistHash || runningSettingsHash !== settingsHash || installedSource !== config.source) {
        if (sessionsForSupervisor(fs, paths.headroomSessionsDir, ports.ownPid).length === 0) {
          ports.log("claude-use headroom supervisor: configuration drifted and no sessions are live; restarting headroom");
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
            `claude-use headroom supervisor: no sessions for ${String(config.idleShutdownMinutes)} minute(s); stopping headroom and exiting`,
          );
          ports.stopProcess(headroomPid);
          // The sticky address survives the shutdown so the next generation starts where this one served. A superseded supervisor leaves the new owner's record alone.
          writeOwnState({
            version,
            ...sticky(),
          });
          return 0;
        }
      } else {
        idleSince = undefined;
      }
    }

    await ports.sleep(HEADROOM_POLL_MS);
  }
}

/** The allowlist as it stands right now: every provider's upstream (the front door's origin for a codex provider, which headroom forwards codex traffic back to) plus Claude Code's own API. */
export function currentHeadroomAllowlist(fs: HeadroomFs, paths: LayoutPaths): readonly string[] {
  const providers = readAllProviders(fs, paths.providersDir).map((entry) => entry.provider);
  return headroomAllowlist(headroomUpstreams(providers, frontDoorOrigin(readFrontDoorState(fs, paths.frontdoorStateFile))));
}

function allowlistOf(ports: SupervisorPorts): readonly string[] {
  return currentHeadroomAllowlist(ports.fs, ports.paths);
}

/** Polls `/readyz` until it answers or `HEADROOM_READY_TIMEOUT_MS` elapses. */
async function waitUntilReady(ports: SupervisorPorts, port: number): Promise<boolean> {
  const deadline = ports.now() + HEADROOM_READY_TIMEOUT_MS;
  for (;;) {
    if (await ports.ready(port)) {
      return true;
    }
    if (ports.now() >= deadline) {
      return false;
    }
    await ports.sleep(HEADROOM_POLL_MS);
  }
}
