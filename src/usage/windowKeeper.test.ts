import { describe, expect, it } from "vitest";

import type { Anchor } from "../config/schema";
import { createFakeFarmFs } from "../test-helpers";
import { readHandled, writeHandled } from "./handledStamps";
import { reasonNotToOpen, runWindowKeeper, type AnchoredIdentity, type WindowKeeperPorts } from "./windowKeeper";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "./schema";

const STAMPS_DIR = "/state/usage";
const STAMPS_FILE = `${STAMPS_DIR}/anchors.json`;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const U40 = 0.4;
const FULL = 1;
const MONDAY_6: readonly Anchor[] = [{ days: ["mon"], time: "06:00", timeZone: "UTC" }];
const BEFORE_ANCHOR = Date.parse("2026-10-12T05:00:00Z");
const AFTER_ANCHOR = Date.parse("2026-10-12T06:03:00Z");

const at = (ms: number): string => new Date(ms).toISOString();

function snapshotWith(identity: string, unified: NonNullable<NonNullable<UsageSnapshot["providers"][string]["rateLimit"]>["unified"]>, nowMs: number): UsageSnapshot {
  return { schemaVersion: USAGE_SCHEMA_VERSION, identity, updatedAt: at(nowMs), providers: { anthropic: { rateLimit: { observedAt: at(nowMs - MINUTE_MS), headers: {}, unified } } } };
}

interface Harness {
  readonly run: (nowMs: number) => ReturnType<typeof runWindowKeeper>;
  readonly opened: string[];
  readonly logs: string[];
  readonly fs: ReturnType<typeof createFakeFarmFs>;
}

function harness(options: { readonly anchored?: readonly AnchoredIdentity[]; readonly snapshots?: Readonly<Record<string, UsageSnapshot>>; readonly open?: (identity: string) => Promise<void> } = {}): Harness {
  const fs = createFakeFarmFs({});
  const opened: string[] = [];
  const logs: string[] = [];
  let now = 0;
  const ports: WindowKeeperPorts = {
    fs,
    stampsFile: STAMPS_FILE,
    nowMs: () => now,
    timeZone: "UTC",
    anchored: () => options.anchored ?? [{ id: "work", identity: "work", anchors: MONDAY_6 }],
    // Unless a test says otherwise the account has been read and reports no open five-hour window, which is the state an anchor exists to act on.
    snapshot: (identity) => (options.snapshots === undefined ? snapshotWith(identity, { fiveHour: { utilization: 0 }, sevenDay: { utilization: U40 } }, AFTER_ANCHOR) : options.snapshots[identity]),
    open:
      options.open ??
      (async (identity) => {
        opened.push(identity);
        await Promise.resolve();
      }),
    log: (line) => {
      logs.push(line);
    },
  };
  return {
    run: async (nowMs) => {
      now = nowMs;
      return await runWindowKeeper(ports);
    },
    opened,
    logs,
    fs,
  };
}

describe("runWindowKeeper", () => {
  it("arms an identity on first sight and acts only on anchors that fall afterwards", async () => {
    const keeper = harness();
    expect((await keeper.run(BEFORE_ANCHOR))[0]).toMatchObject({ identity: "work", status: "armed" });
    expect(keeper.opened).toEqual([]);
    expect((await keeper.run(BEFORE_ANCHOR + MINUTE_MS))[0]).toMatchObject({ status: "waiting" });
    expect((await keeper.run(AFTER_ANCHOR))[0]).toMatchObject({ status: "opened" });
    expect(keeper.opened).toEqual(["work"]);
  });

  it("does not replay an anchor that fell before the identity was first seen", async () => {
    const keeper = harness();
    expect((await keeper.run(AFTER_ANCHOR))[0]).toMatchObject({ status: "armed" });
    expect(keeper.opened).toEqual([]);
  });

  it("skips an anchor for an identity whose quota has not been read, and says so, rather than opening a window blind", async () => {
    const keeper = harness({ snapshots: {} });
    await keeper.run(BEFORE_ANCHOR);
    const outcome = (await keeper.run(AFTER_ANCHOR))[0];
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(outcome?.detail).toContain("not been read");
    expect(keeper.opened).toEqual([]);
  });

  it("acts once per anchor, across runs and restarts", async () => {
    const keeper = harness();
    await keeper.run(BEFORE_ANCHOR);
    await keeper.run(AFTER_ANCHOR);
    await keeper.run(AFTER_ANCHOR + HOUR_MS);
    const restarted = harness();
    restarted.fs.mkdirPrivate(STAMPS_DIR);
    restarted.fs.writeFilePrivate(STAMPS_FILE, keeper.fs.readFileUtf8(STAMPS_FILE) ?? "");
    expect((await restarted.run(AFTER_ANCHOR + HOUR_MS))[0]).toMatchObject({ status: "waiting" });
    expect(keeper.opened).toEqual(["work"]);
    expect(restarted.opened).toEqual([]);
  });

  it("skips and says why when a five-hour window is already open, still marking the anchor handled", async () => {
    const open = snapshotWith("work", { fiveHour: { utilization: U40, resetsAt: at(AFTER_ANCHOR + 2 * HOUR_MS) } }, AFTER_ANCHOR);
    const keeper = harness({ snapshots: { work: open } });
    await keeper.run(BEFORE_ANCHOR);
    const [outcome] = await keeper.run(AFTER_ANCHOR);
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(outcome?.detail).toContain("already open");
    expect(keeper.opened).toEqual([]);
    expect((await keeper.run(AFTER_ANCHOR + MINUTE_MS))[0]).toMatchObject({ status: "waiting" });
  });

  it("logs a failed opening and does not retry before the next anchor", async () => {
    const keeper = harness({
      open: async () => {
        await Promise.resolve();
        throw new Error("signed out");
      },
    });
    await keeper.run(BEFORE_ANCHOR);
    const [outcome] = await keeper.run(AFTER_ANCHOR);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome?.detail).toContain("signed out");
    expect(keeper.logs.join("\n")).toContain("could not open a window");
    expect((await keeper.run(AFTER_ANCHOR + MINUTE_MS))[0]).toMatchObject({ status: "waiting" });
  });

  it("drops an identity from the file once it has no anchors, and arms it afresh if they return", async () => {
    let anchored: readonly AnchoredIdentity[] = [{ id: "work", identity: "work", anchors: MONDAY_6 }];
    const fs = createFakeFarmFs({});
    const ports: WindowKeeperPorts = { fs, stampsFile: STAMPS_FILE, nowMs: () => BEFORE_ANCHOR, timeZone: "UTC", anchored: () => anchored, snapshot: () => undefined, open: async () => {
        await Promise.resolve();
      }, log: () => undefined };
    await runWindowKeeper(ports);
    expect(fs.readFileUtf8(STAMPS_FILE)).toContain("work");
    anchored = [];
    await runWindowKeeper(ports);
    expect(fs.readFileUtf8(STAMPS_FILE)).not.toContain("work");
  });

  it("treats an unreadable stamps file as nothing handled, arming rather than opening", async () => {
    const keeper = harness();
    keeper.fs.mkdirPrivate(STAMPS_DIR);
    keeper.fs.writeFilePrivate(STAMPS_FILE, "{ not json");
    expect((await keeper.run(AFTER_ANCHOR))[0]).toMatchObject({ status: "armed" });
    expect(keeper.opened).toEqual([]);
  });
});

describe("reasonNotToOpen", () => {
  it("does not open for an identity whose quota has not been read, since whether a window is open is then unknown", () => {
    expect(reasonNotToOpen("a", undefined, AFTER_ANCHOR)).toContain("not been read");
  });

  it("opens for an identity whose five-hour window has lapsed or never opened", () => {
    expect(reasonNotToOpen("a", snapshotWith("a", { fiveHour: { utilization: FULL, resetsAt: at(AFTER_ANCHOR - HOUR_MS) }, sevenDay: { utilization: U40 } }, AFTER_ANCHOR), AFTER_ANCHOR)).toBeUndefined();
    expect(reasonNotToOpen("a", snapshotWith("a", { fiveHour: { utilization: 0 }, sevenDay: { utilization: U40 } }, AFTER_ANCHOR), AFTER_ANCHOR)).toBeUndefined();
  });

  it("does not open for a refused account or one with no plan windows", () => {
    const refused = snapshotWith("a", { sevenDay: { utilization: FULL, status: "rejected", resetsAt: at(AFTER_ANCHOR + HOUR_MS) } }, AFTER_ANCHOR);
    expect(reasonNotToOpen("a", refused, AFTER_ANCHOR)).toContain("refused");
    expect(reasonNotToOpen("a", snapshotWith("a", { overageStatus: "allowed" }, AFTER_ANCHOR), AFTER_ANCHOR)).toContain("no plan windows");
  });

  it("does not open for an account that has a seven-day window and no five-hour one, since there is nothing to anchor", () => {
    expect(reasonNotToOpen("a", snapshotWith("a", { sevenDay: { utilization: U40, resetsAt: at(AFTER_ANCHOR + HOUR_MS) } }, AFTER_ANCHOR), AFTER_ANCHOR)).toContain("no five-hour window");
  });
});

describe("runWindowKeeper and identity ids", () => {
  it("files the stamp and reads the snapshot under the identity's id, and opens the window under its name", async () => {
    const asked: string[] = [];
    const keeper = harness({
      anchored: [{ id: "work", identity: "client", anchors: MONDAY_6 }],
      // The snapshot is filed under the id alone, so a read under the name finds none and opens nothing.
      snapshots: { work: snapshotWith("work", { fiveHour: { utilization: 0 }, sevenDay: { utilization: U40 } }, AFTER_ANCHOR) },
      open: async (identity) => {
        asked.push(`open ${identity}`);
        await Promise.resolve();
      },
    });
    await keeper.run(BEFORE_ANCHOR);
    await keeper.run(AFTER_ANCHOR);
    expect(asked).toEqual(["open client"]);
    expect(Object.keys(readHandled(keeper.fs, STAMPS_FILE))).toEqual(["work"]);
  });

  it("keeps a stamp another writer filed while a window was being opened, and drops the one of an identity no longer anchored", async () => {
    const fs = createFakeFarmFs({});
    let now = BEFORE_ANCHOR;
    let anchored: readonly AnchoredIdentity[] = [{ id: "work", identity: "work", anchors: MONDAY_6 }];
    const ports: WindowKeeperPorts = {
      fs,
      stampsFile: STAMPS_FILE,
      nowMs: () => now,
      timeZone: "UTC",
      anchored: () => anchored,
      snapshot: (id) => snapshotWith(id, { fiveHour: { utilization: 0 }, sevenDay: { utilization: U40 } }, AFTER_ANCHOR),
      // While the window opens, a `identity rename --move` moves the identity to the id moved and rekeys its stamp.
      open: async () => {
        anchored = [{ id: "moved", identity: "moved", anchors: MONDAY_6 }];
        writeHandled(fs, STAMPS_FILE, { moved: BEFORE_ANCHOR });
        await Promise.resolve();
      },
      log: () => undefined,
    };
    await runWindowKeeper(ports);
    now = AFTER_ANCHOR;
    await runWindowKeeper(ports);
    expect(readHandled(fs, STAMPS_FILE)).toEqual({ moved: BEFORE_ANCHOR });
  });
});
