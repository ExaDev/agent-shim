import { RC_IDLE_EXPIRY_MS, type RcSessionStatus, type RcSessionTracker, type RcTrackedSessionStatus, type RcWorkerStateFact } from "./rcSessions";
import { withIdentityNames, withRegisteredSessionFacts, type RcRegisteredSession } from "./rcSessionRegistry";
import type { RcObservedCredential, RcWorkerStateReadResult } from "./rcWrites";

/** Milliseconds in a second, for stating the idle bound in a reason a person reads. */
const MS_PER_SECOND = 1_000;

/** One session that registered with the Remote Control service on this machine (its Claude Code registry record names a bridge) but that the door's tracker holds no record of, with the worker state the door could read for it or why it could not. */
export interface RcUnobservedSession {
  /** The Remote Control session id, in the `cse_` form. */
  readonly id: string;
  /** The local Claude Code session id the registry record names. */
  readonly localSessionId: string;
  /** The process that registered the session. */
  readonly pid: number;
  /** Why the door holds no record of the session. */
  readonly reason: string;
  /** The worker state the service answered a read with, always `source: "read"`; undefined when no read succeeded. */
  readonly workerState: RcWorkerStateFact | undefined;
  /** Why there is no worker state: the door holds no credential for the session, or the read failed. Undefined whenever `workerState` is present. */
  readonly workerStateUnavailable: string | undefined;
}

/** The whole status answer: every tracked session's status, and every registered session the tracker does not hold. */
export interface RcStatusReport {
  /** The sessions the tracker holds, oldest-created first, each with a worker state or the reason it has none. */
  readonly statuses: readonly RcSessionStatus[];
  /** The sessions registered on this machine that the tracker does not hold, sorted by id. */
  readonly unobserved: readonly RcUnobservedSession[];
}

/**
 * Where a session's worker state is read from, chosen per session, so one door serves every kind of Remote Control session at once:
 *
 * - `selfHosted`: the door's own self-hosted Remote Control service, present only when the door runs it. A session it owns was created against the door itself (a launch with no Anthropic login, or one whose inference goes to a third-party provider), so the service's own state is the truth, read in process: no request crosses the door's transparent surface to be observed as the session's traffic. A session is owned when the service holds it or when its credential is the one the service minted, so a door restart or a retirement leaves a session answered with the service's own reason and never sent to the real service. These reads are live and are never held.
 * - `service`: the real Remote Control service, for a session created against claude.ai (a native Anthropic login, or a provider launch that still holds one), read with the session's observed or persisted OAuth credential (`readRcWorkerState` over a dial to the real API host, never the door's own surface).
 *
 * A session the self-hosted service does not hold and for which the door has no OAuth credential cannot be read from either, and is reported with the reason.
 */
export interface RcWorkerStateBackends {
  readonly selfHosted?: {
    /** Whether the session is the self-hosted service's: it holds it, or the credential is the one the service minted (`RcSelfHostSurface.ownsSession`). */
    readonly owns: (sessionId: string, authorization: string | undefined) => boolean;
    /** The service's own worker state for a session it owns, or its reason for holding none, such as a session it has since retired (`RcSelfHostSurface.readWorkerState`). */
    readonly read: (sessionId: string) => RcWorkerStateReadResult;
  };
  /** Reads one session's worker state from the real service with the credential `credentialOf` holds for it. */
  readonly service: (sessionId: string, credentialOf: (id: string) => RcObservedCredential | undefined) => Promise<RcWorkerStateReadResult>;
}

/** Everything the status read needs: the tracker's accessors, the registry read, the persisted credentials, the worker state read and a clock. */
export interface RcStatusDeps {
  readonly statusOf: RcSessionTracker["statusOf"];
  readonly noteReadWorkerState: RcSessionTracker["noteReadWorkerState"];
  /** The live credential of a tracked session (the tracker's accessor, which adopts a persisted one when it observed none itself). */
  readonly credentialOf: RcSessionTracker["credentialOf"];
  /** What the Claude Code session registry says about every live session registered on this machine, keyed by `cse_` id (`createRcSessionRegistryReader`). Read at most once per `RC_IDLE_EXPIRY_MS`: its answer supplies the facts every tracked status is enriched with and the sessions the tracker holds no record of. */
  readonly registry: () => ReadonlyMap<string, RcRegisteredSession>;
  /** The current name of the identity whose directory id a tracked session's requests carried (`withIdentityNames`). */
  readonly identityNameOf: (id: string) => string | undefined;
  /** The credential a door generation persisted for a session it observed (`RcCredentialStore.read`), the only credential the door can hold for a session it has no record of. */
  readonly persistedCredentialOf: (sessionId: string) => RcObservedCredential | undefined;
  /** The two backends a session's worker state can come from, chosen per session (`RcWorkerStateBackends`). */
  readonly backends: RcWorkerStateBackends;
  /** The clock the reuse bound is measured on. */
  readonly now: () => number;
}

/** The reason an unobserved session whose create an earlier door generation (or this one, before the record expired) observed has no record now. */
const QUIET_REASON = `the front door holds no record of this session: none of its traffic has crossed the door within the last ${String(RC_IDLE_EXPIRY_MS / MS_PER_SECOND)} s (it has been quiet since this door started or since its record expired, or its traffic now reaches the service by another route). A door generation observed its create, so its worker state is read with the credential persisted then`;

/** The reason an unobserved session the door's own self-hosted service holds has no tracker record. */
const SELF_HOSTED_QUIET_REASON = `the front door's tracker holds no record of this session: none of its traffic has crossed the door within the last ${String(RC_IDLE_EXPIRY_MS / MS_PER_SECOND)} s. The door's self-hosted Remote Control service still holds it, so its worker state is that service's own`;

/** The reason an unobserved session whose create no door generation observed has no record, and no worker state either. */
const NEVER_OBSERVED_REASON =
  "the front door has never observed this session: it registered with the Remote Control service without its create crossing any door generation on this machine (it was launched without routing through the front door, or before the door was serving), so the door holds no record and no credential for it, and no self-hosted Remote Control service of the door holds it either";

/** The message for an unobserved session's missing worker state when the door holds no credential to read it with. */
function noCredentialMessage(sessionId: string): string {
  return `the front door holds no credential for session ${sessionId}, so it cannot read its worker state from the service; reconnecting Remote Control through the door lets it observe the create and the credential`;
}

/**
 * One read, held from the moment it is made: while it is in flight every caller asking about the same session shares it, and once it settles its answer stands in for a fresh one, for `RC_IDLE_EXPIRY_MS` from when it settled, wherever nothing on the tracker can hold it (a failed read of a tracked session, and any read of an unobserved one). A status is polled (the web client asks on a short timer, and several surfaces may ask at once), so without the hold every caller would cost one service request per such session; the bound is the tracker's own idle expiry, the span after which the door already treats a session's last observed facts as stale.
 */
interface HeldRead {
  /** The Authorization value the read was made with (undefined when the session held none): an answer describes that credential's view, so a different credential (a refreshed bearer, or one observed for the first time) is a miss, never served the old credential's 401 or "no bearer" answer. */
  readonly authorization: string | undefined;
  /** When the read was made, which is the instant its answer describes. */
  readonly requestedAt: number;
  /** The read itself, settled or not. */
  readonly result: Promise<RcWorkerStateReadResult>;
  /** When the read settled; undefined while it is in flight. */
  settledAt: number | undefined;
}

/** The status read the door's surfaces serve, holding the reads the tracker cannot (`RC_IDLE_EXPIRY_MS`). */
export type RcStatusResolver = (sessionId?: string) => Promise<RcStatusReport>;

/**
 * Creates the Remote Control status read: the tracker's synchronous status, with the worker state of every session that has none filled in from the service, plus every session that registered with the Remote Control service on this machine but that the door holds no record of. A session's state is observed only when a worker state update crosses the door while its record exists, so a session whose last state change predates the door (or whose record expired and was recreated by a heartbeat) would otherwise report nothing until its next change, however long that is; and a session none of whose traffic has crossed the door within the tracker's idle bound has no record at all, so it would be missing from the status entirely. The service holds the state, so the door asks it, on the same dial and with the same credential as its client-half writes, and marks every answer as read rather than observed.
 *
 * Every call answers the tracked sessions (filtered to one when named) and the unobserved registered ones (filtered the same way). Reads for the sessions that lack a state run concurrently, and a failed read is reported on its own session (`workerStateUnavailable`) without costing the others theirs, so one session the service refuses never hides the rest. A tracked session's successful read is filed on the tracker, so the next status finds it already there; a failed one, and every read of an unobserved session, is held for `RC_IDLE_EXPIRY_MS` and then made again.
 */
export function createRcStatusResolver(deps: RcStatusDeps): RcStatusResolver {
  const held = new Map<string, HeldRead>();
  let heldRegistry: { readonly at: number; readonly registry: ReadonlyMap<string, RcRegisteredSession> } | undefined;
  // The registry read lists and reads every record across every identity's directory and checks each record's process, all synchronously on the door's event loop, and a status is polled (the web client asks every few seconds), so the read is made at most once per `RC_IDLE_EXPIRY_MS` and its answer reused between: a session that registers, exits or is renamed shows within one bound, the span after which the door already treats its own observations of a session as stale.
  const registryOf = (now: number): ReadonlyMap<string, RcRegisteredSession> => {
    if (heldRegistry === undefined || now - heldRegistry.at >= RC_IDLE_EXPIRY_MS) {
      heldRegistry = { at: now, registry: deps.registry() };
    }
    return heldRegistry.registry;
  };
  /** Whether a held read still stands in for a fresh one: in flight, or settled within the bound. */
  const stands = (read: HeldRead, now: number): boolean => read.settledAt === undefined || now - read.settledAt < RC_IDLE_EXPIRY_MS;
  // The entry is filed before the read is awaited, so a caller arriving while it is in flight shares it rather than making its own. This also bounds the fan-out: each session has at most one read outstanding however many callers ask, and the sessions asked about are the Remote Control sessions on one machine, each a running Claude Code process, so no further concurrency cap is needed.
  const heldRead = (sessionId: string, credentialOf: (id: string) => RcObservedCredential | undefined): HeldRead => {
    const authorization = credentialOf(sessionId)?.authorization;
    const previous = held.get(sessionId);
    if (previous !== undefined && previous.authorization === authorization && stands(previous, deps.now())) {
      return previous;
    }
    const read: HeldRead = { authorization, requestedAt: deps.now(), result: deps.backends.service(sessionId, credentialOf), settledAt: undefined };
    held.set(sessionId, read);
    void read.result.then(() => {
      read.settledAt = deps.now();
    });
    return read;
  };

  return async (sessionId) => {
    const now = deps.now();
    // A settled read past its bound is dropped, so the map holds only the sessions still being asked about.
    for (const [id, read] of held) {
      if (!stands(read, now)) {
        held.delete(id);
      }
    }
    const unavailable = new Map<string, string>();
    const registry = registryOf(now);
    const statusesOf = (id: string | undefined): readonly RcTrackedSessionStatus[] => withRegisteredSessionFacts(withIdentityNames(deps.statusOf(id), deps.identityNameOf), registry);
    const trackedBefore = statusesOf(sessionId);
    const trackedIds = new Set(trackedBefore.map((status) => status.id));
    const registered = [...registry]
      .filter(([id]) => (sessionId === undefined || id === sessionId) && !trackedIds.has(id))
      .map(([id, session]) => ({ id, localSessionId: session.localSessionId, pid: session.pid }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const [, readUnobserved] = await Promise.all([
      Promise.all(
        trackedBefore
          .filter((status) => status.workerState === undefined)
          .map(async (status) => {
            if (deps.backends.selfHosted?.owns(status.id, deps.credentialOf(status.id)?.authorization) === true) {
              const read = deps.backends.selfHosted.read(status.id);
              if (read.ok) {
                deps.noteReadWorkerState(status.id, read.workerStatus, deps.now());
              } else {
                unavailable.set(status.id, read.message);
              }
              return;
            }
            const holding = heldRead(status.id, deps.credentialOf);
            const read = await holding.result;
            if (read.ok) {
              // A tracked session's state is filed on its record, so the held read has nothing left to stand in for (unless a newer read has replaced it meanwhile).
              if (held.get(status.id) === holding) {
                held.delete(status.id);
              }
              deps.noteReadWorkerState(status.id, read.workerStatus, holding.requestedAt);
            } else {
              unavailable.set(status.id, read.message);
            }
          }),
      ),
      Promise.all(
        registered.map(async (session): Promise<RcUnobservedSession> => {
          const base = { id: session.id, localSessionId: session.localSessionId, pid: session.pid };
          if (deps.backends.selfHosted?.owns(session.id, deps.persistedCredentialOf(session.id)?.authorization) === true) {
            const read = deps.backends.selfHosted.read(session.id);
            return read.ok
              ? { ...base, reason: SELF_HOSTED_QUIET_REASON, workerState: { value: read.workerStatus, observedAt: deps.now(), source: "read" }, workerStateUnavailable: undefined }
              : { ...base, reason: SELF_HOSTED_QUIET_REASON, workerState: undefined, workerStateUnavailable: read.message };
          }
          if (deps.persistedCredentialOf(session.id)?.authorization === undefined) {
            return { ...base, reason: NEVER_OBSERVED_REASON, workerState: undefined, workerStateUnavailable: noCredentialMessage(session.id) };
          }
          const holding = heldRead(session.id, deps.persistedCredentialOf);
          const read = await holding.result;
          const at = holding.requestedAt;
          return read.ok
            ? { ...base, reason: QUIET_REASON, workerState: { value: read.workerStatus, observedAt: at, source: "read" }, workerStateUnavailable: undefined }
            : { ...base, reason: QUIET_REASON, workerState: undefined, workerStateUnavailable: read.message };
        }),
      ),
    ]);
    // A registered session whose traffic began crossing the door while its read was in flight is now tracked: its read state is filed on the new record (unless an observed one got there first), and it is reported once, as tracked, never also as unobserved.
    const nowTracked = new Set(deps.statusOf(sessionId).map((status) => status.id));
    for (const session of readUnobserved) {
      if (nowTracked.has(session.id) && session.workerState !== undefined) {
        deps.noteReadWorkerState(session.id, session.workerState.value, session.workerState.observedAt);
      }
    }
    // Re-read after the filing, so a state that crossed the door while the reads were in flight is the one reported, and a session that expired meanwhile is no longer listed.
    const tracked = statusesOf(sessionId);
    const trackedAfter = new Set(tracked.map((status) => status.id));
    const statuses = tracked.map((status) => ({ ...status, workerStateUnavailable: status.workerState === undefined ? unavailable.get(status.id) : undefined }));
    return { statuses, unobserved: readUnobserved.filter((session) => !trackedAfter.has(session.id)) };
  };
}
