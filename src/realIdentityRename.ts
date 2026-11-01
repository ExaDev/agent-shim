import fs from "node:fs";
import os from "node:os";

import type { IdentityLaunchProbe, IdentityRenamePorts } from "./identityRename";
import { createIdentitySessionProbe, type ProcessTableFs, type ProcRead } from "./identitySessions";
import { liveLaunchesOn } from "./launcher/launchRecords";
import type { LayoutPaths } from "./paths";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { realFarmFs, realIsProcessRunning, realRunPort, realSleepSync } from "./realPorts";

/** What a read of another process's `/proc` entry gives when the process has exited since it was listed. */
const GONE_PROCESS_CODES: ReadonlySet<string> = new Set(["ENOENT", "ESRCH"]);

/** What it gives when the kernel withholds the entry from this user: another user's process, or one of this user's that marked itself undumpable. */
const WITHHELD_PROCESS_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && codes.has(error.code);
}

/** The real `/proc` reads the Linux session probe makes, telling a process that has gone from one whose entry is withheld. */
const realProcessTableFs: ProcessTableFs = {
  readdir: (dir) => fs.readdirSync(dir),
  readFile: (file): ProcRead => {
    try {
      return { kind: "text", text: fs.readFileSync(file, "utf8") };
    } catch (error) {
      if (hasCode(error, GONE_PROCESS_CODES)) {
        return { kind: "absent" };
      }
      if (hasCode(error, WITHHELD_PROCESS_CODES)) {
        return { kind: "unreadable" };
      }
      throw error;
    }
  },
};

/** Where a path really is, following symlinks. A path that does not exist is its own place, which is how a directory that is not there yet is compared. */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (hasCode(error, GONE_PROCESS_CODES)) {
      return target;
    }
    throw error;
  }
}

/** The real user id, which only POSIX systems have. The session probe asks for it on macOS alone. */
function currentUid(): number {
  if (process.getuid === undefined) {
    throw new Error(`no POSIX user id on ${process.platform}`);
  }
  return process.getuid();
}

/** Whether two paths are one directory on disk, by device and inode: true for a name that differs only in case on a filesystem that ignores case, and for a symlink to the directory. False when either does not exist. */
export function sameDirectory(first: string, second: string): boolean {
  const a = fs.statSync(first, { throwIfNoEntry: false });
  const b = fs.statSync(second, { throwIfNoEntry: false });
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.dev === b.dev && a.ino === b.ino;
}

/** What a launch in progress is called when a refusal names it. */
const LAUNCH_PROGRAM = "agent-shim launch";

/** The real launch probe: the records launchers write under the state root, of launchers whose process is still running. */
export function realLaunchProbe(paths: LayoutPaths): IdentityLaunchProbe {
  return { liveOn: (identity) => liveLaunchesOn(realFarmFs, paths.launchesDir, identity, realIsProcessRunning).map((pid) => ({ pid, program: LAUNCH_PROGRAM })) };
}

/** The real ports behind `identity rename`: the filesystem, the credential cache, `security`, the process table and the resync lock's clock, sleep and liveness check. */
export function realIdentityRenamePorts(paths: LayoutPaths): IdentityRenamePorts {
  return {
    fs: realFarmFs,
    credentialCache: realCredentialCacheEnv(paths),
    run: realRunPort,
    platform: process.platform,
    home: os.homedir(),
    sameDirectory,
    launches: realLaunchProbe(paths),
    sessions: createIdentitySessionProbe(process.platform, { run: realRunPort, uid: currentUid, ownPid: process.pid, procFs: realProcessTableFs, realpath: realpathOrSelf }),
    lock: { nowMs: () => Date.now(), pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync },
  };
}
