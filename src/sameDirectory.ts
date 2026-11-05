import fs from "node:fs";
import path from "node:path";

/** The errors the filesystem gives for a path that cannot be reached because of what it points through or its permissions, not because of a fault in the machine: a cycle of links, a directory that cannot be searched, a path through a file. */
export const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ELOOP", "EACCES", "ENOTDIR"]);

/** The `code` of a system error, or undefined for anything else. */
export function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** What `target` resolves to, or undefined when it does not exist or cannot be reached (`UNREACHABLE_CODES`); any other fault is thrown. */
function reachableStat(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target, { throwIfNoEntry: false });
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== undefined && UNREACHABLE_CODES.has(code)) {
      return undefined;
    }
    throw error;
  }
}

/** Whether two paths are one directory on disk, by device and inode: true for a name that differs only in case on a filesystem that ignores case, and for a symlink to the directory. False when either does not exist or cannot be reached (a cycle of links, a directory that cannot be searched, a path through a file), since neither can then be shown to be the other. */
export function sameDirectory(first: string, second: string): boolean {
  const a = reachableStat(first);
  const b = reachableStat(second);
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.dev === b.dev && a.ino === b.ino;
}

/** `name` with the case of every letter reversed. */
function caseSwapped(name: string): string {
  return name.replace(/[A-Za-z]/gu, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
}

/**
 * Whether names directly inside `directory` that differ only in case are one name, which is what a filesystem that ignores case does. A name that does not exist yet cannot be compared with anything, so this makes a throwaway directory with a mixed-case name inside `directory` and asks whether the swapped-case spelling reaches it, then removes it. False when `directory` does not exist.
 */
export function ignoresCase(directory: string): boolean {
  if (!fs.existsSync(directory)) {
    return false;
  }
  const probe = fs.mkdtempSync(path.join(directory, ".case-probe-"));
  try {
    return sameDirectory(probe, path.join(directory, caseSwapped(path.basename(probe))));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
