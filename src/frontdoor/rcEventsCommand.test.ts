import { describe, expect, it } from "vitest";

import { formatRcSessionEvent } from "./rcEventsCommand";

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
