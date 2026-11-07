import { describe, expect, it } from "vitest";

import type { RcSessionEvent } from "./rcEventLog";
import { RcSessionEventsStreamEndedError, formatRcSessionEvent, lastCursorOf, printRcSessionEvents } from "./rcEventsCommand";

/** A made-up cursor and session of the production shapes. */
const CURSOR = "00000000-0000-4000-8000-0000000000aa.7";
const SESSION = "cse_00000000-0000-4000-8000-00000000000a";
/** An instant whose ISO form the lines assert. */
const AT_ISO = "2026-01-02T03:04:05.000Z";
const AT = Date.parse(AT_ISO);

describe("frontdoor rc events lines", () => {
  it("names the cursor, instant, session and kind of every event, with each kind's own detail", () => {
    const base = { cursor: CURSOR, sequence: 7, session: SESSION, at: AT };
    expect(formatRcSessionEvent({ ...base, kind: "session-appeared" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  session-appeared`);
    expect(formatRcSessionEvent({ ...base, kind: "session-ended", reason: "expired" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  session-ended  expired`);
    expect(formatRcSessionEvent({ ...base, kind: "worker-state", state: "running" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  worker-state  running`);
    expect(formatRcSessionEvent({ ...base, kind: "worker-state", state: "idle", previous: "running" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  worker-state  running -> idle`);
    expect(formatRcSessionEvent({ ...base, kind: "pending-born", requestId: "req_1", type: "can_use_tool", summary: "Bash {}" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  pending-born  req_1 can_use_tool Bash {}`);
    expect(formatRcSessionEvent({ ...base, kind: "pending-retired", requestId: "req_1", reason: "answered" })).toBe(`${CURSOR}  ${AT_ISO}  ${SESSION}  pending-retired  req_1 answered`);
  });
});

/** A stream of the given events, failing with `failure` after them when one is named. */
async function* streamOf(events: readonly RcSessionEvent[], failure?: Error): AsyncGenerator<RcSessionEvent, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

describe("frontdoor rc events printing", () => {
  const event = (sequence: number): RcSessionEvent => ({ kind: "session-appeared", cursor: `00000000-0000-4000-8000-0000000000aa.${String(sequence)}`, sequence, session: SESSION, at: AT });

  it("resolves to the last cursor printed when the stream ends, and to the starting cursor when it printed nothing", async () => {
    const lines: string[] = [];
    const last = await printRcSessionEvents(streamOf([event(1), event(2)]), { json: true, since: undefined }, (line) => {
      lines.push(line);
    });
    expect(last).toBe(event(2).cursor);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([event(1), event(2)]);
    expect(await printRcSessionEvents(streamOf([]), { json: false, since: CURSOR }, () => undefined)).toBe(CURSOR);
  });

  it("carries the last cursor printed on a failure, with the failure as its cause", async () => {
    const dropped = new Error("socket hang up");
    const failure = await printRcSessionEvents(streamOf([event(1)], dropped), { json: false, since: undefined }, () => undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RcSessionEventsStreamEndedError);
    expect(failure instanceof RcSessionEventsStreamEndedError ? [failure.lastCursor, failure.cause] : []).toEqual([event(1).cursor, dropped]);
  });
});

describe("frontdoor rc events resume cursor on leaving", () => {
  it("names the last event printed when the stream had begun, and the starting cursor when it had not", () => {
    const left = new DOMException("left", "AbortError");
    expect(lastCursorOf(new RcSessionEventsStreamEndedError(left, `${CURSOR}9`), CURSOR)).toBe(`${CURSOR}9`);
    expect(lastCursorOf(left, CURSOR)).toBe(CURSOR);
    expect(lastCursorOf(left, undefined)).toBeUndefined();
  });
});
