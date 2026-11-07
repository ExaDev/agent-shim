import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import type { RcEventDial } from "./rcWrites";

/**
 * What the client-half write tests share: a made-up session id, a tracker over a clock the test moves, an exchange driven through the tracker the way the door's adapters drive it, and a whole dial completed from a `writeEvents` fake.
 */

/** A made-up session id of the protocol's shape, and the recurring path that names it. */
export const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
export const HEARTBEAT_PATH = `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`;
/** Where the fake clock starts, so the expected timestamps are the constants the tests name. */
export const CLOCK_START_MS = 1_000;
/** One exchange driven through the tracker the way the door's adapters drive it: request facts, the request body's chunks and end, then the response head, body and end. */
export function exchange(tracker: RcSessionTracker, request: { method: string; url: string; authorization?: string; headers?: Record<string, string>; requestBody?: string }): { readonly respond: (status: number, body?: string, headers?: Record<string, string>) => void } {
  const observed = tracker.observeExchange({
    method: request.method,
    url: request.url,
    headers: { ...(request.authorization === undefined ? {} : { authorization: request.authorization }), ...(request.headers ?? {}) },
  });
  return {
    respond: (status, body = "", headers = {}) => {
      if (request.requestBody !== undefined && observed?.onRequestChunk !== undefined) {
        const half = Math.floor(request.requestBody.length / 2);
        observed.onRequestChunk(Buffer.from(request.requestBody.slice(0, half), "utf8"));
        observed.onRequestChunk(Buffer.from(request.requestBody.slice(half), "utf8"));
        observed.onRequestEnd?.();
      }
      observed?.onResponse(status, headers);
      if (body !== "") {
        observed?.onBodyChunk(Buffer.from(body, "utf8"));
      }
      observed?.onEnd();
    },
  };
}

/** A tracker over a mutable fake clock, so the idle bound is reached by moving time rather than waiting. */
export function trackerWithClock(startAt = CLOCK_START_MS): { readonly tracker: RcSessionTracker; readonly advance: (ms: number) => void } {
  let now = startAt;
  const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS });
  return { tracker, advance: (ms) => {
      now += ms;
    } };
}

/**
 * Completes one writeEvents fake into a whole dial: the teleport half stands as a refusal that names the test, because no non-teleport operation may ever post to the teleport path (the one write the family addresses elsewhere), so an unexpected call fails the test loudly instead of answering as though the path were the events path. The teleport operation's own tests pass a recording teleport half of their own.
 */
export function dialOf(writeEvents: RcEventDial["writeEvents"]): RcEventDial {
  return {
    writeEvents,
    writeTeleportEvents: async () => await Promise.reject(new Error("no operation but the teleport write posts to the teleport-events path")),
    readWorker: async () => await Promise.reject(new Error("no operation but the worker state read gets the worker record")),
  };
}
