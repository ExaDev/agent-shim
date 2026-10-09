import { describe, expect, it } from "vitest";

import { classifyLimit, parseUnifiedRateLimit, rateLimitHeadersOf } from "./rateLimit";

const TOO_MANY_REQUESTS = 429;
const PAYMENT_REQUIRED = 402;
const OK = 200;
const SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;

const NOW_MS = 1_700_000_000_000;
const FIVE_HOUR_RESET_SECONDS = 1_700_003_600;
const SEVEN_DAY_RESET_SECONDS = 1_700_500_000;
const BINDING_RESET_SECONDS = 1_700_001_800;
const RETRY_AFTER_SECONDS = 30;
const EVIDENCE_TOKEN_MAX_LENGTH = 64;
const FIVE_HOUR_UTILISATION = 0.42;
const SEVEN_DAY_UTILISATION = 0.9;

const PREFIX = "anthropic-ratelimit-unified-";

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * MS_PER_SECOND).toISOString();
}

function unifiedHeaders(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    [`${PREFIX}status`]: "allowed",
    [`${PREFIX}5h-status`]: "allowed",
    [`${PREFIX}5h-utilization`]: String(FIVE_HOUR_UTILISATION),
    [`${PREFIX}5h-reset`]: String(FIVE_HOUR_RESET_SECONDS),
    [`${PREFIX}7d-status`]: "allowed_warning",
    [`${PREFIX}7d-utilization`]: String(SEVEN_DAY_UTILISATION),
    [`${PREFIX}7d-reset`]: String(SEVEN_DAY_RESET_SECONDS),
    [`${PREFIX}representative-claim`]: "five_hour",
    [`${PREFIX}reset`]: String(BINDING_RESET_SECONDS),
    [`${PREFIX}overage-status`]: "rejected",
    ...overrides,
  };
}

describe("rateLimitHeadersOf", () => {
  it("keeps only rate-limit headers and lowercases their names", () => {
    const kept = rateLimitHeadersOf({
      "Retry-After": "5",
      "Anthropic-RateLimit-Unified-Status": "allowed",
      "X-RateLimit-Remaining": "9",
      "x-codex-primary-used-percent": "12",
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
    expect(kept).toEqual({
      "retry-after": "5",
      "anthropic-ratelimit-unified-status": "allowed",
      "x-ratelimit-remaining": "9",
      "x-codex-primary-used-percent": "12",
    });
  });

  it("returns undefined when no header is a rate-limit header", () => {
    expect(rateLimitHeadersOf({ "content-type": "text/plain" })).toBeUndefined();
    expect(rateLimitHeadersOf({})).toBeUndefined();
  });
});

describe("parseUnifiedRateLimit", () => {
  it("reads both windows, the binding claim, the reset and the overage status", () => {
    expect(parseUnifiedRateLimit(unifiedHeaders())).toEqual({
      status: "allowed",
      fiveHour: { utilization: FIVE_HOUR_UTILISATION, resetsAt: iso(FIVE_HOUR_RESET_SECONDS), status: "allowed" },
      sevenDay: { utilization: SEVEN_DAY_UTILISATION, resetsAt: iso(SEVEN_DAY_RESET_SECONDS), status: "allowed_warning" },
      representativeClaim: "five_hour",
      resetAt: iso(BINDING_RESET_SECONDS),
      overageStatus: "rejected",
    });
  });

  it("returns undefined when there is no unified header", () => {
    expect(parseUnifiedRateLimit({ "retry-after": "5", "x-ratelimit-remaining": "1" })).toBeUndefined();
  });

  it("omits a window whose headers are all absent", () => {
    const parsed = parseUnifiedRateLimit({ [`${PREFIX}status`]: "allowed", [`${PREFIX}5h-utilization`]: String(FIVE_HOUR_UTILISATION) });
    expect(parsed).toEqual({ status: "allowed", fiveHour: { utilization: FIVE_HOUR_UTILISATION } });
    expect(parsed).not.toHaveProperty("sevenDay");
  });

  it("omits fields that are present but unparseable", () => {
    const parsed = parseUnifiedRateLimit({
      [`${PREFIX}5h-utilization`]: "not-a-number",
      [`${PREFIX}5h-reset`]: "0",
      [`${PREFIX}5h-status`]: "allowed",
      [`${PREFIX}7d-utilization`]: "-0.5",
      [`${PREFIX}7d-reset`]: "soon",
      [`${PREFIX}reset`]: "-1",
    });
    expect(parsed).toEqual({ fiveHour: { status: "allowed" } });
  });

  it("treats a blank utilisation as missing rather than zero", () => {
    expect(parseUnifiedRateLimit({ [`${PREFIX}5h-utilization`]: "  ", [`${PREFIX}status`]: "allowed" })).toEqual({ status: "allowed" });
  });

  it("keeps a zero utilisation", () => {
    expect(parseUnifiedRateLimit({ [`${PREFIX}5h-utilization`]: "0" })).toEqual({ fiveHour: { utilization: 0 } });
  });
});

describe("classifyLimit", () => {
  it.each([OK, SERVER_ERROR])("does not classify status %i", (status) => {
    expect(classifyLimit({ status, headers: {}, error: { type: "usage_limit_reached" }, nowMs: NOW_MS })).toBeUndefined();
  });

  it("classifies a bare 429 as a short rate limit with its status as evidence", () => {
    expect(classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error: undefined, nowMs: NOW_MS })).toEqual({ kind: "rate-limited", evidence: [`status=${String(TOO_MANY_REQUESTS)}`] });
  });

  it("classifies a 402 as an exhausted quota", () => {
    expect(classifyLimit({ status: PAYMENT_REQUIRED, headers: {}, error: undefined, nowMs: NOW_MS })?.kind).toBe("quota-exhausted");
  });

  it("reads retry-after as seconds", () => {
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: { "retry-after": String(RETRY_AFTER_SECONDS) }, error: undefined, nowMs: NOW_MS });
    expect(result).toMatchObject({ kind: "rate-limited", retryAfterSeconds: RETRY_AFTER_SECONDS });
  });

  it("reads retry-after as an HTTP date measured from now", () => {
    const date = new Date(NOW_MS + RETRY_AFTER_SECONDS * MS_PER_SECOND).toUTCString();
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: { "retry-after": date }, error: undefined, nowMs: NOW_MS });
    expect(result?.retryAfterSeconds).toBe(RETRY_AFTER_SECONDS);
  });

  it("clamps an HTTP date in the past to zero", () => {
    const date = new Date(NOW_MS - RETRY_AFTER_SECONDS * MS_PER_SECOND).toUTCString();
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: { "retry-after": date }, error: undefined, nowMs: NOW_MS });
    expect(result?.retryAfterSeconds).toBe(0);
  });

  it("omits retryAfterSeconds when retry-after is unparseable", () => {
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: { "retry-after": "whenever" }, error: undefined, nowMs: NOW_MS });
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });

  it("treats unified rejected with no overage as an exhausted quota carrying its window and reset", () => {
    const headers = Object.fromEntries(Object.entries(unifiedHeaders({ [`${PREFIX}status`]: "rejected" })).filter(([name]) => name !== `${PREFIX}overage-status`));
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers, error: undefined, nowMs: NOW_MS });
    expect(result).toEqual({
      kind: "quota-exhausted",
      resetAt: iso(BINDING_RESET_SECONDS),
      window: "five_hour",
      evidence: [`status=${String(TOO_MANY_REQUESTS)}`, `${PREFIX}status=rejected`],
    });
  });

  it("treats unified rejected with rejected overage as exhausted", () => {
    const headers = unifiedHeaders({ [`${PREFIX}status`]: "rejected", [`${PREFIX}overage-status`]: "rejected" });
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers, error: undefined, nowMs: NOW_MS });
    expect(result?.kind).toBe("quota-exhausted");
    expect(result?.evidence).toContain(`${PREFIX}overage-status=rejected`);
  });

  it("treats unified rejected with overage still allowed as a short rate limit", () => {
    const headers = unifiedHeaders({ [`${PREFIX}status`]: "rejected", [`${PREFIX}overage-status`]: "allowed" });
    expect(classifyLimit({ status: TOO_MANY_REQUESTS, headers, error: undefined, nowMs: NOW_MS })?.kind).toBe("rate-limited");
  });

  it("treats a unified status other than rejected as a short rate limit", () => {
    const headers = unifiedHeaders({ [`${PREFIX}status`]: "allowed_warning" });
    expect(classifyLimit({ status: TOO_MANY_REQUESTS, headers, error: undefined, nowMs: NOW_MS })?.kind).toBe("rate-limited");
  });

  it.each([{ type: "usage_limit_reached" }, { type: "insufficient_quota" }, { code: "insufficient_quota" }, { code: "1308" }, { code: "1321" }])("treats error %j as an exhausted quota", (error) => {
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error, nowMs: NOW_MS });
    expect(result?.kind).toBe("quota-exhausted");
    const [name, value] = Object.entries(error)[0] ?? [];
    expect(result?.evidence).toContain(`error.${String(name)}=${String(value)}`);
  });

  it.each([{ code: "1302" }, { code: "1305" }, { type: "rate_limit_error" }])("treats error %j as a short rate limit", (error) => {
    expect(classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error, nowMs: NOW_MS })?.kind).toBe("rate-limited");
  });

  it("treats a message naming a usage limit as exhausted, without storing the message", () => {
    const message = "Usage limit reached. Your limit will reset at 12:00 for user alice@example.com";
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error: { type: "rate_limit_error", message }, nowMs: NOW_MS });
    expect(result?.kind).toBe("quota-exhausted");
    expect(result?.evidence).toContain("error.message=names a usage limit");
    expect(JSON.stringify(result)).not.toContain("alice");
  });

  it("leaves a message that names no quota as a short rate limit", () => {
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error: { message: "Too many requests, slow down" }, nowMs: NOW_MS });
    expect(result?.kind).toBe("rate-limited");
    expect(result?.evidence).not.toContain("error.message=names a usage limit");
  });

  it("records only short machine-readable error tokens as evidence", () => {
    const result = classifyLimit({ status: TOO_MANY_REQUESTS, headers: {}, error: { type: "rate limit with spaces", code: "x".repeat(EVIDENCE_TOKEN_MAX_LENGTH + 1) }, nowMs: NOW_MS });
    expect(result?.evidence).toEqual([`status=${String(TOO_MANY_REQUESTS)}`]);
  });
});

/** Header sets as `api.anthropic.com` returned them to subscription requests (values kept, nothing account-specific among them). */
describe("headers captured from the live API", () => {
  const WEEK_EXHAUSTED_RESET_SECONDS = 1_791_115_200;
  const FIVE_HOUR_IDLE_RESET_SECONDS = 1_790_955_000;
  const ENTERPRISE_OVERAGE_RESET_SECONDS = 1_793_491_200;
  const WEEK_PARTLY_USED = 0.16;

  const weekExhausted: Record<string, string> = {
    [`${PREFIX}status`]: "rejected",
    [`${PREFIX}representative-claim`]: "seven_day",
    [`${PREFIX}reset`]: String(WEEK_EXHAUSTED_RESET_SECONDS),
    [`${PREFIX}5h-utilization`]: "0.0",
    [`${PREFIX}5h-reset`]: String(FIVE_HOUR_IDLE_RESET_SECONDS),
    [`${PREFIX}7d-status`]: "rejected",
    [`${PREFIX}7d-utilization`]: "1.0",
    [`${PREFIX}7d-reset`]: String(WEEK_EXHAUSTED_RESET_SECONDS),
    [`${PREFIX}7d-surpassed-threshold`]: "1.0",
    [`${PREFIX}overage-status`]: "rejected",
    [`${PREFIX}overage-disabled-reason`]: "out_of_credits",
    [`${PREFIX}fallback-percentage`]: "0.5",
  };

  const enterpriseOverageOnly: Record<string, string> = {
    [`${PREFIX}status`]: "allowed",
    [`${PREFIX}representative-claim`]: "overage",
    [`${PREFIX}reset`]: String(ENTERPRISE_OVERAGE_RESET_SECONDS),
    [`${PREFIX}overage-status`]: "allowed",
    [`${PREFIX}overage-reset`]: String(ENTERPRISE_OVERAGE_RESET_SECONDS),
    [`${PREFIX}overage-utilization`]: "0.0",
    [`${PREFIX}fallback-percentage`]: "0.5",
  };

  it("reads an exhausted weekly window beside an idle five-hour window", () => {
    expect(parseUnifiedRateLimit(weekExhausted)).toMatchObject({
      status: "rejected",
      representativeClaim: "seven_day",
      overageStatus: "rejected",
      fiveHour: { utilization: 0, resetsAt: new Date(FIVE_HOUR_IDLE_RESET_SECONDS * MS_PER_SECOND).toISOString() },
      sevenDay: { utilization: 1, status: "rejected", resetsAt: new Date(WEEK_EXHAUSTED_RESET_SECONDS * MS_PER_SECOND).toISOString() },
    });
  });

  it("reads a five-hour window in grace, with the fraction of its grace allowance used", () => {
    const inGrace: Record<string, string> = {
      [`${PREFIX}status`]: "allowed_warning",
      [`${PREFIX}representative-claim`]: "five_hour",
      [`${PREFIX}5h-status`]: "allowed_warning",
      [`${PREFIX}5h-utilization`]: "0.99",
      [`${PREFIX}5h-reset`]: String(FIVE_HOUR_IDLE_RESET_SECONDS),
      [`${PREFIX}grace-status`]: "active",
      [`${PREFIX}grace-5h-utilization`]: "0.342",
    };
    expect(parseUnifiedRateLimit(inGrace)?.fiveHour).toMatchObject({ utilization: 0.99, status: "allowed_warning", graceUtilization: 0.342 });
  });

  it("ignores a grace figure the response does not mark active", () => {
    const parsed = parseUnifiedRateLimit({ [`${PREFIX}5h-utilization`]: "0.5", [`${PREFIX}grace-5h-utilization`]: "0.1" });
    expect(parsed?.fiveHour).toEqual({ utilization: 0.5 });
  });

  it("reads the overage-included weekly window beside the all-models weekly one", () => {
    const parsed = parseUnifiedRateLimit({
      [`${PREFIX}7d-utilization`]: String(WEEK_PARTLY_USED),
      [`${PREFIX}7d-reset`]: String(WEEK_EXHAUSTED_RESET_SECONDS),
      [`${PREFIX}7d_oi-utilization`]: "0.0",
      [`${PREFIX}7d_oi-reset`]: String(WEEK_EXHAUSTED_RESET_SECONDS),
      [`${PREFIX}7d_oi-status`]: "allowed",
    });
    expect(parsed?.sevenDay?.utilization).toBe(WEEK_PARTLY_USED);
    expect(parsed?.sevenDayOverageIncluded).toMatchObject({ utilization: 0, status: "allowed" });
  });

  it("reads whether a response was served on extra usage, and whether a fallback is on offer", () => {
    expect(parseUnifiedRateLimit({ ...enterpriseOverageOnly, [`${PREFIX}overage-in-use`]: "true", [`${PREFIX}fallback`]: "available" })).toMatchObject({ overageInUse: true, fallbackAvailable: true });
    expect(parseUnifiedRateLimit(enterpriseOverageOnly)).not.toHaveProperty("fallbackAvailable");
  });

  it("reads why extra usage is unavailable", () => {
    expect(parseUnifiedRateLimit(weekExhausted)).toMatchObject({ overageStatus: "rejected", overageDisabledReason: "out_of_credits" });
  });

  it("classifies the refusal that goes with it as an exhausted quota resetting with the week", () => {
    expect(classifyLimit({ status: TOO_MANY_REQUESTS, headers: weekExhausted, error: undefined, nowMs: NOW_MS })).toMatchObject({
      kind: "quota-exhausted",
      window: "seven_day",
      resetAt: new Date(WEEK_EXHAUSTED_RESET_SECONDS * MS_PER_SECOND).toISOString(),
    });
  });

  it("reads an account with no five-hour or weekly window, only extra usage, without inventing either", () => {
    const parsed = parseUnifiedRateLimit(enterpriseOverageOnly);
    expect(parsed).toMatchObject({ status: "allowed", representativeClaim: "overage", overageStatus: "allowed", overageUtilization: 0, overageResetsAt: new Date(ENTERPRISE_OVERAGE_RESET_SECONDS * MS_PER_SECOND).toISOString() });
    expect(parsed?.fiveHour).toBeUndefined();
    expect(parsed?.sevenDay).toBeUndefined();
    expect(classifyLimit({ status: OK, headers: enterpriseOverageOnly, error: undefined, nowMs: NOW_MS })).toBeUndefined();
  });
});
