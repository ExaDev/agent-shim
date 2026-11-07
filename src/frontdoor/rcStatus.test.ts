import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import type { RcRegisteredSession } from "./rcSessionRegistry";
import { createRcStatusResolver, type RcStatusResolver, type RcWorkerStateBackends } from "./rcStatus";
import { RC_WORKER_READ_TIMEOUT_MS, readRcWorkerState, type RcDialAnswer, type RcEventDial, type RcObservedCredential } from "./rcWrites";

/** Made-up session ids of the protocol's shape. */
const QUIET_SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
const OBSERVED_SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
const REFUSED_SESSION_ID = "cse_00000000-0000-4000-8000-000000000003";
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
const CLOCK_START_MS = 1_000;
const OAUTH_BEARER = "Bearer sk-ant-oat";
/** The same session's bearer after its client refreshed it, built from the base value so the source holds no literal token-shaped string for the repository's secret-redaction filter to rewrite. */
const REFRESHED_OAUTH_BEARER = `${OAUTH_BEARER}-refreshed`;

/** Drives one exchange through the tracker the way the door's adapters do: request facts, the request body, then the response. */
function exchange(tracker: RcSessionTracker, request: Readonly<{ method: string; url: string; authorization?: string; requestBody?: string; identity?: string }>, respondWith: Readonly<{ status: number; body?: string }>): void {
  const observed = tracker.observeExchange({ method: request.method, url: request.url, headers: request.authorization === undefined ? {} : { authorization: request.authorization }, ...(request.identity === undefined ? {} : { identity: request.identity }) });
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

/** What a resolver under test is built over beyond the tracker and the dial: the registry, the identity names, the persisted credentials, the clock and the self-hosted backend, each defaulting to nothing registered, no identity names, nothing persisted, a fixed instant and no self-hosted service. */
interface ResolverWorld {
  readonly registered?: ReadonlyMap<string, RcRegisteredSession>;
  readonly identityNames?: Readonly<Record<string, string>>;
  readonly persisted?: Readonly<Record<string, RcObservedCredential>>;
  readonly now?: () => number;
  readonly selfHosted?: RcWorkerStateBackends["selfHosted"];
}

const resolverOf = (tracker: RcSessionTracker, dial: RcEventDial, world: ResolverWorld = {}): RcStatusResolver =>
  createRcStatusResolver({
    statusOf: tracker.statusOf,
    noteReadWorkerState: tracker.noteReadWorkerState,
    credentialOf: tracker.credentialOf,
    registry: () => world.registered ?? new Map(),
    identityNameOf: (id) => world.identityNames?.[id],
    persistedCredentialOf: (sessionId) => world.persisted?.[sessionId],
    backends: { ...(world.selfHosted === undefined ? {} : { selfHosted: world.selfHosted }), service: async (sessionId, credentialOf) => await readRcWorkerState({ credentialOf, dial }, sessionId) },
    now: world.now ?? (() => CLOCK_START_MS),
  });

/** The statuses alone of one status read, for the tests about tracked sessions. */
const statusesOf = async (resolve: RcStatusResolver, sessionId?: string) => (await resolve(sessionId)).statuses;

/** A made-up local session id and registering process for the registry fakes. */
const LOCAL_SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const REGISTERED_PID = 4242;
const registeredAs = (id: string): [string, RcRegisteredSession] => [id, { localSessionId: LOCAL_SESSION_ID, pid: REGISTERED_PID }];

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

  it("stamps a read state with when the read was made, not when its answer was filed", async () => {
    let now = CLOCK_START_MS;
    // The tracker and the resolver share one clock, so filing time and read time differ exactly as they would live.
    const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS });
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: OAUTH_BEARER }, { status: HTTP_STATUS.ok, body: JSON.stringify({ session: { id: QUIET_SESSION_ID } }) });
    const { dial } = readingDial({});
    const slow: RcEventDial = {
      ...dial,
      readWorker: async () => {
        now += RC_IDLE_EXPIRY_MS / 2;
        return await Promise.resolve(workerRecord("idle"));
      },
    };
    const [status] = await statusesOf(resolverOf(tracker, slow, { now: () => now }));
    expect(status?.workerState).toEqual({ value: "idle", observedAt: CLOCK_START_MS, source: "read" });
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

  it("reports a refused read on its own session with the service's answer, files nothing, still reads the others, and holds the failure only while the credential is unchanged", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID, REFUSED_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle"), [REFUSED_SESSION_ID]: { status: HTTP_STATUS.unauthorized, body: "expired" } });
    let now = CLOCK_START_MS;
    const resolve = resolverOf(tracker, dial, { now: () => now });
    const byId = new Map((await statusesOf(resolve)).map((status) => [status.id, status]));
    expect(byId.get(QUIET_SESSION_ID)?.workerState?.value).toBe("idle");
    expect(byId.get(REFUSED_SESSION_ID)?.workerState).toBeUndefined();
    expect(byId.get(REFUSED_SESSION_ID)?.workerStateUnavailable).toContain("refused the observed Authorization bearer");
    expect(tracker.statusOf(REFUSED_SESSION_ID)[0]?.workerState).toBeUndefined();
    // With the same credential, the held failure answers within the bound, still reported, without another request.
    now += 1;
    expect((await statusesOf(resolve, REFUSED_SESSION_ID))[0]?.workerStateUnavailable).toContain("HTTP 401");
    expect(reads.filter((id) => id === REFUSED_SESSION_ID)).toHaveLength(1);
    // The session's client refreshes its bearer, which the door observes: the held 401 described the old one, so the next status reads again at once.
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${REFUSED_SESSION_ID}/client/presence`, authorization: REFRESHED_OAUTH_BEARER }, { status: HTTP_STATUS.ok });
    await resolve();
    expect(reads.filter((id) => id === REFUSED_SESSION_ID)).toHaveLength(2);
  });

  it("reads at once when a bearer is observed for a session whose held answer was that it had none", async () => {
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS });
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker/heartbeat`, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }, { status: HTTP_STATUS.ok });
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("running") });
    const resolve = resolverOf(tracker, dial);
    expect((await statusesOf(resolve))[0]?.workerStateUnavailable).toContain("no claude.ai OAuth bearer has been observed");
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${QUIET_SESSION_ID}/client/presence`, authorization: OAUTH_BEARER }, { status: HTTP_STATUS.ok });
    expect((await statusesOf(resolve))[0]?.workerState).toEqual({ value: "running", observedAt: CLOCK_START_MS, source: "read" });
    expect(reads).toEqual([QUIET_SESSION_ID]);
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

describe("the Remote Control status when traffic crosses the door while a read is in flight", () => {
  it("reports a state observed during the read over the state the read returned", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial } = readingDial({});
    const racing: RcEventDial = {
      ...dial,
      readWorker: async () => {
        exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker`, authorization: OAUTH_BEARER, requestBody: JSON.stringify({ worker_status: "running" }) }, { status: HTTP_STATUS.ok });
        return await Promise.resolve(workerRecord("idle"));
      },
    };
    const [status] = await statusesOf(resolverOf(tracker, racing));
    expect(status?.workerState).toEqual({ value: "running", observedAt: CLOCK_START_MS, source: "observed" });
  });

  it("reports a registered session whose create crossed the door during its read once, as tracked, with the state read", async () => {
    const tracker = trackerWith();
    const { dial } = readingDial({});
    const racing: RcEventDial = {
      ...dial,
      readWorker: async () => {
        exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: OAUTH_BEARER }, { status: HTTP_STATUS.ok, body: JSON.stringify({ session: { id: OBSERVED_SESSION_ID } }) });
        return await Promise.resolve(workerRecord("requires_action"));
      },
    };
    const persisted = { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };
    const report = await resolverOf(tracker, racing, { registered: new Map([registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: persisted } })();
    expect(report.unobserved).toEqual([]);
    expect(report.statuses.map((status) => [status.id, status.workerState?.value, status.workerState?.source])).toEqual([[OBSERVED_SESSION_ID, "requires_action", "read"]]);
  });
});

describe("the Remote Control status against a host that hangs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers at the read's deadline with the hung session's timeout and every other session's state", async () => {
    vi.useFakeTimers();
    const tracker = trackerWith(QUIET_SESSION_ID, REFUSED_SESSION_ID);
    const { dial } = readingDial({ [QUIET_SESSION_ID]: workerRecord("idle") });
    const hanging: RcEventDial = {
      ...dial,
      readWorker: async (sessionId, headers, signal) => (sessionId === REFUSED_SESSION_ID ? await new Promise<never>(() => undefined) : await dial.readWorker(sessionId, headers, signal)),
    };
    let report: Awaited<ReturnType<RcStatusResolver>> | undefined;
    void resolverOf(tracker, hanging)().then((answer) => {
      report = answer;
    });
    await vi.advanceTimersByTimeAsync(RC_WORKER_READ_TIMEOUT_MS - 1);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const byId = new Map(report?.statuses.map((status) => [status.id, status]));
    expect(byId.get(QUIET_SESSION_ID)?.workerState?.value).toBe("idle");
    expect(byId.get(REFUSED_SESSION_ID)?.workerStateUnavailable).toContain("did not answer the worker state read");
  });
});

describe("the Remote Control status when a backend read rejects", () => {
  it("reports the rejection on its own session, holds it for the reuse bound like any failed read, and asks again once the bound lapses", async () => {
    let now = CLOCK_START_MS;
    let asked = 0;
    const tracker = trackerWith(QUIET_SESSION_ID, OBSERVED_SESSION_ID);
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${OBSERVED_SESSION_ID}/worker`, authorization: OAUTH_BEARER, requestBody: JSON.stringify({ worker_status: "running" }) }, { status: HTTP_STATUS.ok });
    const resolve = createRcStatusResolver({
      statusOf: tracker.statusOf,
      noteReadWorkerState: tracker.noteReadWorkerState,
      credentialOf: tracker.credentialOf,
      registry: () => new Map(),
      identityNameOf: () => undefined,
      persistedCredentialOf: () => undefined,
      backends: {
        service: async () => {
          asked += 1;
          return await Promise.reject(new Error("socket hang up"));
        },
      },
      now: () => now,
    });
    const first = await statusesOf(resolve);
    expect(first.map((status) => [status.id, status.workerState?.value, status.workerStateUnavailable])).toEqual([
      [QUIET_SESSION_ID, undefined, expect.stringContaining("socket hang up") as unknown],
      [OBSERVED_SESSION_ID, "running", undefined],
    ]);
    await resolve();
    expect(asked).toBe(1);
    now += RC_IDLE_EXPIRY_MS;
    await resolve();
    expect(asked).toBe(2);
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
    const resolve = resolverOf(tracker, dial, { registered: new Map([registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: persisted } });
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
    const resolve = resolverOf(tracker, dial, { registered: new Map([registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: persisted }, now: () => now });
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
    const report = await resolverOf(tracker, dial, { registered: new Map([registeredAs(QUIET_SESSION_ID), registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined } } })();
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
    const { unobserved } = await resolverOf(tracker, dial, { registered: new Map([registeredAs(OBSERVED_SESSION_ID)]) })();
    expect(unobserved[0]?.reason).toContain("has never observed this session");
    // Each clause of the reason is joined once: no doubled punctuation from the clauses it is built from.
    expect(unobserved[0]?.reason).not.toMatch(/[,.;:]{2}/u);
    expect(unobserved[0]?.workerState).toBeUndefined();
    expect(unobserved[0]?.workerStateUnavailable).toContain(`holds no credential for session ${OBSERVED_SESSION_ID}`);
    expect(reads).toEqual([]);
  });

  it("reports an unobserved session's failed read as the reason, holds any read for the reuse bound, and filters to a named session", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({ [REFUSED_SESSION_ID]: { status: HTTP_STATUS.unauthorized, body: "expired" }, [OBSERVED_SESSION_ID]: workerRecord("idle") });
    let now = CLOCK_START_MS;
    const persisted = { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };
    const resolve = resolverOf(tracker, dial, { registered: new Map([registeredAs(OBSERVED_SESSION_ID), registeredAs(REFUSED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: persisted, [REFUSED_SESSION_ID]: persisted }, now: () => now });
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

describe("the Remote Control status enriched from the session registry", () => {
  it("names each tracked session from the registry and the identity by name, reading the registry once per call", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker`, authorization: OAUTH_BEARER, requestBody: JSON.stringify({ worker_status: "running" }) }, { status: HTTP_STATUS.ok });
    let registryReads = 0;
    const registry = new Map([[QUIET_SESSION_ID, { localSessionId: LOCAL_SESSION_ID, pid: REGISTERED_PID, name: "fix the thing", cwd: "/repo" }]]);
    const resolve = createRcStatusResolver({
      statusOf: tracker.statusOf,
      noteReadWorkerState: tracker.noteReadWorkerState,
      credentialOf: tracker.credentialOf,
      registry: () => {
        registryReads += 1;
        return registry;
      },
      identityNameOf: () => undefined,
      persistedCredentialOf: () => undefined,
      backends: { service: async () => await Promise.reject(new Error("a tracked session with an observed state needs no read")) },
      now: () => CLOCK_START_MS,
    });
    const [status] = await statusesOf(resolve);
    expect(status).toMatchObject({ id: QUIET_SESSION_ID, name: "fix the thing", pid: REGISTERED_PID, cwd: "/repo" });
    expect(registryReads).toBe(1);
  });

  it("reads the registry at most once per idle bound, however often the status is polled", async () => {
    let now = CLOCK_START_MS;
    let registryReads = 0;
    const tracker = trackerWith();
    const resolve = createRcStatusResolver({
      statusOf: tracker.statusOf,
      noteReadWorkerState: tracker.noteReadWorkerState,
      credentialOf: tracker.credentialOf,
      registry: () => {
        registryReads += 1;
        return new Map();
      },
      identityNameOf: () => undefined,
      persistedCredentialOf: () => undefined,
      backends: { service: async () => await Promise.reject(new Error("nothing to read")) },
      now: () => now,
    });
    await resolve();
    await resolve();
    now += RC_IDLE_EXPIRY_MS - 1;
    await resolve();
    expect(registryReads).toBe(1);
    now += 1;
    await resolve();
    expect(registryReads).toBe(2);
  });

  /** A resolver over a registry the test edits between calls, counting each read of it, on a clock the test advances; the tracker shares the clock so a session's creation is ordered against the registry hold. */
  const registryWorld = () => {
    const world = { now: CLOCK_START_MS, reads: 0, registry: new Map<string, RcRegisteredSession>() };
    const tracker = createRcSessionTracker({ now: () => world.now, idleMs: RC_IDLE_EXPIRY_MS });
    const resolve = createRcStatusResolver({
      statusOf: tracker.statusOf,
      noteReadWorkerState: tracker.noteReadWorkerState,
      credentialOf: tracker.credentialOf,
      registry: () => {
        world.reads += 1;
        return world.registry;
      },
      identityNameOf: () => undefined,
      persistedCredentialOf: () => undefined,
      backends: { service: async () => await Promise.resolve({ ok: false as const, message: "no read in this test" }) },
      now: () => world.now,
    });
    return { world, tracker, resolve };
  };

  it("finds a session that registered after the registry was held when it is asked for by id, reading the registry once more for that request", async () => {
    const { world, resolve } = registryWorld();
    expect((await resolve()).unobserved).toEqual([]);
    world.registry = new Map([registeredAs(OBSERVED_SESSION_ID)]);
    expect((await resolve(OBSERVED_SESSION_ID)).unobserved.map((session) => session.id)).toEqual([OBSERVED_SESSION_ID]);
    expect(world.reads).toBe(2);
    // An id the registry still does not list costs one read per request, never more.
    const readsBefore = world.reads;
    await resolve(QUIET_SESSION_ID);
    expect(world.reads).toBe(readsBefore + 1);
  });

  it("names a session that began crossing the door after the registry was held, and holds the registry again for sessions that were already there", async () => {
    const { world, tracker, resolve } = registryWorld();
    await resolve();
    world.now += 1;
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: OAUTH_BEARER }, { status: HTTP_STATUS.ok, body: JSON.stringify({ session: { id: QUIET_SESSION_ID } }) });
    world.registry = new Map([[QUIET_SESSION_ID, { localSessionId: LOCAL_SESSION_ID, pid: REGISTERED_PID, name: "fresh session" }]]);
    expect((await statusesOf(resolve))[0]?.name).toBe("fresh session");
    expect(world.reads).toBe(2);
    await resolve();
    expect(world.reads).toBe(2);
  });

  it("reports the identity a session's requests carried under its current name, and none once that identity is gone", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    exchange(tracker, { method: "PUT", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker`, authorization: OAUTH_BEARER, requestBody: JSON.stringify({ worker_status: "running" }), identity: "identity-id" }, { status: HTTP_STATUS.ok });
    const { dial } = readingDial({});
    const named = await statusesOf(resolverOf(tracker, dial, { identityNames: { "identity-id": "work" } }));
    expect(named[0]?.identity).toBe("work");
    const gone = await statusesOf(resolverOf(tracker, dial, { identityNames: {} }));
    expect(gone[0]?.identity).toBeUndefined();
  });
});

describe("the Remote Control status across the three kinds of session, each read from its own backend", () => {
  /** The credential the self-hosted service minted: it says whose the session is even when the service holds nothing (a door restart, or a session retired for idleness). */
  const LOCAL_BEARER = "Bearer sk-ant-oat1";
  const localCredential = { authorization: LOCAL_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };

  /** A self-hosted backend holding the named sessions with the named states (a held session with no state yet maps to undefined), recording what it was asked. */
  const selfHostedWith = (states: Readonly<Record<string, string | undefined>>) => {
    const asked: string[] = [];
    return {
      asked,
      selfHosted: {
        owns: (id: string, authorization: string | undefined) => id in states || authorization === LOCAL_BEARER,
        read: (id: string) => {
          asked.push(id);
          const state = states[id];
          return state === undefined ? { ok: false as const, message: `the self-hosted Remote Control service holds no worker state for session ${id}` } : { ok: true as const, workerStatus: state };
        },
      },
    };
  };
  const persisted = { authorization: OAUTH_BEARER, anthropicVersion: undefined, anthropicClientPlatform: undefined };

  it("never reads an unobserved session holding the self-hosted credential from the real service, even when the service holds no session (a restarted door)", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({});
    const { selfHosted, asked } = selfHostedWith({});
    const { unobserved } = await resolverOf(tracker, dial, { selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: localCredential } })();
    expect(reads).toEqual([]);
    expect(asked).toEqual([OBSERVED_SESSION_ID]);
    expect(unobserved[0]?.workerState).toBeUndefined();
    expect(unobserved[0]?.workerStateUnavailable).toBeDefined();
  });

  it("never reads a tracked session whose observed credential is the self-hosted one from the real service once the service has retired it", async () => {
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS });
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: LOCAL_BEARER }, { status: HTTP_STATUS.ok, body: JSON.stringify({ session: { id: QUIET_SESSION_ID } }) });
    const { dial, reads } = readingDial({});
    const { selfHosted, asked } = selfHostedWith({});
    const [status] = await statusesOf(resolverOf(tracker, dial, { selfHosted }));
    expect(reads).toEqual([]);
    expect(asked).toEqual([QUIET_SESSION_ID]);
    expect(status?.workerState).toBeUndefined();
    expect(status?.workerStateUnavailable).toBeDefined();
  });


  it("reads a native or provider session (created against claude.ai, holding an OAuth bearer) from the real service, even beside a self-hosted service", async () => {
    const tracker = trackerWith(QUIET_SESSION_ID);
    const { dial, reads } = readingDial({ [QUIET_SESSION_ID]: workerRecord("running") });
    const { selfHosted, asked } = selfHostedWith({});
    const [status] = await statusesOf(resolverOf(tracker, dial, { selfHosted }));
    expect(status?.workerState).toEqual({ value: "running", observedAt: CLOCK_START_MS, source: "read" });
    expect(reads).toEqual([QUIET_SESSION_ID]);
    expect(asked).toEqual([]);
  });

  it("reads a self-hosted session (no Anthropic login at all) from the door's own service in process, with no credential and no dial", async () => {
    // The self-hosted CLI presents the minted credential, never an observed claude.ai bearer, so the service backend could not read it.
    const tracker = createRcSessionTracker({ now: () => CLOCK_START_MS, idleMs: RC_IDLE_EXPIRY_MS });
    exchange(tracker, { method: "POST", url: `/v1/code/sessions/${QUIET_SESSION_ID}/worker/heartbeat`, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }, { status: HTTP_STATUS.ok });
    const { dial, reads } = readingDial({});
    const { selfHosted, asked } = selfHostedWith({ [QUIET_SESSION_ID]: "requires_action", [OBSERVED_SESSION_ID]: "idle" });
    const report = await resolverOf(tracker, dial, { selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]) })();
    expect(report.statuses[0]?.workerState).toEqual({ value: "requires_action", observedAt: CLOCK_START_MS, source: "read" });
    // A registered self-hosted session the tracker has let go of is still read, from the service that holds it, without any credential.
    expect(report.unobserved).toEqual([
      { id: OBSERVED_SESSION_ID, localSessionId: LOCAL_SESSION_ID, pid: REGISTERED_PID, reason: expect.stringContaining("self-hosted Remote Control service still holds it") as unknown, workerState: { value: "idle", observedAt: CLOCK_START_MS, source: "read" }, workerStateUnavailable: undefined },
    ]);
    expect(reads).toEqual([]);
    expect(asked.sort()).toEqual([QUIET_SESSION_ID, OBSERVED_SESSION_ID].sort());
  });

  it("never holds a self-hosted read, so the next status sees the service's current state", async () => {
    const tracker = trackerWith();
    const { dial } = readingDial({});
    const states: Record<string, string | undefined> = { [OBSERVED_SESSION_ID]: "running" };
    const resolve = resolverOf(tracker, dial, { selfHosted: selfHostedWith(states).selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]) });
    expect((await resolve()).unobserved[0]?.workerState?.value).toBe("running");
    states[OBSERVED_SESSION_ID] = "idle";
    expect((await resolve()).unobserved[0]?.workerState?.value).toBe("idle");
  });

  it("reports a self-hosted session whose worker has reported no state with the service's reason", async () => {
    const tracker = trackerWith();
    const { dial } = readingDial({});
    const { unobserved } = await resolverOf(tracker, dial, { selfHosted: selfHostedWith({ [OBSERVED_SESSION_ID]: undefined }).selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]) })();
    expect(unobserved[0]?.workerState).toBeUndefined();
    expect(unobserved[0]?.workerStateUnavailable).toContain("holds no worker state");
  });

  it("reports a session neither backend can read (the self-hosted service does not hold it, and no OAuth credential exists) as never observed, without asking either", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({});
    const { selfHosted, asked } = selfHostedWith({});
    const { unobserved } = await resolverOf(tracker, dial, { selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]) })();
    expect(unobserved[0]?.reason).toContain("no self-hosted Remote Control service of the door holds it");
    expect(unobserved[0]?.workerStateUnavailable).toContain("holds no credential");
    expect(reads).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("reads a session the self-hosted service does not hold but a door generation persisted an OAuth credential for from the real service", async () => {
    const tracker = trackerWith();
    const { dial, reads } = readingDial({ [OBSERVED_SESSION_ID]: workerRecord("idle") });
    const { unobserved } = await resolverOf(tracker, dial, { selfHosted: selfHostedWith({}).selfHosted, registered: new Map([registeredAs(OBSERVED_SESSION_ID)]), persisted: { [OBSERVED_SESSION_ID]: persisted } })();
    expect(unobserved[0]?.workerState?.value).toBe("idle");
    expect(reads).toEqual([OBSERVED_SESSION_ID]);
  });
});
