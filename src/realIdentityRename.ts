import fs from "node:fs";
import os from "node:os";

import type { IdentityLaunchProbe, IdentityRenamePorts, IdentityRenameSignals } from "./identityRename";
import { createIdentitySessionProbe, type ProcessTableFs, type ProcRead } from "./identitySessions";
import { liveLaunchesOn } from "./launcher/launchRecords";
import type { LayoutPaths } from "./paths";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { realFarmFs, realIsProcessRunning, realRunPort, realRunPortWithin, realSleepSync } from "./realPorts";
import { cliKeychainProbe } from "./frontdoor/keychainProbe";
import type { RunPort } from "./launcher/ports";
import { sameDirectory } from "./sameDirectory";

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
export function realpathOrSelf(target: string): string {
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

/** The signals that ask a process to stop and are not a failure of its own: Ctrl-C, a termination request, and the hang-up a closed terminal sends. */
const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The real signal port. While a handler is installed Node no longer ends the process on the signal, which is what lets the rename roll back instead of leaving a half-moved identity. A signal that arrives during synchronous work is delivered when the loop next polls, so `turn` lets two iterations pass: the first immediate runs in a check phase, and one scheduled from it runs in the next iteration, after a poll phase.
 */
export const realSignals: IdentityRenameSignals = {
  onInterrupt: (handler) => {
    for (const signal of INTERRUPT_SIGNALS) {
      process.on(signal, handler);
    }
    return () => {
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, handler);
      }
    };
  },
  turn: async () => {
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        setImmediate(resolve);
      });
    });
  },
};

/** What a launch in progress is called when a refusal names it. */
const LAUNCH_PROGRAM = "agent-shim launch";

/** The real launch probe: the records launchers write under the state root, of launchers whose process is still running. */
export function realLaunchProbe(paths: LayoutPaths): IdentityLaunchProbe {
  return { liveOn: (identity) => liveLaunchesOn(realFarmFs, paths.launchesDir, identity, realIsProcessRunning).map((pid) => ({ pid, program: LAUNCH_PROGRAM })) };
}

/** The real ports behind `identity rename`: the filesystem, the credential cache, `security`, the process table and the resync lock's clock, sleep and liveness check. */
export function realIdentityRenamePorts(paths: LayoutPaths, within: (timeoutMs: number) => RunPort = realRunPortWithin): IdentityRenamePorts {
  return {
    fs: realFarmFs,
    credentialCache: realCredentialCacheEnv(paths),
    run: realRunPort,
    lookupRun: cliKeychainProbe(process.platform, within).run,
    platform: process.platform,
    home: os.homedir(),
    sameDirectory,
    realpath: realpathOrSelf,
    launches: realLaunchProbe(paths),
    signals: realSignals,
    sessions: createIdentitySessionProbe(process.platform, { run: realRunPort, uid: currentUid, ownPid: process.pid, procFs: realProcessTableFs, realpath: realpathOrSelf }),
    lock: { nowMs: () => Date.now(), pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync },
  };
}
