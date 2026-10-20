import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/**
 * What the statusline reads from the machine it runs on, so an element stays a pure function of its input and a test hands it a fake. Each method reports a failure as `undefined` and never throws: a statusline that cannot read something draws without it.
 */
export interface StatuslinePorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  /** The text of a file, or undefined when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
  /** Up to `length` bytes of a file from byte `start`, with the file's whole size, or undefined when it cannot be read. A `start` at or past the end reads no bytes, and reading never loads more than `length` bytes however large the file is. */
  readonly readRange: (path: string, start: number, length: number) => FileRange | undefined;
  /** The standard output of a program run without a shell in `cwd`, or undefined when it fails or outruns the time the statusline allows a program. */
  readonly run: (file: string, args: readonly string[], cwd: string) => string | undefined;
  /** What lies at `path`, without following a final symbolic link (a link is `other`), or undefined when nothing does. */
  readonly entryKind: (path: string) => "directory" | "other" | undefined;
  /** `path` with every symbolic link resolved, or undefined when it does not exist. */
  readonly realPath: (path: string) => string | undefined;
  /** When the file at `path` was last modified, in milliseconds since the epoch, or undefined when it cannot be read. */
  readonly modifiedAtMs: (path: string) => number | undefined;
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

/** The statusline's ports on the real machine. */
export function realStatuslinePorts(env: Readonly<Record<string, string | undefined>>): StatuslinePorts {
  return {
    env,
    homeDirectory: os.homedir(),
    readText: (path) => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
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
    run: (file, args, cwd) => {
      try {
        return execFileSync(file, [...args], { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER_BYTES, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      } catch {
        return undefined;
      }
    },
    entryKind: (path) => {
      try {
        return fs.lstatSync(path).isDirectory() ? "directory" : "other";
      } catch {
        return undefined;
      }
    },
    realPath: (path) => {
      try {
        return fs.realpathSync(path);
      } catch {
        return undefined;
      }
    },
    modifiedAtMs: (path) => {
      try {
        return fs.statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };
}
