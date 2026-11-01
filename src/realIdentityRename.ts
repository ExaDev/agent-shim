import fs from "node:fs";

import type { IdentityRenamePorts } from "./identityRename";
import { createIdentitySessionProbe, type ProcessTableFs } from "./identitySessions";
import type { LayoutPaths } from "./paths";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { realFarmFs, realIsProcessRunning, realRunPort, realSleepSync } from "./realPorts";

/** The errors a read of another process's `/proc` entry gives when the process has exited since it was listed, or belongs to another user: the process is not one this user's session can be, so it reads as absent. */
const ABSENT_PROCESS_CODES: ReadonlySet<string> = new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]);

function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && codes.has(error.code);
}

/** The real `/proc` reads the Linux session probe makes. */
const realProcessTableFs: ProcessTableFs = {
  readdir: (dir) => fs.readdirSync(dir),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if (hasCode(error, ABSENT_PROCESS_CODES)) {
        return undefined;
      }
      throw error;
    }
  },
};

/** The real user id, which only POSIX systems have. The session probe asks for it on macOS alone. */
function currentUid(): number {
  if (process.getuid === undefined) {
    throw new Error(`no POSIX user id on ${process.platform}`);
  }
  return process.getuid();
}

/** The real ports behind `identity rename`: the filesystem, the credential cache, `security`, the process table and the resync lock's clock, sleep and liveness check. */
export function realIdentityRenamePorts(paths: LayoutPaths): IdentityRenamePorts {
  return {
    fs: realFarmFs,
    credentialCache: realCredentialCacheEnv(paths),
    run: realRunPort,
    platform: process.platform,
    sessions: createIdentitySessionProbe(process.platform, { run: realRunPort, uid: currentUid, ownPid: process.pid, procFs: realProcessTableFs }),
    lock: { nowMs: () => Date.now(), pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync },
  };
}
