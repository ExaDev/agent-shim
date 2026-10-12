import { randomUUID } from "node:crypto";

import { CliError } from "../cliError";
import type { LayoutPaths } from "../paths";
import { readStartLock, type HeadroomFs, type HeadroomLock } from "../headroom/state";
import type { ListenerVerdict } from "./probe";
import { FRONT_DOOR_PROTOCOL, listFrontDoorSessions, readFrontDoorState, removeFrontDoorSession, writeFrontDoorSession } from "./state";

/** How long one launch waits for the front door. The listener is this same binary binding one loopback port, so a cold start takes a second or two; the bound only bites when something is genuinely broken. */
const FRONTDOOR_START_TIMEOUT_MS = 30_000;

/** The launcher's poll rate while waiting for the door. */
const FRONTDOOR_LAUNCHER_POLL_MS = 100;

/** How many times a listener that fails authentication is probed before it is believed. One failed probe is what a busy door looks like (sessions reattaching all at once miss the probe's own deadline), so a listener is distrusted only after consecutive failures: three misses in a row are a wedged or foreign listener, not slowness. */
const FRONTDOOR_PROBE_ATTEMPTS = 3;

/** How long a supervisor asked to exit gets before it is killed outright. A door that is not wedged closes its listeners and its stream hub within a few polls; one still running after this cannot be running its signal handler (its event loop is blocked), so waiting longer only spends the launch's deadline. */
const FRONTDOOR_EXIT_GRACE_MS = 5_000;

/** Raised when the front door cannot be brought up in time or has recorded a fatal error: a routed launch has no other way to reach its provider, so it must fail rather than start a session that can never answer. */
export class FrontDoorStartError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "FrontDoorStartError";
  }
}

/** Every effect the ensure step performs, injected so it runs against fakes in tests. */
export interface EnsureFrontDoorPorts {
  readonly fs: HeadroomFs;
  /** Zombie-aware liveness (see `realIsProcessRunning`). */
  readonly isRunning: (pid: number) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  /** Spawns the detached front-door supervisor, returning its pid. */
  readonly spawnSupervisor: (paths: LayoutPaths) => number;
  /** Authenticates the provider listener on `port`: a TLS handshake chaining to agent-shim's CA and a healthy answer, with no capability sent (see `probeFrontDoorSync`). */
  readonly verifyListener: (port: number) => ListenerVerdict;
  /** Asks a running front-door supervisor to exit, without waiting for it to: the caller polls `isRunning`. Only ever called for a pid whose recorded listener has just authenticated as agent-shim's own, or whose process is agent-shim's front-door supervisor (`isFrontDoorSupervisor`). */
  readonly stopSupervisor: (pid: number) => void;
  /** Ends a supervisor that did not exit when asked to, without giving it the chance to refuse: a door whose event loop is blocked never runs its signal handler. Called only for a pid `isFrontDoorSupervisor` has just confirmed, after `stopSupervisor` and a grace period. */
  readonly killSupervisor: (pid: number) => void;
  /** Whether `pid` is a live agent-shim front-door supervisor process, read from the process's own command line. This is what separates a wedged door of this tool, which a replacement must retire so the two never coexist, from an unrelated process that reuses the recorded pid, which must never be signalled. */
  readonly isFrontDoorSupervisor: (pid: number) => boolean;
}

/**
 * Brings the front door up for this launch, or finds it serving, and registers this launcher pid in its session registry: the fact that keeps the door from idling out while this session lives, and the record that holds this launch's capability token. The same lock-and-poll coordination as headroom's and the old codex daemon's ensure: the exclusive-create start lock decides which of several concurrent launches spawns the one supervisor, everyone waits on state.json, and a lock whose holder died is removed and retried. Ready means state names a live supervisor and both listeners' ports, which the supervisor writes only after both have bound (and the provider listener has answered its own health probe).
 *
 * A live pid in state proves nothing about who holds the port it names: the door may have crashed and left the port to anyone, or the pid may have been reused by an unrelated process. So before anything is registered or returned, the provider listener is authenticated over TLS against agent-shim's CA. A listener that fails (wrong certificate, nothing answering, a bad answer) is treated as a stale or hostile owner: its pid is distrusted for the rest of this call and a replacement supervisor is spawned, which binds a free port when the sticky one is held and is then verified in turn. If a supervisor this call spawned also fails verification, the launch is refused naming the reason and the daemon log; no capability is written and no address is handed to the child.
 */
export function ensureFrontDoor(params: {
  readonly paths: LayoutPaths;
  readonly launcherPid: number;
  readonly ports: EnsureFrontDoorPorts;
  /** Replaces a serving door whatever its protocol, once: the restart a binary update asks for, so the new generation serves the sessions already running without waiting for the registry to empty. */
  readonly replace?: boolean;
}): { readonly port: number; readonly connectPort: number; readonly token: string } {
  const { paths, ports } = params;
  const deadline = ports.now() + FRONTDOOR_START_TIMEOUT_MS;
  let spawned = false;
  let replaced = false;
  const distrusted = new Set<number>();
  let lastRejection: string | undefined;
  /** The door this launch is waiting on because it failed its probe while holding live sessions, for the deadline message. */
  let busyDoor: { readonly pid: number; readonly sessions: number } | undefined;

  /** How many registered launches other than this one are running against the door `doorPid`. A record from a release before `supervisorPid` was recorded cannot say which door it uses, so it counts for every door. */
  const liveSessionsOn = (doorPid: number): number =>
    listFrontDoorSessions(ports.fs, paths.frontdoorSessionsDir).filter(
      (session) => session.pid !== params.launcherPid && ports.isRunning(session.pid) && (session.supervisorPid === undefined || session.supervisorPid === doorPid),
    ).length;

  /** Probes the listener until it authenticates or `FRONTDOOR_PROBE_ATTEMPTS` consecutive probes have failed, returning the last verdict. */
  const verifyWithRetry = (port: number): ListenerVerdict => {
    let verdict = ports.verifyListener(port);
    for (let attempt = 1; !verdict.ok && attempt < FRONTDOOR_PROBE_ATTEMPTS; attempt += 1) {
      ports.sleep(FRONTDOOR_LAUNCHER_POLL_MS);
      verdict = ports.verifyListener(port);
    }
    return verdict;
  };

  /** Asks `supervisorPid` to exit and waits until it has, so the replacement that follows binds the sticky ports instead of moving off them. */
  const stopAndAwaitExit = (supervisorPid: number, failure: string): void => {
    ports.stopSupervisor(supervisorPid);
    const graceEnds = ports.now() + FRONTDOOR_EXIT_GRACE_MS;
    let killed = false;
    while (ports.isRunning(supervisorPid)) {
      if (!killed && ports.now() >= graceEnds) {
        ports.killSupervisor(supervisorPid);
        killed = true;
      }
      if (ports.now() >= deadline) {
        throw new FrontDoorStartError(`${failure}. Daemon log: ${paths.frontdoorLogPath}`);
      }
      ports.sleep(FRONTDOOR_LAUNCHER_POLL_MS);
    }
  };

  for (;;) {
    const state = readFrontDoorState(ports.fs, paths.frontdoorStateFile);
    const supervisorPid = state?.supervisorPid;
    if (supervisorPid !== undefined && !distrusted.has(supervisorPid) && ports.isRunning(supervisorPid)) {
      if (state?.port !== undefined && state.connectPort !== undefined) {
        if (supervisorPid === params.launcherPid && params.replace !== true) {
          // This process is the serving door: a launch planned inside it (the usage probe, the window opener, a job) has nothing to authenticate, and probing itself would block the very event loop that has to answer the probe, stalling every session on the door for the whole wait. It registers the launch like any other and returns its own addresses.
          const token = randomUUID();
          writeFrontDoorSession(ports.fs, paths.frontdoorSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), token, supervisorPid });
          return { port: state.port, connectPort: state.connectPort, token };
        }
        const verdict = verifyWithRetry(state.port);
        if (verdict.ok && !replaced && !spawned && (params.replace === true || (state.protocol ?? 0) < FRONT_DOOR_PROTOCOL)) {
          // A door older than this launcher speaks a protocol this launcher's sessions cannot use (a door from before the protocol field is protocol 0). It is replaced, never joined: the registry is on disk and the replacement binds the same sticky ports, so sessions already running reach it on the addresses they froze. The listener has authenticated as this tool's own, which is what makes the recorded pid safe to stop.
          stopAndAwaitExit(
            supervisorPid,
            `the front door (pid ${String(supervisorPid)}, protocol ${String(state.protocol ?? 0)}; this launcher speaks protocol ${String(FRONT_DOOR_PROTOCOL)}) was asked to be replaced and did not exit`,
          );
          replaced = true;
          continue;
        }
        if (verdict.ok) {
          // The token is generated here, per launch: the registry entry is what the door's listeners check requests against, and a fresh launch invalidates nothing (its entry is added alongside the live ones).
          const token = randomUUID();
          writeFrontDoorSession(ports.fs, paths.frontdoorSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), token, supervisorPid });
          return { port: state.port, connectPort: state.connectPort, token };
        }
        lastRejection = `the listener on 127.0.0.1:${String(state.port)} (recorded for pid ${String(supervisorPid)}) failed authentication: ${verdict.reason}`;
        if (spawned) {
          throw new FrontDoorStartError(`${lastRejection}; refusing to send this session's credentials to it. Daemon log: ${paths.frontdoorLogPath}`);
        }
        if (ports.isFrontDoorSupervisor(supervisorPid)) {
          const stranded = liveSessionsOn(supervisorPid);
          if (params.replace === true && !replaced) {
            // An explicit replace is the deliberate way to retire a door that is not answering, which is what a busy-door refusal tells the user to run: it must not be refused for the same reason.
            stopAndAwaitExit(supervisorPid, `the front door (pid ${String(supervisorPid)}) stopped answering and did not exit when asked to`);
            replaced = true;
            continue;
          }
          if (stranded > 0) {
            // A miss is what a busy door looks like, and this door has live sessions that retiring it would cut off (every connection and Remote Control stream drops), so it is waited on until this launch's own deadline and never signalled. Retiring on a miss turned a machine under load into a front door replaced again and again.
            busyDoor = { pid: supervisorPid, sessions: stranded };
          } else {
            // This tool's own door that no longer answers and holds no live session: leaving it running makes the replacement move every sticky port (the headroom allowlist then has to be rewritten for the moved direct origin before a provider launch through headroom can proceed) and strands whatever sessions still point at it. It is retired first, so the replacement binds the same ports. A pid that is not a front-door supervisor is only distrusted, never signalled.
            stopAndAwaitExit(supervisorPid, `the front door (pid ${String(supervisorPid)}) stopped answering and did not exit when asked to`);
            continue;
          }
        } else {
          distrusted.add(supervisorPid);
          continue;
        }
      }
      if (state?.lastError !== undefined) {
        throw new FrontDoorStartError(`the front door reported a fatal error and is not serving: ${state.lastError} (daemon log: ${paths.frontdoorLogPath})`);
      }
    } else if (!spawned) {
      ports.fs.mkdirp(paths.frontdoorDir);
      const created = ports.fs.writeFileExclusive(paths.frontdoorLockFile, `${JSON.stringify({ pid: params.launcherPid, at: ports.now() } satisfies HeadroomLock)}\n`);
      if (created) {
        ports.spawnSupervisor(paths);
        spawned = true;
      } else {
        const lock = readStartLock(ports.fs, paths.frontdoorLockFile);
        if (lock === undefined || !ports.isRunning(lock.pid)) {
          // A dead holder's lock is litter from a launcher that died before its supervisor could clear it.
          ports.fs.removeRecursive(paths.frontdoorLockFile);
          continue;
        }
      }
    }

    if (ports.now() >= deadline) {
      const lastError = state?.lastError;
      throw new FrontDoorStartError(
        `the front door did not become ready within ${String(FRONTDOOR_START_TIMEOUT_MS)}ms` +
          (lastError === undefined ? "" : ` (last error: ${lastError})`) +
          (lastRejection === undefined ? "" : ` (${lastRejection})`) +
          (busyDoor === undefined
            ? ""
            : `. It was not replaced because ${String(busyDoor.sessions)} live session(s) are using it and would lose their connections; run \`agent-shim frontdoor restart\` to replace it deliberately`) +
          `. Daemon log: ${paths.frontdoorLogPath}`,
      );
    }
    ports.sleep(FRONTDOOR_LAUNCHER_POLL_MS);
  }
}

/** The outcome of `restartFrontDoor`: `not-running` when no door was serving (nothing is started: a door exists only for sessions that need one), else the pid replaced and the pid now serving. */
export type RestartFrontDoorResult = { readonly action: "not-running" } | { readonly action: "restarted"; readonly previousPid: number; readonly pid: number };

/**
 * Replaces the serving front door in place: the running supervisor is asked to exit and a fresh one from the installed binary binds the same sticky ports, and the session registry is on disk, so every session already running reaches the new door on its next request. Requests in flight when the old door exits fail once, and Remote Control attachments resume from their persisted cursors.
 *
 * Nothing is started when no door is serving. The restart's own registry entry is removed again before returning, so it never keeps the new door awake.
 */
export function restartFrontDoor(params: { readonly paths: LayoutPaths; readonly pid: number; readonly ports: EnsureFrontDoorPorts }): RestartFrontDoorResult {
  const { paths, ports } = params;
  const previousPid = readFrontDoorState(ports.fs, paths.frontdoorStateFile)?.supervisorPid;
  if (previousPid === undefined || !ports.isRunning(previousPid)) {
    return { action: "not-running" };
  }
  try {
    ensureFrontDoor({ paths, launcherPid: params.pid, replace: true, ports });
  } finally {
    removeFrontDoorSession(ports.fs, paths.frontdoorSessionsDir, params.pid);
  }
  const pid = readFrontDoorState(ports.fs, paths.frontdoorStateFile)?.supervisorPid;
  if (pid === undefined) {
    throw new FrontDoorStartError(`the front door was replaced but its state records no supervisor. Daemon log: ${paths.frontdoorLogPath}`);
  }
  return { action: "restarted", previousPid, pid };
}
