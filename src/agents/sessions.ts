import path from "node:path";

import { CliError } from "../cliError";
import { listSessions, readSessionAgentTree, summariseSession, type SessionRef, type SessionSummary } from "./read";
import type { SessionCommandFs } from "./realFs";
import type { SessionAgentTree } from "./schema";

/**
 * Finding and reading sessions across identities, pure over an injected filesystem: the logic the \`session\` commands and the door's \`sessions\` procedures share, free of command-line dependencies so the library surface can export it.
 */

/** A session as `session list` reports it. `identities` names every identity whose configuration exposes it: history is shared between identities by default, so one session is usually visible to several. */
export interface IdentitySession extends SessionSummary {
  readonly identities: readonly string[];
}

/** Raised when a session id names no session, or more than one. */
export class SessionLookupError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "SessionLookupError";
  }
}

/** The configuration directory an identity's sessions live under. */
function identityConfigDir(identitiesDir: string, identity: string): string {
  return path.join(identitiesDir, identity);
}

/** Identities whose `projects` directory is the same store on disk, scanned once for all of them. */
interface HistoryStore {
  /** The identity whose configuration directory is read for this store. */
  readonly configDir: string;
  readonly identities: readonly string[];
}

/** Groups identities by the real location of their `projects` directory, in the order the identities were given. An identity with no projects directory belongs to no store. */
function historyStores(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[]): readonly HistoryStore[] {
  const byRealPath = new Map<string, { configDir: string; identities: string[] }>();
  for (const identity of identities) {
    const configDir = identityConfigDir(identitiesDir, identity);
    const real = fs.realpath(path.join(configDir, "projects"));
    if (real === undefined) {
      continue;
    }
    const store = byRealPath.get(real);
    if (store === undefined) {
      byRealPath.set(real, { configDir, identities: [identity] });
    } else {
      store.identities.push(identity);
    }
  }
  return [...byRealPath.values()];
}

/** Filters for `session list`. */
export interface SessionListFilters {
  /** Only this identity's sessions. */
  readonly identity?: string;
  /** Include sessions that spawned no agent and ran no workflow. */
  readonly all?: boolean;
}

/**
 * Collects `session list`, read-only: every session of the given identities with its agent and workflow-run counts, newest transcript first. Sessions with nothing to inspect are left out unless `all` is set, because most sessions never spawn an agent and listing them would bury the ones that did.
 */
export function collectSessionList(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[], filters: Readonly<SessionListFilters>): readonly IdentitySession[] {
  const names = filters.identity === undefined ? identities : identities.filter((name) => name === filters.identity);
  if (filters.identity !== undefined && names.length === 0) {
    throw new SessionLookupError(`no identity named "${filters.identity}"`);
  }
  const sessions: IdentitySession[] = [];
  for (const store of historyStores(fs, identitiesDir, names)) {
    for (const ref of listSessions(fs, store.configDir)) {
      const summary = summariseSession(fs, store.configDir, ref);
      if (filters.all === true || summary.agentCount > 0 || summary.workflowRunCount > 0) {
        sessions.push({ ...summary, identities: store.identities });
      }
    }
  }
  return sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionId.localeCompare(right.sessionId));
}

/** A resolved session: where it is read from and which identities expose it. */
export interface LocatedSession {
  readonly identities: readonly string[];
  readonly configDir: string;
  readonly ref: SessionRef;
}

/**
 * Resolves a session id, or an unambiguous prefix of one, across the given identities. Fails with every candidate named when the prefix matches several, so the caller can say which it meant.
 */
export function locateSession(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[], query: string, onlyIdentity?: string): LocatedSession {
  const names = onlyIdentity === undefined ? identities : identities.filter((name) => name === onlyIdentity);
  if (onlyIdentity !== undefined && names.length === 0) {
    throw new SessionLookupError(`no identity named "${onlyIdentity}"`);
  }
  const matches: LocatedSession[] = [];
  for (const store of historyStores(fs, identitiesDir, names)) {
    for (const ref of listSessions(fs, store.configDir)) {
      if (ref.sessionId.startsWith(query)) {
        matches.push({ identities: store.identities, configDir: store.configDir, ref });
      }
    }
  }
  const exact = matches.filter((match) => match.ref.sessionId === query);
  const candidates = exact.length > 0 ? exact : matches;
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return only;
  }
  if (candidates.length === 0) {
    throw new SessionLookupError(`no session matches "${query}"`);
  }
  throw new SessionLookupError(`"${query}" matches ${String(candidates.length)} sessions: ${candidates.map((match) => `${match.ref.sessionId} (${match.identities.join(", ")})`).join("; ")}; give more of the id or pass --identity`);
}

/** One session resolved and read: the tree and every identity that exposes it. */
export interface SessionView {
  readonly identities: readonly string[];
  readonly tree: SessionAgentTree;
}

/** Resolves a session id or prefix and reads its tree: what `session show` and the door's `sessions.show` both answer. */
export function showSession(fs: SessionCommandFs, identitiesDir: string, identities: readonly string[], query: string, onlyIdentity?: string): SessionView {
  const located = locateSession(fs, identitiesDir, identities, query, onlyIdentity);
  return { identities: located.identities, tree: readSessionAgentTree(fs, located.configDir, located.ref) };
}

