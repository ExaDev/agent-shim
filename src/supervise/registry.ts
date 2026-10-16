import path from "node:path";
import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import type { UsageRecord } from "../usage/schema";

/** The filesystem operations the registry needs. */
export type RegistryFs = Pick<FarmFs, "mkdirPrivate" | "writeFilePrivate" | "removeRecursive" | "readdir" | "readFileUtf8">;

/**
 * One supervised session, as its launcher registers it for the other launchers in the same pool to read. Runtime state only: it is written when a launch starts supervising, updated when the session moves, and removed when the launcher ends.
 */
const SupervisedSessionSchema = z.strictObject({
  /** The launcher's process id, which is what tells a live entry from one a crashed launcher left behind. */
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  pool: z.string().min(1),
  /** The identity the session is running as now. */
  identity: z.string().min(1),
  cwd: z.string().min(1),
  /** When the session began running as `identity`: its launch, or the move that brought it there. */
  since: z.iso.datetime(),
  /** The size in tokens of the context the session carried onto `identity` when it moved there; absent for a launch, which carries none. */
  carriedTokens: z.number().int().nonnegative().optional(),
});
export type SupervisedSession = z.infer<typeof SupervisedSessionSchema>;

/**
 * What a session's own hooks and its supervisor record about it, in a file of its own so that the hooks (separate processes that run at the end and start of every turn) never rewrite the registry entry the supervisor owns.
 */
const SessionStateSchema = z.strictObject({
  /** `busy` from the moment a prompt is submitted until the turn ends, `idle` from then until the next prompt: the only times the child can be stopped without losing a turn. */
  mark: z.enum(["busy", "idle"]),
  /** The size in tokens of the context as of the last turn that ended; absent until one has. */
  contextTokens: z.number().int().nonnegative().optional(),
  /** Whether the session was compacted during its stay on the member it runs on now. Set by the supervisor, kept by later marks, and cleared when the session moves. */
  compacted: z.boolean().optional(),
  at: z.iso.datetime(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/** The directory one pool's shared state lives in. */
export function superviseDirOf(paths: LayoutPaths, pool: string): string {
  return path.join(paths.superviseDir, pool);
}

function sessionsDirOf(paths: LayoutPaths, pool: string): string {
  return path.join(superviseDirOf(paths, pool), "sessions");
}

function sessionFileOf(paths: LayoutPaths, pool: string, sessionId: string): string {
  return path.join(sessionsDirOf(paths, pool), `${sessionId}.json`);
}

/** The directory the pool's session states are recorded in. */
export function stateDirOf(paths: LayoutPaths, pool: string): string {
  return path.join(superviseDirOf(paths, pool), "state");
}

/** The file a session's state is recorded in. */
export function sessionStatePath(paths: LayoutPaths, pool: string, sessionId: string): string {
  return path.join(stateDirOf(paths, pool), `${sessionId}.json`);
}

/** Records a session's state, replacing the last. The session id is a file name, so the caller has checked it is a plain identifier. */
export function writeSessionState(fs: RegistryFs, paths: LayoutPaths, pool: string, sessionId: string, state: Readonly<SessionState>): void {
  fs.mkdirPrivate(stateDirOf(paths, pool));
  fs.writeFilePrivate(sessionStatePath(paths, pool, sessionId), `${JSON.stringify(SessionStateSchema.parse(state))}\n`);
}

/** A session's recorded state, or undefined when none was written or what is there is not a state of this schema. */
export function readSessionState(fs: Pick<RegistryFs, "readFileUtf8">, paths: LayoutPaths, pool: string, sessionId: string): SessionState | undefined {
  const raw = fs.readFileUtf8(sessionStatePath(paths, pool, sessionId));
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = SessionStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Registers a session, or replaces its entry when it moves. The session id is a file name, so the caller has checked it is a plain identifier. */
export function registerSupervised(fs: RegistryFs, paths: LayoutPaths, session: Readonly<SupervisedSession>): void {
  fs.mkdirPrivate(sessionsDirOf(paths, session.pool));
  fs.writeFilePrivate(sessionFileOf(paths, session.pool, session.sessionId), `${JSON.stringify(SupervisedSessionSchema.parse(session))}\n`);
}

/** Removes a session's entry and its recorded state. Idempotent. */
export function unregisterSupervised(fs: RegistryFs, paths: LayoutPaths, pool: string, sessionId: string): void {
  fs.removeRecursive(sessionFileOf(paths, pool, sessionId));
  fs.removeRecursive(sessionStatePath(paths, pool, sessionId));
}

/**
 * The pool's sessions whose launcher is still running. An entry whose launcher has gone, or that is not a session of this schema, is not a session anyone is supervising, so it is removed rather than counted.
 */
export function liveSupervised(fs: RegistryFs, paths: LayoutPaths, pool: string, isRunning: (pid: number) => boolean): readonly SupervisedSession[] {
  const live: SupervisedSession[] = [];
  for (const name of fs.readdir(sessionsDirOf(paths, pool))) {
    const file = path.join(sessionsDirOf(paths, pool), name);
    const raw = fs.readFileUtf8(file);
    if (raw === undefined) {
      continue;
    }
    let parsed: z.ZodSafeParseResult<SupervisedSession>;
    try {
      parsed = SupervisedSessionSchema.safeParse(JSON.parse(raw));
    } catch {
      fs.removeRecursive(file);
      continue;
    }
    if (parsed.success && isRunning(parsed.data.pid)) {
      live.push(parsed.data);
    } else {
      fs.removeRecursive(file);
    }
  }
  return live;
}

/**
 * The context tokens already on their way to each member: the sum, per identity, of what the sessions that moved onto it carried, for the ones that have not yet made a request there. Until a moved session's first request lands, the member's usage does not show the cost of writing its context again, so the next mover would rank the member as if that cost were not coming.
 */
export function committedContextTokens(sessions: readonly SupervisedSession[], records: readonly UsageRecord[]): Readonly<Record<string, number>> {
  const committed: Record<string, number> = {};
  for (const session of sessions) {
    if (session.carriedTokens === undefined) {
      continue;
    }
    const sinceMs = Date.parse(session.since);
    const written = records.some((record) => record.sessionId === session.sessionId && record.identity === session.identity && Date.parse(record.at) >= sinceMs);
    if (!written) {
      committed[session.identity] = (committed[session.identity] ?? 0) + session.carriedTokens;
    }
  }
  return committed;
}
