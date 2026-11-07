import path from "node:path";

import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import { RC_IDLE_EXPIRY_MS } from "./rcSessions";

/**
 * The fields of one Claude Code session registry record (`<config dir>/sessions/<pid>.json`) this module reads: the local session id, the process that registered it, and the Remote Control session id the process is bridged to. The record carries more (name, cwd, status and the like); those are left to their own readers, and the schema is not strict so a record growing fields still parses.
 */
const RcRegistryRecordSchema = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  bridgeSessionId: z.string().min(1).optional(),
});

/** One live Claude Code session that registered a Remote Control bridge: the `cse_` id the door's status is keyed by, the local session id, and the registering process. */
export interface RcRegisteredSession {
  /** The Remote Control session id in the `cse_` form the door keys sessions by, converted from the record's `bridgeSessionId` (`rcSessionIdOfBridgeId`). */
  readonly id: string;
  /** The local Claude Code session id, the record's `sessionId`. */
  readonly localSessionId: string;
  /**
   * The process that wrote the record. Its liveness is judged by `isProcessAlive` alone, so once a crashed session's pid has been reused by another process its leftover record reads as live and is listed until the file is removed; telling the two apart would need the process's start time against the record's `procStart`, which this read does not take.
   */
  readonly pid: number;
}

/** Everything the registry read needs, injected so it runs against a fake filesystem and process table in unit tests. */
export interface RcRegistryDeps {
  /** The directory listing and file read of the door's filesystem port. */
  readonly fs: Pick<FarmFs, "readdir" | "readFileUtf8">;
  /** The `sessions` directories to read: every identity's configuration directory's, and the shared Claude home's. The same directory may be named twice (an identity's is usually a link to the shared one), which the read deduplicates by session id. */
  readonly registryDirs: () => readonly string[];
  /** Whether a process is still running, so a record left behind by a process that exited without removing it is not reported as a registered session. */
  readonly isProcessAlive: (pid: number) => boolean;
}

/** The directory under a Claude Code configuration directory that holds its session registry, one record per running process. */
export const CLAUDE_SESSION_REGISTRY_DIR = "sessions";

/** The registry directories of a set of Claude Code configuration directories: the shared Claude home and every identity's, for the door. */
export function rcRegistryDirsOf(configDirs: readonly string[]): readonly string[] {
  return configDirs.map((dir) => path.join(dir, CLAUDE_SESSION_REGISTRY_DIR));
}

/** The suffix every registry record's file name carries. */
const RECORD_SUFFIX = ".json";

/** The prefix of the compatibility form of a Remote Control session id, the form the registry records. */
const COMPAT_SESSION_PREFIX = "session_";

/** The prefix of the infrastructure form of a Remote Control session id, the form the door's tracker and every `/v1/code/sessions/{id}` path use. */
const CSE_SESSION_PREFIX = "cse_";

/**
 * The `cse_` form of a registry record's `bridgeSessionId`. The registry records the compatibility form (`session_<suffix>`), while the door keys every session by the infrastructure form (`cse_<suffix>`); the two share the suffix, and Claude Code converts between them by swapping the prefix alone (verified in the 2.1.319 bundle, whose converter returns `"session_" + id.slice(4)` for a `cse_` id and the reverse for a `session_` one). An id already in the `cse_` form is returned as it is.
 */
export function rcSessionIdOfBridgeId(bridgeSessionId: string): string {
  return bridgeSessionId.startsWith(COMPAT_SESSION_PREFIX) ? `${CSE_SESSION_PREFIX}${bridgeSessionId.slice(COMPAT_SESSION_PREFIX.length)}` : bridgeSessionId;
}

/** Parses one registry record's text, or undefined when it is not one: a file mid-write, or one of another shape, names no session this read can report. */
function recordOf(text: string): z.infer<typeof RcRegistryRecordSchema> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = RcRegistryRecordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * The registry read the door's status serves from: `readRcRegisteredSessions`, made at most once per `RC_IDLE_EXPIRY_MS` and its answer reused in between. The read is synchronous (a listing and a file read per record across every identity's directory, and a process check per record), and the status is polled (the web client asks every few seconds, on the door's own event loop), so an unbounded read would repeat that work on every poll. A session that registers or exits is reflected within one bound, the same span after which the door already treats its own observations of a session as stale.
 */
export function createRcRegistryReader(deps: RcRegistryDeps & { readonly now: () => number }): () => readonly RcRegisteredSession[] {
  let held: { readonly at: number; readonly sessions: readonly RcRegisteredSession[] } | undefined;
  return () => {
    const now = deps.now();
    if (held === undefined || now - held.at >= RC_IDLE_EXPIRY_MS) {
      held = { at: now, sessions: readRcRegisteredSessions(deps) };
    }
    return held.sessions;
  };
}

/**
 * Every live Claude Code session whose registry record names a Remote Control bridge, once per `cse_` id, sorted by id. This is the set of sessions that registered with the Remote Control service, which the door's own tracker can only partly see: the tracker holds a session only while its traffic crosses the door, so the difference between the two is the set the status reports as unobserved. A record whose process has exited is left out, since Claude Code removes its record on a clean exit and only a crash leaves one behind.
 */
export function readRcRegisteredSessions(deps: RcRegistryDeps): readonly RcRegisteredSession[] {
  const byId = new Map<string, RcRegisteredSession>();
  for (const dir of deps.registryDirs()) {
    for (const name of deps.fs.readdir(dir)) {
      if (!name.endsWith(RECORD_SUFFIX)) {
        continue;
      }
      const text = deps.fs.readFileUtf8(path.join(dir, name));
      const record = text === undefined ? undefined : recordOf(text);
      if (record?.bridgeSessionId === undefined) {
        continue;
      }
      const id = rcSessionIdOfBridgeId(record.bridgeSessionId);
      if (byId.has(id) || !deps.isProcessAlive(record.pid)) {
        continue;
      }
      byId.set(id, { id, localSessionId: record.sessionId, pid: record.pid });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
