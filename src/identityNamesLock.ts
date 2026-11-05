import { acquireIdentityLock, IdentityLockBusyError, type AcquireIdentityLockParams, type IdentityLock } from "./launcher/lock";
import type { LayoutPaths } from "./paths";
import { realFarmFs, realIsProcessAlive, realIsProcessRunning, realSleepSync } from "./realPorts";

/** What taking the identity names lock needs from the machine: the lock's own ports, and how many attempts to make before giving up (one for a caller that must not wait, such as the front door, whose event loop a sleep would hold). */
export type IdentityNamesLockPorts = Pick<AcquireIdentityLockParams, "fs" | "nowMs" | "pid" | "isRunning" | "sleep" | "maxAttempts">;

/** The name the identity names lock is filed under, in the state root rather than the identities directory, so it can be no identity's resync lock. */
const IDENTITY_NAMES_LOCK = "identity-names";

/** Raised when another identity operation holds the names lock past the retry budget. An `IdentityLockBusyError`, so every caller that answers a busy lock answers this one, with a message that names what holds it rather than a resync of an identity. */
export class IdentityNamesLockBusyError extends IdentityLockBusyError {
  constructor(lockPath: string, holderPid: number | undefined) {
    super(IDENTITY_NAMES_LOCK, lockPath, holderPid, `Another agent-shim identity operation${holderPid === undefined ? "" : ` (pid ${String(holderPid)})`} holds the lock at ${lockPath} after the full retry budget; nothing was changed.`);
    this.name = "IdentityNamesLockBusyError";
  }
}

/**
 * Takes the one lock that serialises every change to which identity holds which name: `identity add`, `identity remove` and both forms of `identity rename` take it before they change anything (a rename makes its lock-free refusals first) and check the names again under it, a rename of the name alone resolving its identity's id there before it takes that id's resync lock, so two of them can never both find a name free and leave two records claiming it, and an identity cannot be removed while a rename of it is applying. It is taken before any identity's resync lock and never while one is held, so it cannot deadlock against a resync, which never takes it, or a `--move`, which takes the resync locks after it. Throws `IdentityLockBusyError` when another process holds it past the retry budget.
 */
export function acquireIdentityNamesLock(paths: LayoutPaths, ports: IdentityNamesLockPorts): IdentityLock {
  try {
    return acquireIdentityLock({ ...ports, identity: IDENTITY_NAMES_LOCK, dir: paths.root, staleAfterMs: Infinity });
  } catch (error: unknown) {
    if (error instanceof IdentityLockBusyError) {
      throw new IdentityNamesLockBusyError(error.lockPath, error.holderPid);
    }
    throw error;
  }
}

/** Runs `work` holding the identity names lock (see `acquireIdentityNamesLock`) and releases it however `work` ends. */
export function withIdentityNamesLock<T>(paths: LayoutPaths, ports: IdentityNamesLockPorts, work: () => T): T {
  const lock = acquireIdentityNamesLock(paths, ports);
  try {
    return work();
  } finally {
    lock.release();
  }
}

/** The identity names lock's ports on this machine, waiting for a holder as a resync lock is waited for. */
export const realIdentityNamesLockPorts: IdentityNamesLockPorts = { fs: realFarmFs, nowMs: () => Date.now(), pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync };

/** The identity names lock's ports for a caller that must not wait (the front door): one attempt, with nothing to sleep for, so a held lock refuses at once with `IdentityLockBusyError`. */
export const nonWaitingIdentityNamesLockPorts: IdentityNamesLockPorts = { ...realIdentityNamesLockPorts, isRunning: realIsProcessAlive, sleep: () => undefined, maxAttempts: 1 };
