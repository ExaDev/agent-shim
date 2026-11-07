import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import type { RcRegisteredSession } from "./rcRegistry";
import { createRcStatusResolver, type RcStatusResolver } from "./rcStatus";
import type { RcDialAnswer, RcEventDial, RcObservedCredential } from "./rcWrites";

/** Made-up session ids of the protocol's shape. */
const QUIET_SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const OBSERVED_SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
const REFUSED_SESSION_ID = "cse_00000000-0000-4000-8000-000000000003";
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
const OAUTH_BEARER = "Bearer sk-ant-oat";

/** Drives one exchange through the tracker the way the door's adapters do: request facts, the request body, then the response. */
function exchange(tracker: RcSessionTracker, request: Readonly<{ method: string; url: string; authorization?: string; requestBody?: string }>, respondWith: Readonly<{ status: number; body?: string }>): void {
  const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.authorization === undefined ? {} : { authorization: request.authorization } });
  if (request.requestBody !== undefined) {
    observed?.onRequestChunk?.(Buffer.from(request.requestBody, "utf8"));
    observed?.onRequestEnd?.();
  }
  observed?.onResponse(respondWith.status, {});
  if (respondWith.body !== undefined) {
    observed?.onBodyChunk(Buffer.from(respondWith.body, "utf8"));
  }
  observed?.onEnd();
}

/** A tracker that has seen each session's create with an OAuth bearer, so every one holds a credential the read can present. */
function trackerWith(...sessionIds: readonly string[]): RcSessionTracker {
  const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS });
  for (const id of sessionIds) {
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: OAUTH_BEARER }, { status: HTTP_STATUS.ok, body: JSON.stringify({ session: { id } }) });
  }
  return tracker;
}

/** A dial whose worker read answers per session as scripted, recording which sessions it was asked about. */
function readingDial(answers: Readonly<Record<string, RcDialAnswer>>): { readonly dial: RcEventDial; readonly reads: string[] } {
  const reads: string[] = [];
  const never = async (): Promise<RcDialAnswer> => await Promise.reject(new Error("a status read never writes"));
  return {
    reads,
    dial: {
      writeEvents: never,
      writeTeleportEvents: never,
      readWorker: async (sessionId) => {
        reads.push(sessionId);
        const answer = answers[sessionId];
        if (answer === undefined) {
          throw new Error(`no scripted answer for ${sessionId}`);
        }
        return await Promise.resolve(answer);
      },
    },
  };
}

const workerRecord = (workerStatus: string): RcDialAnswer => ({ status: HTTP_STATUS.ok, body: JSON.stringify({ worker: { session_id: "x", worker_epoch: 1, worker_status: workerStatus, external_metadata: {} } }) });

/** What a resolver under test is built over beyond the tracker and the dial: the registered sessions, the persisted credentials and the clock, each defaulting to nothing registered, nothing persisted and a fixed instant. */
interface ResolverWorld {
  readonly registered?: readonly RcRegisteredSession[];
  readonly persisted?: Readonly<Record<string, RcObservedCredential>>;
  readonly now?: () => number;
}

const resolverOf = (tracker: RcSessionTracker, dial: RcEventDial, world: ResolverWorld = {}): RcStatusResolver =>
  createRcStatusResolver({
    statusOf: tracker.statusOf,
    noteReadWorkerState: tracker.noteReadWorkerState,
    credentialOf: tracker.credentialOf,
    registered: () => world.registered ?? [],
    persistedCredentialOf: (sessionId) => world.persisted?.[sessionId],
    dial,
    now: world.now ?? (() => CLOCK_START_MS),
  });

/** The statuses alone of one status read, for the tests about tracked sessions. */
const statusesOf = async (resolve: RcStatusResolver, sessionId?: string) => (await resolve(sessionId)).statuses;

/** A made-up local session id and registering process for the registry fakes. */
const LOCAL_SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const REGISTERED_PID = 4242;
const registeredAs = (id: string): RcRegisteredSession => ({ id, localSessionId: LOCAL_SESSION_ID, pid: REGISTERED_PID });

describe("the Remote Control status with worker states read from the service", () => {
  it("reads the state of a session that has none and marks it as read rather than observed", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle") });
    const [status] = await statusesOf(resolverOf(tracker, dial));
    expect(status?.workerState).toEqual({ value: "idle", observedAt: CLOCK_START_MS, source: "read" });
    expect(status?.workerStateUnavailable).toBeUndefined();
    expect(reads).toEqual([QUIET_SESSION_ID]);
  });

  it("leaves an observed state alone and asks the service only about the sessions without one", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID, OBSERVED_SESSION_ID);
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${OBSERVED_SESSION_ID}/worker`, authorization: OAUTH_BEARER, requestBody: JSON.stringify({ worker_status: "running" }) }, { status: HTTP_STATUS.ok });
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("requires_action") });
    const statuses = await statusesOf(resolverOf(tracker, dial));
    expect(statuses.map((status) => [status.id, status.workerState?.value, status.workerState?.source])).toEqual([
      [QUIET_SESSION_ID, "requires_action", "read"],
      [OBSERVED_SESSION_ID, "running", "observed"],
    ]);
    expect(reads).toEqual([QUIET_SESSION_ID]);
  });

  it("reads a session's state once: the next status finds it already filed", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle") });
    const resolve = resolverOf(tracker, dial);
    await resolve();
    const [again] = await statusesOf(resolve);
    expect(again?.workerState?.source).toBe("read");
    expect(reads).toEqual([QUIET_SESSION_ID]);
  });

  it("reports a refused read on its own session with the service's answer, files nothing, still reads the others, and holds the failure for the reuse bound", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID, REFUSED_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle"), [REFUSED_SESSION_ID]: { status: HTTP_STATUS.forbidden, body: "organisation mismatch" } });
    let now = CLOCK_START_MS;
    const resolve = resolverOf(tracker, dial, { now: () => now });
    const byId = new Map((await statusesOf(resolve)).map((status) => [status.id, status]));
    expect(byId.get(QUIET_SESSION_ID)?.workerState?.value).toBe("idle");
    expect(byId.get(REFUSED_SESSION_ID)?.workerState).toBeUndefined();
    expect(byId.get(REFUSED_SESSION_ID)?.workerStateUnavailable).toBe(`the API answered HTTP 403 to the worker state read of session ${REFUSED_SESSION_ID}: organisation mismatch`);
    expect(tracker.statusOf(REFUSED_SESSION_ID)[0]?.workerState).toBeUndefined();
    // Within the bound the held failure answers, still reported, without another request.
    now += RC_IDLE_EXPIRY_MS - 1;
    expect((await statusesOf(resolve, REFUSED_SESSION_ID))[0]?.workerStateUnavailable).toContain("HTTP 403");
    expect(reads.filter((id) => id === REFUSED_SESSION_ID)).toHaveLength(1);
    // Past it the read is made again.
    now += 1;
    await resolve();
    expect(reads.filter((id) => id === REFUSED_SESSION_ID)).toHaveLength(2);
  });

  it("reports a failed dial as the reason, never as an empty state", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const dial: RcEventDial = { ...readingDial({}).dial, readWorker: async () => await Promise.reject(new Error("ECONNREFUSED")) };
    const [status] = await statusesOf(resolverOf(tracker, dial));
    expect(status?.workerState).toBeUndefined();
    expect(status?.workerStateUnavailable).toContain("ECONNREFUSED");
  });

  it("reports a session holding no OAuth bearer as unreadable without dialling", async () => {
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS });
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker/heartbeat`, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }, { status: HTTP_STATUS.ok });
    const { dial, reads } = readingDial({});
    const [status] = await statusesOf(resolverOf(tracker, dial));
    expect(status?.workerStateUnavailable).toContain("no claude.ai OAuth bearer has been observed");
    expect(reads).toEqual([]);
  });

  it("answers a named session neither tracked nor registered with an empty report and reads nothing", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads } = readingDial({});
    expect(await resolverOf(tracker, dial)(OBSERVED_SESSION_ID)).toEqual({ statuses: [], unobserved: [] });
    expect(reads).toEqual([]);
  });
});

describe("the Remote Control status under concurrent callers", () => {
  /** A dial whose every worker read waits until the test releases it, recording each request it was asked to make. */
  const gatedDial = (): { readonly dial: RcEventDial; readonly reads: string[]; readonly release: () => void } => {
    const reads: string[] = [];
    const waiting: (() => void)[] = [];
    return {
      reads,
      release: () => {
        for (const resume of waiting.splice(0)) {
          resume();
        }
      },
      dial: {
        ...readingDial({}).dial,
        readWorker: async (sessionId) => {
          reads.push(sessionId);
          await new Promise<void>((resume) => {
            waiting.push(resume);
          });
          return workerRecord("idle");
        },
      },
    };
  };
  const persisted = { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };

  it("shares one in-flight read among every caller asking about the same session", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads, release } = gatedDial();
    const resolve = resolverOf(tracker, dial, { registered: [registeredAs(OBSERVED_SESSION_ID)], persisted: { [OBSERVED_SESSION_ID]: persisted } });
    const first = resolve();
    const second = resolve();
    const third = resolve(OBSERVED_SESSION_ID);
    // Let every caller reach its awaits before the dial answers.
    await new Promise<void>((settled) => {
      setImmediate(settled);
    });
    release();
    const [, secondReport, thirdReport] = await Promise.all([first, second, third]);
    expect(reads.sort()).toEqual([QUIET_SESSION_ID, OBSERVED_SESSION_ID].sort());
    expect(secondReport.statuses[0]?.workerState?.value).toBe("idle");
    expect(thirdReport.unobserved[0]?.workerState?.value).toBe("idle");
  });

  it("measures the reuse bound from when a read settled, not from when it was made", async () => {
    const tracker = trackerWith();
    const { dial, reads, release } = gatedDial();
    let now = CLOCK_START_MS;
    const resolve = resolverOf(tracker, dial, { registered: [registeredAs(OBSERVED_SESSION_ID)], persisted: { [OBSERVED_SESSION_ID]: persisted }, now: () => now });
    const pending = resolve();
    await new Promise<void>((settled) => {
      setImmediate(settled);
    });
    // The read takes longer than the bound itself to answer.
    now += RC_IDLE_EXPIRY_MS;
    release();
    const report = await pending;
    // The answer describes the instant the read was made.
    expect(report.unobserved[0]?.workerState?.observedAt).toBe(CLOCK_START_MS);
    now += RC_IDLE_EXPIRY_MS - 1;
    await resolve();
    expect(reads).toEqual([OBSERVED_SESSION_ID]);
  });
});

describe("the Remote Control status of registered sessions the door holds no record of", () => {
  it("lists a registered session the tracker does not hold as unobserved, with its worker state read with the persisted credential", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle"), [OBSERVED_SESSION_ID]: workerRecord("requires_action") });
    const report = await resolverOf(tracker, dial, { registered: [registeredAs(QUIET_SESSION_ID), registeredAs(OBSERVED_SESSION_ID)], persisted: { [OBSERVED_SESSION_ID]: { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined } } })();
    // The tracked session is reported once, as tracked, never also as unobserved.
    expect(report.statuses.map((status) => status.id)).toEqual([QUIET_SESSION_ID]);
    expect(report.unobserved).toEqual([
      {
        id: OBSERVED_SESSION_ID,
        localSessionId: LOCAL_SESSION_ID,
        pid: REGISTERED_PID,
        reason: expect.stringContaining("none of its traffic has crossed the door") as unknown,
        workerState: { value: "requires_action", observedAt: CLOCK_START_MS, source: "read" },
        workerStateUnavailable: undefined,
      },
    ]);
    expect(reads.sort()).toEqual([QUIET_SESSION_ID, OBSERVED_SESSION_ID].sort());
  });

  it("reports a registered session no door generation observed as never observed, without dialling", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({});
    const { unobserved } = await resolverOf(tracker, dial, { registered: [registeredAs(OBSERVED_SESSION_ID)] })();
    expect(unobserved[0]?.reason).toContain("has never observed this session");
    expect(unobserved[0]?.workerState).toBeUndefined();
    expect(unobserved[0]?.workerStateUnavailable).toContain(`holds no credential for session ${OBSERVED_SESSION_ID}`);
    expect(reads).toEqual([]);
  });

  it("reports an unobserved session's failed read as the reason, holds any read for the reuse bound, and filters to a named session", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({ [REFUSED_SESSION_ID]: { status: HTTP_STATUS.unauthorized, body: "expired" }, [OBSERVED_SESSION_ID]: workerRecord("idle") });
    let now = CLOCK_START_MS;
    const persisted = { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };
    const resolve = resolverOf(tracker, dial, { registered: [registeredAs(OBSERVED_SESSION_ID), registeredAs(REFUSED_SESSION_ID)], persisted: { [OBSERVED_SESSION_ID]: persisted, [REFUSED_SESSION_ID]: persisted }, now: () => now });
    const named = await resolve(REFUSED_SESSION_ID);
    expect(named.unobserved.map((session) => session.id)).toEqual([REFUSED_SESSION_ID]);
    expect(named.unobserved[0]?.workerStateUnavailable).toContain("HTTP 401");
    now += RC_IDLE_EXPIRY_MS - 1;
    const held = await resolve();
    expect(held.unobserved.find((session) => session.id === OBSERVED_SESSION_ID)?.workerState).toEqual({ value: "idle", observedAt: now, source: "read" });
    await resolve();
    expect(reads).toEqual([REFUSED_SESSION_ID, OBSERVED_SESSION_ID]);
    now += 1;
    await resolve();
    expect(reads.filter((id) => id === REFUSED_SESSION_ID)).toHaveLength(2);
  });
});
