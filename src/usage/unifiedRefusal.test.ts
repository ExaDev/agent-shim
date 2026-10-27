import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";

import { parseUnifiedRateLimit } from "./rateLimit";
import { exhaustionHeaders, quotaRefusalHeaders } from "./unifiedRefusal";

const NOW_MS = Date.parse("2026-10-22T10:00:00.000Z");
const MS_PER_SECOND = 1000;
const NOW_SEC = NOW_MS / MS_PER_SECOND;
const PAST_RESET_SECONDS = 5;
const RETRY_AFTER_SECONDS = 3600;
const TOO_MANY_REQUESTS = 429;
/** 2026-10-22 23:57:10 on the backend's UTC+8 clock, which is 15:57:10 UTC. */
const MESSAGE_RESET_SEC = Date.parse("2026-10-22T15:57:10.000Z") / MS_PER_SECOND;

function body(error: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: "error", error }));
}

const FIVE_HOUR_REFUSAL = body({ code: "1308", message: "Usage limit reached for 5 hour. Your limit will reset at 2026-10-22 23:57:10" });
const WEEKLY_REFUSAL = body({ code: "1308", message: "Usage limit reached for weekly. Your limit will reset at 2026-10-25 08:00:00" });

describe("exhaustionHeaders", () => {
  it("names the binding window, the instant it lifts and the seconds to it, and says not to retry", () => {
    expect(exhaustionHeaders({ window: "seven_day", resetSec: NOW_SEC + RETRY_AFTER_SECONDS, nowSec: NOW_SEC })).toEqual({
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-reset": String(NOW_SEC + RETRY_AFTER_SECONDS),
      "retry-after": String(RETRY_AFTER_SECONDS),
      "x-should-retry": "false",
    });
  });

  it("asks to wait at least a second, however near or past the reset", () => {
    expect(exhaustionHeaders({ window: "five_hour", resetSec: NOW_SEC - PAST_RESET_SECONDS, nowSec: NOW_SEC })["retry-after"]).toBe("1");
  });
});

describe("quotaRefusalHeaders", () => {
  const refuse = (overrides: Partial<Parameters<typeof quotaRefusalHeaders>[0]>) =>
    quotaRefusalHeaders({ status: TOO_MANY_REQUESTS, headers: { "retry-after": String(RETRY_AFTER_SECONDS) }, body: FIVE_HOUR_REFUSAL, nowMs: NOW_MS, ...overrides });

  it("translates a spent five-hour quota into the real API's form, the reset being the response's own retry-after", () => {
    const headers = refuse({});
    expect(headers).toEqual({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + RETRY_AFTER_SECONDS),
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(NOW_SEC + RETRY_AFTER_SECONDS),
      "retry-after": String(RETRY_AFTER_SECONDS),
      "x-should-retry": "false",
    });
  });

  it("gives the usage store a fresh, spent five-hour window to record", () => {
    const unified = parseUnifiedRateLimit({ ...refuse({}), "retry-after": String(RETRY_AFTER_SECONDS) });
    expect(unified?.status).toBe("rejected");
    expect(unified?.representativeClaim).toBe("five_hour");
    expect(unified?.fiveHour).toEqual({ utilization: 1, status: "rejected", resetsAt: new Date((NOW_SEC + RETRY_AFTER_SECONDS) * MS_PER_SECOND).toISOString() });
  });

  it("translates a spent weekly quota into the seven-day window", () => {
    const headers = refuse({ body: WEEKLY_REFUSAL });
    expect(headers?.["anthropic-ratelimit-unified-representative-claim"]).toBe("seven_day");
    expect(headers?.["anthropic-ratelimit-unified-7d-status"]).toBe("rejected");
    expect(headers?.["anthropic-ratelimit-unified-5h-status"]).toBeUndefined();
  });

  it("reads the reset from the message on the backend's UTC+8 clock when the response has no retry-after", () => {
    const headers = refuse({ headers: {} });
    expect(headers?.["anthropic-ratelimit-unified-reset"]).toBe(String(MESSAGE_RESET_SEC));
    expect(headers?.["retry-after"]).toBe(String(MESSAGE_RESET_SEC - NOW_SEC));
  });

  it("prefers the retry-after, which carries no zone, to the message's wall time", () => {
    expect(refuse({})?.["anthropic-ratelimit-unified-reset"]).toBe(String(NOW_SEC + RETRY_AFTER_SECONDS));
  });

  it("reads a gzip, deflate or brotli body", () => {
    for (const [encoding, encode] of [
      ["gzip", zlib.gzipSync],
      ["deflate", zlib.deflateSync],
      ["br", zlib.brotliCompressSync],
    ] as const) {
      const headers = refuse({ headers: { "retry-after": String(RETRY_AFTER_SECONDS), "content-encoding": encoding }, body: encode(FIVE_HOUR_REFUSAL) });
      expect(headers?.["anthropic-ratelimit-unified-representative-claim"], encoding).toBe("five_hour");
    }
  });

  it.each([
    ["a status other than 429", { status: 402 }],
    ["a 200", { status: 200 }],
    ["an upstream that sent its own unified headers", { headers: { "retry-after": "60", "anthropic-ratelimit-unified-status": "rejected" } }],
    ["a short rate limit", { body: body({ code: "1302", message: "Rate limit reached for requests in 5 hour" }) }],
    ["a quota message that names no window", { body: body({ code: "1310", message: "Monthly Limit Exhausted. Your limit will reset at 2026-11-01 00:00:00" }) }],
    ["a quota with neither retry-after nor a reset time in its message", { headers: {}, body: body({ code: "1308", message: "Usage limit reached for 5 hour." }) }],
    ["a body in a coding it cannot read", { headers: { "retry-after": "60", "content-encoding": "zstd" } }],
    ["a body that is not JSON", { body: new TextEncoder().encode("<html>429</html>") }],
    ["a body that is not decodable", { headers: { "retry-after": "60", "content-encoding": "gzip" }, body: FIVE_HOUR_REFUSAL }],
  ] as const)("leaves %s as the upstream sent it", (_name, overrides) => {
    expect(refuse(overrides)).toBeUndefined();
  });
});
