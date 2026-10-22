import path from "node:path";

import type { HeadroomFs } from "../headroom/state";
import type { FarmStat } from "../launcher/ports";
import { isLiveCapability } from "./capability";
import { isSessionRecordName, readFrontDoorSessionRecord, sessionRecordName, summaryOf, type FrontDoorSession, type FrontDoorSessionSummary } from "./state";

/**
 * The door's in-memory view of the session registry: which capabilities are live, answered without reading the registry for the requests that present one the door already holds.
 *
 * The registry directory is written by other processes (each launcher registers its own launch, and removes it on exit), so the door cannot be told of a change and must look. It looks at three moments, none of them per admitted request: `rescan` on every supervisor tick, which is also where a dead launch is pruned, `forget` for the launches that prune removed, and `admits` for a token the view does not hold. The last is what makes a launch admissible on its first request: the launcher writes its record before its child starts, so that request can arrive before the next tick.
 */
export interface LiveSessionRegistry {
  /**
   * Whether `token` is a live capability. A token the view holds is answered from memory. Any other costs one directory listing and one stat per record file, plus a read of the records whose file is new or whose stat differs from the one the view recorded: a launch that registered since the last look is found and admitted, a launcher that registered again under its own pid (an in-door launch, a relaunching supervisor) is read again, a record removed since is dropped, and a token nobody holds is refused without a record read, however often it is presented.
   *
   * A record removed by someone else is therefore noticed by a presented token the view does not hold, or by the next `rescan`, not by a request for a token it holds: a removed record's capability stays admissible until the next `rescan`. A rewrite that leaves a record's modification time and size unchanged is likewise first seen at the next `rescan`.
   */
  readonly admits: (token: string) => boolean;
  /**
   * Re-reads every record in the directory, replacing what the view holds, and returns the listing it saw (sorted by pid, malformed files skipped, no token in it). The supervisor's tick calls this as its listing, so the registry is read once per tick for both the idle decision and the capabilities.
   */
  readonly rescan: () => readonly FrontDoorSessionSummary[];
  /** Drops the launches `pids` from the view, for the records the caller has just removed (the tick's prune), so their capabilities are refused at once rather than at the next `rescan`. */
  readonly forget: (pids: readonly number[]) => void;
}

/** What `createLiveSessionRegistry` reads through. */
export interface LiveSessionRegistryPorts {
  readonly fs: HeadroomFs;
  readonly sessionsDir: string;
}

/** Whether a file still has the stat the view recorded for it: the fingerprint that says its content has not been rewritten since it was read. */
function sameStat(recorded: Pick<FarmStat, "mtimeMs" | "sizeBytes"> | undefined, current: FarmStat): boolean {
  return recorded?.mtimeMs === current.mtimeMs && recorded.sizeBytes === current.sizeBytes;
}

/**
 * Builds the in-memory registry view over `ports.sessionsDir`. It starts empty, so the first token presented is checked against the directory and the first `rescan` fills the view.
 */
export function createLiveSessionRegistry(ports: LiveSessionRegistryPorts): LiveSessionRegistry {
  const { fs, sessionsDir } = ports;
  /** Every record file the view has read, by file name, with the stat the file had just before it was read: a later stat that differs means the file was rewritten. The record is undefined for a file that is not one, so a listing for an unknown token never parses it again. */
  const known = new Map<string, { readonly stat: Pick<FarmStat, "mtimeMs" | "sizeBytes">; readonly record: FrontDoorSession | undefined }>();
  let tokens: ReadonlySet<string> = new Set();

  const recordNames = (): readonly string[] => fs.readdir(sessionsDir).filter(isSessionRecordName);

  const rebuildTokens = (): void => {
    tokens = new Set([...known.values()].flatMap(({ record }) => (record === undefined ? [] : [record.token])));
  };

  /** Reads one file into the view under `stat`, which the caller took first: a write landing between the stat and the read leaves the view holding newer content under an older stat, which the next look reads again, never older content under a newer stat. */
  const load = (name: string, stat: FarmStat): void => {
    known.set(name, { stat: { mtimeMs: stat.mtimeMs, sizeBytes: stat.sizeBytes }, record: readFrontDoorSessionRecord(fs, sessionsDir, name) });
  };

  /** Stats one record file, or undefined when it vanished since the listing. */
  const statOf = (name: string): FarmStat | undefined => fs.lstat(path.join(sessionsDir, name));

  /** Brings `known` in line with the directory, reading only the files that are new or whose stat changed, and reports whether anything changed. */
  const reconcile = (): boolean => {
    const names = new Set(recordNames());
    let changed = false;
    for (const name of known.keys()) {
      if (!names.has(name)) {
        known.delete(name);
        changed = true;
      }
    }
    for (const name of names) {
      const held = known.get(name);
      const stat = statOf(name);
      if (stat === undefined) {
        changed = known.delete(name) || changed;
      } else if (!sameStat(held?.stat, stat)) {
        load(name, stat);
        changed = true;
      }
    }
    if (changed) {
      rebuildTokens();
    }
    return changed;
  };

  return {
    admits: (token) => {
      if (isLiveCapability(token, tokens)) {
        return true;
      }
      return reconcile() && isLiveCapability(token, tokens);
    },
    rescan: () => {
      known.clear();
      for (const name of recordNames()) {
        const stat = statOf(name);
        if (stat !== undefined) {
          load(name, stat);
        }
      }
      rebuildTokens();
      return [...known.values()].flatMap(({ record }) => (record === undefined ? [] : [summaryOf(record)])).sort((a, b) => a.pid - b.pid);
    },
    forget: (pids) => {
      for (const pid of pids) {
        known.delete(sessionRecordName(pid));
      }
      rebuildTokens();
    },
  };
}
