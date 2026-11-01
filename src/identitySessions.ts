import path from "node:path";

import { CliError } from "./cliError";
import type { RunPort } from "./launcher/ports";

/**
 * The environment variable that names the configuration directory a Claude Code process runs against. The launcher sets it to `<identitiesDir>/<name>` for every session it starts, and a person who exports it by hand names the same directory, so a process that carries it is a session on that identity whoever started it.
 */
const CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR";

/** One process found running against an identity's directory: its id, and the program's name, which is all a message about it needs to say. */
export interface SessionProcess {
  readonly pid: number;
  readonly program: string;
}

/** Answers which processes are running against a configuration directory. Injected so the rename never reads the real process table in a test. */
export interface IdentitySessionProbe {
  /** The roots of every process tree that carries `configDir` as its configuration directory: a session, and whatever it started, counts once. Throws when the process table cannot be read, since "none found" would then be a guess. */
  readonly sessionsOn: (configDir: string) => readonly SessionProcess[];
}

/** Raised when the process table cannot be read, or cannot show the environments a session is told apart by. */
class SessionProbeUnavailableError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "SessionProbeUnavailableError";
  }
}

/** One process as the process table lists it. */
interface ListedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly program: string;
}

/**
 * The roots of the processes that carry the directory, without the asking process and the helper it started to ask. A process is a root when its parent is not itself one of the matches, so a session's hooks, shells and servers are not listed beside it.
 */
function rootsOf(matches: readonly ListedProcess[], ownPid: number): readonly SessionProcess[] {
  const others = matches.filter((match) => match.pid !== ownPid && match.ppid !== ownPid);
  const pids = new Set(matches.map((match) => match.pid));
  return others.filter((match) => !pids.has(match.ppid)).map((match) => ({ pid: match.pid, program: match.program }));
}

/** Whether `text` carries `CLAUDE_CONFIG_DIR=<configDir>` as a whole word: at the start of the line or after a space, and followed by a space or the end, so `…/work2` is not `…/work`. */
function carriesDirectory(text: string, configDir: string): boolean {
  const word = `${CONFIG_DIR_VARIABLE}=${configDir}`;
  for (let from = text.indexOf(word); from !== -1; from = text.indexOf(word, from + 1)) {
    const before = text.charAt(from - 1);
    const after = text.charAt(from + word.length);
    if ((from === 0 || before === " ") && (after === "" || after === " ")) {
      return true;
    }
  }
  return false;
}

/**
 * The sessions in `ps -E -ww -o pid=,ppid=,command=` output that run against `configDir`. `-E` makes `ps` print each process's environment after its command, space separated, which is the only form macOS offers; the match is on the whole `CLAUDE_CONFIG_DIR=<dir>` word. The environment is never returned or reported, only a pid and a program name.
 */
export function parseEnvironmentListing(listing: string, configDir: string, ownPid: number): readonly SessionProcess[] {
  const matches: ListedProcess[] = [];
  for (const line of listing.split("\n")) {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    const [, pidText, ppidText, command] = parsed ?? [];
    if (pidText === undefined || ppidText === undefined || command === undefined || !carriesDirectory(command, configDir)) {
      continue;
    }
    const [executable = ""] = command.split(" ");
    matches.push({ pid: Number(pidText), ppid: Number(ppidText), program: path.basename(executable) });
  }
  return rootsOf(matches, ownPid);
}

/** The reads the Linux probe makes of `/proc`: a directory listing, and a file's text or undefined when the process has gone or belongs to another user. */
export interface ProcessTableFs {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (file: string) => string | undefined;
}

const PROC_ROOT = "/proc";

/** The parent pid in `/proc/<pid>/stat`: the second field after the command name, which is in parentheses and may itself hold spaces and parentheses, so the fields are counted from the last closing one. */
function parentPidOf(stat: string): number | undefined {
  const [, ppid] = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
  return ppid === undefined ? undefined : Number(ppid);
}

/** The sessions on Linux, read from each process's own NUL separated environment, which unlike `ps` output keeps a value with a space in it exact. */
function sessionsFromProc(procFs: ProcessTableFs, configDir: string, ownPid: number): readonly SessionProcess[] {
  const word = `${CONFIG_DIR_VARIABLE}=${configDir}`;
  const matches: ListedProcess[] = [];
  for (const entry of procFs.readdir(PROC_ROOT)) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const environment = procFs.readFile(`${PROC_ROOT}/${entry}/environ`);
    if (environment?.split("\u0000").includes(word) !== true) {
      continue;
    }
    const ppid = parentPidOf(procFs.readFile(`${PROC_ROOT}/${entry}/stat`) ?? "");
    if (ppid === undefined || Number.isNaN(ppid)) {
      continue;
    }
    matches.push({ pid: Number(entry), ppid, program: (procFs.readFile(`${PROC_ROOT}/${entry}/comm`) ?? "").trim() });
  }
  return rootsOf(matches, ownPid);
}

/** What the probe reads the process table through. */
export interface IdentitySessionProbeDeps {
  readonly run: RunPort;
  /** The user whose processes are listed: a session of another user cannot be running against this user's directory. Asked for only on macOS, where `ps` lists by user. */
  readonly uid: () => number;
  /** The asking process, left out of what it finds. */
  readonly ownPid: number;
  readonly procFs: ProcessTableFs;
}

/**
 * The session probe for `platform`: `ps -E` on macOS and `/proc` on Linux. Anywhere else a process's environment cannot be read, and the probe says so on use rather than report that nothing is running.
 */
export function createIdentitySessionProbe(platform: NodeJS.Platform, deps: IdentitySessionProbeDeps): IdentitySessionProbe {
  if (platform === "darwin") {
    return {
      sessionsOn(configDir) {
        const result = deps.run.run("ps", ["-E", "-ww", "-U", String(deps.uid()), "-o", "pid=,ppid=,command="]);
        if (result.status !== 0) {
          throw new SessionProbeUnavailableError(`Could not read the process table to see whether a session is running (ps exited ${result.status === null ? "without a status" : String(result.status)}).`);
        }
        return parseEnvironmentListing(result.stdout, configDir, deps.ownPid);
      },
    };
  }
  if (platform === "linux") {
    return { sessionsOn: (configDir) => sessionsFromProc(deps.procFs, configDir, deps.ownPid) };
  }
  return {
    sessionsOn() {
      throw new SessionProbeUnavailableError(`Cannot tell whether a session is running on ${platform}, where a process's environment cannot be read, so an identity cannot be renamed here.`);
    },
  };
}
