import path from "node:path";

import { acquireIdentityLock } from "../launcher/lock";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { readSessionState, stateDirOf } from "./registry";

/** The operations a hook needs to announce itself and serialise its state update. */
export interface HookGuardDeps {
  readonly fs: FarmFs;
  readonly paths: LayoutPaths;
  readonly pid: number;
  readonly now: () => number;
  readonly isRunning: (pid: number) => boolean;
  readonly sleep: (ms: number) => void;
  readonly maxAttempts?: number;
}

function prefixOf(sessionId: string): string {
  return `${sessionId}.hook.`;
}

/** Whether `filename`, a name in the pool's state directory, is one of `sessionId`'s own: its state file, whose name is `stateFile`, or a hook announcement it left. The directory is shared with every concurrent session, and a name that is another session's, or a lock, is none of its business. */
export function isSessionStateFile(sessionId: string, stateFile: string, filename: string): boolean {
  return filename === stateFile || (filename.startsWith(prefixOf(sessionId)) && filename.endsWith(".json"));
}

/** Whether a hook is still processing or failed before it could safely record its state. */
export function hooksPending(fs: Pick<FarmFs, "readdir">, paths: LayoutPaths, pool: string, sessionId: string): boolean {
  return fs.readdir(stateDirOf(paths, pool)).some((name) => name.startsWith(prefixOf(sessionId)) && name.endsWith(".json"));
}

/** The current conversation, only when no hook is pending or has failed. */
export function currentConversation(fs: Pick<FarmFs, "readFileUtf8" | "readdir">, paths: LayoutPaths, pool: string, sessionId: string): string | undefined {
  const state = readSessionState(fs, paths, pool, sessionId);
  return state === undefined || state.unavailable === true || hooksPending(fs, paths, pool, sessionId) ? undefined : (state.conversationId ?? sessionId);
}

/** A held hook-state lock and its pending announcement. */
export interface HookGuard {
  readonly finish: (success: boolean, newTurn: boolean) => void;
}

/** Announces a hook before it reads stdin. The lock is acquired afterwards so no hook can hold it while waiting for input. A failed hook leaves its announcement behind; a later successful start clears announcements whose processes have exited. */
export function announceHook(deps: Readonly<HookGuardDeps>, pool: string, sessionId: string): { readonly acquire: () => HookGuard } {
  const dir = stateDirOf(deps.paths, pool);
  deps.fs.mkdirPrivate(dir);
  const marker = path.join(dir, `${prefixOf(sessionId)}${String(deps.pid)}.json`);
  // A marker for this PID can be left by a failed hook whose PID was reused. Keep it visible while this hook runs.
  const created = deps.fs.writeFileExclusive(marker, `${JSON.stringify({ pid: deps.pid })}\n`);
  return {
    acquire: () => {
      const lock = acquireIdentityLock({ identity: `mark-${sessionId}`, dir, fs: deps.fs, nowMs: deps.now, pid: deps.pid, isRunning: deps.isRunning, sleep: deps.sleep, ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }) });
      return {
        finish: (success, newTurn) => {
          try {
            if (success && newTurn) {
              for (const name of deps.fs.readdir(dir)) {
                if (!name.startsWith(prefixOf(sessionId)) || !name.endsWith(".json")) {
                  continue;
                }
                const pidText = name.slice(prefixOf(sessionId).length, -".json".length);
                const pid = Number(pidText);
                if (Number.isSafeInteger(pid) && pid > 0 && pid !== deps.pid && !deps.isRunning(pid)) {
                  deps.fs.removeRecursive(path.join(dir, name));
                }
              }
            }
            if (success && (created || newTurn)) {
              deps.fs.removeRecursive(marker);
            }
          } finally {
            lock.release();
          }
        },
      };
    },
  };
}
