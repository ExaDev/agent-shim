import { randomUUID } from "node:crypto";
import path from "node:path";

import { CliError } from "../cliError";
import type { FarmFs } from "./ports";

/** How long a lock file may sit untouched before a later launch treats it as abandoned and takes it. Deliberately far longer than any plausible resync of a large `~/.claude`, since stealing a live lock is worse than waiting behind one. */
const DEFAULT_STALE_AFTER_MS = 120_000;
/** How long to wait between attempts to take a held lock. */
const DEFAULT_RETRY_DELAY_MS = 50;
/** How many attempts before giving up. With the default delay this is a ten-second ceiling — long enough for a sibling session's resync, short enough that a wedged lock does not hang a terminal indefinitely. */
const DEFAULT_MAX_ATTEMPTS = 200;

/** What one lock file holds. The token is what makes releasing safe: a lock stolen from a crashed process must not then be released out from under whoever took it. */
interface LockRecord {
  readonly identity: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAtMs: number;
}

/** A held identity lock. Releasing is idempotent and never removes a lock some other process has since taken. */
export interface IdentityLock {
  readonly path: string;
  readonly token: string;
  readonly release: () => void;
}

/** Raised when another process holds the identity's lock and did not release it within the retry budget. */
export class IdentityLockBusyError extends CliError {
  constructor(
    readonly identity: string,
    readonly lockPath: string,
    readonly holderPid: number | undefined,
  ) {
    super(
      `Another claude-use resync is already running for identity "${identity}"` +
        (holderPid === undefined ? "" : ` (pid ${String(holderPid)})`) +
        `. Its lock at ${lockPath} was still held after the full retry budget; nothing was changed.`,
    );
    this.name = "IdentityLockBusyError";
  }
}

/** Everything `acquireIdentityLock` needs, all of it injected so a test never sleeps for real, never reads a real pid table, and never writes outside its own fake filesystem. */
export interface AcquireIdentityLockParams {
  readonly identity: string;
  /** The directory the lock file lives in — `~/.claude-use/identities`, alongside (never inside) the farm the lock protects, so a farm swap can rename the farm root out from under itself without disturbing the lock. */
  readonly dir: string;
  readonly fs: FarmFs;
  readonly nowMs: () => number;
  readonly pid: number;
  /** Answers whether a process is still running, so a lock left behind by a crash is recognised rather than waited out for the full staleness window. Zombie-aware: a holder that exited without being reaped still answers signal 0 as alive, but will never release the lock itself. */
  readonly isRunning: (pid: number) => boolean;
  /** Blocks for the given number of milliseconds. Synchronous by necessity: the whole launcher is synchronous, right through to `spawnSync`. */
  readonly sleep: (ms: number) => void;
  readonly staleAfterMs?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
}

/** The path of one identity's lock file. */
export function identityLockPath(dir: string, identity: string): string {
  return path.join(dir, `.${identity}.lock`);
}

function parseLockRecord(raw: string | undefined): LockRecord | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  if (!("identity" in parsed) || !("pid" in parsed) || !("token" in parsed) || !("acquiredAtMs" in parsed)) {
    return undefined;
  }
  const { identity, pid, token, acquiredAtMs } = parsed;
  if (typeof identity !== "string" || typeof pid !== "number" || typeof token !== "string" || typeof acquiredAtMs !== "number") {
    return undefined;
  }
  return { identity, pid, token, acquiredAtMs };
}

/**
 * Takes the per-identity resync lock, held for the whole of a resync and released before the real `claude` binary is spawned.
 *
 * Two terminals in two different client directories under one identity is exactly the pattern directory rules exist to support, and it is exactly the pattern that races: both launches resolve their own cascade and both want to rewrite the same identity's farm toward two different states. This serialises them.
 *
 * Mutual exclusion rests on one exclusive-create — a read-then-write pair would leave a window where both processes see no lock. A lock whose holder is no longer running, or whose record is older than the staleness window, or whose contents cannot be parsed at all, is removed and retaken: a machine that crashed mid-resync must not need manual cleanup before `claude` works again. A lock genuinely held by a live process is waited on, and only after the full retry budget does this give up — loudly, with the holder's pid, rather than proceeding unsynchronised.
 */
export function acquireIdentityLock(params: AcquireIdentityLockParams): IdentityLock {
  const lockPath = identityLockPath(params.dir, params.identity);
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const token = randomUUID();

  // Only created when genuinely absent: a resync that turns out to be a no-op must perform no filesystem write at all beyond the lock file itself, and an unconditional mkdir would be one.
  if (params.fs.lstat(params.dir) === undefined) {
    params.fs.mkdirp(params.dir);
  }

  let lastHolderPid: number | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const record: LockRecord = { identity: params.identity, pid: params.pid, token, acquiredAtMs: params.nowMs() };
    if (params.fs.writeFileExclusive(lockPath, `${JSON.stringify(record)}\n`)) {
      return {
        path: lockPath,
        token,
        release: () => {
          const current = parseLockRecord(params.fs.readFileUtf8(lockPath));
          if (current !== undefined && current.token !== token) {
            return;
          }
          params.fs.removeRecursive(lockPath);
        },
      };
    }

    const existing = parseLockRecord(params.fs.readFileUtf8(lockPath));
    if (existing === undefined) {
      // Either the holder vanished between the failed create and this read, or the file is unparseable — a truncated write from a process killed mid-`writeFileExclusive`. Neither is a lock anyone is relying on.
      params.fs.removeRecursive(lockPath);
      continue;
    }
    lastHolderPid = existing.pid;
    const expired = params.nowMs() - existing.acquiredAtMs > staleAfterMs;
    if (expired || !params.isRunning(existing.pid)) {
      params.fs.removeRecursive(lockPath);
      continue;
    }
    params.sleep(retryDelayMs);
  }

  throw new IdentityLockBusyError(params.identity, lockPath, lastHolderPid);
}
