import type { Pool } from "../config/schema";
import { IdentityLockBusyError, acquireIdentityLock } from "../launcher/lock";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { FIVE_HOUR_WINDOW_MS } from "../usage/pick";
import { readUsageLog, readUsageSnapshot } from "../usage/read";
import { decideCompaction } from "./compaction";
import { COMPACT_TIMEOUT_MS, type CompactionResult, type CompactRequest } from "./realCompact";
import { liveSupervised, readSessionState, superviseDirOf, writeSessionState, type SessionState, type SupervisedSession } from "./registry";
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
  /** True only after the session's transcript proves its Stop hooks completed successfully. */
  readonly hooksFinished: (session: Readonly<SupervisedSession>, state: Readonly<SessionState>) => boolean;
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
      const registry = liveSupervised(fs, paths, pool, wiring.isRunning).filter((session) => session.identity === identity);
      const sessions = registry.map((session) => ({ sessionId: session.sessionId, state: readSessionState(fs, paths, pool, session.sessionId) }));
      const decision = decideCompaction({
        atUtilisation: wiring.policy.compactAtUtilisation,
        snapshot: readUsageSnapshot(fs, paths.usageSnapshotsDir, identity),
        records: () => readUsageLog(fs, paths.usageLogDir, { sinceMs: nowMs - FIVE_HOUR_WINDOW_MS }).records.filter((record) => record.identity === identity),
        sessions,
        sessionId,
        nowMs,
      });
      if (!decision.compact) {
        return decision;
      }
      const own = registry.find((session) => session.sessionId === sessionId);
      const state = sessions.find((session) => session.sessionId === sessionId)?.state;
      if (own === undefined || state === undefined || !wiring.hooksFinished(own, state)) {
        return { compact: false, reason: "the turn's Stop hooks have not finished successfully" };
      }
      return decision;
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
        ...(previous?.conversationId === undefined ? {} : { conversationId: previous.conversationId }),
        ...(previous?.transcriptPath === undefined ? {} : { transcriptPath: previous.transcriptPath }),
        ...(previous?.promptId === undefined ? {} : { promptId: previous.promptId }),
        ...(previous?.unavailable === true ? { unavailable: true } : {}),
        ...(previous?.contextTokens === undefined ? {} : { contextTokens: previous.contextTokens }),
        ...(compacted ? { compacted: true } : {}),
        at: new Date(wiring.now()).toISOString(),
      });
    },
  };
}
