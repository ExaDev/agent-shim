import type { FarmFs } from "./launcher/ports";

/** The filesystem operations a rotation performs, all of them already part of the farm's filesystem port so a rotation runs against the same real and fake implementations. */
export type LogRotationFs = Pick<FarmFs, "lstat" | "rename" | "removeRecursive" | "copyRecursive" | "writeFileUtf8">;

/** When a log is rotated and how much of its history is kept. */
export interface LogRotationLimits {
  /** The size in bytes above which the live file is rotated. */
  readonly maxBytes: number;
  /** How many rotated files are kept beside the live one, at least one: `<log>.1` is the newest and `<log>.<keptGenerations>` the oldest, and the file shifted past it is deleted. */
  readonly keptGenerations: number;
}

/**
 * Rotates the log at `logPath` when it is larger than `limits.maxBytes`, returning whether it did.
 *
 * The live file is copied to `<log>.1` and then emptied in place, never renamed away, because a daemon started with its output redirected into the file holds a descriptor on that inode and would keep writing into the renamed file. That descriptor is opened for appending, so writes after the truncation land at the start of the emptied file. Lines written in the instant between the copy and the truncation are lost, which is the cost of rotating a file whose writer cannot be asked to reopen it.
 *
 * Every byte offset taken before a rotation (see `SupervisorPorts.daemonLogSize`) is invalid after it, so a caller that holds one rotates only between the point it takes the offset and no later point it reads it back.
 */
export function rotateLogIfOver(fs: LogRotationFs, logPath: string, limits: LogRotationLimits): boolean {
  if ((fs.lstat(logPath)?.sizeBytes ?? 0) <= limits.maxBytes) {
    return false;
  }
  const generation = (index: number): string => `${logPath}.${String(index)}`;
  fs.removeRecursive(generation(limits.keptGenerations));
  for (let index = limits.keptGenerations - 1; index >= 1; index -= 1) {
    if (fs.lstat(generation(index)) !== undefined) {
      fs.rename(generation(index), generation(index + 1));
    }
  }
  fs.copyRecursive(logPath, generation(1));
  fs.writeFileUtf8(logPath, "");
  return true;
}
