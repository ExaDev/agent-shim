import { HTTP_STATUS } from "../codex/http";
import type { RcSessionTracker } from "./rcSessions";
import { createRcStatusResolver, type RcStatusResolver } from "./rcStatus";
import type { RcRegisteredSession } from "./rcSessionRegistry";
import { readRcWorkerState, type RcDialAnswer, type RcEventDial } from "./rcWrites";

/** A made-up registered session the tracker under test never holds, with its local id and registering process. */
export const UNOBSERVED_TEST_SESSION_ID = "cse_00000000-0000-4000-8000-0000000000dd";
const UNOBSERVED_TEST_LOCAL_SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const UNOBSERVED_TEST_PID = 4242;

/** The instant the clock of this world always reads. A tracker built on `testStatusClock` and the resolver `testStatusResolver` builds share it, so no hold or expiry depends on real time. */
const TEST_STATUS_CLOCK_MS = 1_000_000;

/** The injected clock the world's tracker and resolver share: fixed, so a read held by the resolver never lapses and a session is never created after a registry read it was held with. */
export const testStatusClock = (): number => TEST_STATUS_CLOCK_MS;

/** The worker state every read in this world answers with. */
export const TEST_READ_WORKER_STATUS = "idle";

/** A dial whose worker read answers every session with the protocol's documented worker record, and which refuses every write: the status read only ever reads. */
const readOnlyDial: RcEventDial = {
  writeEvents: async () => await Promise.reject(new Error("a status read never writes events")),
  writeTeleportEvents: async () => await Promise.reject(new Error("a status read never writes teleport events")),
  readWorker: async (sessionId): Promise<RcDialAnswer> =>
    await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ worker: { session_id: sessionId, worker_epoch: 1, worker_status: TEST_READ_WORKER_STATUS, external_metadata: {} } }) }),
};

/**
 * The real status resolver over a tracker, with one registered session the tracker does not hold (`UNOBSERVED_TEST_SESSION_ID`) whose create a door generation persisted a credential for, a dial answering every worker read with `TEST_READ_WORKER_STATUS`, and the registry facts `registered` names for tracked sessions: the world the surfaces' tests serve their status from, so each answer passes through the real resolver and the real output schema.
 */
export function testStatusResolver(tracker: RcSessionTracker, registered: ReadonlyMap<string, RcRegisteredSession> = new Map()): RcStatusResolver {
  return createRcStatusResolver({
    statusOf: tracker.statusOf,
    noteReadWorkerState: tracker.noteReadWorkerState,
    credentialOf: tracker.credentialOf,
    registry: () => new Map([...registered, [UNOBSERVED_TEST_SESSION_ID, { localSessionId: UNOBSERVED_TEST_LOCAL_SESSION_ID, pid: UNOBSERVED_TEST_PID }]]),
    identityNameOf: (id) => id,
    persistedCredentialOf: (sessionId) => (sessionId === UNOBSERVED_TEST_SESSION_ID ? { authorization: "Bearer test-oauth", anthropicVersion: undefined, anthropicClientPlatform: undefined } : undefined),
    backends: { service: async (sessionId, credentialOf) => await readRcWorkerState({ credentialOf, dial: readOnlyDial }, sessionId) },
    now: testStatusClock,
  });
}
