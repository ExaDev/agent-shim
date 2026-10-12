import type { DoctorSection, DoctorSeverity } from "./doctorReport";
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
