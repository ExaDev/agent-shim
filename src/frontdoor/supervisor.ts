import type { HeadroomFs } from "../headroom/state";
import { listSessions, pruneDeadSessions } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { readFrontDoorState, writeFrontDoorState, type FrontDoorState } from "./state";

/** A bound front-door listener in this process, and how to stop it. */
interface FrontDoorListenerHandle {
  readonly port: number;
  /** Stops accepting, ends every live connection, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/** Every effect the front-door supervisor performs, injected so its whole lifecycle runs against fakes: no real process, port, clock or listener in a unit test. */
export interface FrontDoorSupervisorPorts {
  readonly fs: HeadroomFs;
  readonly paths: LayoutPaths;
  readonly ownPid: number;
  readonly now: () => number;
  /** An event-loop-yielding wait, for the same reason headroom's is: nothing else would ever run between ticks. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Zombie-aware liveness, the notion every coordination decision in this project uses. */
  readonly isRunning: (pid: number) => boolean;
  /**
   * Starts the front-door listener in this process on `preferredPort` (falling back to any free port when the sticky one is taken, decided at bind time rather than by a racy check-then-bind probe) and resolves once it has bound and answered its health probe. Everything the routed pipeline needs travels in here, resolved by the caller: this supervisor owns the lifecycle, not the routing.
   */
  readonly startListener: (preferredPort: number | undefined) => Promise<FrontDoorListenerHandle>;
  readonly log: (line: string) => void;
}

/** Options for `runFrontDoorSupervisor`. */
export interface RunFrontDoorSupervisorOptions {
  /** Bounds the loop's iterations so a test can observe steady state; such a run returns `FRONTDOOR_SUPERVISOR_STILL_RUNNING`. */
  readonly tickLimit?: number;
}

/** Returned by a tick-bounded run that reached its limit while still serving. Never an exit code. */
export const FRONTDOOR_SUPERVISOR_STILL_RUNNING = -1;

/** The supervisor's tick rate for the idle clock. */
export const FRONTDOOR_POLL_MS = 1_000;

const MS_PER_MINUTE = 60_000;

/**
 * Runs the front-door supervisor: binds the listener on the sticky port (the address every routed session's base URL was frozen at, which is why it must not move), records the serving state, and shuts down after `idleShutdownMinutes` with an empty session registry. Returns the exit code: 0 for an idle shutdown, 1 for a fatal start failure.
 *
 * The listener lives in this process, so there is no child to keep alive: a crash of this process is a crash of every routed session's door at once, and recovery is the next launch's ensure spawning a replacement on the same sticky port, which is exactly the failure model the issue asks to settle with tests. Keeping the headroom daemon alive is the headroom supervisor's job, not this one's; the two daemons idle out independently.
 */
export async function runFrontDoorSupervisor(idleShutdownMinutes: number, ports: FrontDoorSupervisorPorts, options: RunFrontDoorSupervisorOptions = {}): Promise<number> {
  const { fs, paths } = ports;
  const previous = readFrontDoorState(fs, paths.frontdoorStateFile);
  let lastPort = previous?.lastPort;
  const sticky = (): Pick<FrontDoorState, "lastPort"> => (lastPort === undefined ? {} : { lastPort });

  const fail = (message: string): number => {
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastError: message, ...sticky() });
    fs.removeRecursive(paths.frontdoorLockFile);
    ports.log(`claude-use frontdoor supervisor: ${message}`);
    return 1;
  };

  writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: ports.ownPid, ...sticky() });

  const previousSticky = lastPort;
  let listener;
  try {
    listener = await ports.startListener(lastPort);
  } catch (error) {
    return fail(`could not start the front-door listener: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousSticky !== undefined && listener.port !== previousSticky) {
    ports.log(`claude-use frontdoor supervisor: sticky port ${String(previousSticky)} was occupied; moving to ${String(listener.port)} (sessions launched against the old port are stale until they relaunch)`);
  }
  lastPort = listener.port;
  writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: ports.ownPid, port: listener.port, ...sticky() });
  // The start lock has done its job: state now names a live supervisor, so every future launcher finds it there instead.
  fs.removeRecursive(paths.frontdoorLockFile);
  ports.log(`claude-use frontdoor supervisor ${String(ports.ownPid)}: front door listening on 127.0.0.1:${String(listener.port)}`);

  let idleSince: number | undefined;
  let ticks = 0;
  for (;;) {
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      return FRONTDOOR_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    pruneDeadSessions(fs, paths.frontdoorSessionsDir, ports.isRunning);
    if (listSessions(fs, paths.frontdoorSessionsDir).length === 0) {
      idleSince ??= ports.now();
      if (ports.now() - idleSince >= idleShutdownMinutes * MS_PER_MINUTE) {
        ports.log(`claude-use frontdoor supervisor: no sessions for ${String(idleShutdownMinutes)} minute(s); closing the front door and exiting`);
        await listener.close();
        // The sticky address survives the shutdown so the next generation starts where this one served.
        writeFrontDoorState(fs, paths.frontdoorStateFile, sticky());
        return 0;
      }
    } else {
      idleSince = undefined;
    }
    await ports.sleep(FRONTDOOR_POLL_MS);
  }
}
