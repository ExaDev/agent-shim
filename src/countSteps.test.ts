import { describe, expect, it } from "vitest";

import { countSteps, growsLinearly } from "./test-helpers";

const LENGTH = 4;
const ITEMS = Array.from({ length: LENGTH }, (_, index) => index + 1);
const SECOND = 2;
const FACTOR = 10;
const FIRST_SIZE = 10;
const SECOND_SIZE = 20;
const THIRD_SIZE = 40;
const OVERHEAD = 1_000;
const SLOPE = 3;

describe("countSteps", () => {
  it("counts nothing for a run that uses no array operation", () => {
    expect(countSteps(() => undefined)).toBe(0);
  });

  it("counts one step for each callback call and the length for each scan", () => {
    expect(countSteps(() => { ITEMS.filter((item) => item > 0); })).toBe(LENGTH);
    expect(countSteps(() => { ITEMS.some((item) => item < 0); })).toBe(LENGTH);
    expect(countSteps(() => { ITEMS.find((item) => item === SECOND); })).toBe(SECOND);
    expect(countSteps(() => { ITEMS.includes(LENGTH - 1); })).toBe(LENGTH);
    expect(countSteps(() => { ITEMS.indexOf(LENGTH - 1); })).toBe(LENGTH);
  });

  it("counts the steps of an iteration, so a spread copy and a for...of count their length", () => {
    expect(countSteps(() => { Array.of(...ITEMS); })).toBe(LENGTH + 1);
    let total = 0;
    expect(countSteps(() => {
      for (const item of ITEMS) {
        total += item;
      }
    })).toBe(LENGTH + 1);
    expect(total).toBeGreaterThan(0);
  });

  it("counts the iterators an array returns and the callback methods that walk from the end", () => {
    let visited = 0;
    expect(countSteps(() => { for (const entry of ITEMS.entries()) { visited += entry.length; } })).toBe(LENGTH + 1);
    expect(countSteps(() => { for (const key of ITEMS.keys()) { visited += key; } })).toBe(LENGTH + 1);
    expect(countSteps(() => { for (const value of ITEMS.values()) { visited += value; } })).toBe(LENGTH + 1);
    expect(visited).toBeGreaterThan(0);
    expect(countSteps(() => { ITEMS.reduceRight((total, item) => total + item, 0); })).toBe(LENGTH);
    expect(countSteps(() => { ITEMS.findLastIndex((item) => item > 0); })).toBe(1);
  });

  it("does not count what it says it does not count", () => {
    expect(countSteps(() => { ITEMS.slice(); ITEMS.concat(ITEMS); JSON.stringify(ITEMS); })).toBe(0);
    expect(countSteps(() => { Array.of(...new Set(ITEMS)); })).toBe(LENGTH + 1);
    let total = 0;
    expect(countSteps(() => {
      for (let index = 0; index < LENGTH; index += 1) {
        total += ITEMS[index] ?? 0;
      }
    })).toBe(0);
    expect(total).toBeGreaterThan(0);
  });

  it("passes the callback's thisArg through, and the operation's result", () => {
    const context = { factor: FACTOR, label: "context" };
    const receivers: unknown[] = [];
    let mapped: number[] = [];
    countSteps(() => {
      ITEMS.forEach(function (this: unknown) { receivers.push(this); }, context);
      mapped = ITEMS.map(function (this: typeof context, item) { return item * this.factor; }, context);
    });
    expect(receivers).toEqual(ITEMS.map(() => context));
    expect(mapped).toEqual(ITEMS.map((item) => item * FACTOR));
  });

  it("restores the array operations however the run ends", () => {
    const original = Array.prototype.filter;
    expect(() => countSteps(() => { throw new Error("run failed"); })).toThrow("run failed");
    expect(Array.prototype.filter).toBe(original);
    countSteps(() => undefined);
    expect(Array.prototype.filter).toBe(original);
  });
});

describe("growsLinearly", () => {
  const SIZES = [FIRST_SIZE, SECOND_SIZE, THIRD_SIZE] as const;

  it("accepts a count with a fixed overhead and one slope, however large the overhead", () => {
    expect(growsLinearly(SIZES, [OVERHEAD + SLOPE * FIRST_SIZE, OVERHEAD + SLOPE * SECOND_SIZE, OVERHEAD + SLOPE * THIRD_SIZE])).toBe(true);
  });

  it("accepts a count that grows slower than linearly", () => {
    expect(growsLinearly(SIZES, [FIRST_SIZE * FIRST_SIZE, SECOND_SIZE * FIRST_SIZE * SLOPE, THIRD_SIZE * FIRST_SIZE * SLOPE - THIRD_SIZE])).toBe(true);
  });

  it("refuses a count whose slope grows, even a little", () => {
    const base = [OVERHEAD, OVERHEAD + SECOND_SIZE * SLOPE] as const;
    expect(growsLinearly(SIZES, [base[0], base[1], base[1] + THIRD_SIZE * SLOPE + 1])).toBe(false);
    expect(growsLinearly(SIZES, SIZES.map((size) => size * size) as unknown as readonly [number, number, number])).toBe(false);
  });
});
