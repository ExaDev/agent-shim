import { enterProcessRole } from "../processRole";
import type { DoorWatchdog } from "./watchdog";
import type net from "node:net";
import path from "node:path";

import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import type { DoorHealthPublisher } from "./doorHealthEvents";
import type { LiveSessionRegistry } from "./liveSessionRegistry";
import type { HandoverOutcome, HandoverSockets, ListenSource, Predecessor } from "./handover";
import { FRONT_DOOR_PROTOCOL, pruneDeadFrontDoorSessions, readFrontDoorState, removeFrontDoorDirectRecord, writeFrontDoorDirectRecord, writeFrontDoorState, type FrontDoorSessionSummary, type FrontDoorState, markFrontDoorDraining, unmarkFrontDoorDraining } from "./state";

/** A bound front-door listener in this process, and how to stop it. */
interface FrontDoorListenerHandle {
  readonly port: number;
  /** The listening socket itself, which a planned replacement hands to the successor door (see `./handover.ts`). */
  readonly listening: net.Server;
  /** Stops accepting, ends every live connection, and resolves once the port is released. */
  readonly close: () => Promise<void>;
  /** Releases the port at once (before the first await) and leaves the work already in progress to finish; resolves when the listener has nothing left to carry. */
  readonly drain: () => Promise<void>;
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

/**
 * The installed entry the door's turnover check watches: the resolved own-executable path when that entry is itself named `agent-shim` (with or without Windows' `.exe`), the `agent-shim` sibling beside it when one exists, and the own path otherwise. `agent-shim update` renames its verified bytes over the entry the updating process resolved, so a door spawned through another name (the `claude` hardlink `shim enable` maintains, or the legacy `claude-use` symlink) never sees its own exec'd file change, and the sibling beside it is the file the update replaces. The sibling is preferred only when it exists because the package's own layouts defeat the rule otherwise: a door started from the npm bundle resolves to `dist/cli.cjs`, whose sibling `dist/agent-shim.cjs` is never shipped, while `dist/cli.cjs` itself is exactly the file `npm install -g agent-shim@latest` replaces, so the own path is the right watch whenever no sibling answers.
 */
export function watchedInstallEntry(resolvedOwnExecutablePath: string, siblingExists: (candidate: string) => boolean): string {
  const parsed = path.parse(resolvedOwnExecutablePath);
  if (parsed.name === "agent-shim") {
    return resolvedOwnExecutablePath;
  }
  const sibling = path.join(parsed.dir, `agent-shim${parsed.ext}`);
  return siblingExists(sibling) ? sibling : resolvedOwnExecutablePath;
}

/** Every effect the front-door supervisor performs, injected so its whole lifecycle runs against fakes: no real process, port, clock or listener in a unit test. */
export interface FrontDoorSupervisorPorts {
  readonly fs: HeadroomFs;
  readonly paths: LayoutPaths;
  /**
   * The door's view of the session registry (see `LiveSessionRegistry`), shared with the listeners' admission check. The tick lists the registry through it, so the capabilities the listeners admit are refreshed by the read the tick makes anyway, and the launches the tick prunes are forgotten by it in the same tick.
   */
  readonly registry: LiveSessionRegistry;
  readonly ownPid: number;
  readonly now: () => number;
  /** An event-loop-yielding wait, for the same reason headroom's is: nothing else would ever run between ticks. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Zombie-aware liveness, the notion every coordination decision in this project uses. */
  readonly isRunning: (pid: number) => boolean;
  /**
   * Which of `pids` are running, by the same zombie-aware notion as `isRunning` but answered without blocking the event loop. Everything the supervisor asks while it serves goes through this: it asks about every registered session once a tick, and a synchronous process-table read per session would hold the loop that answers every session for as long as the machine took to run them.
   */
  readonly runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>;
  /**
   * Starts the provider listener in this process from `source`: bound on its preferred port (falling back to any free port when the sticky one is taken, decided at bind time rather than by a racy check-then-bind probe), or adopted from the door this one replaces. Resolves once it accepts and has answered its own health probe over TLS. This is the HTTPS listener every provider session's base URL points at, serving a loopback leaf signed by agent-shim's CA.
   */
  readonly startProviderListener: (source: ListenSource) => Promise<FrontDoorListenerHandle>;
  /**
   * Starts the CONNECT surface in this process from `source` (same bind-time fallback, or adopted): the TLS-terminating listener an OAuth session's HTTPS_PROXY points at. Bound before any state names it, so an OAuth launch never finds one listener up without the other.
   */
  readonly startConnectListener: (source: ListenSource) => Promise<FrontDoorListenerHandle>;
  /**
   * Starts the direct listener from `source` (same bind-time fallback, or adopted): the same routes as the provider listener, minus the headroom hop, over plain HTTP because headroom is what connects to it. Headroom forwards routed traffic back here, which is what keeps the hop from looping, and the port is sticky like the others because headroom's allowlist admits its exact origin. It admits only the hop's own requests and holds no credential until it redeems one from the hop's custody.
   */
  readonly startDirectListener: (source: ListenSource) => Promise<FrontDoorListenerHandle>;
  /**
   * Stops the Remote Control stream hub: persists every live attachment's sequence cursor synchronously, then frees the dials. Called exactly once on every exit the supervisor owns, after every listener has stopped accepting. A closing exit has every listener down by then; a drain still has responses settling, which is safe because the hub refuses to attach once it is closed (otherwise the reconcile after an observed exchange would re-attach a stream the close had just ended).
   */
  readonly closeRcStreamHub: () => void;
  /**
   * Starts the watchdog that ends this process when its main event loop stops running: it lives on its own thread, so a loop that is blocked cannot stall it. It beats from its own timer on the main loop rather than from the tick, so a tick waiting on a slow `ps` is never taken for a loop that stopped, and the supervisor stops it before it begins to retire, so it only ever judges a door that is meant to be serving. Optional because ending the process is only right when the process is the door: the CLI's `__frontdoor-supervisor` supplies it, and a library host that runs the door inside its own process does not get its application killed by default.
   */
  readonly startWatchdog?: () => DoorWatchdog;
  /**
   * Aborted when the process is asked to exit (the CLI's `__frontdoor-supervisor` aborts it on its first SIGTERM or SIGINT). The door then retires by draining: it releases its listening addresses at once, so a successor can bind the same sticky ports, ends what holds its own routing state, and stays up only as long as the connections it still carries (blind tunnels, a response being streamed) take to end. Optional for a host that decides when the door stops by other means.
   */
  readonly retire?: AbortSignal;
  /**
   * A planned replacement that keeps every address accepting (see `./handover.ts`): `requested` is aborted when a launcher asks this door to hand its listeners to a successor (the CLI's `__frontdoor-supervisor` aborts it on `SIGUSR2`), and `run` starts the successor, hands it the three listening sockets and resolves once it serves them or with why it did not. The door keeps accepting throughout and drains afterwards either way, so a failed handover still ends in the ordinary replacement. Optional because only a door whose process can start a successor of itself can offer it.
   */
  readonly handover?: { readonly requested: AbortSignal; readonly run: (sockets: HandoverSockets) => Promise<HandoverOutcome> };
  /**
   * The door this one replaces through a handover, when it was started for one: its listeners are adopted from that door's sockets instead of bound, the state file is not written until this door accepts on all three (the old door owns it and keeps serving until then), and the old door is told once this door serves. Absent for every other start.
   */
  readonly predecessor?: Predecessor;
  /** Stops the work the door runs on its own account rather than for a request (the usage, window, job and catalogue keepers), called once when a drain begins so the successor's are the only ones acting. Optional because a host without such work has nothing to stop. */
  readonly stopBackgroundWork?: () => void;
  /**
   * Reports one tick's session-registry facts to the door's event backbone: the sessions the tick's listing saw (taken before the prune, so a pruned launch's record is still there to name its start time) and the pids the tick's prune removed. The launch lifecycle publisher turns the diff between ticks into source-tagged events; the listing is also this loop's own idle input, so the two read one fact instead of two.
   */
  readonly observeLaunchRegistry: (sessions: readonly FrontDoorSessionSummary[], pruned: readonly number[]) => void;
  /**
   * Publishes the supervisor's own state transitions to the door's event backbone: the generation serving, a start failure that ends it, the binary turnover and the idle shutdown. Fed the moments the supervisor already lives through, published as they happen rather than at a tick, because these are process facts.
   */
  readonly doorHealth: DoorHealthPublisher;
  /**
   * Stats the installed entry the door's binary lives at (see `watchedInstallEntry`), or undefined when it cannot be statted. The turnover check compares this against the stat taken when the supervisor started: a replaced binary turns the door over at the first empty session registry, an unstatable one (a deleted binary, or a remove-then-link install between its removal and its relink) leaves the door alone rather than flapping on a half-applied install.
   */
  readonly statOwnExecutable: () => OwnExecutableStat | undefined;
  /**
   * Checks the expiring-quota windows against the clock, once per tick: the publisher holds the snapshots the usage source keeps fresh, so this costs arithmetic, never a file read.
   */
  readonly checkQuotaExpiry: () => void;
  readonly log: (line: string) => void;
}

/** How often `awaitPidExit` looks: short, because the stalled door is ended immediately after the replacement is started. */
const AWAIT_PID_POLL_MS = 50;

/**
 * Waits until `pid` is no longer running and returns how long that took. A door its watchdog replaced is started before the stalled one is ended, so it must not bind until the stalled one has released the sticky ports: a bind that found them held would take other ports and strand every session still pointing at the old ones. The wait has no bound of its own because the stalled door has been sent SIGKILL, so it ends as soon as the kernel finishes tearing the process down, which under heavy load can take longer than any fixed bound (a bound that elapsed first stranded every session). Only a process wedged in the kernel never exits, and it would hold the ports against any fallback as well.
 */
export async function awaitPidExit(pid: number, ports: Pick<FrontDoorSupervisorPorts, "isRunning" | "now" | "sleep">): Promise<number> {
  const startedAt = ports.now();
  while (ports.isRunning(pid)) {
    await ports.sleep(AWAIT_PID_POLL_MS);
  }
  return ports.now() - startedAt;
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
 * Runs the front-door supervisor: binds all three listeners (the HTTPS provider listener, the CONNECT surface and the plain-HTTP direct listener, each on its sticky port), records the serving state, and shuts down with an empty session registry, either at the first such tick after the executable it serves as has been replaced on disk (so an applied update reaches the door without waiting out the idle window) or after `idleShutdownMinutes` of it. A door whose state file comes to name another live supervisor is superseded: from then on it takes no new sessions, never writes the state file again, and exits as soon as the sessions it was serving have ended. Returns the exit code: 0 for any of these retirements, 1 for a fatal start failure.
 *
 * The listeners live in this process, so there is no child to keep alive: a crash of this process is a crash of every routed session's door at once, and recovery is the next launch's ensure spawning a replacement on the same sticky ports, which is exactly the failure model the issue asks to settle with tests. Keeping the headroom daemon alive is the headroom supervisor's job, not this one's; the two daemons idle out independently.
 */
export async function runFrontDoorSupervisor(idleShutdownMinutes: number, ports: FrontDoorSupervisorPorts, options: RunFrontDoorSupervisorOptions = {}): Promise<number> {
  // From here this process's event loop answers every session, so nothing in it may block the thread (see `refuseToBlockInRole`). Left again on return, which only an in-process host or a test ever reaches.
  const leaveRole = enterProcessRole("frontdoor-supervisor");
  try {
    return await serveFrontDoor(idleShutdownMinutes, ports, options);
  } finally {
    leaveRole();
  }
}

/** The supervisor's body, run by `runFrontDoorSupervisor` inside the front door's process role. */
async function serveFrontDoor(idleShutdownMinutes: number, ports: FrontDoorSupervisorPorts, options: RunFrontDoorSupervisorOptions): Promise<number> {
  const { fs, paths } = ports;
  // The binary identity this generation serves as, taken before any listener binds so an update landing during the door's own startup (CA load, binds, probes) is still a turnover for this generation rather than captured as the new normal. The turnover decision itself additionally waits for the second tick, because the launch that ensured this door writes its session record a few hundred milliseconds after the bind, and a door retiring on tick one would close its listeners under that launch's probe and refuse it outright.
  const servingBinary = ports.statOwnExecutable();
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

  const { predecessor } = ports;
  /** Where each listener comes from: the old door's socket when this door replaces it by a handover, else a bind on its sticky port. */
  const sourceOf = (listener: "provider" | "connect" | "direct", preferredPort: number | undefined): ListenSource =>
    predecessor === undefined ? { preferredPort } : { inherit: async () => await predecessor.take(listener) };

  const fail = (message: string): number => {
    // A startup failure exits this process exactly as the idle shutdown does, so the hub's final cursor save belongs here too: a session whose frozen base URL still names the sticky port could have delivered an observed exchange between the first listener's bind and this failure, and its attachment would otherwise lose the one save the exit could still make.
    ports.closeRcStreamHub();
    // A successor that fails leaves the state file and the start lock alone: the door it was replacing still owns the one and serves every address, and the other belongs to whichever launcher holds it.
    if (predecessor === undefined) {
      writeFrontDoorState(fs, paths.frontdoorStateFile, { lastError: message, ...sticky() });
      fs.removeRecursive(paths.frontdoorLockFile);
    }
    ports.log(`agent-shim frontdoor supervisor: ${message}`);
    return 1;
  };

  // Claimed before the binds so concurrent launches wait on this start rather than spawning another. A successor makes no such claim: the door it replaces is still the owner, serving the same addresses, until this one serves them too.
  if (predecessor === undefined) {
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: ports.ownPid, ...sticky() });
  }

  const previousSticky = lastPort;
  let http;
  try {
    http = await ports.startProviderListener(sourceOf("provider", lastPort));
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
    connect = await ports.startConnectListener(sourceOf("connect", lastConnectPort));
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
    direct = await ports.startDirectListener(sourceOf("direct", lastDirectPort));
  } catch (error) {
    await connect.close();
    await http.close();
    ports.doorHealth.listenerFailed("direct", error instanceof Error ? error.message : String(error));
    return fail(`could not start the direct listener: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousStickyDirect !== undefined && direct.port !== previousStickyDirect) {
    ports.log(`agent-shim frontdoor supervisor: sticky direct port ${String(previousStickyDirect)} was occupied; moving to ${String(direct.port)} (headroom admits the new address once its supervisor rewrites the allowlist file)`);
  }
  lastDirectPort = direct.port;
  // Recorded under this door's own pid before launches can be sent here, and kept until this door exits: headroom must keep admitting this door's direct origin for as long as any of its sessions can route through it, including after another door supersedes it in `state.json`.
  writeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, { pid: ports.ownPid, directPort: direct.port });

  writeFrontDoorState(fs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: ports.ownPid, port: http.port, connectPort: connect.port, directPort: direct.port, ...sticky() });
  ports.doorHealth.generation({ providerPort: http.port, connectPort: connect.port, directPort: direct.port });
  if (predecessor === undefined) {
    // The start lock has done its job: state now names a live supervisor, so every future launcher finds it there instead.
    fs.removeRecursive(paths.frontdoorLockFile);
  } else {
    // The state file names this door from the write above, so the old door, told it may stop accepting, finds a live owner and leaves the record as written.
    predecessor.serving();
  }
  ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: front door on 127.0.0.1:${String(http.port)}, CONNECT surface on 127.0.0.1:${String(connect.port)}${predecessor === undefined ? "" : ", taken over from the door it replaced"}`);

  // Started only now that every listener is bound and the serving state is written, so the watchdog never judges a door that is still starting, and stopped by `closeServing` before any retirement begins.
  const watchdog = ports.startWatchdog?.();

  let idleSince: number | undefined;
  let ticks = 0;
  /**
   * The live supervisor the state file names in place of this one, or undefined while this door is still the one launches are sent to. An absent or unreadable record, this door's own pid and a dead owner all leave the door serving as the owner, the same claimability the headroom supervisor's ownership check applies: nothing serves at a dead owner's addresses, so it supersedes nobody.
   */
  const supersedingOwner = async (): Promise<number | undefined> => {
    const owner = readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid;
    return owner !== undefined && owner !== ports.ownPid && (await ports.runningAmong([owner])).has(owner) ? owner : undefined;
  };
  // Set on the tick that first sees another live owner, and never cleared: from that moment launches are sent to the owner's addresses, and should that owner die, the next launch's ensure brings up a fresh door rather than returning to this one, which no longer appears in the state file.
  let supersededBy: number | undefined;
  // The sessions this superseded door still serves, captured one tick after the supersession is noticed, so a launch that read the state just before the owner rewrote it has registered by then (the same one-tick allowance the first tick's turnover grace gives the ensuring launch). Counting a launch made against the new owner in that tick only keeps this door up until that launch ends; leaving out one made against this door would close the listeners its child still points at.
  let served: readonly FrontDoorSessionSummary[] | undefined;
  const binaryReplaced = (): boolean => {
    const current = ports.statOwnExecutable();
    // A present-but-different stat is the turnover signal; an absent one (a deleted binary, or a remove-then-link install between its removal and its relink) is not, and a stat returning to the exact captured identity after such a window is equally not, so a half-applied install never flaps the door.
    return current !== undefined && servingBinary !== undefined && (current.dev !== servingBinary.dev || current.ino !== servingBinary.ino || current.size !== servingBinary.size || current.mtimeMs !== servingBinary.mtimeMs);
  };
  /** The tick's wait, cut short by a request to retire so the listeners are released straight away rather than at the next tick. The abort listener lives only as long as the wait: one shared promise raced against every tick's sleep would keep a reaction per tick for as long as the door serves. */
  const pause = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        resolve();
      };
      ports.retire?.addEventListener("abort", wake, { once: true });
      ports.handover?.requested.addEventListener("abort", wake, { once: true });
      void ports.sleep(FRONTDOOR_POLL_MS).then(() => {
        ports.retire?.removeEventListener("abort", wake);
        ports.handover?.requested.removeEventListener("abort", wake);
        resolve();
      });
    });
  };
  // The retirement a request to exit asks for, in place of `closeServing`: every address is released first, before anything slow, then the state file stops naming this door as the owner so a launch starts a successor on those addresses instead of joining a door that no longer accepts, and the process lives on only for what its listeners still carry. The stream hub is closed once the listeners stop accepting; it refuses to attach again, so a response that settles during the drain cannot start a stream that the successor also attaches.
  const retireByDrain = async (): Promise<number> => {
    ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: releasing the front door's addresses and finishing the connections it carries`);
    watchdog?.stop();
    // The successor's keepers take over: a draining door that kept running its own would act on the same usage stamps, windows and jobs beside them.
    ports.stopBackgroundWork?.();
    const drained = [direct.drain(), connect.drain(), http.drain()];
    if ((await supersedingOwner()) === undefined) {
      writeFrontDoorState(fs, paths.frontdoorStateFile, sticky());
    }
    markFrontDoorDraining(fs, paths.frontdoorDrainingDir, ports.ownPid);
    ports.closeRcStreamHub();
    await Promise.all(drained);
    unmarkFrontDoorDraining(fs, paths.frontdoorDrainingDir, ports.ownPid);
    removeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, ports.ownPid);
    ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: the connections this door carried have ended; exiting`);
    return 0;
  };
  // The planned replacement that keeps every address accepting: the successor takes the listening sockets while this door still accepts on them, so a connection made at any moment of the swap is queued on a socket one of the two doors is serving, and only then does this door drain. A handover that fails is logged and ends in the same drain, which clears the state file's owner so the launcher waiting on it starts a successor the ordinary way.
  const handOverThenDrain = async (run: (sockets: HandoverSockets) => Promise<HandoverOutcome>): Promise<number> => {
    ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: asked to hand the front door's listeners to a successor; accepting on them until it serves`);
    const outcome = await run({ provider: http.listening, connect: connect.listening, direct: direct.listening });
    if (outcome.ok) {
      ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: successor ${String(outcome.successorPid)} serves the front door's listeners`);
      ports.doorHealth.superseded(outcome.successorPid);
    } else {
      ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: the handover failed (${outcome.reason}); retiring by drain so a successor is started on the released addresses`);
    }
    return await retireByDrain();
  };
  // The graceful stop every retirement shares: listeners down in the established order, the RC stream hub's cursor save last.
  const closeServing = async (): Promise<void> => {
    watchdog?.stop();
    await direct.close();
    await connect.close();
    await http.close();
    // Last of the serving machinery to stop, and deliberately last: with every listener down no observed exchange can settle and re-attach a stream, so the hub's synchronous cursor persistence is the final word on every attachment before the process exits.
    ports.closeRcStreamHub();
    // Nothing can route through this door's direct listener any more, so headroom may stop admitting its origin.
    removeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, ports.ownPid);
  };
  // The owner's retirement: the serving machinery stopped, then the sticky addresses written so the next generation starts where this one served, unless another live supervisor has claimed the state file since this tick looked, whose record is never rewritten.
  const shutdown = async (): Promise<number> => {
    await closeServing();
    if ((await supersedingOwner()) === undefined) {
      writeFrontDoorState(fs, paths.frontdoorStateFile, sticky());
    }
    return 0;
  };
  for (;;) {
    if (ports.retire?.aborted === true) {
      ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: asked to exit`);
      return await retireByDrain();
    }
    // Only the owner hands over: a superseded door no longer serves the addresses launches are sent to, so a request reaching it has nothing to hand.
    if (ports.handover?.requested.aborted === true && supersededBy === undefined) {
      return await handOverThenDrain(ports.handover.run);
    }
    if (options.tickLimit !== undefined && ticks >= options.tickLimit) {
      watchdog?.stop();
      return FRONTDOOR_SUPERVISOR_STILL_RUNNING;
    }
    ticks += 1;
    // The listing precedes the prune so the launch lifecycle publisher sees each pruned launch's record with its start time; the prune's removals are handed to it beside the listing, and the idle decision reads the same listing minus those removals rather than listing again.
    const listed = ports.registry.rescan();
    const running = await ports.runningAmong(listed.map((session) => session.pid));
    const pruned = pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, listed, (pid) => running.has(pid));
    // Synchronous with the prune above, so a pruned launch's capability is refused from the next request on, not from the next tick.
    ports.registry.forget(pruned);
    ports.observeLaunchRegistry(listed, pruned);
    ports.checkQuotaExpiry();
    const prunedPids = new Set(pruned);
    const live = listed.filter((session) => !prunedPids.has(session.pid));
    if (supersededBy === undefined) {
      supersededBy = await supersedingOwner();
      if (supersededBy !== undefined) {
        ports.log(`agent-shim frontdoor supervisor ${String(ports.ownPid)}: supervisor ${String(supersededBy)} now owns the front door; taking no new sessions and exiting once the sessions this door serves have ended`);
        ports.doorHealth.superseded(supersededBy);
        await pause();
        continue;
      }
    } else {
      const owner = supersededBy;
      // Records keyed by a door's own pid are the sessions a transparent surface mints for itself, living exactly as long as that door does: neither this door's nor the owner's is a launch this door serves.
      // A launch records the supervisor of the door it was sent to, so one sent to the owner is not this door's to wait for; a record with no attribution is counted as this door's, since leaving it out could close listeners a session still points at.
      // A served session is matched by pid and start time together, so a later launch that reuses an ended launcher's pid is not mistaken for it.
      served = (served ?? live.filter((session) => session.pid !== ports.ownPid && session.pid !== owner && (session.supervisorPid === undefined || session.supervisorPid === ports.ownPid))).filter((own) => live.some((session) => session.pid === own.pid && session.startedAt === own.startedAt));
      if (served.length === 0) {
        ports.log("agent-shim frontdoor supervisor: the sessions this superseded door served have ended; closing the front door and exiting");
        ports.doorHealth.drained();
        // No state write: the file names the owner, and this door's sticky addresses are not the owner's to inherit.
        await closeServing();
        return 0;
      }
      await pause();
      continue;
    }
    if (live.length === 0) {
      // The first tick never retires the door: the ensuring launch's session record lands shortly after the bind (see the capture comment above), and this grace is what lets a startup-window update turn over on tick two with the record already in place.
      if (ticks > 1 && binaryReplaced()) {
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
    await pause();
  }
}
