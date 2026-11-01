import path from "node:path";

import { CliError } from "./cliError";
import type { RunPort } from "./launcher/ports";

/**
 * The environment variable that names the configuration directory a Claude Code process runs against. The launcher sets it to `<identitiesDir>/<name>` for every session it starts, and a person who exports it by hand names the same directory, so a process that carries it is a session on that identity whoever started it.
 */
const CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR";

const VARIABLE_PREFIX = `${CONFIG_DIR_VARIABLE}=`;

/** One process found running against an identity's directory: its id, and the program's name, which is all a message about it needs to say. */
export interface SessionProcess {
  readonly pid: number;
  readonly program: string;
}

/** Answers which processes are running against a configuration directory. Injected so the rename never reads the real process table in a test. */
export interface IdentitySessionProbe {
  /** The roots of every process tree that carries `configDir` as its configuration directory: a session, and whatever it started, counts once. Throws when the process table cannot be read, or on Linux when it shows a process of this user whose environment it cannot, since "none found" would then be a guess. On macOS `ps -E` prints no environment for a process of this user that it cannot read, and a row with none is indistinguishable from a process with an empty environment, so such a process is never counted: the probe sees exactly the sessions whose environment `ps` shows. Refusing on every row without one would refuse every rename, because a large share of ordinary same-user processes show none. */
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

/** Where a path really is: its trailing slashes and dot segments removed, then its symlinks followed. A path that does not exist is its own place. */
function canonicalDirectory(directory: string, realpath: (target: string) => string): string {
  return realpath(path.resolve(directory));
}

/** The spellings of the wanted directory a process may carry it under: as asked, and where it really is. */
function spellingsOf(configDir: string, canonical: string): readonly string[] {
  return [...new Set([configDir, canonical])];
}

/** Whether `rest` is `spelling` followed by the end of the word: a space, the end, or slashes and then either. */
function startsWithWord(rest: string, spelling: string): boolean {
  return rest.startsWith(spelling) && /^\/*(?: |$)/u.test(rest.slice(spelling.length));
}

/**
 * Whether `text` carries `CLAUDE_CONFIG_DIR=<dir>` as a whole word naming the wanted directory: at the start of the line or after a space, and followed by a space or the end, so `…/work2` is not `…/work`. A spelling with a trailing slash, or one reaching the directory through a symlink, names it too. `ps` prints the environment space separated, so a directory with a space in it is only recognised when it is spelled as asked or as it really is.
 */
function carriesDirectory(text: string, configDir: string, realpath: (target: string) => string): boolean {
  const canonical = canonicalDirectory(configDir, realpath);
  const spellings = spellingsOf(configDir, canonical);
  for (let from = text.indexOf(VARIABLE_PREFIX); from !== -1; from = text.indexOf(VARIABLE_PREFIX, from + 1)) {
    if (from > 0 && text.charAt(from - 1) !== " ") {
      continue;
    }
    const rest = text.slice(from + VARIABLE_PREFIX.length);
    const [value = ""] = rest.split(" ");
    if (spellings.some((spelling) => startsWithWord(rest, spelling)) || (value !== "" && canonicalDirectory(value, realpath) === canonical)) {
      return true;
    }
  }
  return false;
}

/**
 * The sessions in `ps -E -ww -o pid=,ppid=,command=` output that run against `configDir`. `-E` makes `ps` print each process's environment after its command, space separated, which is the only form macOS offers. The environment is never returned or reported, only a pid and a program name.
 */
export function parseEnvironmentListing(listing: string, configDir: string, ownPid: number, realpath: (target: string) => string): readonly SessionProcess[] {
  const matches: ListedProcess[] = [];
  for (const line of listing.split("\n")) {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    const [, pidText, ppidText, command] = parsed ?? [];
    if (pidText === undefined || ppidText === undefined || command === undefined || !carriesDirectory(command, configDir, realpath)) {
      continue;
    }
    const [executable = ""] = command.split(" ");
    matches.push({ pid: Number(pidText), ppid: Number(ppidText), program: path.basename(executable) });
  }
  return rootsOf(matches, ownPid);
}

/** What reading one file of a process's `/proc` entry found: its text, nothing because the process has gone, or nothing because this user may not read it. */
export type ProcRead = { readonly kind: "text"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "unreadable" };

/** The reads the Linux probe makes of `/proc`: a directory listing, and a file. */
export interface ProcessTableFs {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (file: string) => ProcRead;
}

const PROC_ROOT = "/proc";

/** The text of a `/proc` file, or undefined when it is absent or unreadable. */
function textOf(read: ProcRead): string | undefined {
  return read.kind === "text" ? read.text : undefined;
}

/** The parent pid in `/proc/<pid>/stat`: the second field after the command name, which is in parentheses and may itself hold spaces and parentheses, so the fields are counted from the last closing one. */
function parentPidOf(stat: string): number | undefined {
  const [, ppid] = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
  return ppid === undefined ? undefined : Number(ppid);
}

/** Whether the process `entry` runs as user `uid`, from the real user id in its `/proc/<pid>/status`, which every user may read. A process that has gone is nobody's. */
function ownedBy(procFs: ProcessTableFs, entry: string, uid: number): boolean {
  const real = /^Uid:\s+(\d+)/mu.exec(textOf(procFs.readFile(`${PROC_ROOT}/${entry}/status`)) ?? "")?.[1];
  return real !== undefined && Number(real) === uid;
}

/** The sessions on Linux, read from each process's own NUL separated environment, which unlike `ps` output keeps a value with a space in it exact. */
function sessionsFromProc(deps: IdentitySessionProbeDeps, configDir: string): readonly SessionProcess[] {
  const { procFs, realpath } = deps;
  const canonical = canonicalDirectory(configDir, realpath);
  const matches: ListedProcess[] = [];
  for (const entry of procFs.readdir(PROC_ROOT)) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const environment = procFs.readFile(`${PROC_ROOT}/${entry}/environ`);
    if (environment.kind === "absent") {
      continue;
    }
    if (environment.kind === "unreadable") {
      // Another user's process cannot be a session on this user's directory. One of this user's that withholds its environment (a process that marked itself undumpable, say) might be, and saying nothing is running would be a guess.
      if (ownedBy(procFs, entry, deps.uid())) {
        const program = (textOf(procFs.readFile(`${PROC_ROOT}/${entry}/comm`)) ?? "").trim();
        throw new SessionProbeUnavailableError(`Cannot read the environment of pid ${entry} (${program === "" ? "unknown program" : program}), a process of yours, so cannot tell whether it is a session running against ${configDir}. End it, then run the command again.`);
      }
      continue;
    }
    const carries = environment.text
      .split("\u0000")
      .filter((variable) => variable.startsWith(VARIABLE_PREFIX))
      .map((variable) => variable.slice(VARIABLE_PREFIX.length))
      .some((value) => value !== "" && canonicalDirectory(value, realpath) === canonical);
    if (!carries) {
      continue;
    }
    const ppid = parentPidOf(textOf(procFs.readFile(`${PROC_ROOT}/${entry}/stat`)) ?? "");
    if (ppid === undefined || Number.isNaN(ppid)) {
      continue;
    }
    matches.push({ pid: Number(entry), ppid, program: (textOf(procFs.readFile(`${PROC_ROOT}/${entry}/comm`)) ?? "").trim() });
  }
  return rootsOf(matches, deps.ownPid);
}

/** What the probe reads the process table through. */
export interface IdentitySessionProbeDeps {
  readonly run: RunPort;
  /** The user whose processes are listed: a session of another user cannot be running against this user's directory. Asked for only where it is needed: on macOS, where `ps` lists by user, and on Linux for a process whose environment is unreadable. */
  readonly uid: () => number;
  /** The asking process, left out of what it finds. */
  readonly ownPid: number;
  readonly procFs: ProcessTableFs;
  /** Where a path really is, following symlinks; a path that does not exist answers as itself. */
  readonly realpath: (target: string) => string;
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
        return parseEnvironmentListing(result.stdout, configDir, deps.ownPid, deps.realpath);
      },
    };
  }
  if (platform === "linux") {
    return { sessionsOn: (configDir) => sessionsFromProc(deps, configDir) };
  }
  return {
    sessionsOn() {
      throw new SessionProbeUnavailableError(`Cannot tell whether a session is running on ${platform}, where a process's environment cannot be read, so an identity cannot be renamed here.`);
    },
  };
}
