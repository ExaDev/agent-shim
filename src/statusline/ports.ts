import { spawnSyncBlocking } from "../blockingSpawn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memoryUseFromMeminfo, usedBytesFromVmStat, type MemoryUse } from "./memoryUse";

/**
 * What the statusline reads from the machine it runs on, so an element stays a pure function of its input and a test hands it a fake. Each method reports a failure as `undefined` and never throws: a statusline that cannot read something draws without it.
 */
export interface StatuslinePorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  /** The directory the statusline keeps its own state in, which it may create and rewrite whenever it is gone. */
  readonly stateDirectory: string;
  /** Where and how the machine tells the time: the BCP 47 locale its wall-clock times are written in and the IANA time zone they are told in. */
  readonly clock: { readonly locale: string; readonly timeZone: string };
  /** The text of a file, or undefined when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
  /** Up to `length` bytes of a file from byte `start`, with the file's whole size, or undefined when it cannot be read. A `start` at or past the end reads no bytes, and reading never loads more than `length` bytes however large the file is. */
  readonly readRange: (path: string, start: number, length: number) => FileRange | undefined;
  /** The names of a directory's entries, or undefined when it cannot be listed. */
  readonly listDirectory: (path: string) => readonly string[] | undefined;
  /** Replaces a file's text, creating its directories, so a reader never sees half of it. A failure to write is dropped: what the statusline writes is derived state that the next render writes again. */
  readonly writeText: (path: string, text: string) => void;
  /** Removes a file or a directory with everything beneath it. A failure is dropped, like a failed write: it only leaves derived state in place for the next render to remove. */
  readonly removePath: (path: string) => void;
  /** The standard output of a program run in `cwd`, or undefined when it fails, outruns the time the statusline allows a program, or writes more than it may. No shell ever interprets the program's arguments: they reach it as they are, even when `outputInFile` has the system shell set the file size limit and then start the program. */
  readonly run: (file: string, args: readonly string[], cwd: string, options?: RunOptions) => string | undefined;
  /** What lies at `path`, without following a final symbolic link (a link is `other`), or undefined when nothing does. */
  readonly entryKind: (path: string) => "directory" | "other" | undefined;
  /** `path` with every symbolic link resolved, or undefined when it does not exist. */
  readonly realPath: (path: string) => string | undefined;
  /** When the file at `path` was last modified, in milliseconds since the epoch, or undefined when it cannot be read. */
  readonly modifiedAtMs: (path: string) => number | undefined;
  /** How much of the machine's memory is in use, or undefined when the platform gives no figure the statusline trusts. */
  readonly memoryUse: () => MemoryUse | undefined;
}

/** How a program is run, beyond the defaults. */
interface RunOptions {
  /** Capture the program's standard output in a size-limited file instead of a pipe, for a program the person chose: a process it leaves running cannot then hold the call, and the output it wrote is kept. The limit applies to every file the program writes, and to every process it starts. */
  readonly outputInFile?: boolean;
}

/** What `readRange` returns: the bytes read and the size of the file they were read from. */
export interface FileRange {
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** The longest a program the statusline starts may run: the statusline refreshes while a person is working, so a program that hangs must cost a bounded wait, and a few seconds is the most a refresh can wait without the line looking stuck. */
export const RUN_TIMEOUT_MS = 2_000;

/** The file and directory modes the statusline's own state gets: readable by its owner alone, since the ledger names sessions and their spend. */
const STATE_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;

/** The most standard output a program the statusline starts may produce: more than this is as good as none. */
export const RUN_MAX_OUTPUT_BYTES = 1_048_576;

/** The size of the blocks POSIX defines `ulimit -f` as counting in; a shell that counts in larger blocks (bash does) lets a file grow to a multiple of what is asked for, never to less. */
const ULIMIT_BLOCK_BYTES = 512;

/** The name prefix of the private directory a program's output is written into while it runs. */
const RUN_DIRECTORY_PREFIX = "agent-shim-run-";

/** The directory, inside the statusline's state directory, that those directories are made in. */
const RUN_DIRECTORY = "run";

/** The permissions of the file a program writes its output to: its owner only (the directory made for it is private too). Meaningless on Windows, which has no such permission bits. */
const RUN_FILE_MODE = 0o600;

/** How many times `RUN_TIMEOUT_MS` a run directory must outlive to be taken for one that a cancelled statusline left (Claude Code cancels a command still running when a newer update arrives): a call lasts at most the limit and the time to start, so a directory this much older than the limit has no call behind it, and the margin keeps a call on a loaded machine from having its directory swept under it. */
const STALE_AFTER_TIMEOUTS = 10;

/** How old a run directory must be to be swept as left by a call that no longer exists. */
export const STALE_RUN_DIRECTORY_MS = RUN_TIMEOUT_MS * STALE_AFTER_TIMEOUTS;

/** The command that runs `file` with `args` under a limit on the size of any file it writes, through `shell` (the system shell, `/bin/sh`): `ulimit -f` is set and the shell `exec`s the program with the arguments as they are, so nothing in them is read by the shell, and a program that writes more is stopped by SIGXFSZ. The limit is `RUN_MAX_OUTPUT_BYTES`, or a multiple of it on a shell that counts in larger blocks than POSIX does, and it covers every file the program writes and every process it starts. `exec` takes no `--`: dash does not accept it. */
export function fileSizeLimitedCommand(shell: string, file: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  return { command: shell, args: ["-c", `ulimit -f ${String(RUN_MAX_OUTPUT_BYTES / ULIMIT_BLOCK_BYTES)}; exec "$0" "$@"`, file, ...args] };
}

/** `descriptor`'s file read whole when it is smaller than `RUN_MAX_OUTPUT_BYTES`, else undefined: a program that wrote more has no usable output, and one whose file reached the bound exactly was cut off there by a shell that counts the limit in POSIX's blocks (and one that ignores the signal exits normally), so a file of that size is refused as a larger one is, whichever block size the shell counts in. */
function readOutput(descriptor: number): string | undefined {
  const { size } = fs.fstatSync(descriptor);
  if (size >= RUN_MAX_OUTPUT_BYTES) {
    return undefined;
  }
  const buffer = Buffer.alloc(size);
  const read = fs.readSync(descriptor, buffer, 0, size, 0);
  return buffer.toString("utf8", 0, read);
}

/** Removes the run directories under `root` that a cancelled call left behind: those older than `STALE_RUN_DIRECTORY_MS`. */
function sweepStaleRunDirectories(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith(RUN_DIRECTORY_PREFIX))) {
    const directory = path.join(root, name);
    try {
      // lstat, so a dangling link is judged by the link itself and can be removed; an entry that another call swept meanwhile is already gone.
      if (Date.now() - fs.lstatSync(directory).mtimeMs > STALE_RUN_DIRECTORY_MS) {
        discard(directory);
      }
    } catch {
      continue;
    }
  }
}

/**
 * A program run without a shell (except the one `fileSizeLimitedCommand` starts it through when its output is asked to go to a file), as `StatuslinePorts.run` describes. It is killed with SIGKILL when it outruns `RUN_TIMEOUT_MS`: SIGTERM, which a timeout sends by default, can be ignored, and the program would then hold the statusline for as long as it chose to run.
 *
 * By default its standard output goes to a pipe, bounded by `RUN_MAX_OUTPUT_BYTES`. With `outputInFile` it goes to a file in a private directory under `runRoot`, removed afterwards whatever happened, because the call waits for a pipe to close: a program that exits but leaves a process holding the pipe (anything started with `&`, an agent such as gpg-agent or ssh-agent) would hold the call to the time limit and lose its output. With a file the call returns when the program exits and the output it wrote is kept. A file has no buffer limit, so such a program is started under `ulimit -f`, which also bounds every other file it writes; Windows has no `ulimit`, and there only the time limit bounds the file. A call that is cancelled (Claude Code does so with SIGTERM when a newer update arrives) cannot remove its directory, so the next call sweeps the ones that are old enough, and the program it started keeps running until it exits. On Windows a directory is also left behind when a process the program started still holds the file open, to be swept by a later call.
 *
 * Only the program itself is killed at the limit. A process it started stays running after the program is killed or exits, and the synchronous API cannot reap it: `spawnSync` has no documented way to start the program as the leader of a process group (`detached` is neither a documented nor a typed option), and gives the pid back only once the program has gone, so there is no group to signal.
 */
function runProgram(runRoot: string, file: string, args: readonly string[], cwd: string, options: RunOptions = {}): string | undefined {
  return options.outputInFile === true ? runWithOutputInFile(runRoot, file, args, cwd) : runWithPipe(file, args, cwd);
}

/** A program with its standard output on a pipe, bounded by `RUN_MAX_OUTPUT_BYTES`; killed with SIGKILL at `RUN_TIMEOUT_MS`. */
function runWithPipe(file: string, args: readonly string[], cwd: string): string | undefined {
  try {
    const result = spawnSyncBlocking("a statusline command", file, args, { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: RUN_MAX_OUTPUT_BYTES, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return result.error === undefined && result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** A program with its standard output in a file of a private directory under `runRoot`, as `runProgram` describes. */
function runWithOutputInFile(runRoot: string, file: string, args: readonly string[], cwd: string): string | undefined {
  let directory: string | undefined;
  try {
    sweepStaleRunDirectories(runRoot);
    fs.mkdirSync(runRoot, { recursive: true, mode: STATE_DIRECTORY_MODE });
    directory = fs.mkdtempSync(path.join(runRoot, RUN_DIRECTORY_PREFIX));
    const descriptor = fs.openSync(path.join(directory, "stdout"), "wx+", RUN_FILE_MODE);
    try {
      const limited = process.platform === "win32" ? { command: file, args } : fileSizeLimitedCommand("/bin/sh", file, args);
      const result = spawnSyncBlocking("a statusline command", limited.command, limited.args, { cwd, timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", descriptor, "ignore"], windowsHide: true });
      return result.error === undefined && result.status === 0 ? readOutput(descriptor) : undefined;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  } finally {
    if (directory !== undefined) {
      discard(directory);
    }
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Removes a file or directory tree, as `StatuslinePorts.removePath` describes; one that cannot be removed was either never there or is left for the next render to remove. */
function discard(target: string): void {
  try {
    fs.rmSync(target, { force: true, recursive: true });
  } catch {
    return;
  }
}

/** The memory in use on this machine: macOS reports it through `vm_stat` and Linux through `/proc/meminfo`, because `os.freemem` leaves reclaimable cache out of what is free on both and so overstates the use; elsewhere `os.freemem` is the only account there is. */
function readMemoryUse(): MemoryUse | undefined {
  const totalBytes = os.totalmem();
  if (process.platform === "darwin") {
    const output = runWithPipe("/usr/bin/vm_stat", [], process.cwd());
    const usedBytes = output === undefined ? undefined : usedBytesFromVmStat(output);
    return usedBytes === undefined ? undefined : { usedBytes, totalBytes };
  }
  if (process.platform === "linux") {
    const meminfo = readText("/proc/meminfo");
    return meminfo === undefined ? undefined : memoryUseFromMeminfo(meminfo);
  }
  return { usedBytes: totalBytes - os.freemem(), totalBytes };
}

/** The statusline's ports on the real machine, keeping its own state in `stateDirectory`. */
export function realStatuslinePorts(env: Readonly<Record<string, string | undefined>>, stateDirectory: string): StatuslinePorts {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  return {
    env,
    homeDirectory: os.homedir(),
    stateDirectory,
    clock: { locale, timeZone },
    readText,
    readRange: (file, start, length) => {
      try {
        const descriptor = fs.openSync(file, "r");
        try {
          const { size } = fs.fstatSync(descriptor);
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
          const read = fs.readSync(descriptor, buffer, 0, buffer.length, start);
          return { size, bytes: buffer.subarray(0, read) };
        } finally {
          fs.closeSync(descriptor);
        }
      } catch {
        return undefined;
      }
    },
    run: (file, args, cwd, options) => runProgram(path.join(stateDirectory, RUN_DIRECTORY), file, args, cwd, options),
    entryKind: (target) => {
      try {
        return fs.lstatSync(target).isDirectory() ? "directory" : "other";
      } catch {
        return undefined;
      }
    },
    realPath: (target) => {
      try {
        return fs.realpathSync(target);
      } catch {
        return undefined;
      }
    },
    modifiedAtMs: (target) => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return undefined;
      }
    },
    listDirectory: (target) => {
      try {
        return fs.readdirSync(target);
      } catch {
        return undefined;
      }
    },
    writeText: (target, text) => {
      // Written beside the target and renamed over it, so a concurrent reader sees the old file or the new one; the process id keeps two statuslines' temporary files apart.
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${String(process.pid)}.tmp`);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: STATE_DIRECTORY_MODE });
        fs.writeFileSync(temporary, text, { mode: STATE_FILE_MODE });
        fs.renameSync(temporary, target);
      } catch {
        discard(temporary);
      }
    },
    removePath: discard,
    memoryUse: readMemoryUse,
  };
}
