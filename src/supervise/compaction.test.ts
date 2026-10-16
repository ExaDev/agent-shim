import { describe, expect, it } from "vitest";

import { FAKE_NOW_MS } from "../test-helpers";
import { USAGE_SCHEMA_VERSION, type UsageRecord, type UsageSnapshot } from "../usage/schema";
import { decideCompaction, type CompactionCandidate, type CompactionInput } from "./compaction";
import type { SessionState } from "./registry";

const HOUR_MS = 3_600_000;
const MS_PER_SECOND = 1000;
const BILLED = 100_000;
const FIRST_UTILISATION = 0.4;
const NOW_UTILISATION = 0.5;
const NEARLY_SPENT_UTILISATION = 0.8;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

/** A snapshot whose five-hour and seven-day windows have the given utilisation and reset ahead, or already behind. */
function snapshotOf(five: number | undefined, seven: number | undefined, resetsInMs = HOUR_MS): UsageSnapshot {
  const window = (utilization: number | undefined): { utilization: number; resetsAt: string } | undefined => (utilization === undefined ? undefined : { utilization, resetsAt: iso(resetsInMs) });
  const seen = iso(-HOUR_MS);
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity: "work",
    updatedAt: seen,
    providers: { anthropic: { lastRequestAt: seen, lastStatus: 200, rateLimit: { observedAt: seen, headers: {}, unified: { fiveHour: window(five), sevenDay: window(seven) } } } },
  };
}

/** Two readings of the five-hour window, `BILLED` tokens apart: the window rose 0.1 over 100k billed tokens, so one token costs 1e-6 of it. */
function measured(): UsageRecord[] {
  const record = (agoMs: number, utilization: number, billed: number): UsageRecord => ({
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: iso(-agoMs),
    identity: "work",
    provider: "anthropic",
    route: "anthropic",
    method: "POST",
    endpoint: "/v1/messages",
    status: 200,
    latencyMs: 1,
    durationMs: 1,
    outcome: "completed",
    usage: { inputTokens: billed },
    rateLimitHeaders: { "anthropic-ratelimit-unified-5h-utilization": String(utilization), "anthropic-ratelimit-unified-5h-reset": String(Math.round((FAKE_NOW_MS + HOUR_MS) / MS_PER_SECOND)) },
  });
  return [record(HOUR_MS, FIRST_UTILISATION, 0), record(1, NOW_UTILISATION, BILLED)];
}

const idle = (contextTokens: number, extra: Readonly<Partial<SessionState>> = {}): SessionState => ({ mark: "idle", contextTokens, at: iso(0), ...extra });
const session = (sessionId: string, state: SessionState | undefined): CompactionCandidate => ({ sessionId, state });

function decide(overrides: Readonly<Partial<CompactionInput>>) {
  return decideCompaction({ atUtilisation: undefined, snapshot: snapshotOf(NOW_UTILISATION, NOW_UTILISATION), records: () => [], sessions: [session("a", idle(BILLED))], sessionId: "a", nowMs: FAKE_NOW_MS, ...overrides });
}

describe("decideCompaction with a utilisation threshold", () => {
  const AT = 85;
  const HIGH = 0.9;
  const LOW = 0.6;

  it("compacts once the five-hour window passes the threshold, naming it", () => {
    const decision = decide({ atUtilisation: AT, snapshot: snapshotOf(HIGH, LOW) });
    expect(decision).toMatchObject({ compact: true, contextTokens: BILLED });
    expect(decision.reason).toContain("the 5h window is at 90%, past 85%");
  });

  it("compacts when only the seven-day window has passed it", () => {
    expect(decide({ atUtilisation: AT, snapshot: snapshotOf(LOW, HIGH) }).reason).toContain("the 7d window is at 90%");
  });

  it("does not compact below the threshold, nor on a window that has already reset", () => {
    expect(decide({ atUtilisation: AT, snapshot: snapshotOf(LOW, LOW) }).compact).toBe(false);
    expect(decide({ atUtilisation: AT, snapshot: snapshotOf(HIGH, HIGH, -HOUR_MS) }).compact).toBe(false);
  });

  it("does not compact for an identity with no snapshot yet", () => {
    expect(decide({ atUtilisation: AT, snapshot: undefined }).compact).toBe(false);
  });
});

describe("decideCompaction by cost", () => {
  /** The window has 20% left; one token costs 1e-6 of it. */
  const COMFORTABLE = 0.5;
  const BIG = 150_000;

  it("compacts when compacting every session on the member would use more than the window has left", () => {
    const sessions = [session("a", idle(BIG)), session("b", idle(BILLED))];
    const decision = decide({ snapshot: snapshotOf(NEARLY_SPENT_UTILISATION, undefined), records: measured, sessions });
    expect(decision).toMatchObject({ compact: true, contextTokens: BIG });
    expect(decision.reason).toContain("the 5h window has 20% left, and compacting every session on this member would use about 25%");
  });

  it("does not compact while the window has more left than that", () => {
    expect(decide({ snapshot: snapshotOf(COMFORTABLE, undefined), records: measured, sessions: [session("a", idle(BIG))] }).compact).toBe(false);
  });

  it("does not compact on an identity whose cost per token has not been measured, or that reports no five-hour window", () => {
    expect(decide({ snapshot: snapshotOf(NEARLY_SPENT_UTILISATION, undefined), records: () => [] }).compact).toBe(false);
    expect(decide({ snapshot: snapshotOf(undefined, NEARLY_SPENT_UTILISATION), records: measured }).compact).toBe(false);
  });
});

describe("decideCompaction reading the usage log", () => {
  it("reads the records only when the cost rule has a session that could go, never for a session that must wait or when a threshold decides", () => {
    let reads = 0;
    const records = (): UsageRecord[] => {
      reads += 1;
      return measured();
    };
    const BIG = 150_000;
    const base = { snapshot: snapshotOf(NEARLY_SPENT_UTILISATION, undefined), records };
    decide({ ...base, atUtilisation: 50, sessions: [session("a", idle(BIG))] });
    decide({ ...base, sessions: [session("a", idle(BILLED)), session("b", idle(BIG))], sessionId: "a" });
    decide({ ...base, sessions: [session("a", { mark: "busy", contextTokens: BIG, at: iso(0) })] });
    expect(reads).toBe(0);
    decide({ ...base, sessions: [session("a", idle(BIG))] });
    expect(reads).toBe(1);
  });
});

describe("decideCompaction for one session among several", () => {
  const AT = 50;
  const BIG = 150_000;
  const base = { atUtilisation: AT, snapshot: snapshotOf(NOW_UTILISATION, undefined) };

  it("lets only the session with the largest context go first, and the lower id on a tie", () => {
    const sessions = [session("a", idle(BILLED)), session("b", idle(BIG)), session("c", idle(BIG))];
    expect(decide({ ...base, sessions, sessionId: "a" })).toEqual({ compact: false, reason: "a larger session on this member compacts first" });
    expect(decide({ ...base, sessions, sessionId: "c" }).compact).toBe(false);
    expect(decide({ ...base, sessions, sessionId: "b" })).toMatchObject({ compact: true, contextTokens: BIG });
  });

  it("is not held back by a larger session that is busy, already compacted or has no context recorded", () => {
    const sessions = [session("a", idle(BILLED)), session("b", { mark: "busy", contextTokens: BIG, at: iso(0) }), session("c", idle(BIG, { compacted: true })), session("d", { mark: "idle", at: iso(0) })];
    expect(decide({ ...base, sessions, sessionId: "a" }).compact).toBe(true);
  });

  it("does not compact a session that is mid-turn, already compacted, has no context or no recorded state", () => {
    for (const state of [{ mark: "busy" as const, contextTokens: BIG, at: iso(0) }, idle(BIG, { compacted: true }), { mark: "idle" as const, at: iso(0) }, undefined]) {
      expect(decide({ ...base, sessions: [session("a", state)] }).compact).toBe(false);
    }
  });
});
