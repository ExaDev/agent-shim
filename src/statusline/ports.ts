import { execFileSyncBlocking } from "../blockingSpawn";
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
  /** The standard output of a program run without a shell in `cwd`, or undefined when it fails or outruns the time the statusline allows a program. */
  readonly run: (file: string, args: readonly string[], cwd: string) => string | undefined;
  /** What lies at `path`, without following a final symbolic link (a link is `other`), or undefined when nothing does. */
  readonly entryKind: (path: string) => "directory" | "other" | undefined;
  /** `path` with every symbolic link resolved, or undefined when it does not exist. */
  readonly realPath: (path: string) => string | undefined;
  /** When the file at `path` was last modified, in milliseconds since the epoch, or undefined when it cannot be read. */
  readonly modifiedAtMs: (path: string) => number | undefined;
  /** How much of the machine's memory is in use, or undefined when the platform gives no figure the statusline trusts. */
  readonly memoryUse: () => MemoryUse | undefined;
}

/** What `readRange` returns: the bytes read and the size of the file they were read from. */
export interface FileRange {
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** The longest a program the statusline starts may run: the statusline refreshes while a person is working, so a program that hangs must cost a bounded wait, and a few seconds is the most a refresh can wait without the line looking stuck. */
const RUN_TIMEOUT_MS = 2_000;

/** The most standard output a program the statusline starts may produce before it is cut off. */
const RUN_MAX_BUFFER_BYTES = 1_048_576;

/** A program run without a shell, as `StatuslinePorts.run` describes. */
function runProgram(file: string, args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSyncBlocking("a statusline command", file, args, { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER_BYTES, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The file and directory modes the statusline's own state gets: readable by its owner alone, since the ledger names sessions and their spend. */
const STATE_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;

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
    const output = runProgram("/usr/bin/vm_stat", [], process.cwd());
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
    run: runProgram,
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
