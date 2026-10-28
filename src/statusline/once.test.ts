import { describe, expect, it } from "vitest";

import { once } from "./once";

describe("once", () => {
  it("runs the read on the first call alone and returns its result on every call", () => {
    let runs = 0;
    const kept = { value: "read" };
    const read = once(() => {
      runs += 1;
      return kept;
    });
    expect(read()).toBe(kept);
    expect(read()).toBe(kept);
    expect(runs).toBe(1);
  });

  it("keeps a result of undefined, so a read that finds nothing is not run again", () => {
    let runs = 0;
    const read = once((): string | undefined => {
      runs += 1;
      return undefined;
    });
    expect(read()).toBeUndefined();
    expect(read()).toBeUndefined();
    expect(runs).toBe(1);
  });

  it("does not run the read until it is first called", () => {
    let runs = 0;
    once(() => {
      runs += 1;
      return runs;
    });
    expect(runs).toBe(0);
  });
});
