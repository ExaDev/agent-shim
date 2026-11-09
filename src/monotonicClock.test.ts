import { afterEach, describe, expect, it, vi } from "vitest";

import { deadlineAfter } from "./monotonicClock";

/** A wall clock stepped by a time sync or a long sleep: two days, in milliseconds. */
const MS_PER_DAY = 86_400_000;
const WALL_CLOCK_JUMP_MS = MS_PER_DAY + MS_PER_DAY;
const DEADLINE_MS = 1_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deadlineAfter", () => {
  it("does not expire when the wall clock jumps forward, and expires when the monotonic clock passes it", () => {
    let monotonic = 0;
    const expired = deadlineAfter(DEADLINE_MS, () => monotonic);
    const wall = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(wall + WALL_CLOCK_JUMP_MS);
    expect(expired()).toBe(false);
    monotonic = DEADLINE_MS - 1;
    expect(expired()).toBe(false);
    monotonic = DEADLINE_MS;
    expect(expired()).toBe(true);
  });

  it("reads the real monotonic clock by default, which a wall clock jump does not move", () => {
    const expired = deadlineAfter(DEADLINE_MS);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WALL_CLOCK_JUMP_MS);
    expect(expired()).toBe(false);
  });
});
