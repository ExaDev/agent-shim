/**
 * Why a launcher asked a running front door to exit. A closed set, so a log line can be grouped by it and a new cause has to be named here before it can be sent:
 *
 * `restart-command` is `agent-shim frontdoor restart`; `update-restart` is the restart `agent-shim update --restart-door` makes after installing a new binary; `protocol-older` is a launch finding a door that speaks an older protocol than its own; `probe-failed-restart` is a restart that found the door not answering; `probe-failed-idle` is a launch that found the door not answering while no other session was registered against it.
 */
export const REPLACEMENT_REASONS = ["restart-command", "update-restart", "protocol-older", "probe-failed-restart", "probe-failed-idle"] as const;
export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

/** The reasons a caller may ask for a deliberate replacement with, as opposed to the ones a launch finds for itself. */
export type RequestedReplacementReason = Extract<ReplacementReason, "restart-command" | "update-restart">;

/** The signals a launcher sends a door: `SIGUSR2` asks it to hand its listeners to a successor it starts itself (see `./handover.ts`), `SIGTERM` asks it to exit, and `SIGKILL` is the escalation after the grace period. */
export type ReplacementSignal = "SIGUSR2" | "SIGTERM" | "SIGKILL";

/** What a launcher knows when it signals a door. Numbers and a closed-set reason only: nothing here can carry a credential, a path or a name. */
export interface ReplacementFacts {
  readonly reason: ReplacementReason;
  readonly signal: ReplacementSignal;
  readonly launcherPid: number;
  readonly launcherProtocol: number;
  readonly doorPid: number;
  /** The protocol the door recorded; 0 for a door from before the field existed. */
  readonly doorProtocol: number;
  /** Registered sessions other than the launcher's own that are running against this door: what the replacement cuts off. */
  readonly liveSessions: number;
}

/** The line a launcher appends to the door's log before it signals the door. `key=value` pairs, so it greps and splits without a parser. */
export function replacementLine(facts: ReplacementFacts): string {
  return `launcher ${String(facts.launcherPid)}: replacing front door; reason=${facts.reason} signal=${facts.signal} door=${String(facts.doorPid)} doorProtocol=${String(facts.doorProtocol)} launcherProtocol=${String(facts.launcherProtocol)} liveSessions=${String(facts.liveSessions)}`;
}

/** What a door knows about itself at the moment it is told to exit. */
export interface DoorExitFacts {
  /** Authenticated connections open on the CONNECT surface, blind tunnels and terminated sessions together: every one is dropped by the exit. */
  readonly tunnels: number;
  /** Registered sessions whose launcher is still running. */
  readonly liveSessions: number;
  readonly protocol: number;
  readonly uptimeSeconds: number;
}

/** The line a door appends when it receives its first signal and begins to retire, in the same `key=value` form as `replacementLine`. `tunnelsOpen` is what the door will keep running until it ends. */
export function retireLine(doorPid: number, signal: string, facts: DoorExitFacts): string {
  return `frontdoor ${String(doorPid)}: received ${signal}; retiring; tunnelsOpen=${String(facts.tunnels)} liveSessions=${String(facts.liveSessions)} protocol=${String(facts.protocol)} uptimeSeconds=${String(facts.uptimeSeconds)}`;
}

/** The line a door appends when an interrupt arrives while it is retiring and it exits at once, dropping what it was still carrying. */
export function exitNowLine(doorPid: number, facts: DoorExitFacts): string {
  return `frontdoor ${String(doorPid)}: received SIGINT again; exiting now; tunnelsDropped=${String(facts.tunnels)} liveSessions=${String(facts.liveSessions)}`;
}

/** The line a door appends when a further SIGTERM arrives while it is retiring and nothing changes. */
export function alreadyRetiringLine(doorPid: number): string {
  return `frontdoor ${String(doorPid)}: received SIGTERM again; already retiring`;
}

/** The line a door appends when it is asked to hand its listeners over, in the same `key=value` form as `retireLine`. */
export function handoverLine(doorPid: number, facts: DoorExitFacts): string {
  return `frontdoor ${String(doorPid)}: received SIGUSR2; handing the listeners to a successor; tunnelsOpen=${String(facts.tunnels)} liveSessions=${String(facts.liveSessions)} protocol=${String(facts.protocol)} uptimeSeconds=${String(facts.uptimeSeconds)}`;
}

/** The line a door appends when a further request to hand over arrives once it is already handing over or retiring, and nothing changes. */
export function alreadyHandingOverLine(doorPid: number): string {
  return `frontdoor ${String(doorPid)}: received SIGUSR2 again; already handing over or retiring`;
}

/** The part of a process this needs: a way to subscribe to a signal. */
interface SignalSource {
  readonly on: (signal: "SIGTERM" | "SIGINT" | "SIGUSR2", listener: () => void) => unknown;
}

/**
 * Makes the door hand its listeners to a successor on its first `SIGUSR2` (see `FrontDoorSupervisorPorts.handover`) and log any repeat without acting on it: two launchers that read the state file before the successor rewrote it each send one, and a second successor would only fail to take sockets the first already holds. The log line comes first, for the reason `retireOnSignals` gives.
 */
export function handOverOnSignal(source: SignalSource, params: { readonly doorPid: number; readonly facts: () => DoorExitFacts; readonly log: (line: string) => void; readonly handOver: () => void }): void {
  let requested = false;
  source.on("SIGUSR2", () => {
    if (requested) {
      params.log(alreadyHandingOverLine(params.doorPid));
      return;
    }
    requested = true;
    params.log(handoverLine(params.doorPid, params.facts()));
    params.handOver();
  });
}

/**
 * Makes the door retire on its first `SIGTERM` or `SIGINT`, ignore a repeated `SIGTERM`, and exit at once on a repeated `SIGINT`. Every signal logs first, because the log is the only record that outlives the process. `retire` starts the drain (see `FrontDoorSupervisorPorts.retire`). A repeated `SIGTERM` is not a request to stop faster: two launchers that read the state file before it changed each send one, and the second must not drop the tunnels the first let live. The explicit "now" is `SIGINT` (a person's second interrupt) or, for a door that never releases its addresses, the launcher's `SIGKILL`.
 */
export function retireOnSignals(source: SignalSource, params: { readonly doorPid: number; readonly facts: () => DoorExitFacts; readonly log: (line: string) => void; readonly retire: () => void; readonly exit: (code: number) => void }): void {
  let retiring = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    source.on(signal, () => {
      if (retiring && signal === "SIGTERM") {
        params.log(alreadyRetiringLine(params.doorPid));
        return;
      }
      if (retiring) {
        params.log(exitNowLine(params.doorPid, params.facts()));
        params.exit(0);
        return;
      }
      retiring = true;
      params.log(retireLine(params.doorPid, signal, params.facts()));
      params.retire();
    });
  }
}
