import type { Pool } from "../config/schema";
import { IdentityLockBusyError, acquireIdentityLock } from "../launcher/lock";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { FIVE_HOUR_WINDOW_MS } from "../usage/pick";
import { readUsageLog, readUsageSnapshot } from "../usage/read";
import { decideCompaction } from "./compaction";
import { COMPACT_TIMEOUT_MS, type CompactionResult, type CompactRequest } from "./realCompact";
import { liveSupervised, readSessionState, superviseDirOf, writeSessionState } from "./registry";
import type { CompactionDeps } from "./supervise";

/** A compaction slot older than this is abandoned whoever claims to hold it, since a pid can be reused. Twice the longest a compaction may run, which also covers stopping the child before it and the preparation of the launch it needs. */
const COMPACT_SLOT_STALE_MS = COMPACT_TIMEOUT_MS * 2;

/** What the compaction dependencies need from the launcher that supervises the session. */
export interface CompactionWiring {
  readonly paths: LayoutPaths;
  readonly fs: FarmFs;
  readonly pool: string;
  /** The pool's own policy: only `compactAtUtilisation` matters here. */
  readonly policy: Readonly<Pick<Pool, "compactAtUtilisation">>;
  /** The supervising launcher's process id, which marks the slot it holds as live. */
  readonly pid: number;
  readonly now: () => number;
  readonly isRunning: (pid: number) => boolean;
  readonly sleep: (ms: number) => void;
  /** Compacts a conversation as an identity: the real one runs `/compact` through the Agent SDK. */
  readonly compact: (request: CompactRequest, signal: AbortSignal) => Promise<CompactionResult>;
}

/**
 * The compaction dependencies of one supervised session, over the pool's shared registry: the decision reads the sessions on the identity and what their hooks recorded, the identity's snapshot and, only for the one session that could go, its recent usage records; the slot is one lock file per identity, taken without waiting, so a session that finds it held simply looks again at the next change; and `markCompacted` writes the flag the other sessions' decisions read.
 */
export function createCompactionDeps(wiring: Readonly<CompactionWiring>): CompactionDeps {
  const { paths, fs, pool } = wiring;
  return {
    shouldCompact: (identity, sessionId) => {
      const nowMs = wiring.now();
      const sessions = liveSupervised(fs, paths, pool, wiring.isRunning)
        .filter((session) => session.identity === identity)
        .map((session) => ({ sessionId: session.sessionId, state: readSessionState(fs, paths, pool, session.sessionId) }));
      return decideCompaction({
        atUtilisation: wiring.policy.compactAtUtilisation,
        snapshot: readUsageSnapshot(fs, paths.usageSnapshotsDir, identity),
        records: () => readUsageLog(fs, paths.usageLogDir, { sinceMs: nowMs - FIVE_HOUR_WINDOW_MS }).records.filter((record) => record.identity === identity),
        sessions,
        sessionId,
        nowMs,
      });
    },
    acquire: (identity) => {
      try {
        const lock = acquireIdentityLock({ identity: `compact-${identity}`, dir: superviseDirOf(paths, pool), fs, nowMs: wiring.now, pid: wiring.pid, isRunning: wiring.isRunning, sleep: wiring.sleep, maxAttempts: 1, staleAfterMs: COMPACT_SLOT_STALE_MS });
        return { release: lock.release };
      } catch (error) {
        if (error instanceof IdentityLockBusyError) {
          return undefined;
        }
        throw error;
      }
    },
    compact: wiring.compact,
    markCompacted: (sessionId, compacted) => {
      const previous = readSessionState(fs, paths, pool, sessionId);
      writeSessionState(fs, paths, pool, sessionId, {
        mark: previous?.mark ?? "idle",
        ...(previous?.contextTokens === undefined ? {} : { contextTokens: previous.contextTokens }),
        ...(compacted ? { compacted: true } : {}),
        at: new Date(wiring.now()).toISOString(),
      });
    },
  };
}
