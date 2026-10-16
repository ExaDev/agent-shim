import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs, FAKE_NOW_MS } from "../test-helpers";
import { USAGE_SCHEMA_VERSION, type UsageRecord } from "../usage/schema";
import { quotaHitOf } from "./limit";

const paths = buildLayoutPaths("/state");
const HOUR_MS = 3_600_000;
const THREE_HOURS_MS = 10_800_000;
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const LOW_UTILISATION = 0.2;
const MAX_20X = "default_claude_max_20x";
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

/** A snapshot whose seven-day window is `status` with `utilization` used. */
function snapshotOf(identity: string, status: "allowed" | "rejected", utilization: number): string {
  const seen = iso(-HOUR_MS);
  return JSON.stringify({
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: seen,
    account: { organizationRateLimitTier: MAX_20X },
    providers: { anthropic: { lastRequestAt: seen, lastStatus: status === "rejected" ? HTTP_TOO_MANY_REQUESTS : HTTP_OK, rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization, resetsAt: iso(HOUR_MS), status } } } } },
  });
}

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return { schemaVersion: USAGE_SCHEMA_VERSION, at: iso(-1), provider: "anthropic", route: "anthropic", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed", identity: "work", sessionId: "s1", ...overrides };
}

const EXHAUSTED = { kind: "quota-exhausted" as const, resetAt: iso(HOUR_MS), evidence: ["status=rejected"] };

/** A fake store holding `snapshot` for `work` and `records` in one log segment. */
function store(snapshot: string, records: readonly UsageRecord[]): ReturnType<typeof createFakeFarmFs> {
  const day = new Date(FAKE_NOW_MS).toISOString().slice(0, "YYYY-MM-DD".length);
  return createFakeFarmFs({
    [`${paths.usageSnapshotsDir}/work.json`]: snapshot,
    [`${paths.usageLogDir}/${day}.1.jsonl`]: records.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  });
}

const SINCE = FAKE_NOW_MS - 2 * HOUR_MS;

describe("quotaHitOf", () => {
  it("finds the refusal when the identity is refused and this session's own request was classified quota-exhausted", () => {
    const fs = store(snapshotOf("work", "rejected", 1), [record({ status: 429, limit: EXHAUSTED })]);
    const hit = quotaHitOf(fs, paths, "work", "s1", SINCE, FAKE_NOW_MS);
    expect(hit?.resetAt).toBe(iso(HOUR_MS));
    expect(hit?.reason).toContain("refused");
  });

  it("finds nothing while the identity is still served, whatever the log holds", () => {
    const fs = store(snapshotOf("work", "allowed", LOW_UTILISATION), [record({ status: 429, limit: EXHAUSTED })]);
    expect(quotaHitOf(fs, paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
  });

  it("finds nothing when the refusal was another session's, another identity's, or only a short rate limit", () => {
    const snapshot = snapshotOf("work", "rejected", 1);
    expect(quotaHitOf(store(snapshot, [record({ sessionId: "other", status: 429, limit: EXHAUSTED })]), paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
    expect(quotaHitOf(store(snapshot, [record({ identity: "spare", status: 429, limit: EXHAUSTED })]), paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
    expect(quotaHitOf(store(snapshot, [record({ status: 429, limit: { kind: "rate-limited", evidence: [] } })]), paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
    expect(quotaHitOf(store(snapshot, [record({})]), paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
  });

  it("ignores a refusal from before the child started", () => {
    const fs = store(snapshotOf("work", "rejected", 1), [record({ at: iso(-THREE_HOURS_MS), status: 429, limit: EXHAUSTED })]);
    expect(quotaHitOf(fs, paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
  });

  it("finds nothing for an identity with no snapshot yet", () => {
    expect(quotaHitOf(createFakeFarmFs({}), paths, "work", "s1", SINCE, FAKE_NOW_MS)).toBeUndefined();
  });
});
