/**
 * Why a launcher asked a running front door to exit. A closed set, so a log line can be grouped by it and a new cause has to be named here before it can be sent:
 *
 * `restart-command` is `agent-shim frontdoor restart`; `update-restart` is the restart `agent-shim update --restart-door` makes after installing a new binary; `protocol-older` is a launch finding a door that speaks an older protocol than its own; `probe-failed-restart` is a restart that found the door not answering; `probe-failed-idle` is a launch that found the door not answering while no other session was registered against it.
 */
export const REPLACEMENT_REASONS = ["restart-command", "update-restart", "protocol-older", "probe-failed-restart", "probe-failed-idle"] as const;
export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

/** The reasons a caller may ask for a deliberate replacement with, as opposed to the ones a launch finds for itself. */
export type RequestedReplacementReason = Extract<ReplacementReason, "restart-command" | "update-restart">;

/** What a launcher knows when it signals a door. Numbers and a closed-set reason only: nothing here can carry a credential, a path or a name. */
export interface ReplacementFacts {
  readonly reason: ReplacementReason;
  /** `SIGTERM` for the request to exit, `SIGKILL` for the escalation after the grace period. */
  readonly signal: "SIGTERM" | "SIGKILL";
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

/** The line a door appends when it receives a signal and exits, in the same `key=value` form as `replacementLine`. */
export function exitLine(doorPid: number, signal: string, facts: DoorExitFacts): string {
  return `frontdoor ${String(doorPid)}: received ${signal}; exiting; tunnelsDropped=${String(facts.tunnels)} liveSessions=${String(facts.liveSessions)} protocol=${String(facts.protocol)} uptimeSeconds=${String(facts.uptimeSeconds)}`;
}

/** The part of a process this needs: a way to subscribe to a signal. */
interface SignalSource {
  readonly on: (signal: "SIGTERM" | "SIGINT", listener: () => void) => unknown;
}

/** Makes the door log what it is dropping, then exit, on `SIGTERM` and `SIGINT`. The log line is written before the exit, because the line is the only record that outlives the process. */
export function exitLoggingOnSignals(source: SignalSource, params: { readonly doorPid: number; readonly facts: () => DoorExitFacts; readonly log: (line: string) => void; readonly exit: (code: number) => void }): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    source.on(signal, () => {
      params.log(exitLine(params.doorPid, signal, params.facts()));
      params.exit(0);
    });
  }
}
