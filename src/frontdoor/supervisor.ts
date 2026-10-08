import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import type { DoorHealthPublisher } from "./doorHealthEvents";
import { FRONT_DOOR_PROTOCOL, listFrontDoorSessions, pruneDeadFrontDoorSessions, readFrontDoorState, writeFrontDoorState, type FrontDoorSessionSummary, type FrontDoorState } from "./state";

/** A bound front-door listener in this process, and how to stop it. */
interface FrontDoorListenerHandle {
  readonly port: number;
  /** Stops accepting, ends every live connection, and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

/**
 * The file identity of the executable this supervisor was spawned from, everything that distinguishes one installed binary from its replacement at the same path: `agent-shim update` installs by rename, so a newer release on disk is a different inode there, and the turnover check is a plain identity comparison rather than a version query (which would mean spawning a subprocess once per tick).
 */
export interface OwnExecutableStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
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
   * Starts the provider listener in this process on `preferredPort` (falling back to any free port when the sticky one is taken, decided at bind time rather than by a racy check-then-bind probe) and resolves once it has bound and answered its own health probe over TLS. This is the HTTPS listener every provider session's base URL points at, serving a loopback leaf signed by agent-shim's CA.
   */
  readonly startProviderListener: (preferredPort: number | undefined) => Promise<FrontDoorListenerHandle>;
  /**
   * Starts the CONNECT surface in this process on `preferredPort` (same bind-time fallback): the TLS-terminating listener an OAuth session's HTTPS_PROXY points at. Bound before any state names it, so an OAuth launch never finds one listener up without the other.
   */
  readonly startConnectListener: (preferredPort: number | undefined) => Promise<FrontDoorListenerHandle>;
  /**
   * Starts the direct listener on `preferredPort` (same bind-time fallback): the same routes as the provider listener, minus the headroom hop, over plain HTTP because headroom is what connects to it. Headroom forwards routed traffic back here, which is what keeps the hop from looping, and the port is sticky like the others because headroom's allowlist admits its exact origin. It admits only the hop's own requests and holds no credential until it redeems one from the hop's custody.
   */
  readonly startDirectListener: (preferredPort: number | undefined) => Promise<FrontDoorListenerHandle>;
  /**
   * Stops the Remote Control stream hub: persists every live attachment's sequence cursor synchronously, then frees the dials. Called exactly once on every exit the supervisor owns, after every listener it started is down (a live listener could still settle an observed Remote Control exchange, and the reconcile that follows would re-attach a stream the close had just ended) and before the final state write and the process's exit.
   */
  readonly closeRcStreamHub: () => void;
  /**
   * Reports one tick's session-registry facts to the door's event backbone: the sessions the tick's listing saw (taken before the prune, so a pruned launch's record is still there to name its start time) and the pids the tick's prune removed. The launch lifecycle publisher turns the diff between ticks into source-tagged events; the listing is also this loop's own idle input, so the two read one fact instead of two.
   */
  readonly observeLaunchRegistry: (sessions: readonly FrontDoorSessionSummary[], pruned: readonly number[]) => void;
  /**
   * Publishes the supervisor's own state transitions to the door's event backbone: the generation serving, a start failure that ends it, the binary turnover and the idle shutdown. Fed the moments the supervisor already lives through, published as they happen rather than at a tick, because these are process facts.
   */
  readonly doorHealth: DoorHealthPublisher;
  /**
   * Stats the executable this supervisor was spawned from, or undefined when it cannot be statted. The turnover check compares this against the stat taken when the door started serving: a replaced binary turns the door over at the first empty session registry, an unstatable one (missing, or mid-install between the removal and the rename) leaves the door alone rather than flapping on a half-applied update.
   */
  readonly statOwnExecutable: () => OwnExecutableStat | undefined;
  /**
   * Checks the expiring-quota windows against the clock, once per tick: the publisher holds the snapshots the usage source keeps fresh, so this costs arithmetic, never a file read.
   */
  readonly checkQuotaExpiry: () => void;
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
 * Runs the front-door supervisor: binds all three listeners (the HTTPS provider listener, the CONNECT surface and the plain-HTTP direct listener, each on its sticky port), records the serving state, and shuts down with an empty session registry, either at the first such tick after the executable it serves as has been replaced on disk (so an applied update reaches the door without waiting out the idle window) or after `idleShutdownMinutes` of it. Returns the exit code: 0 for either retirement, 1 for a fatal start failure.
 *
 * The listeners live in this process, so there is no child to keep alive: a crash of this process is a crash of every routed session's door at once, and recovery is the next launch's ensure spawning a replacement on the same sticky ports, which is exactly the failure model the issue asks to settle with tests. Keeping the headroom daemon alive is the headroom supervisor's job, not this one's; the two daemons idle out independently.
 */
export async function runFrontDoorSupervisor(idleShutdownMinutes: number, ports: FrontDoorSupervisorPorts, options: RunFrontDoorSupervisorOptions = {}): Promise<number> {
  const { fs, paths } = ports;
  const previous = readFrontDoorState(fs, paths.frontdoorStateFile);
  let lastPort = previous?.lastPort;
  let lastConnectPort = previous?.lastConnectPort;
  let lastDirectPort = previous?.lastDirectPort;
  /** The sticky addresses, attached to every state write so the next generation inherits them whatever else the write says. */
  const sticky = (): Pick<FrontDoorState, "lastPort" | "lastConnectPort" | "lastDirectPort"> => ({
    ...(lastPort === undefined ? {} : { lastPort }),
    ...(lastConnectPort === undefined ? {} : { lastConnectPort }),
    ...(lastDirectPort === undefined ? {} : { lastDirectPort }),
  });

  const fail = (message: string): number => {
    // A startup failure exits this process exactly as the idle shutdown does, so the hub's final cursor save belongs here too: a session whose frozen base URL still names the sticky port could have delivered an observed exchange between the first listener's bind and this failure, and its attachment would otherwise lose the one save the exit could still make.
    ports.closeRcStreamHub();
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastError: message, ...sticky() });
    fs.removeRecursive(paths.frontdoorLockFile);
    ports.log(`agent-shim frontdoor supervisor: ${message}`);
    return 1;
  };

  writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: ports.ownPid, ...sticky() });

  const previousSticky = lastPort;
  let http;
  try {
    http = await ports.startProviderListener(lastPort);
  } catch (error) {
    ports.doorHealth.listenerFailed("provider", error instanceof Error ? error.message : String(error));
    return fail(`could not start the provider listener: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousSticky !== undefined && http.port !== previousSticky) {
    ports.log(`agent-shim frontdoor supervisor: sticky port ${String(previousSticky)} was occupied; moving to ${String(http.port)} (sessions launched against the old port are stale until they relaunch)`);
  }
  lastPort = http.port;

  const previousStickyConnect = lastConnectPort;
  let connect;
  try {
    connect = await ports.startConnectListener(lastConnectPort);
  } catch (error) {
    await http.close();
    ports.doorHealth.listenerFailed("connect", error instanceof Error ? error.message : String(error));
    return fail(`could not start the CONNECT surface: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousStickyConnect !== undefined && connect.port !== previousStickyConnect) {
    ports.log(`agent-shim frontdoor supervisor: sticky CONNECT port ${String(previousStickyConnect)} was occupied; moving to ${String(connect.port)} (OAuth sessions launched against the old port are stale until they relaunch)`);
  }
  lastConnectPort = connect.port;

  const previousStickyDirect = lastDirectPort;
  let direct;
  try {
    direct = await ports.startDirectListener(lastDirectPort);
  } catch (error) {
    await connect.close();
    await http.close();
    ports.doorHealth.listenerFailed("direct", error instanceof Error ? error.message : String(error));
    return fail(`could not start the direct listener: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousStickyDirect !== undefined && direct.port !== previousStickyDirect) {
    ports.log(`agent-shim frontdoor supervisor: sticky direct port ${String(previousStickyDirect)} was occupied; moving to ${String(direct.port)} (headroom must be restarted to admit the new address)`);
  }
  lastDirectPort = direct.port;

  writeFrontDoorState(fs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: ports.ownPid, port: http.port, connectPort: connect.port, directPort: direct.port, ...sticky() });
  ports.doorHealth.generation({ providerPort: http.port, connectPort: connect.port, directPort: direct.port });
  // The start lock has done its job: state now names a live supervisor, so every future launcher finds it there instead.
  fs.removeRecursive(paths.frontdoorLockFile);
  ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: front door on 127.0.0.1:${String(http.port)}, CONNECT surface on 127.0.0.1:${String(connect.port)}`);

  let idleSince: number | undefined;
  let ticks = 0;
  // The binary identity this generation serves as, taken once the door is serving: a stat captured any earlier could name a binary that was replaced before the door ever accepted a session, and turning that over would retire a door nobody ever used. An unstatable executable at startup disables the turnover check for this generation rather than guessing.
  const servingBinary = ports.statOwnExecutable();
  const binaryReplaced = (): boolean => {
    const current = ports.statOwnExecutable();
    // A present-but-different stat is the turnover signal; an absent one (binary deleted, or mid-install between removal and rename) is not, so a half-applied update never flaps the door.
    return current !== undefined && servingBinary !== undefined && (current.dev !== servingBinary.dev || current.ino !== servingBinary.ino || current.size !== servingBinary.size || current.mtimeMs !== servingBinary.mtimeMs);
  };
  // The one graceful exit both retirements share: listeners down in the established order, the RC stream hub's cursor save last, sticky addresses preserved for the successor.
  const shutdown = async (): Promise<number> => {
    await direct.close();
    await connect.close();
    await http.close();
    // Last of the serving machinery to stop, and deliberately last: with every listener down no observed exchange can settle and re-attach a stream, so the hub's synchronous cursor persistence is the final word on every attachment before the process exits.
    ports.closeRcStreamHub();
    // The sticky addresses survive the shutdown so the next generation starts where this one served.
    writeFrontDoorState(fs, paths.frontdoorStateFile, sticky());
    return 0;
  };
  for (;;) {
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      return FRONTDOOR_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    // The listing precedes the prune so the launch lifecycle publisher sees each pruned launch's record with its start time; the prune's removals are handed to it beside the listing, and the idle decision reads the same listing minus those removals rather than listing again.
    const listed = listFrontDoorSessions(fs, paths.frontdoorSessionsDir);
    const pruned = pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, ports.isRunning);
    ports.observeLaunchRegistry(listed, pruned);
    ports.checkQuotaExpiry();
    const prunedPids = new Set(pruned);
    if (listed.filter((session) => !prunedPids.has(session.pid)).length === 0) {
      if (binaryReplaced()) {
        ports.log("agent-shim frontdoor supervisor: the installed binary changed and no sessions are live; turning the door over for the next launch");
        ports.doorHealth.binaryTurnover();
        return await shutdown();
      }
      idleSince ??= ports.now();
      if (ports.now() - idleSince >= idleShutdownMinutes * MS_PER_MINUTE) {
        ports.log(`agent-shim frontdoor supervisor: no sessions for ${String(idleShutdownMinutes)} minute(s); closing the front door and exiting`);
        ports.doorHealth.idleShutdown();
        return await shutdown();
      }
    } else {
      idleSince = undefined;
    }
    await ports.sleep(FRONTDOOR_POLL_MS);
  }
}
