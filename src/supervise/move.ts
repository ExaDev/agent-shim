import path from "node:path";

import type { Pool } from "../config/schema";
import { IdentityLockBusyError, acquireIdentityLock } from "../launcher/lock";
import type { FarmFs, FsPort, LogPort } from "../launcher/ports";
import type { PoolResolution, ResolvePoolParams } from "../launcher/pool";
import type { LayoutPaths } from "../paths";
import { recordStickyPick } from "../usage/poolPick";
import { readUsageLog } from "../usage/read";
import { projectDirNameOf } from "../usage/resumeContext";
import { committedContextTokens, liveSupervised, registerSupervised, superviseDirOf } from "./registry";

/** One session asking to leave the identity it has run out of quota on. */
export interface MoveRequest {
  readonly sessionId: string;
  /** The identity the session is leaving. */
  readonly from: string;
  /** The size in tokens of the conversation's context, when its transcript was read: what the new member must write again. */
  readonly contextTokens: number | undefined;
}

/** What a move came to: the member the session now belongs to (already registered for it), or why it stays where it is. */
export type MoveOutcome =
  | { readonly kind: "move"; readonly to: string; readonly explanation: string }
  | { readonly kind: "stay"; readonly reason: string };

/** Everything the coordinator needs, injected so it runs against the same fakes as the rest of the launcher. */
export interface MoverDeps {
  readonly paths: LayoutPaths;
  /** Reads identity files, so a member whose identity was removed is skipped as a launch skips it. */
  readonly fs: FsPort;
  /** The usage store, the registry, the lock and the transcripts the next member would see. */
  readonly farmFs: FarmFs;
  readonly pool: string;
  readonly pools: Readonly<Record<string, Pool>>;
  readonly cwd: string;
  /** The supervising launcher's process id, which marks its registry entries as live. */
  readonly pid: number;
  readonly now: () => number;
  readonly isRunning: (pid: number) => boolean;
  /** Blocks while the move lock is held by another launcher: synchronous, because a move is a few file reads and the lock is held for no longer. */
  readonly sleep: (ms: number) => void;
  /** Picks a member for a conversation being resumed: `resolvePoolLaunch` in production. */
  readonly pickMember: (params: ResolvePoolParams) => PoolResolution;
  readonly log: LogPort;
}

/**
 * The move coordinator for one pool: takes a session's request to leave a member it has run out of quota on and, under one lock shared by every supervising launcher of the pool, decides where it goes.
 *
 * Under the lock a move is: read the pool's live sessions, count the context the ones already moved are carrying onto each member and have not yet written there (`committedContextTokens`), re-rank the pool for the resumed conversation with those counted, check the chosen member can see the conversation's transcript, record the pick, and register the session on its new member with the context it carries. The registration is inside the lock, so the next session to move sees this one's commitment instead of ranking the same member as if it were empty.
 *
 * The session stays put, with the reason, when the pool has no other member that can take it, or the member it would go to does not share the conversation's history.
 */
export function createMover(deps: Readonly<MoverDeps>): (request: MoveRequest) => MoveOutcome {
  const { paths, farmFs, pool } = deps;
  return (request) => {
    let lock;
    try {
      lock = acquireIdentityLock({ identity: "move", dir: superviseDirOf(paths, pool), fs: farmFs, nowMs: deps.now, pid: deps.pid, isRunning: deps.isRunning, sleep: deps.sleep });
    } catch (error) {
      if (error instanceof IdentityLockBusyError) {
        return { kind: "stay", reason: error.message };
      }
      throw error;
    }
    try {
      const others = liveSupervised(farmFs, paths, pool, deps.isRunning).filter((session) => session.sessionId !== request.sessionId);
      const carrying = others.filter((session) => session.carriedTokens !== undefined);
      const records = carrying.length === 0 ? [] : readUsageLog(farmFs, paths.usageLogDir, { sinceMs: Math.min(...carrying.map((session) => Date.parse(session.since))) }).records;
      const committed = committedContextTokens(others, records);
      const resolution = deps.pickMember({
        poolName: pool,
        selectedVia: "the supervising launcher",
        pools: deps.pools,
        paths,
        fs: deps.fs,
        usageFs: farmFs,
        cwd: deps.cwd,
        now: deps.now,
        sleep: deps.sleep,
        passthrough: ["--resume", request.sessionId],
        ...(request.contextTokens === undefined ? {} : { resumeContextTokens: request.contextTokens }),
        ...(Object.keys(committed).length === 0 ? {} : { committedContextTokens: committed }),
        wait: false,
        // Recorded below, once the member is known to be able to resume the conversation: a pick that is then refused must leave the directory's last pick as it was.
        recordPick: false,
        log: deps.log,
      });
      if (!resolution.ok) {
        return { kind: "stay", reason: resolution.message };
      }
      if (resolution.identity === request.from) {
        return { kind: "stay", reason: `no other member of pool "${pool}" can take it` };
      }
      const transcript = path.join(paths.identitiesDir, resolution.identity, "projects", projectDirNameOf(deps.cwd), `${request.sessionId}.jsonl`);
      if (farmFs.lstat(transcript)?.kind !== "file") {
        return { kind: "stay", reason: `${resolution.identity} does not share this conversation's history, so it could not resume it` };
      }
      const nowMs = deps.now();
      recordStickyPick(farmFs, paths.usagePicksFile, deps.cwd, resolution.identity, nowMs);
      registerSupervised(farmFs, paths, {
        pid: deps.pid,
        sessionId: request.sessionId,
        pool,
        identity: resolution.identity,
        cwd: deps.cwd,
        since: new Date(nowMs).toISOString(),
        ...(request.contextTokens === undefined ? {} : { carriedTokens: request.contextTokens }),
      });
      return { kind: "move", to: resolution.identity, explanation: resolution.explanation };
    } finally {
      lock.release();
    }
  };
}
