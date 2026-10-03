import { describe, expect, it } from "vitest";

import { createFakeFarmFs, DAY_MS, paths } from "../test-helpers";
import {
  listLogSegments,
  listUsageSnapshots,
  readUsageLog,
  readUsageSnapshot,
  segmentDay,
  segmentName,
  snapshotPath,
  summariseUsage,
  UsageSnapshotError,
  type UsageReadFs,
} from "./read";
import { USAGE_SCHEMA_VERSION, type UsageRecord, type UsageSnapshot } from "./schema";

const DAY_START = Date.parse("2026-01-15T00:00:00.000Z");
const HOUR_MS = 3_600_000;
const THREE_HOURS_MS = HOUR_MS + HOUR_MS + HOUR_MS;
const WRITER_PID = 77;
const INVALID_LINE_COUNT = 3;
const PARTIAL_LINE_LENGTH = 40;
const OK_STATUS = 200;
const RATE_LIMITED_STATUS = 429;
const SERVER_ERROR_STATUS = 500;
const LOG_DIR = paths.usageLogDir;
const SNAPSHOTS_DIR = paths.usageSnapshotsDir;

function anonymousRecordAt(epochMs: number): UsageRecord {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: new Date(epochMs).toISOString(),
    provider: "anthropic",
    route: "passthrough",
    method: "POST",
    endpoint: "/v1/messages",
    status: OK_STATUS,
    latencyMs: 10,
    durationMs: 20,
    outcome: "completed",
  };
}

function recordAt(epochMs: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { ...anonymousRecordAt(epochMs), identity: "work", ...overrides };
}

function lines(...records: readonly UsageRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function snapshotOf(identity: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: new Date(DAY_START).toISOString(),
    providers: { anthropic: { lastRequestAt: new Date(DAY_START).toISOString(), lastStatus: OK_STATUS } },
    ...overrides,
  };
}

describe("segment naming", () => {
  it("names a segment by UTC day and writer pid, and recovers the day from an instant", () => {
    expect(segmentDay(Date.parse("2026-01-15T23:59:59.000Z"))).toBe("2026-01-15");
    expect(segmentDay(Date.parse("2026-01-16T00:00:00.000Z"))).toBe("2026-01-16");
    expect(segmentName("2026-01-15", WRITER_PID)).toBe("2026-01-15.77.jsonl");
  });

  it("lists segments oldest day first with the instant each day ends, ignoring files that are not segments", () => {
    const fs = createFakeFarmFs({
      [`${LOG_DIR}/2026-01-15.9.jsonl`]: "",
      [`${LOG_DIR}/2026-01-14.2.jsonl`]: "",
      [`${LOG_DIR}/2026-01-15.10.jsonl`]: "",
      [`${LOG_DIR}/2026-01-15.9.jsonl.tmp`]: "",
      [`${LOG_DIR}/readme.txt`]: "",
    });

    const segments = listLogSegments(fs, LOG_DIR);

    expect(segments.map((segment) => segment.name)).toEqual(["2026-01-14.2.jsonl", "2026-01-15.10.jsonl", "2026-01-15.9.jsonl"]);
    expect(segments[0]).toEqual({ name: "2026-01-14.2.jsonl", day: "2026-01-14", endsAt: DAY_START });
  });

  it("lists nothing for a log directory that does not exist", () => {
    expect(listLogSegments(createFakeFarmFs(), LOG_DIR)).toEqual([]);
  });
});

describe("readUsageLog", () => {
  it("returns every valid record oldest first across segments and writers", () => {
    const early = recordAt(DAY_START + HOUR_MS, { requestId: "early" });
    const middle = recordAt(DAY_START + 2 * HOUR_MS, { requestId: "middle" });
    const late = recordAt(DAY_START + DAY_MS + HOUR_MS, { requestId: "late" });
    const fs = createFakeFarmFs({
      [`${LOG_DIR}/2026-01-16.1.jsonl`]: lines(late),
      [`${LOG_DIR}/2026-01-15.2.jsonl`]: lines(middle),
      [`${LOG_DIR}/2026-01-15.1.jsonl`]: lines(early),
    });

    const read = readUsageLog(fs, LOG_DIR);

    expect(read.records.map((record) => record.requestId)).toEqual(["early", "middle", "late"]);
    expect(read.invalidLines).toBe(0);
  });

  it("counts lines that are not records of this schema version instead of hiding them", () => {
    const valid = recordAt(DAY_START);
    const newerSchema = { ...valid, schemaVersion: USAGE_SCHEMA_VERSION + 1 };
    const withContent = { ...valid, prompt: "unexpected field" };
    const fs = createFakeFarmFs({
      [`${LOG_DIR}/2026-01-15.1.jsonl`]: `${lines(valid)}{not json}\n${JSON.stringify(newerSchema)}\n${JSON.stringify(withContent)}\n\n`,
    });

    const read = readUsageLog(fs, LOG_DIR);

    expect(read.records).toEqual([valid]);
    expect(read.invalidLines).toBe(INVALID_LINE_COUNT);
  });

  it("leaves a segment's unfinished last line for the next read rather than counting it invalid", () => {
    const complete = recordAt(DAY_START);
    const unfinished = JSON.stringify(recordAt(DAY_START + HOUR_MS)).slice(0, PARTIAL_LINE_LENGTH);
    const fs = createFakeFarmFs({ [`${LOG_DIR}/2026-01-15.1.jsonl`]: `${lines(complete)}${unfinished}` });

    const read = readUsageLog(fs, LOG_DIR);

    expect(read.records).toEqual([complete]);
    expect(read.invalidLines).toBe(0);
  });

  it("returns only records at or after sinceMs, and does not open segments that ended before it", () => {
    const before = recordAt(DAY_START + HOUR_MS, { requestId: "before" });
    const boundary = recordAt(DAY_START + 2 * HOUR_MS, { requestId: "boundary" });
    const after = recordAt(DAY_START + THREE_HOURS_MS, { requestId: "after" });
    const previousDay = recordAt(DAY_START - HOUR_MS, { requestId: "previous-day" });
    const fs = createFakeFarmFs({
      [`${LOG_DIR}/2026-01-14.1.jsonl`]: `${lines(previousDay)}corrupt line that would be counted if opened\n`,
      [`${LOG_DIR}/2026-01-15.1.jsonl`]: lines(before, boundary, after),
    });

    const read = readUsageLog(fs, LOG_DIR, { sinceMs: DAY_START + 2 * HOUR_MS });

    expect(read.records.map((record) => record.requestId)).toEqual(["boundary", "after"]);
    expect(read.invalidLines).toBe(0);
  });

  it("skips a segment pruned between the listing and the read", () => {
    const present = recordAt(DAY_START);
    const base = createFakeFarmFs({ [`${LOG_DIR}/2026-01-15.1.jsonl`]: lines(present) });
    const racing: UsageReadFs = { readFileUtf8: base.readFileUtf8, readdir: (dir) => [...base.readdir(dir), "2026-01-10.5.jsonl"] };

    const read = readUsageLog(racing, LOG_DIR);

    expect(read.records).toEqual([present]);
    expect(read.invalidLines).toBe(0);
  });
});

describe("usage snapshots", () => {
  it("reads nothing for an identity with no snapshot", () => {
    expect(readUsageSnapshot(createFakeFarmFs(), SNAPSHOTS_DIR, "work")).toBeUndefined();
  });

  it("reads back a snapshot as written", () => {
    const snapshot = snapshotOf("work", { account: { billingType: "stripe_subscription" } });
    const fs = createFakeFarmFs({ [snapshotPath(SNAPSHOTS_DIR, "work")]: JSON.stringify(snapshot) });

    expect(readUsageSnapshot(fs, SNAPSHOTS_DIR, "work")).toEqual(snapshot);
  });

  it("reports a snapshot that is not valid JSON as unreadable, naming the file", () => {
    const file = snapshotPath(SNAPSHOTS_DIR, "work");
    const fs = createFakeFarmFs({ [file]: "{broken" });

    expect(() => readUsageSnapshot(fs, SNAPSHOTS_DIR, "work")).toThrow(UsageSnapshotError);
    expect(() => readUsageSnapshot(fs, SNAPSHOTS_DIR, "work")).toThrow(`${file} is not a usage snapshot this agent-shim can read`);
  });

  it("reports a snapshot of another schema version as unreadable, naming the field", () => {
    const fs = createFakeFarmFs({ [snapshotPath(SNAPSHOTS_DIR, "work")]: JSON.stringify({ ...snapshotOf("work"), schemaVersion: USAGE_SCHEMA_VERSION + 1 }) });

    expect(() => readUsageSnapshot(fs, SNAPSHOTS_DIR, "work")).toThrow(/schemaVersion/);
  });

  it("refuses an identity name that could name a path outside the snapshots directory", () => {
    expect(() => snapshotPath(SNAPSHOTS_DIR, "../escape")).toThrow('"../escape" is not a valid identity name.');
    expect(() => readUsageSnapshot(createFakeFarmFs(), SNAPSHOTS_DIR, ".hidden")).toThrow("is not a valid identity name");
  });

  it("lists every identity's snapshot ordered by identity, skipping files that are not snapshots", () => {
    const fs = createFakeFarmFs({
      [snapshotPath(SNAPSHOTS_DIR, "personal")]: JSON.stringify(snapshotOf("personal")),
      [snapshotPath(SNAPSHOTS_DIR, "work")]: JSON.stringify(snapshotOf("work")),
      [`${SNAPSHOTS_DIR}/.hidden.json`]: JSON.stringify(snapshotOf(".hidden")),
      [`${SNAPSHOTS_DIR}/work.json.tmp`]: "partial",
    });

    expect(listUsageSnapshots(fs, SNAPSHOTS_DIR).map((snapshot) => snapshot.identity)).toEqual(["personal", "work"]);
  });
});

describe("summariseUsage", () => {
  it("totals requests, failures, limits and tokens per identity and provider", () => {
    const summaries = summariseUsage([
      recordAt(DAY_START, { usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 2, cacheReadInputTokens: 1 }, model: "model-a" }),
      recordAt(DAY_START + HOUR_MS, {
        status: RATE_LIMITED_STATUS,
        limit: { kind: "rate-limited", evidence: [] },
        usage: { inputTokens: 7 },
        model: "model-a",
      }),
      recordAt(DAY_START + 2 * HOUR_MS, {
        status: RATE_LIMITED_STATUS,
        limit: { kind: "quota-exhausted", evidence: [] },
        model: "model-b",
      }),
      recordAt(DAY_START + THREE_HOURS_MS, { status: SERVER_ERROR_STATUS, usage: { outputTokens: 3 } }),
    ]);

    expect(summaries).toEqual([
      {
        identity: "work",
        provider: "anthropic",
        requests: 4,
        failed: 3,
        limits: { "rate-limited": 1, "quota-exhausted": 1 },
        tokens: { inputTokens: 17, outputTokens: 8, cacheCreationInputTokens: 2, cacheReadInputTokens: 1 },
        firstAt: new Date(DAY_START).toISOString(),
        lastAt: new Date(DAY_START + THREE_HOURS_MS).toISOString(),
        models: ["model-a", "model-b"],
      },
    ]);
  });

  it("keeps identities and providers apart and orders them, with a launch that resolved no identity first", () => {
    const summaries = summariseUsage([
      recordAt(DAY_START, { identity: "work", provider: "z" }),
      recordAt(DAY_START, { identity: "work", provider: "anthropic" }),
      recordAt(DAY_START, { identity: "personal", provider: "anthropic" }),
      anonymousRecordAt(DAY_START),
    ]);

    expect(summaries.map((summary) => [summary.identity, summary.provider])).toEqual([
      [undefined, "anthropic"],
      ["personal", "anthropic"],
      ["work", "anthropic"],
      ["work", "z"],
    ]);
    expect(summaries.every((summary) => summary.requests === 1)).toBe(true);
  });

  it("lists models most-used first, breaking ties by name, and leaves out a response that named none", () => {
    const summaries = summariseUsage([
      recordAt(DAY_START, { model: "beta" }),
      recordAt(DAY_START, { model: "alpha" }),
      recordAt(DAY_START, { model: "gamma" }),
      recordAt(DAY_START, { model: "gamma" }),
      recordAt(DAY_START),
    ]);

    expect(summaries[0]?.models).toEqual(["gamma", "alpha", "beta"]);
  });

  it("reports zero totals for a group whose responses carried no usage", () => {
    const [summary] = summariseUsage([recordAt(DAY_START)]);

    expect(summary?.tokens).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    expect(summary?.limits).toEqual({ "rate-limited": 0, "quota-exhausted": 0 });
    expect(summary?.failed).toBe(0);
  });

  it("summarises no records as no groups", () => {
    expect(summariseUsage([])).toEqual([]);
  });
});
