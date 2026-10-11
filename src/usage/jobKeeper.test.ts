import { describe, expect, it } from "vitest";

import type { Job } from "../config/schema";
import { createFakeFarmFs } from "../test-helpers";
import { runJobs, type JobKeeperPorts, type NamedJob } from "./jobKeeper";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "./schema";

const STAMPS_DIR = "/state/usage";
const STAMPS_FILE = `${STAMPS_DIR}/jobs.json`;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const U40 = 0.4;
const TWENTY = 20;
const TWENTY_FIVE = 25;
const TEN = 10;
const FIVE = 5;
const TWENTY_MINUTES_MS = TWENTY * MINUTE_MS;
const TWENTY_FIVE_MINUTES_MS = TWENTY_FIVE * MINUTE_MS;
const TEN_MINUTES_MS = TEN * MINUTE_MS;
const FIVE_HOURS_MS = FIVE * HOUR_MS;
const FULL = 1;
const BEFORE_ANCHOR = Date.parse("2026-10-12T05:00:00Z");
const AFTER_ANCHOR = Date.parse("2026-10-12T06:03:00Z");

const at = (ms: number): string => new Date(ms).toISOString();

const SCHEDULED: Job = { target: { identity: "work" }, trigger: { at: [{ days: ["mon"], time: "06:00", timeZone: "UTC" }] }, prompt: "go", cwd: "/work", timeout: "10m" };
const BEFORE_RESET: Job = { target: { identity: "work" }, trigger: { beforeReset: "fiveHour", lead: "30m" }, prompt: "go", cwd: "/work", timeout: "10m" };

function snapshotWith(unified: NonNullable<NonNullable<UsageSnapshot["providers"][string]["rateLimit"]>["unified"]>, nowMs: number): UsageSnapshot {
  return { schemaVersion: USAGE_SCHEMA_VERSION, identity: "work", updatedAt: at(nowMs), providers: { anthropic: { rateLimit: { observedAt: at(nowMs - MINUTE_MS), headers: {}, unified } } } };
}

interface Harness {
  readonly run: (nowMs: number) => ReturnType<typeof runJobs>;
  readonly ran: string[];
  readonly logs: string[];
  readonly running: Set<string>;
  readonly fs: ReturnType<typeof createFakeFarmFs>;
}

function harness(options: { readonly jobs?: readonly NamedJob[]; readonly snapshot?: UsageSnapshot; readonly resolveIdentity?: JobKeeperPorts["resolveIdentity"]; readonly runJob?: JobKeeperPorts["run"]; readonly running?: Set<string> } = {}): Harness {
  const fs = createFakeFarmFs({});
  const ran: string[] = [];
  const logs: string[] = [];
  const running = options.running ?? new Set<string>();
  let now = 0;
  const ports: JobKeeperPorts = {
    fs,
    stampsFile: STAMPS_FILE,
    nowMs: () => now,
    timeZone: "UTC",
    jobs: () => options.jobs ?? [{ name: "digest", job: SCHEDULED }],
    resolveIdentity: options.resolveIdentity ?? ((target) => ("identity" in target ? target.identity : undefined)),
    snapshot: () => options.snapshot,
    run:
      options.runJob ??
      (async (name, identity) => {
        ran.push(`${name} as ${identity}`);
        await Promise.resolve();
      }),
    running,
    log: (line) => {
      logs.push(line);
    },
  };
  return {
    run: (nowMs) => {
      now = nowMs;
      return runJobs(ports);
    },
    ran,
    logs,
    running,
    fs,
  };
}

describe("runJobs, schedule jobs", () => {
  it("arms on first sight, then runs once when an anchor falls", async () => {
    const keeper = harness();
    expect(keeper.run(BEFORE_ANCHOR).outcomes[0]).toMatchObject({ name: "digest", status: "armed" });
    expect(keeper.run(BEFORE_ANCHOR + MINUTE_MS).outcomes[0]).toMatchObject({ status: "waiting" });
    const fired = keeper.run(AFTER_ANCHOR);
    expect(fired.outcomes[0]).toMatchObject({ status: "started" });
    await fired.settled;
    expect(keeper.ran).toEqual(["digest as work"]);
    const again = keeper.run(AFTER_ANCHOR + HOUR_MS);
    expect(again.outcomes[0]).toMatchObject({ status: "waiting" });
    await again.settled;
    expect(keeper.ran).toHaveLength(1);
  });

  it("does not replay an anchor that fell before the job was first seen", async () => {
    const keeper = harness();
    const first = keeper.run(AFTER_ANCHOR);
    expect(first.outcomes[0]).toMatchObject({ status: "armed" });
    await first.settled;
    expect(keeper.ran).toEqual([]);
  });

  it("runs a pool job as the identity its pool resolves to", async () => {
    const keeper = harness({ jobs: [{ name: "digest", job: { ...SCHEDULED, target: { pool: "subs" } } }], resolveIdentity: () => "spare" });
    keeper.run(BEFORE_ANCHOR);
    await keeper.run(AFTER_ANCHOR).settled;
    expect(keeper.ran).toEqual(["digest as spare"]);
  });

  it("skips, naming why, when the pool cannot pick or resolving throws, and keeps going with the other jobs", async () => {
    const keeper = harness({
      jobs: [
        { name: "empty", job: { ...SCHEDULED, target: { pool: "none" } } },
        { name: "broken", job: { ...SCHEDULED, target: { pool: "gone" } } },
        { name: "fine", job: SCHEDULED },
      ],
      resolveIdentity: (target) => {
        if ("pool" in target && target.pool === "gone") {
          throw new Error('No pool named "gone"');
        }
        return "identity" in target ? target.identity : undefined;
      },
    });
    keeper.run(BEFORE_ANCHOR);
    const fired = keeper.run(AFTER_ANCHOR);
    await fired.settled;
    expect(fired.outcomes.map((outcome) => `${outcome.name}:${outcome.status}`)).toEqual(["empty:skipped", "broken:skipped", "fine:started"]);
    expect(fired.outcomes[1]?.detail).toContain("No pool named");
    expect(keeper.ran).toEqual(["fine as work"]);
  });

  it("does not start a job again while its previous run is still going, and does not log that", async () => {
    let finish: () => void = () => undefined;
    const keeper = harness({
      runJob: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    keeper.run(BEFORE_ANCHOR);
    const fired = keeper.run(AFTER_ANCHOR);
    expect(keeper.running.has("digest")).toBe(true);
    const during = keeper.run(AFTER_ANCHOR + MINUTE_MS);
    expect(during.outcomes[0]).toMatchObject({ status: "running" });
    finish();
    await fired.settled;
    expect(keeper.running.has("digest")).toBe(false);
    expect(keeper.logs.filter((line) => line.includes("still going"))).toEqual([]);
  });

  it("logs a failed run and does not run it again before the next anchor", async () => {
    const keeper = harness({
      runJob: async () => {
        await Promise.resolve();
        throw new Error("signed out");
      },
    });
    keeper.run(BEFORE_ANCHOR);
    await keeper.run(AFTER_ANCHOR).settled;
    expect(keeper.logs.join("\n")).toContain("failed as work: signed out");
    expect(keeper.run(AFTER_ANCHOR + MINUTE_MS).outcomes[0]).toMatchObject({ status: "waiting" });
  });

  it("skips and says why when the identity is refused, still consuming the anchor", async () => {
    const refused = snapshotWith({ sevenDay: { utilization: FULL, status: "rejected", resetsAt: at(AFTER_ANCHOR + HOUR_MS) } }, AFTER_ANCHOR);
    const keeper = harness({ snapshot: refused });
    keeper.run(BEFORE_ANCHOR);
    const fired = keeper.run(AFTER_ANCHOR);
    await fired.settled;
    expect(fired.outcomes[0]).toMatchObject({ status: "skipped" });
    expect(fired.outcomes[0]?.detail).toContain("refused");
    expect(keeper.ran).toEqual([]);
    expect(keeper.run(AFTER_ANCHOR + MINUTE_MS).outcomes[0]).toMatchObject({ status: "waiting" });
  });

  it("drops a removed job from the file", () => {
    const fs = createFakeFarmFs({});
    let jobs: readonly NamedJob[] = [{ name: "digest", job: SCHEDULED }];
    const ports: JobKeeperPorts = { fs, stampsFile: STAMPS_FILE, nowMs: () => BEFORE_ANCHOR, timeZone: "UTC", jobs: () => jobs, resolveIdentity: () => "work", snapshot: () => undefined, run: async () => { await Promise.resolve(); }, running: new Set(), log: () => undefined };
    runJobs(ports);
    expect(fs.readFileUtf8(STAMPS_FILE)).toContain("digest");
    jobs = [];
    runJobs(ports);
    expect(fs.readFileUtf8(STAMPS_FILE)).not.toContain("digest");
  });
});

describe("runJobs, before-reset jobs", () => {
  const resetsAt = AFTER_ANCHOR + TWENTY_MINUTES_MS;
  const open = snapshotWith({ fiveHour: { utilization: U40, resetsAt: at(resetsAt) } }, AFTER_ANCHOR);

  it("waits outside the lead, runs once inside it, and runs again for the next instance of the window", async () => {
    const keeper = harness({ jobs: [{ name: "burn", job: BEFORE_RESET }], snapshot: open });
    const early = keeper.run(resetsAt - HOUR_MS);
    expect(early.outcomes[0]).toMatchObject({ status: "waiting" });
    const fired = keeper.run(resetsAt - TWENTY_FIVE_MINUTES_MS);
    expect(fired.outcomes[0]).toMatchObject({ status: "started" });
    await fired.settled;
    expect((keeper.run(resetsAt - TEN_MINUTES_MS)).outcomes[0]).toMatchObject({ status: "waiting" });
    expect(keeper.ran).toEqual(["burn as work"]);
    const nextReset = resetsAt + FIVE_HOURS_MS;
    const nextKeeper = harness({ jobs: [{ name: "burn", job: BEFORE_RESET }], snapshot: snapshotWith({ fiveHour: { utilization: U40, resetsAt: at(nextReset) } }, nextReset - HOUR_MS) });
    nextKeeper.fs.mkdirPrivate(STAMPS_DIR);
    nextKeeper.fs.writeFilePrivate(STAMPS_FILE, keeper.fs.readFileUtf8(STAMPS_FILE) ?? "");
    await nextKeeper.run(nextReset - TWENTY_FIVE_MINUTES_MS).settled;
    expect(nextKeeper.ran).toEqual(["burn as work"]);
  });

  it("skips when the identity has no such window", () => {
    const keeper = harness({ jobs: [{ name: "burn", job: BEFORE_RESET }], snapshot: snapshotWith({ sevenDay: { utilization: U40, resetsAt: at(resetsAt) } }, AFTER_ANCHOR) });
    const result = keeper.run(resetsAt - TWENTY_FIVE_MINUTES_MS);
    expect(result.outcomes[0]).toMatchObject({ status: "skipped" });
    expect(result.outcomes[0]?.detail).toContain("no fiveHour window");
  });

  it("does not repeat a run for the same window instance after a restart", async () => {
    const first = harness({ jobs: [{ name: "burn", job: BEFORE_RESET }], snapshot: open });
    await first.run(resetsAt - TWENTY_FIVE_MINUTES_MS).settled;
    const restarted = harness({ jobs: [{ name: "burn", job: BEFORE_RESET }], snapshot: open });
    restarted.fs.mkdirPrivate(STAMPS_DIR);
    restarted.fs.writeFilePrivate(STAMPS_FILE, first.fs.readFileUtf8(STAMPS_FILE) ?? "");
    await restarted.run(resetsAt - TWENTY_MINUTES_MS).settled;
    expect(restarted.ran).toEqual([]);
  });
});
