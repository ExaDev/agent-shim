import { acquireIdentityNamesLock } from "./identityNamesLock";
import { acquireIdentityLock, type AcquireIdentityLockParams, type IdentityLock } from "./launcher/lock";
import type { FarmFs } from "./launcher/ports";
import type { LayoutPaths } from "./paths";

/** What taking a rename's locks needs: the filesystem the lock files are written through and the lock's own ports (the rename's `IdentityRenamePorts` carry both). */
export interface RenameLockPorts {
  readonly fs: FarmFs;
  readonly lock: Pick<AcquireIdentityLockParams, "nowMs" | "pid" | "isRunning" | "sleep">;
}

/** The identity names lock and the resync locks a rename holds. */
export interface HeldLocks {
  /** Restarts each lock's staleness clock; throws `IdentityLockLostError` when one was taken over. */
  readonly refresh: () => void;
  readonly release: () => void;
}

/** Takes the identity names lock (see `acquireIdentityNamesLock`), then the resync lock of each identity `names` gives, in name order, and returns what refreshes and releases them all. `resolve` is called once the names lock is held and gives the names and anything else the caller resolved there (`value`), so a name resolved to an id there stays resolved so, since no add, remove or other rename can change it until the release. The order does not depend on which name is the old one, so two renames running in opposite directions over the same pair ask for the locks in the same order and cannot each hold one and wait for the other. If one is busy, or `resolve` throws, those already taken are released before the error is thrown. */
export function holdLocks<T>(paths: LayoutPaths, resolve: () => { readonly names: readonly string[]; readonly value: T }, ports: RenameLockPorts): HeldLocks & { readonly value: T } {
  const held: IdentityLock[] = [];
  const release = (): void => {
    for (const lock of [...held].reverse()) {
      lock.release();
    }
  };
  const value = ((): T => {
    try {
      held.push(acquireIdentityNamesLock(paths, { fs: ports.fs, ...ports.lock }));
      const resolved = resolve();
      for (const identity of [...resolved.names].sort()) {
        held.push(acquireIdentityLock({ identity, dir: paths.identitiesDir, fs: ports.fs, ...ports.lock }));
      }
      return resolved.value;
    } catch (error) {
      release();
      throw error;
    }
  })();
  return {
    value,
    refresh: () => {
      for (const lock of held) {
        lock.refresh();
      }
    },
    release,
  };
}
