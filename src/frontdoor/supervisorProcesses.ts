import type { RunPort } from "../launcher/ports";
import type { FrontDoorLiveness } from "./state";

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

/** The parts of one `ps -o pid=,stat=,command= -p <pids>` run that decide a liveness verdict. `status` is null when ps was killed (a timeout included), and `error` is set when it could not be run at all. */
export interface PsRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/**
 * The verdict one `ps -o pid=,stat=,command= -p <pids>` run gives on the `asked` pids. Only a line led by an asked pid is read, and only the first such line for each, so neither an unasked process nor a command line holding a line break can pass for a door. A read pid is a door when its state is not a zombie's (`Z`) and the front-door supervisor subcommand is one whole argument of its command line; an asked pid the table does not list is gone. ps exits 1 with no output when none of the pids exists, and refuses a pid above the platform's maximum as too large, which are answers; anything else that is not a clean exit (no ps, a signal or timeout, an error message) leaves every asked pid unknown, with the reason.
 */
export function frontDoorLivenessFromPs(run: PsRun, asked: readonly number[]): FrontDoorLiveness {
  if (refusedEveryPidAsTooLarge(run, asked)) {
    return { doors: new Set(), unknown: new Map() };
  }
  const failure = psFailure(run);
  if (failure !== undefined) {
    return { doors: new Set(), unknown: new Map(asked.map((pid) => [pid, failure])) };
  }
  const askedSet = new Set(asked);
  const seen = new Set<number>();
  const doors = new Set<number>();
  for (const line of run.stdout.split("\n")) {
    const [pidText, stat, ...argumentsList] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!askedSet.has(pid) || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    if (stat !== undefined && !stat.startsWith("Z") && argumentsList.includes(FRONT_DOOR_SUPERVISOR_ARGUMENT)) {
      doors.add(pid);
    }
  }
  return { doors, unknown: new Map() };
}

/** How ps (macOS's, and the BSDs') reports a pid above the platform's maximum, which no process can hold. */
const PID_TOO_LARGE = /^ps: process id too large: (\d+)$/;

/** Whether ps refused every asked pid as above the platform's maximum and said nothing else: an answer (none of them can be running), not a failure. Only when it covers every asked pid, since ps prints nothing for any pid of a batch it refuses over one. */
function refusedEveryPidAsTooLarge(run: PsRun, asked: readonly number[]): boolean {
  const lines = run.stderr.split("\n").filter((line) => line.trim() !== "");
  const tooLarge = new Set(lines.map((line) => Number(PID_TOO_LARGE.exec(line.trim())?.[1])));
  return run.status === 1 && run.stdout.trim() === "" && lines.length > 0 && lines.every((line) => PID_TOO_LARGE.test(line.trim())) && asked.every((pid) => tooLarge.has(pid));
}

/** Why a ps run gave no answer, or undefined when it answered (a clean exit, or exit 1 with no output, which is ps saying none of the pids exists). */
function psFailure(run: PsRun): string | undefined {
  if (run.error !== undefined) {
    return run.error.message;
  }
  if (run.status === null) {
    return "ps was terminated before it answered";
  }
  const noneExist = run.status === 1 && run.stdout.trim() === "" && run.stderr.trim() === "";
  if (run.status !== 0 && !noneExist) {
    return `ps exited ${String(run.status)}${run.stderr.trim() === "" ? "" : `: ${run.stderr.trim()}`}`;
  }
  return undefined;
}

/**
 * Which of `pids` are running front-door supervisors: one `runPs` over all of them, and, when that run fails as a whole (macOS ps refuses a whole batch over one pid above its own maximum, say), one run per pid, so a pid ps will not answer for leaves only itself unknown. No run at all when there is nothing to ask about.
 */
export function frontDoorLivenessOf(pids: readonly number[], runPs: (pids: readonly number[]) => PsRun): FrontDoorLiveness {
  if (pids.length === 0) {
    return { doors: new Set(), unknown: new Map() };
  }
  const batch = frontDoorLivenessFromPs(runPs(pids), pids);
  if (batch.unknown.size === 0 || pids.length === 1) {
    return batch;
  }
  const doors = new Set<number>();
  const unknown = new Map<number, string>();
  for (const pid of pids) {
    const single = frontDoorLivenessFromPs(runPs([pid]), [pid]);
    for (const door of single.doors) {
      doors.add(door);
    }
    for (const [unanswered, reason] of single.unknown) {
      unknown.set(unanswered, reason);
    }
  }
  return { doors, unknown };
}
