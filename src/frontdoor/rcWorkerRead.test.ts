import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import type { RcSessionTracker } from "./rcSessions";
import { RC_WORKER_READ_ANSWER_EXCERPT_CHARS, RC_WORKER_READ_TIMEOUT_MS, perSessionRcEventDial, readRcWorkerState, type RcEventDial } from "./rcWrites";
import { HEARTBEAT_PATH, SESSION_ID, dialOf, exchange, trackerWithClock } from "./rcWritesTestWorld";

/**
 * The worker state read: what it reads, how it fails and when it gives up, and the per-call choice of dial that decides whether it and every other client-half write goes to the self-hosted service or the real one.
 */

describe("reading a session's worker state from the service", () => {
  const WORKER_PATH_RECORD = JSON.stringify({ worker: { session_id: SESSION_ID, worker_epoch: 3, worker_status: "running", external_metadata: {} } });
  /** A dial whose worker read answers as scripted and records the headers it was sent. */
  const readingDial = (answer: () => Promise<{ status: number; body: string }>): { readonly dial: RcEventDial; readonly sent: readonly { sessionId: string; headers: Readonly<Record<string, string>> }[] } => {
    const sent: { sessionId: string; headers: Readonly<Record<string, string>> }[] = [];
    return {
      sent,
      dial: {
        ...dialOf(async () => await Promise.reject(new Error("a worker state read never writes events"))),
        readWorker: async (sessionId, headers) => {
          sent.push({ sessionId, headers });
          return await answer();
        },
      },
    };
  };
  const observedSession = (): { readonly tracker: RcSessionTracker } => {
    const { tracker } = trackerWithClock();
    exchange(tracker, { method: "POST", url: "/v1/code/sessions", authorization: "Bearer sk-ant-oat", headers: { "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }).respond(HTTP_STATUS.ok, JSON.stringify({ session: { id: SESSION_ID } }));
    return { tracker };
  };

  it("reads worker.worker_status with the observed bearer and protocol headers", async () => {
    const { tracker } = observedSession();
    const { dial, sent } = readingDial(async () => await Promise.resolve({ status: HTTP_STATUS.ok, body: WORKER_PATH_RECORD }));
    expect(await readRcWorkerState({ credentialOf: tracker.credentialOf, dial }, SESSION_ID)).toEqual({ ok: true, workerStatus: "running" });
    expect(sent).toEqual([{ sessionId: SESSION_ID, headers: { authorization: "Bearer sk-ant-oat", "anthropic-version": "2023-06-01", "anthropic-client-platform": "desktop_app" } }]);
  });

  it("refuses a session the tracker has not observed, and one holding only a worker JWT, without dialling", async () => {
    const { tracker } = observedSession();
    const { dial, sent } = readingDial(async () => await Promise.resolve({ status: HTTP_STATUS.ok, body: WORKER_PATH_RECORD }));
    const unobserved = await readRcWorkerState({ credentialOf: tracker.credentialOf, dial }, "cse_00000000-0000-4000-8000-0000000000ff");
    expect(unobserved).toEqual({ ok: false, message: expect.stringContaining("has not observed Remote Control session") as unknown });
    const workerOnly = trackerWithClock().tracker;
    exchange(workerOnly, { method: "POST", url: HEARTBEAT_PATH, authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.worker.jwt" }).respond(HTTP_STATUS.ok);
    const jwtOnly = await readRcWorkerState({ credentialOf: workerOnly.credentialOf, dial }, SESSION_ID);
    expect(jwtOnly).toEqual({ ok: false, message: expect.stringContaining("no claude.ai OAuth bearer has been observed") as unknown });
    expect(sent).toEqual([]);
  });

  it("surfaces a refused bearer, any other failing status and an unreachable host as failures naming the cause", async () => {
    const { tracker } = observedSession();
    const stale = readingDial(async () => await Promise.resolve({ status: HTTP_STATUS.unauthorized, body: "expired" }));
    expect(await readRcWorkerState({ credentialOf: tracker.credentialOf, dial: stale.dial }, SESSION_ID)).toEqual({ ok: false, message: expect.stringContaining("refused the observed Authorization bearer") as unknown });
    const refused = readingDial(async () => await Promise.resolve({ status: HTTP_STATUS.forbidden, body: "no" }));
    expect(await readRcWorkerState({ credentialOf: tracker.credentialOf, dial: refused.dial }, SESSION_ID)).toEqual({ ok: false, message: `the API answered HTTP 403 to the worker state read of session ${SESSION_ID}: no` });
    const unreachable = readingDial(async () => await Promise.reject(new Error("ECONNREFUSED")));
    expect(await readRcWorkerState({ credentialOf: tracker.credentialOf, dial: unreachable.dial }, SESSION_ID)).toEqual({ ok: false, message: expect.stringContaining("ECONNREFUSED") as unknown });
  });

  describe("against a host that never answers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts the request at the read's deadline and reports the timeout, even when the dial ignores the signal", async () => {
      vi.useFakeTimers();
      const { tracker } = observedSession();
      const signals: AbortSignal[] = [];
      const hung: RcEventDial = {
        ...dialOf(async () => await Promise.reject(new Error("a worker state read never writes events"))),
        // Never settles, whatever the signal says: the read must still settle at its deadline.
        readWorker: async (_sessionId, _headers, signal) => {
          signals.push(signal);
          return await new Promise<never>(() => undefined);
        },
      };
      let settled: Awaited<ReturnType<typeof readRcWorkerState>> | undefined;
      void readRcWorkerState({ credentialOf: tracker.credentialOf, dial: hung }, SESSION_ID).then((result) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(RC_WORKER_READ_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(settled).toEqual({ ok: false, message: expect.stringContaining("did not answer the worker state read") as unknown });
      // The resolver holds a failed read for its reuse bound, so the message promises no retry of its own.
      expect(settled?.ok === false ? settled.message : "").not.toContain("asks again");
    });

    it("reports a dial that rejects on the abort as the timeout, not as an unreachable host", async () => {
      vi.useFakeTimers();
      const { tracker } = observedSession();
      const aborting: RcEventDial = {
        ...dialOf(async () => await Promise.reject(new Error("a worker state read never writes events"))),
        readWorker: async (_sessionId, _headers, signal) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      };
      const read = readRcWorkerState({ credentialOf: tracker.credentialOf, dial: aborting }, SESSION_ID);
      await vi.advanceTimersByTimeAsync(RC_WORKER_READ_TIMEOUT_MS);
      expect(await read).toEqual({ ok: false, message: expect.stringContaining("did not answer the worker state read") as unknown });
    });
  });

  it("quotes at most an excerpt of the API's answer in a failure, saying how much was left out", async () => {
    const { tracker } = observedSession();
    const overflow = 1_000;
    const page = "x".repeat(RC_WORKER_READ_ANSWER_EXCERPT_CHARS + overflow);
    for (const status of [HTTP_STATUS.unauthorized, HTTP_STATUS.forbidden, HTTP_STATUS.ok]) {
      const { dial } = readingDial(async () => await Promise.resolve({ status, body: page }));
      const read = await readRcWorkerState({ credentialOf: tracker.credentialOf, dial }, SESSION_ID);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.message).toContain(`${"x".repeat(RC_WORKER_READ_ANSWER_EXCERPT_CHARS)}... (${String(overflow)} more characters)`);
        expect(read.message).not.toContain("x".repeat(RC_WORKER_READ_ANSWER_EXCERPT_CHARS + 1));
      }
    }
  });

  it("refuses an accepted answer that names no worker state rather than reporting an empty one", async () => {
    const { tracker } = observedSession();
    for (const body of ["not json", "{}", JSON.stringify({ worker: {} }), JSON.stringify({ worker: { worker_status: "" } }), JSON.stringify({ worker: { worker_status: 3 } })]) {
      const { dial } = readingDial(async () => await Promise.resolve({ status: HTTP_STATUS.ok, body }));
      expect(await readRcWorkerState({ credentialOf: tracker.credentialOf, dial }, SESSION_ID)).toEqual({ ok: false, message: expect.stringContaining("without a worker.worker_status") as unknown });
    }
  });
});

describe("the per-session choice of write dial", () => {
  it("sends a session the self-hosted service holds to the door's own surface, and every other session to the real service", async () => {
    const calls: string[] = [];
    const recording = (backend: string): RcEventDial => ({
      writeEvents: async (sessionId) => {
        calls.push(`${backend} events ${sessionId}`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
      writeTeleportEvents: async (sessionId) => {
        calls.push(`${backend} teleport ${sessionId}`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
      readWorker: async (sessionId) => {
        calls.push(`${backend} worker ${sessionId}`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
    });
    const selfHostedId = "cse_00000000-0000-4000-8000-0000000000a1";
    const dial = perSessionRcEventDial((id) => id === selfHostedId, recording("self-hosted"), recording("service"));
    await dial.writeEvents(selfHostedId, {}, "{}");
    await dial.writeEvents(SESSION_ID, {}, "{}");
    await dial.writeTeleportEvents(SESSION_ID, {}, "{}");
    await dial.readWorker(selfHostedId, {}, new AbortController().signal);
    expect(calls).toEqual([`self-hosted events ${selfHostedId}`, `service events ${SESSION_ID}`, `service teleport ${SESSION_ID}`, `self-hosted worker ${selfHostedId}`]);
  });

  it("decides from the headers a call carries as well as from the session, so a local credential never reaches the real service", async () => {
    const calls: string[] = [];
    const recording = (backend: string): RcEventDial => ({
      writeEvents: async () => {
        calls.push(`${backend} events`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
      writeTeleportEvents: async () => {
        calls.push(`${backend} teleport`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
      readWorker: async () => {
        calls.push(`${backend} worker`);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: "{}" });
      },
    });
    const local = { authorization: "Bearer local-minted" };
    // The service holds no session at all (a restarted door), yet the credential is the one it minted.
    const dial = perSessionRcEventDial((_id, headers) => headers.authorization === local.authorization, recording("self-hosted"), recording("service"));
    await dial.writeEvents(SESSION_ID, local, "{}");
    await dial.writeTeleportEvents(SESSION_ID, local, "{}");
    await dial.readWorker(SESSION_ID, local, new AbortController().signal);
    await dial.readWorker(SESSION_ID, { authorization: "Bearer other" }, new AbortController().signal);
    expect(calls).toEqual(["self-hosted events", "self-hosted teleport", "self-hosted worker", "service worker"]);
  });
});
