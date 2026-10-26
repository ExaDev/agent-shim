import type { LayoutPaths } from "../paths";
import { HEADROOM_START_TIMEOUT_MS, startSupervisorUnderLock, type EnsureHeadroomPorts } from "./ensure";
import { listSessions, readStartLock, resolveServingHeadroomState, writeSession } from "./state";

/** Every effect the keeper performs, injected so a tick runs against fakes in tests. */
export interface HeadroomKeeperPorts {
  readonly paths: LayoutPaths;
  /** The pid the keeper holds the start lock as: the long-lived process running it, never a launcher. */
  readonly ownPid: number;
  readonly ports: Pick<EnsureHeadroomPorts, "fs" | "now" | "isRunning" | "spawnSupervisor">;
  readonly log: (message: string) => void;
}

/** What one keeper tick found and did. */
export type HeadroomKeeperOutcome =
  /** A supervisor is alive. Any launcher still registered against a supervisor that is gone was bound to the live one. */
  | { readonly kind: "serving"; readonly rebound: readonly number[] }
  /** No supervisor is alive and no live launcher is registered against a dead one: the idle shutdown the supervisor chose, which nothing should undo. */
  | { readonly kind: "idle" }
  /** No supervisor is alive, live launchers need one, and the last attempt is too recent to judge: a start is given as long as one launch gives it. */
  | { readonly kind: "backing-off"; readonly waiting: number }
  /** No supervisor is alive and live launchers need one: this tick tried to start it. */
  | { readonly kind: "starting"; readonly start: "spawned" | "held" | "cleared-stale-lock"; readonly waiting: number };

/**
 * Keeps the headroom supervisor alive for as long as a launcher that routes through it is.
 *
 * Only a launch ever started the supervisor, so one that exited (a signal, a crash, a package upgrade that removed the interpreter it ran from) left every running session's requests failing with a bad gateway at the front door's hop until some unrelated launch happened to start another. The front door is the long-lived process that sees those requests fail, so it runs this on its own cadence.
 *
 * A launcher counts as needing the supervisor when it is alive and is registered against a supervisor that is not: the supervisor's own idle shutdown removes nothing a live launcher is registered against, so that state can only mean it died. The supervisor is started through `startSupervisorUnderLock`, the step a launch uses, so a launch and the keeper never start two. A start that has not produced a live supervisor within `HEADROOM_START_TIMEOUT_MS`, the bound a launch waits for one, is attempted again, and not before.
 *
 * Once a supervisor is alive, the launchers registered against a dead one are re-registered against it. Without that the new supervisor has no sessions of its own, so it would shut itself down after its idle period and leave the same failure behind.
 */
export function createHeadroomKeeper(deps: HeadroomKeeperPorts): { readonly tick: () => HeadroomKeeperOutcome } {
  const { paths, ports, log } = deps;
  let lastAttemptAt: number | undefined;

  /** Removes the start lock this keeper holds, so a later launch or tick can take it: the lock otherwise lives as long as its holder. */
  const releaseOwnLock = (): void => {
    if (readStartLock(ports.fs, paths.headroomLockFile)?.pid === deps.ownPid) {
      ports.fs.removeRecursive(paths.headroomLockFile);
    }
  };

  const tick = (): HeadroomKeeperOutcome => {
    const state = resolveServingHeadroomState(ports.fs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, ports.isRunning)?.state;
    const supervisorPid = state?.supervisorPid;
    const orphans = listSessions(ports.fs, paths.headroomSessionsDir).filter((session) => ports.isRunning(session.pid) && !ports.isRunning(session.supervisorPid));

    if (supervisorPid !== undefined && ports.isRunning(supervisorPid)) {
      lastAttemptAt = undefined;
      releaseOwnLock();
      for (const session of orphans) {
        writeSession(ports.fs, paths.headroomSessionsDir, { ...session, supervisorPid });
      }
      if (orphans.length > 0) {
        log(`front door: re-registered ${String(orphans.length)} launcher(s) against headroom supervisor ${String(supervisorPid)}`);
      }
      return { kind: "serving", rebound: orphans.map((session) => session.pid) };
    }

    if (orphans.length === 0) {
      return { kind: "idle" };
    }
    if (lastAttemptAt !== undefined && ports.now() - lastAttemptAt < HEADROOM_START_TIMEOUT_MS) {
      return { kind: "backing-off", waiting: orphans.length };
    }
    // A previous attempt that never produced a supervisor leaves this keeper's own lock behind, which would read as someone else's start in progress.
    releaseOwnLock();
    lastAttemptAt = ports.now();
    const start = startSupervisorUnderLock({ paths, holderPid: deps.ownPid, ports });
    log(`front door: headroom supervisor is not running and ${String(orphans.length)} launcher(s) are registered against it (${start})`);
    return { kind: "starting", start, waiting: orphans.length };
  };

  return { tick };
}
