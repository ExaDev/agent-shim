import { describe, expect, it } from "vitest";

import {
  AccountMetadataSchema,
  isRateLimitHeader,
  LimitClassificationSchema,
  TokenUsageSchema,
  UnifiedRateLimitSchema,
  USAGE_SCHEMA_VERSION,
  UsageRecordSchema,
  UsageSnapshotSchema,
} from "./schema";

const OK = 200;
const HALF = 0.5;
const AT = "2026-01-02T03:04:05.000Z";
const LATENCY_MS = 120;
const DURATION_MS = 900;
const UNSUPPORTED_VERSION = USAGE_SCHEMA_VERSION + 1;

function validRecord(): Record<string, unknown> {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: AT,
    provider: "anthropic",
    route: "anthropic",
    method: "POST",
    endpoint: "/v1/messages",
    status: OK,
    latencyMs: LATENCY_MS,
    durationMs: DURATION_MS,
    outcome: "completed",
  };
}

function validSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity: "personal",
    updatedAt: AT,
    providers: { anthropic: { lastRequestAt: AT, lastStatus: OK } },
  };
}

describe("UsageRecordSchema", () => {
  it("accepts a record with only its required fields", () => {
    expect(UsageRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it("accepts the optional usage, limit and rate-limit header fields", () => {
    const parsed = UsageRecordSchema.parse({
      ...validRecord(),
      usage: { inputTokens: 1, outputTokens: 2 },
      limit: { kind: "rate-limited", retryAfterSeconds: 5, evidence: ["status=429"] },
      rateLimitHeaders: { "retry-after": "5" },
    });
    expect(parsed.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(parsed.limit?.kind).toBe("rate-limited");
    expect(parsed.rateLimitHeaders).toEqual({ "retry-after": "5" });
  });

  it("rejects an unknown key, so content can never be written", () => {
    expect(UsageRecordSchema.safeParse({ ...validRecord(), prompt: "hello" }).success).toBe(false);
  });

  it("rejects an unknown key inside usage and limit", () => {
    expect(UsageRecordSchema.safeParse({ ...validRecord(), usage: { inputTokens: 1, text: "x" } }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...validRecord(), limit: { kind: "rate-limited", evidence: [], message: "x" } }).success).toBe(false);
  });

  it("rejects any version other than the current one", () => {
    expect(UsageRecordSchema.safeParse({ ...validRecord(), schemaVersion: UNSUPPORTED_VERSION }).success).toBe(false);
    const withoutVersion = Object.fromEntries(Object.entries(validRecord()).filter(([name]) => name !== "schemaVersion"));
    expect(UsageRecordSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const withoutProvider = Object.fromEntries(Object.entries(validRecord()).filter(([name]) => name !== "provider"));
    expect(UsageRecordSchema.safeParse(withoutProvider).success).toBe(false);
  });

  it("rejects a non-ISO instant, a negative latency, a fractional status and an unknown outcome", () => {
    expect(UsageRecordSchema.safeParse({ ...validRecord(), at: "yesterday" }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...validRecord(), latencyMs: -1 }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...validRecord(), status: 200.5 }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...validRecord(), outcome: "failed" }).success).toBe(false);
  });
});

describe("TokenUsageSchema", () => {
  it("accepts an empty object and each count alone", () => {
    expect(TokenUsageSchema.safeParse({}).success).toBe(true);
    expect(TokenUsageSchema.safeParse({ cacheReadInputTokens: 0 }).success).toBe(true);
  });

  it("rejects negative, fractional and unknown counts", () => {
    expect(TokenUsageSchema.safeParse({ inputTokens: -1 }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ outputTokens: 1.5 }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ input_tokens: 1 }).success).toBe(false);
  });
});

describe("LimitClassificationSchema", () => {
  it("rejects a kind outside the two known ones and a missing evidence list", () => {
    expect(LimitClassificationSchema.safeParse({ kind: "blocked", evidence: [] }).success).toBe(false);
    expect(LimitClassificationSchema.safeParse({ kind: "quota-exhausted" }).success).toBe(false);
    expect(LimitClassificationSchema.safeParse({ kind: "quota-exhausted", evidence: [] }).success).toBe(true);
  });
});

describe("UnifiedRateLimitSchema", () => {
  it("rejects an unknown key in the state and in a window", () => {
    expect(UnifiedRateLimitSchema.safeParse({ fallback: "available" }).success).toBe(false);
    expect(UnifiedRateLimitSchema.safeParse({ fiveHour: { utilization: HALF, extra: 1 } }).success).toBe(false);
  });

  it("rejects a negative utilisation", () => {
    expect(UnifiedRateLimitSchema.safeParse({ sevenDay: { utilization: -0.1 } }).success).toBe(false);
  });
});

describe("UsageSnapshotSchema", () => {
  it("accepts a snapshot with a provider and no optional state", () => {
    expect(UsageSnapshotSchema.parse(validSnapshot()).providers.anthropic?.lastStatus).toBe(OK);
  });

  it("rejects an unknown key at the top level, in account metadata and in a provider state", () => {
    expect(UsageSnapshotSchema.safeParse({ ...validSnapshot(), token: "x" }).success).toBe(false);
    expect(UsageSnapshotSchema.safeParse({ ...validSnapshot(), account: { accessToken: "x" } }).success).toBe(false);
    expect(UsageSnapshotSchema.safeParse({ ...validSnapshot(), providers: { anthropic: { lastRequestAt: AT, lastStatus: OK, body: "x" } } }).success).toBe(false);
  });

  it("rejects any version other than the current one", () => {
    expect(UsageSnapshotSchema.safeParse({ ...validSnapshot(), schemaVersion: UNSUPPORTED_VERSION }).success).toBe(false);
  });

  it("carries the rate-limit state and last limit of a provider", () => {
    const parsed = UsageSnapshotSchema.parse({
      ...validSnapshot(),
      providers: {
        anthropic: {
          lastRequestAt: AT,
          lastStatus: OK,
          rateLimit: { observedAt: AT, headers: { "retry-after": "5" }, unified: { status: "allowed", fiveHour: { utilization: HALF } } },
          lastLimit: { kind: "quota-exhausted", evidence: ["status=402"], observedAt: AT, status: 402 },
        },
      },
    });
    expect(parsed.providers.anthropic?.rateLimit?.unified?.fiveHour?.utilization).toBe(HALF);
    expect(parsed.providers.anthropic?.lastLimit).toMatchObject({ kind: "quota-exhausted", status: 402 });
  });

  it("rejects a limit event without its observation instant", () => {
    const providers = { anthropic: { lastRequestAt: AT, lastStatus: OK, lastLimit: { kind: "rate-limited", evidence: [], status: 429 } } };
    expect(UsageSnapshotSchema.safeParse({ ...validSnapshot(), providers }).success).toBe(false);
  });
});

describe("AccountMetadataSchema", () => {
  it("accepts an empty object and rejects unknown fields", () => {
    expect(AccountMetadataSchema.safeParse({}).success).toBe(true);
    expect(AccountMetadataSchema.safeParse({ emailAddress: "a@example.com", hasExtraUsageEnabled: true }).success).toBe(true);
    expect(AccountMetadataSchema.safeParse({ refreshToken: "x" }).success).toBe(false);
  });
});

describe("isRateLimitHeader", () => {
  it.each(["retry-after", "Retry-After", "anthropic-ratelimit-unified-status", "x-ratelimit-remaining-requests", "ratelimit-limit", "RateLimit-Policy", "x-codex-primary-used-percent"])("keeps %s", (name) => {
    expect(isRateLimitHeader(name)).toBe(true);
  });

  it.each(["authorization", "content-type", "request-id", "x-api-key", "set-cookie", "anthropic-version"])("drops %s", (name) => {
    expect(isRateLimitHeader(name)).toBe(false);
  });
});
