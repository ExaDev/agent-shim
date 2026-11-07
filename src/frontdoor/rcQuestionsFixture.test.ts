import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import fixture from "./fixtures/rc-question-2.1.319.json";
import { RC_IDLE_EXPIRY_MS, createRcSessionTracker } from "./rcSessions";
import { RcStreamEnvelopeSchema } from "./rcSchemas";
import { answerRcControlRequest, type RcEventDial } from "./rcWrites";

/**
 * The question exchange captured from a real Claude Code 2.1.319 session (see the fixture's own `source`): what the CLI sends when its agent asks a question, the answer it accepted and continued on, and the sequence it emits when the question is dismissed in its terminal. The tracker and the answer builder are checked against those bytes, not against shapes written by hand.
 */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000000";

/** Where the fake clock starts. */
const CLOCK_START_MS = 1_000;

const envelopeOf = (value: unknown) => RcStreamEnvelopeSchema.parse(value);

/** The heartbeat cadence the CLI keeps a live session on, which the tracker's idle bound is derived from. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** A tracker holding the fixture's session, over a clock the test moves; moving it delivers the session's heartbeats on their cadence, as a live session's would arrive. */
function trackerWithSession(): { readonly tracker: ReturnType<typeof createRcSessionTracker>; readonly advance: (ms: number) => void } {
  let now = CLOCK_START_MS;
  const tracker = createRcSessionTracker({ now: () => now, idleMs: RC_IDLE_EXPIRY_MS });
  const heartbeat = (): void => {
    const observed = tracker.observeExchange({ method: "POST", url: `/v1/code/sessions/${SESSION_ID}/worker/heartbeat`, headers: { authorization: "Bearer b" } });
    observed?.onResponse(HTTP_STATUS.ok, {});
    observed?.onEnd();
  };
  heartbeat();
  return {
    tracker,
    advance: (ms) => {
      for (let left = ms; left > 0; left -= HEARTBEAT_INTERVAL_MS) {
        now += Math.min(left, HEARTBEAT_INTERVAL_MS);
        heartbeat();
      }
    },
  };
}

describe("the captured 2.1.319 question exchange", () => {
  const question = envelopeOf(fixture.question);
  const requestId = fixture.question.payload.request_id;

  it("lists the captured question's text, header, selection kind and options", () => {
    const { tracker } = trackerWithSession();
    tracker.fileStreamEvent(SESSION_ID, question);
    expect(tracker.pendingOf()[0]?.questions).toEqual(fixture.question.payload.request.input.questions);
  });

  it("holds it for as long as the worker waited before the captured answer, which the worker still accepted", () => {
    const { tracker, advance } = trackerWithSession();
    tracker.fileStreamEvent(SESSION_ID, question);
    advance(Date.parse(fixture.answer.created_at) - Date.parse(fixture.question.created_at));
    expect(tracker.pendingOf().map((pending) => pending.requestId)).toEqual([requestId]);
  });

  it("builds exactly the answer the CLI accepted, resolving the chosen labels against the captured questions", async () => {
    const { tracker } = trackerWithSession();
    tracker.fileStreamEvent(SESSION_ID, question);
    const written: string[] = [];
    const dial: RcEventDial = {
      writeEvents: async (_sessionId, _headers, body) => {
        written.push(body);
        return await Promise.resolve({ status: HTTP_STATUS.ok, body: JSON.stringify({ results: [{ sequence_num: 1 }] }) });
      },
      writeTeleportEvents: async () => await Promise.reject(new Error("the answer path never teleports")),
    };
    const credentialOf = () => ({ authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: undefined });
    // The choices the live session was answered with, resolved by the door's own path, not the fixture's answers fed back in.
    const result = await answerRcControlRequest({ credentialOf, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, pendingToolInputOf: tracker.pendingToolInputOf, claimPending: tracker.claimPending, noteSequenceNums: tracker.noteSequenceNums, dial }, SESSION_ID, requestId, { approve: true, message: undefined, choices: [["SQLite"], ["lint", "test"]] });
    expect(result.ok).toBe(true);
    const [body] = written;
    // The service stamps its own receipt time onto the event it relays, so the comparison is with the payload the client wrote: its type and response.
    const { type, response } = fixture.answer.payload;
    expect(body === undefined ? undefined : JSON.parse(body)).toEqual({ events: [{ payload: { type, response } }] });
  });

  it("retires the question on the captured dismissal: the worker's own deny, then its control_cancel_request", () => {
    const { tracker } = trackerWithSession();
    tracker.fileStreamEvent(SESSION_ID, envelopeOf(fixture.dismissedQuestion));
    tracker.fileStreamEvent(SESSION_ID, envelopeOf(fixture.dismissalCancel));
    expect(tracker.pendingOf()).toEqual([]);
    const { tracker: second } = trackerWithSession();
    second.fileStreamEvent(SESSION_ID, envelopeOf(fixture.dismissedQuestion));
    second.fileStreamEvent(SESSION_ID, envelopeOf(fixture.dismissalResponse));
    expect(second.pendingOf()).toEqual([]);
  });
});
