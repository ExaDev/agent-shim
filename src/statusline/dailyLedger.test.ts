import { describe, expect, it } from "vitest";

import type { SessionCost } from "./cost";
import { DAILY_LEDGER_DIRECTORY, recordDailySpend } from "./dailyLedger";
import { fakeStatuslineFilesystem, fakeStatuslinePorts } from "./testing";

const STATE = "/state/test";
const ROOT = `${STATE}/${DAILY_LEDGER_DIRECTORY}`;
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
const YEAR = 2026;
const OCTOBER = 9;
const DAY = 19;
const MIDDAY_HOUR = 12;
const MORNING_HOUR = 9;
const LATE_HOUR = 23;
const TODAY = "2026-10-19";
const TOMORROW = "2026-10-20";
/** Local noon, so a few hours either side stay on the same local day whatever the machine's time zone. */
const NOON = new Date(YEAR, OCTOBER, DAY, MIDDAY_HOUR, 0, 0).getTime();
const LATE_EVENING = new Date(YEAR, OCTOBER, DAY, LATE_HOUR, 0, 0).getTime();
const NEXT_MORNING = new Date(YEAR, OCTOBER, DAY + 1, MORNING_HOUR, 0, 0).getTime();
const FIRST_FIGURE = 2;
const SECOND_FIGURE = 5;
const THIRD_FIGURE = 3;
const SMALL_RISE = 1.5;
const OLD_SPEND = 9;
const PEAK = 4;
const BEFORE_MIDNIGHT = 6;
const AFTER_MIDNIGHT = 8;
const OTHER_PROCESS_FIGURE = 10;
const LONG_ID_LENGTH = 129;

const native = (usdValue: number): SessionCost => ({ usd: usdValue, source: "native" });
const estimate = (usdValue: number): SessionCost => ({ usd: usdValue, source: "estimate" });

function setup(initial: Readonly<Record<string, string>> = {}): ReturnType<typeof fakeStatuslineFilesystem> & { readonly ports: ReturnType<typeof fakeStatuslinePorts> } {
  const filesystem = fakeStatuslineFilesystem(initial);
  return { ...filesystem, ports: fakeStatuslinePorts({ ...filesystem.ports, stateDirectory: STATE }) };
}

/** What a session's file for a day holds. */
function stored(files: ReadonlyMap<string, string>, day: string, session: string): unknown {
  return JSON.parse(files.get(`${ROOT}/${day}/${session}.json`) ?? "null");
}

describe("recordDailySpend", () => {
  it("states nothing until a session has been seen, and writes nothing", () => {
    const { ports, files } = setup();
    expect(recordDailySpend(ports, NOON, undefined, native(1))).toBeUndefined();
    expect(recordDailySpend(ports, NOON, "s1", undefined)).toBeUndefined();
    expect(files.size).toBe(0);
  });

  it("counts a session from its first sighting, so what it spent before is not the day's", () => {
    const { ports, files } = setup();
    expect(recordDailySpend(ports, NOON, "s1", native(FIRST_FIGURE))).toBe(0);
    expect(recordDailySpend(ports, NOON + HOUR_MS, "s1", native(SECOND_FIGURE))).toBe(SECOND_FIGURE - FIRST_FIGURE);
    expect(stored(files, TODAY, "s1")).toMatchObject({ baselineUsd: FIRST_FIGURE, totalUsd: SECOND_FIGURE, source: "native" });
  });

  it("adds sessions together, each from its own first sighting", () => {
    const { ports } = setup();
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, NOON, "s2", native(OTHER_PROCESS_FIGURE));
    recordDailySpend(ports, NOON, "s1", native(1 + SMALL_RISE));
    expect(recordDailySpend(ports, NOON, "s2", native(OTHER_PROCESS_FIGURE + 2))).toBeCloseTo(SMALL_RISE + 2);
  });

  it("keeps the highest figure seen, so a session whose figure falls does not take the day's total down", () => {
    const { ports } = setup();
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, NOON, "s1", native(PEAK));
    expect(recordDailySpend(ports, NOON, "s1", native(2))).toBe(PEAK - 1);
  });

  it("still states the day's total on a render that has no cost of its own", () => {
    const { ports } = setup();
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, NOON, "s1", native(THIRD_FIGURE));
    expect(recordDailySpend(ports, NOON, "other", undefined)).toBe(THIRD_FIGURE - 1);
  });

  it("does not let sessions drawing at the same moment overwrite one another, whichever reads or writes first", () => {
    const { ports: first, files, ports: shared } = setup();
    let interleaved = false;
    // The other session's statusline runs between this one's first read and its write, as two processes can.
    const racing = fakeStatuslinePorts({
      ...shared,
      readText: (target) => {
        const text = shared.readText(target);
        if (!interleaved) {
          interleaved = true;
          recordDailySpend(first, NOON, "b", native(OTHER_PROCESS_FIGURE));
        }
        return text;
      },
    });
    recordDailySpend(racing, NOON, "a", native(1));
    expect(recordDailySpend(first, NOON, "b", native(OTHER_PROCESS_FIGURE + 2))).toBe(2);
    expect(recordDailySpend(first, NOON, "a", native(1 + SMALL_RISE))).toBeCloseTo(2 + SMALL_RISE);
    expect([...files.keys()].sort()).toEqual([`${ROOT}/${TODAY}/a.json`, `${ROOT}/${TODAY}/b.json`]);
  });

  it("starts the total again at local midnight, carrying a session that spans it from the total it had on its last render", () => {
    const { ports, files } = setup();
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, LATE_EVENING, "s1", native(BEFORE_MIDNIGHT));
    expect(recordDailySpend(ports, NEXT_MORNING, "s1", native(BEFORE_MIDNIGHT))).toBe(0);
    expect(recordDailySpend(ports, NEXT_MORNING, "s1", native(BEFORE_MIDNIGHT + SMALL_RISE))).toBe(SMALL_RISE);
    expect(stored(files, TOMORROW, "s1")).toMatchObject({ baselineUsd: BEFORE_MIDNIGHT, totalUsd: BEFORE_MIDNIGHT + SMALL_RISE });
  });

  it("counts the spend between a session's last render before midnight and its first after as the new day's", () => {
    const { ports } = setup();
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, LATE_EVENING, "s1", native(BEFORE_MIDNIGHT));
    expect(recordDailySpend(ports, NEXT_MORNING, "s1", native(AFTER_MIDNIGHT))).toBe(AFTER_MIDNIGHT - BEFORE_MIDNIGHT);
  });

  it("starts a session unseen for a day from its figure then, and removes days older than the one before", () => {
    const { ports, files } = setup({ [`${ROOT}/2026-10-10/old.json`]: "{}", [`${ROOT}/2026-10-11/old.json`]: "{}" });
    recordDailySpend(ports, NOON, "old", native(1));
    recordDailySpend(ports, NOON, "old", native(OLD_SPEND));
    const later = NEXT_MORNING + HOUR_MS * HOURS_PER_DAY;
    expect(recordDailySpend(ports, later, "old", native(OLD_SPEND + 1))).toBe(0);
    expect([...files.keys()].sort()).toEqual([`${ROOT}/2026-10-19/old.json`, `${ROOT}/2026-10-21/old.json`]);
  });

  it("binds a session to the source of its first figure, and counts nothing from another", () => {
    const { ports, files } = setup();
    recordDailySpend(ports, NOON, "s1", estimate(1));
    expect(recordDailySpend(ports, NOON, "s1", native(OLD_SPEND))).toBe(0);
    expect(stored(files, TODAY, "s1")).toMatchObject({ baselineUsd: 1, totalUsd: 1, source: "estimate" });
    expect(recordDailySpend(ports, NOON, "s1", estimate(1 + SMALL_RISE))).toBe(SMALL_RISE);
  });

  it("does not carry a session across midnight from a figure of another source", () => {
    const { ports } = setup();
    recordDailySpend(ports, LATE_EVENING, "s1", estimate(1));
    expect(recordDailySpend(ports, NEXT_MORNING, "s1", native(OLD_SPEND))).toBe(0);
  });

  it("does not rewrite a file for a render that changes nothing, and refreshes a stale last-seen time", () => {
    const writes: string[] = [];
    const filesystem = fakeStatuslineFilesystem({});
    const ports = fakeStatuslinePorts({
      ...filesystem.ports,
      stateDirectory: STATE,
      writeText: (target, text) => {
        writes.push(text);
        filesystem.ports.writeText(target, text);
      },
    });
    recordDailySpend(ports, NOON, "s1", native(1));
    recordDailySpend(ports, NOON + 1, "s1", native(1));
    expect(writes).toHaveLength(1);
    recordDailySpend(ports, NOON + HOUR_MS, "s1", native(1));
    expect(writes).toHaveLength(2);
  });

  it("replaces a session file that is not an entry, storing the new state", () => {
    for (const damaged of ["{ not json", JSON.stringify({ baselineUsd: "lots" }), ""]) {
      const { ports, files } = setup({ [`${ROOT}/${TODAY}/s1.json`]: damaged });
      expect(recordDailySpend(ports, NOON, "s1", native(THIRD_FIGURE))).toBe(0);
      expect(stored(files, TODAY, "s1"), damaged).toEqual({ baselineUsd: THIRD_FIGURE, totalUsd: THIRD_FIGURE, source: "native", seenAtMs: NOON });
    }
  });

  it("counts a session once while its entry is mid-write, and ignores a temporary file a killed process left", () => {
    const entry = JSON.stringify({ baselineUsd: 1, totalUsd: THIRD_FIGURE, source: "native", seenAtMs: NOON });
    const { ports } = setup({ [`${ROOT}/${TODAY}/abc.json`]: entry, [`${ROOT}/${TODAY}/.abc.json.123.tmp`]: entry });
    expect(recordDailySpend(ports, NOON, undefined, undefined)).toBe(THIRD_FIGURE - 1);
  });

  it("leaves a day dated after today alone, as when the clock was set back, while removing only days before the one preceding today", () => {
    const { ports, files } = setup({ [`${ROOT}/2026-10-30/s9.json`]: "{}", [`${ROOT}/2026-10-10/old.json`]: "{}", [`${ROOT}/2026-10-18/yesterday.json`]: "{}" });
    recordDailySpend(ports, NOON, "s1", native(1));
    expect([...files.keys()].sort()).toEqual([`${ROOT}/2026-10-18/yesterday.json`, `${ROOT}/2026-10-19/s1.json`, `${ROOT}/2026-10-30/s9.json`]);
  });

  it("leaves a session id that could name another path out of the ledger", () => {
    const { ports, files } = setup();
    for (const id of ["../escape", "a/b", ".hidden", "", "a, b", "x".repeat(LONG_ID_LENGTH)]) {
      expect(recordDailySpend(ports, NOON, id, native(1)), id).toBeUndefined();
    }
    expect(files.size).toBe(0);
  });
});
