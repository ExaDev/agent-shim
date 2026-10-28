import { describe, expect, it } from "vitest";

import { createFakeFarmFs, DAY_MS, paths } from "../test-helpers";
import {
  listLogSegments,
  listUsageSnapshots,
  readRecentUsageRecords,
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

describe("readRecentUsageRecords", () => {
  /** The multiplier and increment of the Numerical Recipes linear congruential generator, which needs no more than a reproducible spread of layouts. */
  const LCG_MULTIPLIER = 1_664_525;
  const LCG_INCREMENT = 1_013_904_223;
  const UINT32_BITS = 32;
  const UINT32_SPAN = 2 ** UINT32_BITS;

  /** A deterministic generator, so a failing layout is reproducible from its seed. */
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
      return state / UINT32_SPAN;
    };
  }

  const LAYOUT_SEEDS = 40;
  const LAYOUT_DAYS = 6;
  const MAX_WRITERS_PER_DAY = 3;
  const MAX_RECORDS_PER_SEGMENT = 6;
  const MAX_COUNT = 14;
  /** How long before its day began a record in that day's segment may be stamped: it is stamped, then written. */
  const STAMP_LEAD_MS = 2 * HOUR_MS;
  const CORRUPT_LINE_ONE_IN = 5;
  const SECOND_MS = 1_000;
  const HALF_SECOND_MS = SECOND_MS / 2;

  function randomLayout(next: () => number): Record<string, string> {
    const files: Record<string, string> = {};
    for (let day = 0; day < LAYOUT_DAYS; day += 1) {
      const dayStart = DAY_START + day * DAY_MS;
      const writers = 1 + Math.floor(next() * MAX_WRITERS_PER_DAY);
      for (let writer = 0; writer < writers; writer += 1) {
        const records = Array.from({ length: Math.floor(next() * (MAX_RECORDS_PER_SEGMENT + 1)) }, () => recordAt(Math.floor(dayStart - STAMP_LEAD_MS + next() * (DAY_MS + STAMP_LEAD_MS))));
        const corrupt = next() * CORRUPT_LINE_ONE_IN < 1 ? "{not json}\n" : "";
        files[`${LOG_DIR}/${segmentDay(dayStart)}.${String(WRITER_PID + writer)}.jsonl`] = `${corrupt}${lines(...records)}`;
      }
    }
    return files;
  }

  it("returns exactly the newest records the full read would, over many layouts", () => {
    for (let seed = 1; seed <= LAYOUT_SEEDS; seed += 1) {
      const next = generator(seed);
      const fs = createFakeFarmFs(randomLayout(next));
      for (let count = 1; count <= MAX_COUNT; count += 1) {
        expect(readRecentUsageRecords(fs, LOG_DIR, count), `seed ${String(seed)}, count ${String(count)}`).toEqual(readUsageLog(fs, LOG_DIR).records.slice(-count));
      }
    }
  });

  it("opens only the newest day's segments when they already hold the records asked for", () => {
    const files: Record<string, string> = {};
    for (let day = 0; day < LAYOUT_DAYS; day += 1) {
      files[`${LOG_DIR}/${segmentDay(DAY_START + day * DAY_MS)}.${String(WRITER_PID)}.jsonl`] = lines(recordAt(DAY_START + day * DAY_MS + HOUR_MS), recordAt(DAY_START + day * DAY_MS + 2 * HOUR_MS));
    }
    const base = createFakeFarmFs(files);
    const opened: string[] = [];
    const counting: UsageReadFs = {
      readdir: base.readdir,
      readFileUtf8: (file) => {
        opened.push(file);
        return base.readFileUtf8(file);
      },
    };

    const recent = readRecentUsageRecords(counting, LOG_DIR, 2);

    expect(recent).toHaveLength(2);
    expect(opened).toEqual([`${LOG_DIR}/${segmentDay(DAY_START + (LAYOUT_DAYS - 1) * DAY_MS)}.${String(WRITER_PID)}.jsonl`]);
  });

  it("reads the older day when a record in it is later than the newest day's records, stamped before midnight and written after", () => {
    const stampedLate = recordAt(DAY_START + DAY_MS - HALF_SECOND_MS, { requestId: "older-day-later-stamp" });
    const writtenAfterMidnight = recordAt(DAY_START + DAY_MS - SECOND_MS, { requestId: "newer-day-earlier-stamp" });
    const fs = createFakeFarmFs({
      [`${LOG_DIR}/2026-01-15.1.jsonl`]: lines(stampedLate),
      [`${LOG_DIR}/2026-01-16.1.jsonl`]: lines(writtenAfterMidnight),
    });

    expect(readRecentUsageRecords(fs, LOG_DIR, 1).map((record) => record.requestId)).toEqual(["older-day-later-stamp"]);
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
