import { randomUUID } from "node:crypto";

import type { Pool } from "../config/schema";
import type { FarmRuntime, LaunchPlan } from "../launcher";
import { hasSettingsArgument, initialConversationOf, type SupervisedLaunch } from "../launcher/claudeSession";
import { isClaudeSubcommand } from "../launcher/claudeSubcommand";
import { resolvePoolLaunch } from "../launcher/pool";
import type { LogPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { refreshPools } from "../poolUsageRefresh";
import { realFarmFs, realFsPort, selfInvocation, type DaemonSpawner } from "../realPorts";
import { latestConversationId, resumedContextTokens } from "../usage/resumeContext";
import { createCompactionDeps } from "./compactionDeps";
import { quotaHitOf } from "./limit";
import { markHooksSettings } from "./marks";
import { createIdentityMover, createMover } from "./move";
import { createRealCompactor } from "./realCompact";
import { realSignalPort, realSupervisedSpawnPort, realTimerPort, realWatchDirectory, resetTerminal } from "./realPorts";
import { readModelMove, registerSupervised, removeModelMove, stateDirOf, unregisterSupervised } from "./registry";
import { supervise, type CompactionDeps } from "./supervise";

/**
 * Whether a launch on `pool` is run under the supervisor: the pool resumes on a spent quota and the arguments start a session. A claude subcommand (`plugin install`, `auth status`) starts none, so there is no conversation to move to another member and the supervisor's `--session-id` would be rejected as an unknown option.
 */
export function supervisesLaunch(pool: Pick<Pool, "resumeOnLimit"> | undefined, passthrough: readonly string[]): boolean {
  return pool?.resumeOnLimit === true && !isClaudeSubcommand(passthrough);
}

/** What `runSupervised` needs from the launcher that calls it. */
export interface RunSupervisedParams {
  readonly paths: LayoutPaths;
  /** The pool the launch selected, which has `resumeOnLimit` on. */
  readonly pool: string;
  readonly pools: Readonly<Record<string, Pool>>;
  readonly farm: FarmRuntime;
  /** The arguments claude will receive, as the person typed them. */
  readonly passthrough: readonly string[];
  /** Builds the plan for one launch: `prepareLaunch` over this machine's ports, with the supervised parameter set. */
  readonly prepare: (launch: SupervisedLaunch) => LaunchPlan;
  readonly spawnDaemon: DaemonSpawner;
  readonly log: LogPort;
}

/**
 * Runs a pool launch under the supervisor and returns the exit code the launcher exits with, or undefined when this launch cannot be supervised (it is not an interactive terminal, or its conversation names no id to resume), in which case the caller runs it as an ordinary launch.
 *
 * A launch that cannot be supervised says why once on the way, except where being unsupervised is the ordinary case (a script, a pipe, a print run).
 */
export async function runSupervised(params: Readonly<RunSupervisedParams>): Promise<number | undefined> {
  const { paths, pool, farm, log } = params;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  if (process.platform === "win32") {
    log.warn(`agent-shim: pool "${pool}" resumes on a spent quota, which needs a POSIX terminal; this launch runs unsupervised`);
    return undefined;
  }
  const first = initialConversationOf(params.passthrough, { newId: randomUUID, latestId: () => latestConversationId(farm.fs, { claudeHome: farm.claudeHome, cwd: farm.cwd }) });
  if ("reason" in first) {
    log.warn(`agent-shim: pool "${pool}" resumes on a spent quota, but this launch runs unsupervised: ${first.reason}`);
    return undefined;
  }
  // Compacting needs to know when a turn begins and ends, which the session's own hooks tell it. They are passed with `--settings`, which a launch that passes its own cannot take.
  let launch: SupervisedLaunch = first;
  let compaction: CompactionDeps | undefined;
  const policy = params.pools[pool];
  if (policy?.compactBeforeLimit === true) {
    if (hasSettingsArgument(params.passthrough)) {
      log.warn(`agent-shim: pool "${pool}" compacts before its quota is spent, which needs --settings for its turn hooks; this launch passes its own, so it moves without compacting`);
    } else {
      launch = { ...first, settings: markHooksSettings(selfInvocation([]), paths.root, pool, first.sessionId) };
      compaction = createCompactionDeps({
        paths,
        fs: realFarmFs,
        pool,
        policy,
        pid: farm.lock.pid,
        now: farm.now,
        isRunning: farm.lock.isRunning,
        sleep: farm.lock.sleep,
        compact: createRealCompactor({ paths, spawnDaemon: params.spawnDaemon }),
      });
    }
  }
  const mover = createMover({
    paths,
    fs: realFsPort,
    farmFs: realFarmFs,
    pool,
    pools: params.pools,
    cwd: farm.cwd,
    pid: farm.lock.pid,
    now: farm.now,
    isRunning: farm.lock.isRunning,
    sleep: farm.lock.sleep,
    pickMember: resolvePoolLaunch,
    log,
  });
  const identityMover = createIdentityMover({
    paths,
    fs: realFsPort,
    farmFs: realFarmFs,
    pool,
    pools: params.pools,
    cwd: farm.cwd,
    pid: farm.lock.pid,
    now: farm.now,
    isRunning: farm.lock.isRunning,
    sleep: farm.lock.sleep,
    pickMember: resolvePoolLaunch,
    log,
  });
  return await supervise(
    {
      pool,
      cwd: farm.cwd,
      pid: farm.lock.pid,
      prepare: params.prepare,
      spawn: realSupervisedSpawnPort,
      signals: realSignalPort,
      timer: realTimerPort,
      watchChanges: (identity, onChange) => {
        const stopSnapshot = realWatchDirectory(paths.usageSnapshotsDir, (filename) => filename === `${identity}.json`, `${identity}'s usage`, log)(onChange);
        // The end of a turn is recorded after its last response has updated the snapshot, so a session that has just gone idle is only seen by watching the state. The whole pool's state is watched: a sibling that finished compacting frees the identity's slot for the next session.
        const stopState = compaction === undefined ? undefined : realWatchDirectory(stateDirOf(paths, pool), (filename) => filename.endsWith(".json"), "the pool's sessions", log)(onChange);
        return () => {
          stopSnapshot();
          stopState?.();
        };
      },
      quotaHit: (identity, sessionId, sinceMs) => quotaHitOf(realFarmFs, paths, identity, sessionId, sinceMs, farm.now()),
      decideMove: async (request) => {
        // The ranking reads recorded usage, which only moves when a request passes the door: members whose record has gone stale are asked for current figures first, as at a launch.
        await refreshPools({ paths, cwd: farm.cwd, poolNames: [pool], spawnDaemon: params.spawnDaemon, log: (line) => { log.warn(line); } });
        return mover(request);
      },
      contextTokens: (sessionId) => resumedContextTokens(farm.fs, { claudeHome: farm.claudeHome, cwd: farm.cwd, passthrough: ["--resume", sessionId] }),
      claimModelMove: (sessionId) => {
        const request = readModelMove(realFarmFs, paths, sessionId);
        if (request === undefined) {
          return undefined;
        }
        removeModelMove(realFarmFs, paths, sessionId);
        return { to: request.to, model: request.model };
      },
      decideRemodel: (request) => identityMover({ sessionId: request.sessionId, from: request.from, to: request.to, contextTokens: undefined }),
      watchModelMoves: (onChange) => realWatchDirectory(paths.modelMovesDir, () => true, "the model-move requests", log)(onChange),
      ...(compaction === undefined ? {} : { compaction }),
      register: (session) => {
        registerSupervised(realFarmFs, paths, session);
      },
      unregister: (sessionId) => {
        unregisterSupervised(realFarmFs, paths, pool, sessionId);
      },
      resetTerminal,
      now: farm.now,
      log,
    },
    launch,
  );
}
