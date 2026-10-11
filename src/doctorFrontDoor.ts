import type { DoctorSection, DoctorSeverity } from "./doctorReport";
import type { FrontDoorSupervisorListing } from "./frontdoor/supervisorProcesses";

/**
 * Reports front-door supervisors alive at once. A superseded supervisor keeps listening on its own addresses for the launches already connected to it, and moves the sticky ports the serving door's launches froze, so each supervisor other than the one state.json names is a `fail` carrying the command that stops it. The report only names that command: stopping a supervisor cuts off the launches still connected to it, so it is the reader's call.
 *
 * `registeredPid` is the supervisor state.json names, or undefined when the file is absent or unreadable.
 */
export function pushFrontDoor(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  supervisors: FrontDoorSupervisorListing,
  registeredPid: number | undefined,
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
    push(
      "frontdoor",
      "fail",
      `Front door supervisor pid ${String(pid)} is running beside ${String(pids.length - 1)} other(s). ${serving} ` +
        `Stop it with \`kill ${String(pid)}\`; launches still connected to it lose their door.`,
      String(pid),
    );
  }
}
