import { describe, expect, it } from "vitest";

import { createFakeFarmFs, DAY_MS, FAKE_NOW_MS, paths, type FakeFarmFs } from "../test-helpers";
import { AccountMetadataError } from "./account";
import { listLogSegments, readUsageLog, readUsageSnapshot, segmentDay, segmentName, snapshotPath } from "./read";
import { USAGE_SCHEMA_VERSION, type AccountMetadata, type LimitClassification, type ProviderQuota, type RateLimitState, type UsageRecord, type UsageSnapshot } from "./schema";
import { createUsageStore, foldProviderState, pruneUsageLog, USAGE_RETENTION_MS, type UsageStoreDeps } from "./store";

const PID = 4242;
const LATENCY_MS = 250;
const DURATION_MS = 900;
const OK_STATUS = 200;
const RATE_LIMITED_STATUS = 429;
const SECOND_MS = 1000;
const RETENTION_DAYS = 7;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const MIDNIGHT = Date.parse("2026-01-15T00:00:00.000Z");
const NOW_ISO = new Date(FAKE_NOW_MS).toISOString();
const UNIFIED_STATUS_HEADER = "anthropic-ratelimit-unified-status";

const ANONYMOUS_RECORD: UsageRecord = {
  schemaVersion: USAGE_SCHEMA_VERSION,
  at: NOW_ISO,
  provider: "anthropic",
  route: "passthrough",
  method: "POST",
  endpoint: "/v1/messages",
  status: OK_STATUS,
  latencyMs: LATENCY_MS,
  durationMs: DURATION_MS,
  outcome: "completed",
};

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { ...ANONYMOUS_RECORD, identity: "work", ...overrides };
}

function atOffset(offsetMs: number): string {
  return new Date(FAKE_NOW_MS + offsetMs).toISOString();
}

interface Harness {
  readonly fs: FakeFarmFs;
  readonly logged: string[];
  readonly store: ReturnType<typeof createUsageStore>;
}

function harness(overrides: Partial<UsageStoreDeps> = {}, fs: FakeFarmFs = createFakeFarmFs()): Harness {
  const logged: string[] = [];
  const store = createUsageStore({
    fs,
    paths,
    pid: PID,
    now: () => FAKE_NOW_MS,
    readAccount: () => undefined,
    log: (line) => {
      logged.push(line);
    },
    ...overrides,
  });
  return { fs, logged, store };
}

function todaysSegment(): string {
  return `${paths.usageLogDir}/${segmentName(segmentDay(FAKE_NOW_MS), PID)}`;
}

describe("createUsageStore", () => {
  it("tells the publish dep every snapshot it writes, the fact the door's usage event source is wired to", () => {
    const published: UsageSnapshot[] = [];
    const world = harness({ publish: (snapshot) => { published.push(snapshot); } });
    world.store.record(makeRecord({ provider: "anthropic" }));
    world.store.record(makeRecord({ provider: "z" }));
    expect(published.map((snapshot) => Object.keys(snapshot.providers))).toEqual([["anthropic"], ["anthropic", "z"]]);
    // The published payload is the snapshot on disk, verbatim: the consumer diffs or reads windows from the payload itself.
    expect(published.at(-1)).toEqual(JSON.parse(world.fs.readFileUtf8(`${paths.usageSnapshotsDir}/work.json`) ?? "{}"));
  });

  it("records with no publish dep wired at all, and a record without an identity writes no snapshot so would publish nothing", () => {
    const world = harness();
    world.store.record({ ...ANONYMOUS_RECORD });
    // The record still landed in the log: the store is a plain filesystem writer whenever no backbone is wired.
    expect((world.fs.readFileUtf8(todaysSegment()) ?? "").trim()).toContain(ANONYMOUS_RECORD.endpoint);
    expect(world.fs.readFileUtf8(`${paths.usageSnapshotsDir}/work.json`)).toBeUndefined();
  });

  it("appends each record as one line to this process's segment for the day", () => {
    const { fs, store } = harness();
    const first = makeRecord({ requestId: "req-1" });
    const second = makeRecord({ requestId: "req-2" });

    store.record(first);
    store.record(second);

    const lines = (fs.readFileUtf8(todaysSegment()) ?? "").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([first, second]);
    expect(listLogSegments(fs, paths.usageLogDir).map((segment) => segment.name)).toEqual([segmentName("2026-01-15", PID)]);
  });

  it("creates the store directories and the segment owner-only", () => {
    const { fs, store } = harness();

    store.record(makeRecord());

    expect(fs.modeOf(paths.usageDir)).toBe(OWNER_ONLY_DIR_MODE);
    expect(fs.modeOf(paths.usageLogDir)).toBe(OWNER_ONLY_DIR_MODE);
    expect(fs.modeOf(paths.usageSnapshotsDir)).toBe(OWNER_ONLY_DIR_MODE);
    expect(fs.modeOf(todaysSegment())).toBe(OWNER_ONLY_FILE_MODE);
    expect(fs.modeOf(snapshotPath(paths.usageSnapshotsDir, "work"))).toBe(OWNER_ONLY_FILE_MODE);
  });

  it("writes the identity's snapshot with the provider's latest state and the account metadata", () => {
    const account: AccountMetadata = { billingType: "stripe_subscription", seatTier: "team_standard", userRateLimitTier: "default_claude_max_5x" };
    const { fs, store } = harness({ readAccount: (identity) => (identity === "work" ? account : undefined) });

    store.record(
      makeRecord({
        model: "claude-sonnet",
        rateLimitHeaders: { [UNIFIED_STATUS_HEADER]: "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.25" },
      }),
    );

    const snapshot = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work");
    expect(snapshot).toEqual({
      schemaVersion: USAGE_SCHEMA_VERSION,
      identity: "work",
      updatedAt: NOW_ISO,
      account,
      providers: {
        anthropic: {
          lastRequestAt: NOW_ISO,
          lastStatus: OK_STATUS,
          lastModel: "claude-sonnet",
          rateLimit: {
            observedAt: atOffset(LATENCY_MS),
            headers: { [UNIFIED_STATUS_HEADER]: "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.25" },
            unified: { status: "allowed", fiveHour: { utilization: 0.25 } },
          },
        },
      },
    });
  });

  it("keeps each provider's state side by side in one identity's snapshot", () => {
    const { fs, store } = harness();

    store.record(makeRecord({ provider: "anthropic" }));
    store.record(makeRecord({ provider: "z", status: RATE_LIMITED_STATUS }));

    const snapshot = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work");
    expect(Object.keys(snapshot?.providers ?? {}).sort()).toEqual(["anthropic", "z"]);
    expect(snapshot?.providers.anthropic?.lastStatus).toBe(OK_STATUS);
    expect(snapshot?.providers.z?.lastStatus).toBe(RATE_LIMITED_STATUS);
  });

  it("writes no snapshot for a record without an identity but still logs it", () => {
    const { fs, store } = harness();

    store.record(ANONYMOUS_RECORD);

    expect(readUsageLog(fs, paths.usageLogDir).records).toEqual([ANONYMOUS_RECORD]);
    expect(fs.readdir(paths.usageSnapshotsDir)).toEqual([]);
  });

  it("logs the record but names no snapshot after an identity that is not a valid file name", () => {
    const { fs, logged, store } = harness();
    const traversal = makeRecord({ identity: "../escape" });

    store.record(traversal);

    expect(readUsageLog(fs, paths.usageLogDir).records).toEqual([traversal]);
    expect(fs.readdir(paths.usageSnapshotsDir)).toEqual([]);
    expect(logged).toEqual(['usage: no snapshot for identity "../escape", which is not a valid identity name']);
  });

  it("replaces an unreadable snapshot with a fresh one and says so", () => {
    const fs = createFakeFarmFs({ [snapshotPath(paths.usageSnapshotsDir, "work")]: "{not json" });
    const { logged, store } = harness({}, fs);

    store.record(makeRecord());

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.lastRequestAt).toBe(NOW_ISO);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("usage: replacing an unreadable snapshot");
  });

  it("writes the snapshot without an account when the profile cannot be read, and says why", () => {
    const failure = new AccountMetadataError("/identities/work/.claude.json", "not valid JSON");
    const { fs, logged, store } = harness({
      readAccount: () => {
        throw failure;
      },
    });

    store.record(makeRecord());

    const snapshot = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work");
    expect(snapshot?.account).toBeUndefined();
    expect(snapshot?.providers.anthropic?.lastStatus).toBe(OK_STATUS);
    expect(logged).toEqual([`usage: snapshot for work written without account metadata: ${failure.message}`]);
  });

  it("does not swallow an account-reader failure that is not an account metadata error", () => {
    const { store } = harness({
      readAccount: () => {
        throw new Error("EIO");
      },
    });

    expect(() => {
      store.record(makeRecord());
    }).toThrow("EIO");
  });

  describe("out-of-order records", () => {
    const newerHeaders = { [UNIFIED_STATUS_HEADER]: "rejected" };
    const olderHeaders = { [UNIFIED_STATUS_HEADER]: "allowed" };

    it("keeps the newest request's status, time and model when an older record arrives afterwards", () => {
      const { fs, store } = harness();

      store.record(makeRecord({ at: atOffset(SECOND_MS), status: OK_STATUS, model: "newer-model" }));
      store.record(makeRecord({ at: atOffset(0), status: RATE_LIMITED_STATUS, model: "older-model" }));

      const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic;
      expect(state?.lastRequestAt).toBe(atOffset(SECOND_MS));
      expect(state?.lastStatus).toBe(OK_STATUS);
      expect(state?.lastModel).toBe("newer-model");
    });

    it("takes the newer record's state when it arrives after an older one", () => {
      const { fs, store } = harness();

      store.record(makeRecord({ at: atOffset(0), status: OK_STATUS, model: "older-model" }));
      store.record(makeRecord({ at: atOffset(SECOND_MS), status: RATE_LIMITED_STATUS, model: "newer-model" }));

      const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic;
      expect(state?.lastRequestAt).toBe(atOffset(SECOND_MS));
      expect(state?.lastStatus).toBe(RATE_LIMITED_STATUS);
      expect(state?.lastModel).toBe("newer-model");
    });

    it("keeps the newest rate-limit observation whichever order the records arrive in", () => {
      const { fs, store } = harness();

      store.record(makeRecord({ at: atOffset(SECOND_MS), rateLimitHeaders: newerHeaders }));
      store.record(makeRecord({ at: atOffset(0), rateLimitHeaders: olderHeaders }));

      const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic;
      expect(state?.rateLimit?.headers).toEqual(newerHeaders);
      expect(state?.rateLimit?.observedAt).toBe(atOffset(SECOND_MS + LATENCY_MS));
    });

    it("keeps the newest limit event and lets a later success leave it in place", () => {
      const { fs, store } = harness();
      const limit: LimitClassification = { kind: "rate-limited", evidence: ["status=429"] };

      store.record(makeRecord({ at: atOffset(0), status: RATE_LIMITED_STATUS, limit }));
      store.record(makeRecord({ at: atOffset(SECOND_MS), status: OK_STATUS }));

      const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic;
      expect(state?.lastLimit).toEqual({ ...limit, observedAt: atOffset(LATENCY_MS), status: RATE_LIMITED_STATUS });
      expect(state?.lastStatus).toBe(OK_STATUS);
    });

    it("keeps the older record's model when the newest record named none", () => {
      const folded = foldProviderState(
        foldProviderState(undefined, makeRecord({ at: atOffset(0), model: "named-model" })),
        makeRecord({ at: atOffset(SECOND_MS) }),
      );

      expect(folded.lastModel).toBe("named-model");
      expect(folded.lastRequestAt).toBe(atOffset(SECOND_MS));
    });
  });

  describe("retention", () => {
    it("drops segments whose day ended before the retention window began and keeps the rest", () => {
      const fs = createFakeFarmFs({
        [`${paths.usageLogDir}/2026-01-07.1.jsonl`]: "old\n",
        [`${paths.usageLogDir}/2026-01-08.1.jsonl`]: "edge\n",
        [`${paths.usageLogDir}/2026-01-14.1.jsonl`]: "recent\n",
        [`${paths.usageLogDir}/notes.tmp`]: "not a segment\n",
      });
      const { store } = harness({ now: () => MIDNIGHT }, fs);

      store.record(makeRecord({ at: new Date(MIDNIGHT).toISOString() }));

      expect(fs.readdir(paths.usageLogDir)).toEqual(["2026-01-08.1.jsonl", "2026-01-14.1.jsonl", "2026-01-15.4242.jsonl", "notes.tmp"]);
    });

    it("prunes on the first write of each day only", () => {
      const fs = createFakeFarmFs();
      let nowMs = FAKE_NOW_MS;
      const { store } = harness({ now: () => nowMs }, fs);

      store.record(makeRecord());
      const lateStraggler = `${paths.usageLogDir}/2026-01-01.9.jsonl`;
      fs.seed({ [lateStraggler]: "old\n" });
      store.record(makeRecord());
      expect(fs.readFileUtf8(lateStraggler)).toBe("old\n");

      nowMs += DAY_MS;
      store.record(makeRecord({ at: new Date(nowMs).toISOString() }));
      expect(fs.readFileUtf8(lateStraggler)).toBeUndefined();
    });

    it("treats a segment ending exactly at the cutoff as expired", () => {
      const fs = createFakeFarmFs({
        [`${paths.usageLogDir}/2026-01-07.1.jsonl`]: "ends at the cutoff\n",
        [`${paths.usageLogDir}/2026-01-08.1.jsonl`]: "ends a day later\n",
      });

      pruneUsageLog(fs, paths.usageLogDir, MIDNIGHT);

      expect(fs.readdir(paths.usageLogDir)).toEqual(["2026-01-08.1.jsonl"]);
      expect(USAGE_RETENTION_MS).toBe(RETENTION_DAYS * DAY_MS);
    });
  });

  describe("failures", () => {
    it("surfaces a log write failure to the caller and writes no snapshot", () => {
      const base = createFakeFarmFs();
      const failing: FakeFarmFs = {
        ...base,
        appendFilePrivate: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      };
      const { store } = harness({}, failing);

      expect(() => {
        store.record(makeRecord());
      }).toThrow("ENOSPC: no space left on device");
      expect(base.readdir(paths.usageSnapshotsDir)).toEqual([]);
    });

    it("surfaces a snapshot write failure to the caller after the record is logged", () => {
      const base = createFakeFarmFs();
      const failing: FakeFarmFs = {
        ...base,
        writeFilePrivate: () => {
          throw new Error("EACCES: permission denied");
        },
      };
      const { store } = harness({}, failing);

      expect(() => {
        store.record(makeRecord());
      }).toThrow("EACCES: permission denied");
      expect(readUsageLog(base, paths.usageLogDir).records).toHaveLength(1);
    });

    it("rejects a record carrying a field the schema does not name, before anything touches disk", () => {
      const { fs, store } = harness();
      const withContent = { ...makeRecord(), prompt: "the user's prompt" };

      expect(() => {
        store.record(withContent);
      }).toThrow();
      expect(fs.writes).toEqual([]);
    });
  });
});

describe("recordQuota", () => {
  const HOUR_MS = 3_600_000;
  const FIVE_HOURS = 5;
  const FIVE_HOUR_MS = FIVE_HOURS * HOUR_MS;
  const FIVE_HOUR_UTILISATION = 0.13;
  const HALF_USED = 0.5;

  function quotaObservedAt(offsetMs: number, utilization = FIVE_HOUR_UTILISATION): ProviderQuota {
    return { observedAt: atOffset(offsetMs), source: "z.ai", level: "max", windows: [{ measures: "tokens", periodMs: FIVE_HOUR_MS, utilization, resetsAt: atOffset(FIVE_HOUR_MS) }] };
  }

  it("attaches the quota to the provider's existing state and leaves the rest of it alone", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ provider: "z", model: "glm-5.1" }));
    const quota = quotaObservedAt(0);

    expect(store.recordQuota("work", "z", quota)).toBe(true);

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.z).toEqual({ lastRequestAt: NOW_ISO, lastStatus: OK_STATUS, lastModel: "glm-5.1", quota });
  });

  it("keeps the quota when a later request for the provider is recorded", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ provider: "z" }));
    const quota = quotaObservedAt(0);
    store.recordQuota("work", "z", quota);

    store.record(makeRecord({ provider: "z", at: atOffset(SECOND_MS), status: RATE_LIMITED_STATUS }));

    const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.z;
    expect(state?.quota).toEqual(quota);
    expect(state?.lastStatus).toBe(RATE_LIMITED_STATUS);
  });

  it("keeps an already stored quota that was observed later", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ provider: "z" }));
    const newer = quotaObservedAt(SECOND_MS, HALF_USED);
    store.recordQuota("work", "z", newer);

    store.recordQuota("work", "z", quotaObservedAt(0));

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.z?.quota).toEqual(newer);
  });

  it("replaces a quota with a newer observation", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ provider: "z" }));
    store.recordQuota("work", "z", quotaObservedAt(0));
    const newer = quotaObservedAt(SECOND_MS, HALF_USED);

    store.recordQuota("work", "z", newer);

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.z?.quota).toEqual(newer);
  });

  it("attaches nothing, and writes nothing, for an identity or provider with no recorded usage", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ provider: "anthropic" }));
    const before = fs.snapshot();

    expect(store.recordQuota("work", "z", quotaObservedAt(0))).toBe(false);
    expect(store.recordQuota("other", "z", quotaObservedAt(0))).toBe(false);

    expect(fs.snapshot()).toEqual(before);
  });
});

describe("recordRateLimit", () => {
  const FIVE_HOUR_FRACTION = 0.24;
  const HALF_USED = 0.5;

  function fetchedAt(offsetMs: number, utilization = FIVE_HOUR_FRACTION, overageStatus?: string): RateLimitState {
    return { observedAt: atOffset(offsetMs), headers: {}, unified: { fiveHour: { utilization, resetsAt: atOffset(DAY_MS) }, ...(overageStatus === undefined ? {} : { overageStatus }) } };
  }

  it("records the fetched state beside the provider's existing state and leaves the rest of it alone", () => {
    const { fs, store } = harness();
    store.record(makeRecord({ model: "claude-sonnet-5-5" }));
    const fetched = fetchedAt(0);

    store.recordRateLimit("work", "anthropic", fetched);

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic).toEqual({ lastRequestAt: NOW_ISO, lastStatus: OK_STATUS, lastModel: "claude-sonnet-5-5", rateLimit: fetched });
  });

  it("creates the provider's state for an identity that has made no request, with no request time", () => {
    const { fs, store } = harness();
    const fetched = fetchedAt(0);

    store.recordRateLimit("work", "anthropic", fetched);

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic).toEqual({ rateLimit: fetched });
  });

  it("takes the request fields from the first request recorded after a fetched state alone", () => {
    const { fs, store } = harness();
    const fetched = fetchedAt(0);
    store.recordRateLimit("work", "anthropic", fetched);

    store.record(makeRecord());

    const state = readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic;
    expect(state).toMatchObject({ lastRequestAt: NOW_ISO, lastStatus: OK_STATUS, rateLimit: fetched });
  });

  it("keeps a rate-limit state observed later than the fetched one", () => {
    const { fs, store } = harness();
    store.record(makeRecord());
    const newer = fetchedAt(SECOND_MS, HALF_USED);
    store.recordRateLimit("work", "anthropic", newer);

    store.recordRateLimit("work", "anthropic", fetchedAt(0));

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit).toEqual(newer);
  });

  it("carries the whole extra-usage meter earlier response headers stated, not only its status", () => {
    const { fs, store } = harness();
    store.record(makeRecord());
    const meter = { overageStatus: "allowed", overageUtilization: HALF_USED, overageResetsAt: atOffset(DAY_MS), overageDisabledReason: "out_of_credits" };
    store.recordRateLimit("work", "anthropic", { observedAt: atOffset(0), headers: {}, unified: meter });

    store.recordRateLimit("work", "anthropic", fetchedAt(SECOND_MS, HALF_USED));

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit?.unified).toEqual({ fiveHour: { utilization: HALF_USED, resetsAt: atOffset(DAY_MS) }, ...meter });
  });

  it("lets the usage endpoint's extra-usage figures win over earlier headers, and keeps the reset only the headers give", () => {
    const { fs, store } = harness();
    store.record(makeRecord());
    store.recordRateLimit("work", "anthropic", { observedAt: atOffset(0), headers: {}, unified: { overageStatus: "allowed", overageUtilization: HALF_USED, overageResetsAt: atOffset(DAY_MS) } });
    const spend = { usedMinor: 84_900, limitMinor: 200_000, currency: "USD" };

    store.recordRateLimit("work", "anthropic", { observedAt: atOffset(SECOND_MS), headers: {}, unified: { overageStatus: "rejected", overageUtilization: 1, extraUsageSpend: spend } });

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit?.unified).toEqual({ overageStatus: "rejected", overageUtilization: 1, overageResetsAt: atOffset(DAY_MS), extraUsageSpend: spend });
  });

  it("keeps what response headers recorded when the usage endpoint has nothing to report, noting only that it was asked", () => {
    const { fs, store } = harness();
    store.record(makeRecord());
    const fromHeaders: RateLimitState = { observedAt: atOffset(0), headers: { "anthropic-ratelimit-unified-overage-utilization": "0.42" }, unified: { overageStatus: "allowed", overageUtilization: 0.42 } };
    store.recordRateLimit("work", "anthropic", fromHeaders);

    store.recordRateLimit("work", "anthropic", { observedAt: atOffset(SECOND_MS), headers: {} });

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit).toEqual({ ...fromHeaders, planWindowsUnavailableAt: atOffset(SECOND_MS) });
  });

  it("records an answer without plan windows for an account that has no state yet, as the question having been asked", () => {
    const { fs, store } = harness();
    store.recordRateLimit("work", "anthropic", { observedAt: atOffset(0), headers: {} });

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit).toEqual({ observedAt: atOffset(0), headers: {}, planWindowsUnavailableAt: atOffset(0) });
  });

  it("carries the extra-usage status earlier response headers stated, which the usage endpoint does not report", () => {
    const { fs, store } = harness();
    store.record(makeRecord());
    store.recordRateLimit("work", "anthropic", fetchedAt(0, FIVE_HOUR_FRACTION, "allowed"));

    store.recordRateLimit("work", "anthropic", fetchedAt(SECOND_MS, HALF_USED));

    expect(readUsageSnapshot(fs, paths.usageSnapshotsDir, "work")?.providers.anthropic?.rateLimit?.unified).toEqual({ fiveHour: { utilization: HALF_USED, resetsAt: atOffset(DAY_MS) }, overageStatus: "allowed" });
  });
});
