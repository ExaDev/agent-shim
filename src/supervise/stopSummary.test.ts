import { describe, expect, it } from "vitest";

import { stopHooksFinished } from "./stopSummary";

const SESSION = "77777777-7777-4777-8777-777777777777";
const AT = "2026-11-06T22:42:47.200Z";
const AFTER = "2026-11-06T22:42:47.206Z";
const line = (value: object): string => `${JSON.stringify(value)}\n`;
const finished = { type: "system", subtype: "stop_hook_summary", sessionId: SESSION, timestamp: AFTER, preventedContinuation: false, stopReason: "", hookErrors: [] };

describe("stopHooksFinished", () => {
  it("requires the current turn's complete successful hook summary", () => {
    expect(stopHooksFinished(line(finished), SESSION, AT)).toBe(true);
    expect(stopHooksFinished("", SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ ...finished, timestamp: "2026-11-06T22:42:47.100Z" }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ ...finished, sessionId: "another" }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ ...finished, hookErrors: ["blocked"] }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ ...finished, preventedContinuation: true }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ ...finished, stopReason: "continue" }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line({ type: "system", subtype: "stop_hook_summary", timestamp: AFTER }), SESSION, AT)).toBe(false);
  });

  it("rejects later conversation activity and an incomplete tail", () => {
    expect(stopHooksFinished(line(finished) + line({ type: "user" }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line(finished) + line({ type: "attachment" }), SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line(finished) + '{"type":', SESSION, AT)).toBe(false);
    expect(stopHooksFinished(line(finished) + line({ type: "cost-state" }), SESSION, AT)).toBe(true);
  });
});
