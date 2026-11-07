import path from "node:path";

import { z } from "zod";

import type { SessionCommandFs } from "../agents/realFs";
import type { RcSessionStatus } from "./rcSessions";

/**
 * The Claude Code session registry as the door reads it to say which Remote Control session is which: one JSON file per live session process under `<configuration directory>/sessions`, written by the CLI itself. Only the fields the status surface reports are read (`pid`, `cwd`, `name`, `updatedAt` and the `bridgeSessionId` that joins the entry to the door's session); everything else in the file is ignored, and a file that is not an entry (the `.key` files and the `.tmp-` files of an atomic write that sit beside them) is skipped rather than failed.
 *
 * The join is a prefix swap: the registry's `bridgeSessionId` is `session_<x>` where the door tracks the same session as `cse_<x>`. A session the registry does not hold, because it runs on another host, has not written its entry yet, or has a registry no identity of this door can reach, is reported by the door's own observations alone.
 */

/** The prefix the registry's `bridgeSessionId` carries. */
const REGISTRY_BRIDGE_PREFIX = "session_";

/** The prefix the door tracks the same session under. */
const DOOR_SESSION_PREFIX = "cse_";

/** The directory under an identity's configuration directory that holds the registry. */
const REGISTRY_DIR = "sessions";

/** The suffix of an entry's file; the atomic-write temporaries and the `.key` files beside the entries do not end with it. */
const ENTRY_SUFFIX = ".json";

/** The reads the registry reader makes: directory listing and file reads, plus resolving the registry directory to the real location it points at, which is how identities that share one registry are told from identities with their own. */
export type RcSessionRegistryFs = Pick<SessionCommandFs, "readdir" | "readFileUtf8" | "realpath">;

/** One identity whose registry is searched: its name and the configuration directory it launches sessions with. */
export interface RcRegistryIdentity {
  readonly name: string;
  readonly configDir: string;
}

/** The fields of a registry entry the door reads. */
const RegistryEntrySchema = z.looseObject({
  sessionId: z.string().min(1),
  pid: z.int().positive(),
  bridgeSessionId: z.string().startsWith(REGISTRY_BRIDGE_PREFIX),
  cwd: z.string().optional(),
  name: z.string().optional(),
  updatedAt: z.number().optional(),
});

/** What the registry says about one session, with every field the entry did not carry absent rather than blank. */
export interface RcRegisteredSession {
  /** The session process's id. */
  readonly pid: number;
  /** The Claude Code session's own id, the stem of its transcript and the join to everything on disk. */
  readonly localSessionId: string;
  /** The directory the session was started in. */
  readonly cwd?: string;
  /** The session's name, as the CLI shows it. */
  readonly name?: string;
  /** The identity whose own registry holds the entry. Absent when several identities share the registry (the default, since sessions are history and shared), because the entry then says nothing about which of them launched the session. */
  readonly identity?: string;
}

/** A parsed entry with the ordering fact the choice between two entries for one session needs. */
interface Candidate {
  readonly session: RcRegisteredSession;
  readonly updatedAt: number;
}

/** Whether `candidate` is the entry to keep over `kept`: the more recently updated, and the higher pid when the updates tie, so the choice never depends on directory order. */
function supersedes(candidate: Candidate, kept: Candidate): boolean {
  return candidate.updatedAt > kept.updatedAt || (candidate.updatedAt === kept.updatedAt && candidate.session.pid > kept.session.pid);
}

/** Identities whose registry directory is one store on disk, scanned once. */
interface RegistryStore {
  readonly directory: string;
  readonly identities: readonly string[];
}

/** Groups the identities by the real location of their registry directory, in the order given; an identity with no registry directory belongs to no store. */
function registryStores(fs: RcSessionRegistryFs, identities: readonly RcRegistryIdentity[]): readonly RegistryStore[] {
  const byRealPath = new Map<string, { directory: string; identities: string[] }>();
  for (const identity of identities) {
    const directory = path.join(identity.configDir, REGISTRY_DIR);
    const real = fs.realpath(directory);
    if (real === undefined) {
      continue;
    }
    const store = byRealPath.get(real);
    if (store === undefined) {
      byRealPath.set(real, { directory, identities: [identity.name] });
    } else {
      store.identities.push(identity.name);
    }
  }
  return [...byRealPath.values()];
}

/** Everything the registry reader needs, injected so it runs against fakes. */
export interface RcSessionRegistryDeps {
  readonly fs: RcSessionRegistryFs;
  /** The identities to search, read on every call so one added after the door started is searched the moment it exists. */
  readonly identities: () => readonly RcRegistryIdentity[];
  /** Whether a process is alive: an entry whose process has exited is a file a crash left behind, and describes no session. */
  readonly isRunning: (pid: number) => boolean;
}

/**
 * Builds the registry reader: each call reads every identity's registry (a shared one once) and returns the live sessions it holds keyed by the door's `cse_` id. When a session has several live entries, as a resumed one can while its earlier file lingers, the most recently updated wins.
 */
export function createRcSessionRegistryReader(deps: RcSessionRegistryDeps): () => ReadonlyMap<string, RcRegisteredSession> {
  return () => {
    const chosen = new Map<string, Candidate>();
    for (const store of registryStores(deps.fs, deps.identities())) {
      // Only an identity with a registry of its own can say who launched a session in it.
      const [owner, ...others] = store.identities;
      for (const file of deps.fs.readdir(store.directory)) {
        if (!file.endsWith(ENTRY_SUFFIX)) {
          continue;
        }
        const raw = deps.fs.readFileUtf8(path.join(store.directory, file));
        if (raw === undefined) {
          continue;
        }
        let parsed: z.ZodSafeParseResult<z.output<typeof RegistryEntrySchema>>;
        try {
          parsed = RegistryEntrySchema.safeParse(JSON.parse(raw));
        } catch {
          // A half-written or foreign file is not an entry.
          continue;
        }
        if (!parsed.success || !deps.isRunning(parsed.data.pid)) {
          continue;
        }
        const { pid, sessionId, cwd, name, updatedAt, bridgeSessionId } = parsed.data;
        const candidate: Candidate = {
          session: {
            pid,
            localSessionId: sessionId,
            ...(cwd === undefined || cwd === "" ? {} : { cwd }),
            ...(name === undefined || name === "" ? {} : { name }),
            ...(owner === undefined || others.length > 0 ? {} : { identity: owner }),
          },
          updatedAt: updatedAt ?? 0,
        };
        const id = `${DOOR_SESSION_PREFIX}${bridgeSessionId.slice(REGISTRY_BRIDGE_PREFIX.length)}`;
        const kept = chosen.get(id);
        if (kept === undefined || supersedes(candidate, kept)) {
          chosen.set(id, candidate);
        }
      }
    }
    return new Map([...chosen].map(([id, candidate]) => [id, candidate.session]));
  };
}

/**
 * Adds what the registry says to the statuses the door built from its own observations: the name and process id always, and the working directory and identity only where the door observed none (what the session itself stated, and the launching identity the door saw on its own requests, outrank a registry that is only a file on disk). A status whose session the registry does not hold is returned as it is.
 */
export function withRegisteredSessionFacts(statuses: readonly RcSessionStatus[], registry: ReadonlyMap<string, RcRegisteredSession>): readonly RcSessionStatus[] {
  return statuses.map((status) => {
    const registered = registry.get(status.id);
    if (registered === undefined) {
      return status;
    }
    return {
      ...status,
      pid: registered.pid,
      ...(status.cwd === undefined && registered.cwd !== undefined ? { cwd: registered.cwd } : {}),
      ...(registered.name === undefined ? {} : { name: registered.name }),
      ...(status.identity === undefined && registered.identity !== undefined ? { identity: registered.identity } : {}),
    };
  });
}

/** Wraps the tracker's status read so every answer carries the registry's facts; the registry is read only when there is a status to describe. */
export function rcStatusWithRegistry(statusOf: (sessionId?: string) => readonly RcSessionStatus[], readRegistry: () => ReadonlyMap<string, RcRegisteredSession>): (sessionId?: string) => readonly RcSessionStatus[] {
  return (sessionId) => {
    const statuses = statusOf(sessionId);
    return statuses.length === 0 ? statuses : withRegisteredSessionFacts(statuses, readRegistry());
  };
}
