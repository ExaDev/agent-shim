import type { RunPort } from "../launcher/ports";

/** The hidden subcommand every front-door supervisor process is started with. */
const FRONT_DOOR_SUPERVISOR_ARGUMENT = "__frontdoor-supervisor";

/** What listing the front-door supervisors found: their pids, or why the process table could not be read. */
export type FrontDoorSupervisorListing =
  | { readonly ok: true; readonly pids: readonly number[] }
  | { readonly ok: false; readonly message: string };

/**
 * The pids of every `__frontdoor-supervisor` process in `ps -o pid=,command=` output, ascending. A process counts only when the subcommand is one whole argument, so an editor or `grep` whose arguments merely mention the name is not mistaken for a supervisor.
 */
export function parseFrontDoorSupervisorPids(psOutput: string): readonly number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const [pidText, ...argumentsList] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0 && argumentsList.includes(FRONT_DOOR_SUPERVISOR_ARGUMENT)) {
      pids.push(pid);
    }
  }
  return pids.sort((a, b) => a - b);
}

/**
 * Lists the front-door supervisor processes owned by `uid` by reading the process table, never by signalling anything. Several can be alive at once: a superseded supervisor keeps serving the launches that were connected to it until they end.
 */
export function listFrontDoorSupervisors(run: RunPort, uid: number): FrontDoorSupervisorListing {
  const result = run.run("ps", ["-U", String(uid), "-o", "pid=,command="]);
  // A null status means the process never ran (not on PATH, or killed by a signal); Node leaves stdout and stderr null then, whatever their declared type says.
  if (result.status === null) {
    return { ok: false, message: "ps could not be run" };
  }
  if (result.status !== 0) {
    return { ok: false, message: `ps exited ${String(result.status)}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}` };
  }
  return { ok: true, pids: parseFrontDoorSupervisorPids(result.stdout) };
}
