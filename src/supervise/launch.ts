import { createHash, randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import packageJson from "../../package.json";

import type { Pool } from "../config/schema";
import type { FarmRuntime, LaunchPlan } from "../launcher";
import { combineCallerSettings, hasSettingsArgument, initialConversationOf, type SupervisedLaunch } from "../launcher/claudeSession";
import { isClaudeSubcommand } from "../launcher/claudeSubcommand";
import { resolvePoolLaunch } from "../launcher/pool";
import type { LogPort } from "../launcher/ports";
import { identityRecordsOver } from "../identityRecords";
import type { LayoutPaths } from "../paths";
import { refreshPools } from "../poolUsageRefresh";
import { realContentSourcePath, realFarmFs, realFsPort, selfInvocation, type DaemonSpawner } from "../realPorts";
import { contextTokensOfTranscript, latestConversationId } from "../usage/resumeContext";
import { createCompactionDeps } from "./compactionDeps";
import { quotaHitOf } from "./limit";
import { createLifecycleRecorder } from "./lifecycle";
import { currentConversation, hooksPending } from "./hookGuard";
import { COMPACT_TIMEOUT_MS } from "./compactTimeout";
import { compactInSession, sessionControlReady } from "./sessionControl";
import { stageSessionControlPlugin, withSessionControlPlugin } from "./sessionControlPlugin";
import { markHooksSettings } from "./marks";
import { createIdentityMover, createMover } from "./move";
import { createRealCompactor } from "./realCompact";
import { realSignalPort, realSupervisedSpawnPort, realTimerPort, realWatchDirectory, realWatchExistingDirectory, resetTerminal } from "./realPorts";
import { readModelMove, readSessionState, registerSupervised, removeModelMove, unregisterSupervised, writeSessionControl } from "./registry";
import { stopHooksFinished } from "./stopSummary";
import { stageSupervisedSettings } from "./settings";
import { supervise, type CompactionDeps } from "./supervise";
import { watchSessionFiles } from "./watchSession";

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
  /** Additional Claude flags placed before the caller's arguments. */
  readonly extraFlags: readonly string[];
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
  if (params.extraFlags.includes("--")) {
    log.warn(`agent-shim: pool "${pool}" cannot supervise a launch whose extra flags end option parsing`);
    return undefined;
  }
  const first = initialConversationOf(params.passthrough, { newId: randomUUID, latestId: () => latestConversationId(farm.fs, { claudeHome: farm.claudeHome, cwd: farm.cwd }) });
  if ("reason" in first) {
    log.warn(`agent-shim: pool "${pool}" resumes on a spent quota, but this launch runs unsupervised: ${first.reason}`);
    return undefined;
  }
  let entrypointSha256AtStart: string | null;
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(realContentSourcePath()), hash);
    entrypointSha256AtStart = hash.digest("hex");
  } catch {
    entrypointSha256AtStart = null;
    log.warn("agent-shim: could not fingerprint the supervisor entrypoint");
  }
  const lifecycle = createLifecycleRecorder({ fs: realFarmFs, logsDir: paths.logsDir, fileId: randomUUID(), sessionId: first.sessionId, supervisorPid: farm.lock.pid, supervisorVersion: packageJson.version, entrypointSha256AtStart, now: farm.now, log });
  // The hooks also identify the current conversation after /clear, which moves need even when the pool does not compact.
  let compaction: CompactionDeps | undefined;
  const policy = params.pools[pool];
  const markSettings = markHooksSettings(selfInvocation([]), paths.root, pool, first.sessionId);
  const settingsArgs = [...params.extraFlags, ...params.passthrough];
  const settings = hasSettingsArgument(settingsArgs) ? combineCallerSettings(settingsArgs, markSettings, (name) => farm.fs.readFileUtf8(path.resolve(farm.cwd, name))) : undefined;
  // Every supervised launch loads the control plugin: the supervisor compacts through it when the pool asks for that, and the door reaches the session through it for the goal and compaction verbs, finding it through the directory the registry entry names.
  const plugin = stageSessionControlPlugin();
  if (policy?.compactBeforeLimit === true) {
      const baseCompaction = createCompactionDeps({
        paths,
        fs: realFarmFs,
        pool,
        policy,
        pid: farm.lock.pid,
        now: farm.now,
        isRunning: farm.lock.isRunning,
        sleep: farm.lock.sleep,
        hooksFinished: (session, state) => {
          if (hooksPending(realFarmFs, paths, pool, session.sessionId)) {
            return false;
          }
          const conversationId = state.conversationId ?? session.sessionId;
          const text = state.transcriptPath === undefined ? undefined : realFarmFs.readFileUtf8(state.transcriptPath);
          return text !== undefined && stopHooksFinished(text, conversationId, state.at);
        },
        compact: createRealCompactor({ paths, spawnDaemon: params.spawnDaemon }),
      });
      compaction = { ...baseCompaction, live: { ready: () => sessionControlReady(plugin), compact: async (conversationId, signal) => await compactInSession(plugin, conversationId, { signal, expiresInMs: COMPACT_TIMEOUT_MS }) } };
  }
  // The supervisor moves a session only after an Anthropic quota refusal, so both movers rank the pool on each member's Claude account and pass no `providerOf`.
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
  const staged = settings === undefined ? undefined : stageSupervisedSettings(realFarmFs, paths, pool, first.sessionId, farm.lock.pid, settings);
  const launch: SupervisedLaunch = { ...first, ...(staged === undefined ? { settings: markSettings } : { settingsFile: staged.file }) };
  try {
    return await supervise(
    {
      pool,
      cwd: farm.cwd,
      pid: farm.lock.pid,
      lifecycle,
      prepare: (nextLaunch) => {
        const plan = params.prepare(nextLaunch);
        rmSync(plugin.ready, { force: true });
        return { ...plan, args: withSessionControlPlugin(plan.args, plugin.directory) };
      },
      spawn: realSupervisedSpawnPort,
      signals: realSignalPort,
      timer: realTimerPort,
      watchChanges: (identity, onChange) => {
        const stopPlugin = realWatchExistingDirectory(plugin.directory, (filename) => filename === "ready.json", "the control plugin", log)(onChange);
        const stopSnapshot = realWatchDirectory(paths.usageSnapshotsDir, (filename) => filename === `${identity}.json`, `${identity}'s usage`, log)(onChange);
        const stopSession = watchSessionFiles({ paths, pool, sessionId: first.sessionId, watchTranscript: compaction !== undefined, fs: realFarmFs, log, watch: { directory: realWatchDirectory, existingDirectory: realWatchExistingDirectory } })(onChange);
        if (sessionControlReady(plugin)) queueMicrotask(onChange);
        return () => {
          stopPlugin();
          stopSnapshot();
          stopSession();
        };
      },
      quotaHit: (identity, sessionId, sinceMs) => quotaHitOf(realFarmFs, paths, identity, sessionId, sinceMs, farm.now()),
      decideMove: async (request) => {
        // The ranking reads recorded usage, which only moves when a request passes the door: members whose record has gone stale are asked for current figures first, as at a launch.
        await refreshPools({ paths, cwd: farm.cwd, poolNames: [pool], spawnDaemon: params.spawnDaemon, log: (line) => { log.warn(line); } });
        return mover(request);
      },
      contextTokens: (sessionId) => {
        const state = readSessionState(realFarmFs, paths, pool, first.sessionId);
        if (state?.transcriptPath === undefined || (state.conversationId ?? first.sessionId) !== sessionId) {
          return undefined;
        }
        const transcript = realFarmFs.readFileUtf8(state.transcriptPath);
        return transcript === undefined ? undefined : contextTokensOfTranscript(transcript);
      },
      currentConversationId: (sessionId) => currentConversation(realFarmFs, paths, pool, sessionId),
      claimModelMove: (sessionId) => {
        const request = readModelMove(realFarmFs, paths, sessionId);
        if (request === undefined) {
          return undefined;
        }
        removeModelMove(realFarmFs, paths, sessionId);
        return { to: request.to, model: request.model };
      },
      decideRemodel: (request) => identityMover(request),
      watchModelMoves: (onChange) => realWatchDirectory(paths.modelMovesDir, () => true, "the model-move requests", log)(onChange),
      ...(compaction === undefined ? {} : { compaction }),
      register: (session) => {
        registerSupervised(realFarmFs, paths, session);
        writeSessionControl(realFarmFs, paths, pool, session.sessionId, { pid: session.pid, directory: plugin.directory });
      },
      unregister: (sessionId) => {
        unregisterSupervised(realFarmFs, paths, pool, sessionId);
      },
      resetTerminal,
      now: farm.now,
      log,
      // An identity whose name cannot be read is named by its id, which reaches it, so its relaunch reports the file.
      nameOf: (id) => {
        const record = identityRecordsOver(realFarmFs, paths.identitiesDir).find((candidate) => candidate.id === id);
        return record === undefined ? undefined : (record.name ?? record.id);
      },
    },
    launch,
    );
  } finally {
    staged?.release();
    plugin.release();
  }
}
