import type { DoctorSection, DoctorSeverity } from "./doctorReport";
import type { FrontDoorListenerReading } from "./frontdoor/listenerReadings";
import type { FrontDoorSessionSummary } from "./frontdoor/state";
import type { FrontDoorSupervisorListing } from "./frontdoor/supervisorProcesses";

/**
 * Reports front-door supervisors alive at once. A door superseded by the one state.json names keeps serving the launches registered against it and exits once they end, which is expected, so it is a `warn` saying so. Any other supervisor beside the one state.json names (serving no registered launch) is a `fail` carrying the command that stops it: it moves the sticky ports the serving door's launches froze and serves nothing. The report only names that command: stopping a supervisor cuts off the launches still connected to it, so it is the reader's call.
 *
 * `registeredPid` is the supervisor state.json names, or undefined when the file is absent or unreadable; `liveSessions` are the launches registered with the front door whose launcher is still running.
 */
export function pushFrontDoor(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  supervisors: FrontDoorSupervisorListing,
  registeredPid: number | undefined,
  liveSessions: readonly FrontDoorSessionSummary[],
): void {
  if (!supervisors.ok) {
    push("frontdoor", "warn", `Could not list processes to look for duplicate front door supervisors: ${supervisors.message}.`);
    return;
  }
  const { pids } = supervisors;
  if (pids.length === 0) {
    push("frontdoor", "pass", "No front door supervisor is running.");
    return;
  }
  const [only, ...rest] = pids;
  if (only !== undefined && rest.length === 0) {
    push("frontdoor", "pass", `One front door supervisor is running (pid ${String(only)}).`);
    return;
  }
  const serving =
    registeredPid !== undefined && pids.includes(registeredPid)
      ? `The front door state file names pid ${String(registeredPid)} as the serving supervisor.`
      : "The front door state file names no running supervisor.";
  for (const pid of pids.filter((candidate) => candidate !== registeredPid)) {
    const served = liveSessions.filter((session) => session.supervisorPid === pid).length;
    if (registeredPid !== undefined && pids.includes(registeredPid) && served > 0) {
      push(
        "frontdoor",
        "warn",
        `Front door supervisor pid ${String(pid)} has been superseded by pid ${String(registeredPid)} and still serves ${String(served)} launch${served === 1 ? "" : "es"} registered against it; it exits once they end.`,
        String(pid),
      );
      continue;
    }
    push(
      "frontdoor",
      "fail",
      `Front door supervisor pid ${String(pid)} is running beside ${String(pids.length - 1)} other(s). ${serving} ` +
        `Stop it with \`kill ${String(pid)}\`; launches still connected to it lose their door.`,
      String(pid),
    );
  }
}

/** The sessions each listener carries, named in a finding so a person can tell which of their sessions a failing listener cuts off. */
const LISTENER_ROUTES: Readonly<Record<FrontDoorListenerReading["listener"], string>> = {
  provider: "provider sessions (`z`, `m` and the like)",
  connect: "every plain OAuth session, which reaches Anthropic through it",
};

/**
 * Reports whether each listener of the serving door accepts, which a live supervisor pid cannot say: a door whose event loop is blocked is alive and accepts nothing. A listener that does not accept within the probe's bound fails the check and names the sessions it cuts off; one that does is a pass that states how long it took on this machine now, as an observation, not a threshold.
 */
export function pushFrontDoorListeners(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  readings: readonly FrontDoorListenerReading[],
): void {
  for (const reading of readings) {
    const where = `127.0.0.1:${String(reading.port)}`;
    if (reading.ok) {
      push("frontdoor", "pass", `The front door's ${reading.listener} listener on ${where} accepted a probe in ${String(Math.round(reading.elapsedMs))} ms.`, reading.listener);
      continue;
    }
    push(
      "frontdoor",
      "fail",
      `The front door's ${reading.listener} listener on ${where} did not accept a probe${reading.reason === undefined ? "" : ` (${reading.reason})`}, so ${LISTENER_ROUTES[reading.listener]} cannot get through while it stays like this. ` +
        "The supervisor is alive but is not serving: `agent-shim frontdoor restart` replaces it.",
      reading.listener,
    );
  }
}
