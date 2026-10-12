import type { DoctorSection, DoctorSeverity } from "./doctorReport";
import { describeAllowlistDrift, type AllowlistDrift } from "./headroom/allowlistDrift";
import type { AllowlistFileProblem } from "./headroom/socket";
import type { UndeterminedFrontDoor } from "./headroom/supervisor";

/** How the running headroom daemon's allowlist file and recorded hash compare with the allowlist computed now, as `doctor` audits it. A file lacking a live door's origin, a recorded hash that lags the file, or an earlier release's fixed allowlist that lags fails (requests through that door are refused or provider launches wait at their gate); a file still listing a gone door's origin warns. */
export interface DoctorHeadroomAllowlist {
  /** The drift `diagnoseAllowlistDrift` found, or undefined when the file and the recorded hash are current. */
  readonly drift: AllowlistDrift | undefined;
  /** The allowlist file the daemon reads. */
  readonly file: string;
  /** The log the supervisor reports a failed write of that file to. */
  readonly logPath: string;
  /** The recorded front doors the process table could not answer for (see `undeterminedFrontDoors`): each is a warning, since its origin stays admitted until a read can tell. */
  readonly undeterminedFrontDoors: readonly UndeterminedFrontDoor[];
  /** How the allowlist file fails the rules it is held to (see `reportableAllowlistFileProblem`), or undefined when it keeps them or an earlier release's daemon, which reads no file, serves: a failure, whether or not a daemon is up, when headroom refuses it over a directory agent-shim cannot repair, and a warning while a daemon is up otherwise. */
  readonly fileProblem: AllowlistFileProblem | undefined;
}

/** Pushes a failure for an allowlist file headroom refuses over a directory agent-shim cannot repair, whether or not a daemon is up: one serving admits nothing, and every supervisor started stops over it before serving. */
export function pushRefusedAllowlistFile(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, allowlist: DoctorHeadroomAllowlist): void {
  const problem = allowlist.fileProblem;
  if (problem?.repairable === false) {
    // A directory above agent-shim's own: every provider request through headroom fails until the reader applies the remedy the message names.
    push("headroom", "fail", `Headroom refuses its allowlist file, so it admits nothing and every provider request through headroom fails: ${problem.message}.`, allowlist.file);
  }
}

/** Pushes the allowlist findings for a daemon that is up: a warning for a file breaking agent-shim's owner-only rule, which its supervisor repairs, its drift, if any, and a warning for each recorded door the process table could not answer for. */
export function pushHeadroomAllowlist(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  allowlist: DoctorHeadroomAllowlist,
  daemon: { readonly headroomPid: number; readonly liveSupervisorPid: number | undefined },
): void {
  const { drift } = allowlist;
  const problem = allowlist.fileProblem;
  if (problem?.repairable === true) {
    // A warning: the break lies in agent-shim's own directories or the file, which the supervisor repairs on its next tick, or stops the daemon over, recording why, when it cannot.
    push("headroom", "warn", `Headroom's allowlist file breaks agent-shim's owner-only rule for it: ${problem.message}. Its supervisor repairs this on its next tick, and stops the daemon if it cannot.`, allowlist.file);
  }
  if (drift !== undefined) {
    // An earlier release's daemon refuses what its fixed allowlist lacks, and a lagging file or hash refuses or holds up provider launches; only entries the file still lists after nothing routes to them cost nothing but exposure.
    const blocking = drift.startedByEarlierRelease === true || drift.missingFromFile.length > 0 || drift.hashLags;
    push(
      "headroom",
      blocking ? "fail" : "warn",
      `Headroom daemon ${String(daemon.headroomPid)}'s allowlist lags the current one: ` +
        describeAllowlistDrift({ drift, allowlistFile: allowlist.file, liveSupervisorPid: daemon.liveSupervisorPid, logPath: allowlist.logPath }) +
        ". `--no-headroom` launches are unaffected.",
      String(daemon.headroomPid),
    );
  }
  for (const door of allowlist.undeterminedFrontDoors) {
    push("headroom", "warn", `Could not tell whether front door ${String(door.pid)} is still running (${door.reason}), so headroom keeps admitting its direct origin ${door.origin} until a later read can.`, String(door.pid));
  }
}
