import path from "node:path";
import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import type { UsageRecord } from "../usage/schema";
import type { TranscriptFollower } from "./transcriptFollower";

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
  /** The id of the identity the session is running as now: the directory it is stored in, which a rename of its name keeps, so the entry stays true across one. */
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
  /** The current Claude conversation when it differs from the launch id, for example after /clear. */
  conversationId: z.uuid().optional(),
  /** Claude's own path for the current conversation transcript. */
  transcriptPath: z.string().min(1).optional(),
  /** Claude's identifier for the most recently submitted prompt. */
  promptId: z.uuid().optional(),
  /** A hook failed to establish the current conversation, so the saved id must not be used for a move. */
  unavailable: z.literal(true).optional(),
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

/**
 * Where a supervised session's in-process control plugin listens, written by its launcher for the front door to read: the plugin directory (its request and result files beneath it, `sessionControlPlugin.ts`) and the launcher's pid, which tells a live channel from one a crashed launcher left. A file of its own, beside the registry entry, because a move rewrites the entry while the plugin, staged once per launcher, stays.
 */
const SessionControlSchema = z.strictObject({
  pid: z.number().int().positive(),
  directory: z.string().min(1),
});
export type SessionControl = z.infer<typeof SessionControlSchema>;

function controlFileOf(paths: LayoutPaths, pool: string, sessionId: string): string {
  return path.join(superviseDirOf(paths, pool), "control", `${sessionId}.json`);
}

/** Records where a session's control plugin listens. The session id is a file name, so the caller has checked it is a plain identifier. */
export function writeSessionControl(fs: RegistryFs, paths: LayoutPaths, pool: string, sessionId: string, control: Readonly<SessionControl>): void {
  fs.mkdirPrivate(path.dirname(controlFileOf(paths, pool, sessionId)));
  fs.writeFilePrivate(controlFileOf(paths, pool, sessionId), `${JSON.stringify(SessionControlSchema.parse(control))}\n`);
}

/** Where a session's control plugin listens, or undefined when its launcher recorded none or what is there is not a record of this schema. */
export function readSessionControl(fs: Pick<RegistryFs, "readFileUtf8">, paths: LayoutPaths, pool: string, sessionId: string): SessionControl | undefined {
  const raw = fs.readFileUtf8(controlFileOf(paths, pool, sessionId));
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = SessionControlSchema.safeParse(JSON.parse(raw));
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

/** Removes a session's entry, its recorded state and its control record. Idempotent. */
export function unregisterSupervised(fs: RegistryFs, paths: LayoutPaths, pool: string, sessionId: string): void {
  fs.removeRecursive(sessionFileOf(paths, pool, sessionId));
  fs.removeRecursive(sessionStatePath(paths, pool, sessionId));
  fs.removeRecursive(controlFileOf(paths, pool, sessionId));
}

/** A registry entry with the file it was read from, so a caller that finds its launcher gone can remove it. */
interface ListedSupervised {
  readonly file: string;
  readonly session: SupervisedSession;
}

/** The pool's entries, liveness unjudged. An entry that is not a session of this schema is not one anyone is supervising, so it is removed rather than listed. */
function listSupervised(fs: RegistryFs, paths: LayoutPaths, pool: string): readonly ListedSupervised[] {
  const listed: ListedSupervised[] = [];
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
    if (parsed.success) {
      listed.push({ file, session: parsed.data });
    } else {
      fs.removeRecursive(file);
    }
  }
  return listed;
}

/**
 * The pool's sessions whose launcher is still running. An entry whose launcher has gone, or that is not a session of this schema, is not a session anyone is supervising, so it is removed rather than counted.
 */
export function liveSupervised(fs: RegistryFs, paths: LayoutPaths, pool: string, isRunning: (pid: number) => boolean): readonly SupervisedSession[] {
  const live: SupervisedSession[] = [];
  for (const { file, session } of listSupervised(fs, paths, pool)) {
    if (isRunning(session.pid)) {
      live.push(session);
    } else {
      fs.removeRecursive(file);
    }
  }
  return live;
}

/**
 * The context tokens already on their way to each member: the sum, per identity id, of what the sessions that moved onto it carried, for the ones that have not yet made a request there. Until a moved session's first request lands, the member's usage does not show the cost of writing its context again, so the next mover would rank the member as if that cost were not coming.
 */
export function committedContextTokens(sessions: readonly SupervisedSession[], records: readonly UsageRecord[]): Readonly<Record<string, number>> {
  const committed: Record<string, number> = {};
  for (const session of sessions) {
    if (session.carriedTokens === undefined) {
      continue;
    }
    const sinceMs = Date.parse(session.since);
    // The registry and the door's usage records both key the member by its id.
    const written = records.some((record) => record.sessionId === session.sessionId && record.identity === session.identity && Date.parse(record.at) >= sinceMs);
    if (!written) {
      committed[session.identity] = (committed[session.identity] ?? 0) + session.carriedTokens;
    }
  }
  return committed;
}

/**
 * One request from the front door for a supervised session to relaunch under another identity: the session picked a model member (`acct:<identity>/<model>`) that only a relaunch can serve, one login per process, so the door asks the session's supervisor to move it. Written by the door, claimed and removed by the supervisor.
 */
const ModelMoveRequestSchema = z.strictObject({
  /** The session the request is for: the id its supervisor registered it under. */
  sessionId: z.string().min(1),
  /** The id of the identity the model runs under, which the door resolved the `acct:` member's name to when it wrote the request. */
  to: z.string().min(1),
  /** The model to resume with, the part after the identity in the `acct:` member. */
  model: z.string().min(1),
  /** When the door wrote the request, so a supervisor can tell a fresh request from one left behind. */
  at: z.iso.datetime(),
});
export type ModelMoveRequest = z.infer<typeof ModelMoveRequestSchema>;

/** Writes one model-move request, replacing any the session already holds. The session id is a file name, so the caller has checked it is a plain identifier. */
export function writeModelMove(fs: RegistryFs, paths: LayoutPaths, request: Readonly<ModelMoveRequest>): void {
  fs.mkdirPrivate(paths.modelMovesDir);
  fs.writeFilePrivate(path.join(paths.modelMovesDir, `${request.sessionId}.json`), `${JSON.stringify(ModelMoveRequestSchema.parse(request))}\n`);
}

/**
 * Leaves a model-move request for the supervisor of session `sessionId`, when one is supervising it, to relaunch the session under the identity an `acct:` model member names: `to` is that identity's name, and the request carries the id `idOf` resolves it to now, since the supervisor keys its sessions by id, which a rename keeps. Returns false, leaving nothing, when no live supervisor holds the session or no identity is named `to`, so the door answers with the command to run instead.
 */
export async function requestAccountMove(deps: { readonly fs: RegistryFs; readonly paths: LayoutPaths; readonly runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>; readonly idOf: (name: string) => string | undefined; readonly now: () => number }, sessionId: string, to: string, model: string): Promise<boolean> {
  if ((await supervisedSessionOf(deps.fs, deps.paths, sessionId, deps.runningAmong)) === undefined) {
    return false;
  }
  const toId = deps.idOf(to);
  if (toId === undefined) {
    return false;
  }
  writeModelMove(deps.fs, deps.paths, { sessionId, to: toId, model, at: new Date(deps.now()).toISOString() });
  return true;
}

/** Reads the session's pending model-move request, when one is there and parses. */
export function readModelMove(fs: Pick<RegistryFs, "readFileUtf8">, paths: LayoutPaths, sessionId: string): ModelMoveRequest | undefined {
  const raw = fs.readFileUtf8(path.join(paths.modelMovesDir, `${sessionId}.json`));
  if (raw === undefined) {
    return undefined;
  }
  try {
    return ModelMoveRequestSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Removes the session's model-move request, claimed or superseded. Idempotent. */
export function removeModelMove(fs: Pick<RegistryFs, "removeRecursive">, paths: LayoutPaths, sessionId: string): void {
  fs.removeRecursive(path.join(paths.modelMovesDir, `${sessionId}.json`));
}

/**
 * The live registry entry a session id belongs to, across every pool: what tells the door a session is supervised (so a model move can be left for its supervisor) and which pool's lock the move belongs under. A session id registers once, so the first live entry is the entry. Entries whose launcher has gone are removed, as `liveSupervised` does. Liveness is read without blocking the calling thread, since the door that calls this answers every session on its event loop.
 */
export async function supervisedSessionOf(fs: RegistryFs, paths: LayoutPaths, sessionId: string, runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>): Promise<SupervisedSession | undefined> {
  const listed = fs.readdir(paths.superviseDir).flatMap((pool) => listSupervised(fs, paths, pool));
  const running = await runningAmong(listed.map(({ session }) => session.pid));
  const live = listed.filter(({ file, session }) => {
    if (running.has(session.pid)) {
      return true;
    }
    fs.removeRecursive(file);
    return false;
  });
  return live.find(({ session }) => session.sessionId === sessionId)?.session;
}

/** A live supervised session together with what the door needs to act on it: its recorded state and where its control plugin listens. */
interface SupervisedBridgeSession {
  readonly session: SupervisedSession;
  readonly state: SessionState | undefined;
  readonly control: SessionControl | undefined;
}

/** Which live supervised session a Remote Control session belongs to: one, none, or more than one, which is refused rather than guessed at (a resumed or forked conversation can carry the same bridge row in two transcripts). */
export type SupervisedBridgeLookup = { readonly kind: "found"; readonly session: SupervisedBridgeSession } | { readonly kind: "none" } | { readonly kind: "ambiguous"; readonly sessionIds: readonly string[] };

/**
 * The live supervised session a Remote Control session (`cse_` id) belongs to, across every pool: the one whose current transcript's latest `bridge-session` row names that id, which Claude Code writes into the transcript itself, so the join needs nothing the supervisor or the door kept beside it. Each transcript is read through `follower`, which reads only what was appended since its last read. Two live launches claiming the id is refused. Entries whose launcher has gone are removed, with their state and control records, as `unregisterSupervised` removes them.
 */
export async function supervisedSessionOfBridge(fs: RegistryFs, paths: LayoutPaths, bridgeSessionId: string, runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>, follower: TranscriptFollower): Promise<SupervisedBridgeLookup> {
  const listed = fs.readdir(paths.superviseDir).flatMap((pool) => listSupervised(fs, paths, pool));
  const running = await runningAmong(listed.map(({ session }) => session.pid));
  const claims: SupervisedBridgeSession[] = [];
  for (const { session } of listed) {
    if (!running.has(session.pid)) {
      unregisterSupervised(fs, paths, session.pool, session.sessionId);
      continue;
    }
    const state = readSessionState(fs, paths, session.pool, session.sessionId);
    const transcript = state?.transcriptPath;
    if (transcript === undefined) {
      continue;
    }
    const facts = await follower.factsOf(transcript);
    if (facts?.bridgeSessionId === bridgeSessionId) {
      const control = readSessionControl(fs, paths, session.pool, session.sessionId);
      claims.push({ session, state, control: control?.pid === session.pid ? control : undefined });
    }
  }
  const [only, ...others] = claims;
  if (only === undefined) {
    return { kind: "none" };
  }
  return others.length === 0 ? { kind: "found", session: only } : { kind: "ambiguous", sessionIds: claims.map((claim) => claim.session.sessionId).sort() };
}
