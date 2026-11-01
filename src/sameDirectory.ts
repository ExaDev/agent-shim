import fs from "node:fs";
import path from "node:path";

/** Whether two paths are one directory on disk, by device and inode: true for a name that differs only in case on a filesystem that ignores case, and for a symlink to the directory. False when either does not exist. */
export function sameDirectory(first: string, second: string): boolean {
  const a = fs.statSync(first, { throwIfNoEntry: false });
  const b = fs.statSync(second, { throwIfNoEntry: false });
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
